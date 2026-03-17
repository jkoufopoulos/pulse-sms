#!/usr/bin/env node
/**
 * Regression eval runner — per-assertion behavioral testing.
 *
 * Plays each scenario turn-by-turn through the live pipeline,
 * then uses Claude as a judge to grade individual assertions
 * tied to behavioral principles.
 *
 * Usage:
 *   node scripts/run-regression-evals.js                     # Run all
 *   node scripts/run-regression-evals.js --name "filter"     # Name substring
 *   node scripts/run-regression-evals.js --principle P1       # By principle
 *   node scripts/run-regression-evals.js --url http://...     # Custom server
 *   node scripts/run-regression-evals.js --concurrency 10     # Parallel scenarios (default: 5)
 *   node scripts/run-regression-evals.js --judge               # Enable LLM judge (off by default)
 *   node scripts/run-regression-evals.js --model gemini-2.5-flash  # Override brain model
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { generate } = require('../src/llm');
const { runCodeEvals } = require('../src/evals/code-evals');

const args = process.argv.slice(2);
const nameFilter = args.find(a => a.startsWith('--name='))?.split('=')[1]
  || (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);
const principleFilter = args.find(a => a.startsWith('--principle='))?.split('=')[1]
  || (args.includes('--principle') ? args[args.indexOf('--principle') + 1] : null);
const BASE = args.find(a => a.startsWith('--url='))?.split('=')[1]
  || (args.includes('--url') ? args[args.indexOf('--url') + 1] : null)
  || 'http://localhost:3000';
const CONCURRENCY = parseInt(
  args.find(a => a.startsWith('--concurrency='))?.split('=')[1]
  || (args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : null)
  || '5', 10);
const BRAIN_MODEL = args.find(a => a.startsWith('--model='))?.split('=')[1]
  || (args.includes('--model') ? args[args.indexOf('--model') + 1] : null);
const JUDGE_MODEL = process.env.PULSE_MODEL_JUDGE || 'gemini-2.5-flash';
const NO_JUDGE = args.includes('--no-judge');

const PRICING = {
  'gemini-2.5-flash': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  'claude-haiku-4-5-20251001': { input: 0.80 / 1_000_000, output: 4.0 / 1_000_000 },
};

const JUDGE_SYSTEM = `You are a QA judge for Pulse, an SMS bot that recommends NYC events.

You will be given:
1. A multi-turn conversation transcript between a user and Pulse
2. A list of specific assertions to evaluate — each with a "check" (what should be true) and an "anti_pattern" (what would be a failure)

Your job: evaluate each assertion independently against the actual conversation.

GRADING RULES:
- Events, venues, and URLs will differ between runs — that's expected. Judge BEHAVIOR, not specific content.
- Focus on whether each assertion's "check" is satisfied and "anti_pattern" is avoided.
- An assertion passes if the check is met, even if the wording is different.
- An assertion fails if the anti_pattern is triggered OR the check is clearly not met.
- If Pulse had no events for a category, it's acceptable to say so — judge whether it handled the scarcity honestly.
- Be strict on filter persistence: if the user asked for "free comedy" and Pulse returned jazz or paid events without acknowledging the filter change, that's a FAIL.

Return STRICT JSON (no markdown fences):
{
  "assertions": [
    {
      "id": "A1",
      "pass": true,
      "evidence": "Exact quote or paraphrase from the conversation supporting your judgment",
      "reasoning": "Brief explanation of why this passes or fails"
    }
  ]
}`;

async function judgeScenario(scenario, actualConversation) {
  const transcript = actualConversation.map(t =>
    `[Turn ${t.turn}] ${t.sender.toUpperCase()}: ${t.message}`
  ).join('\n\n');

  const assertionList = scenario.assertions.map(a =>
    `- ${a.id} (Principle: ${a.principle})\n  Check: ${a.check}\n  Anti-pattern: ${a.anti_pattern}`
  ).join('\n\n');

  const prompt = `<scenario>
Name: ${scenario.name}
Principles tested: ${scenario.tests_principles.join(', ')}
</scenario>

<conversation>
${transcript}
</conversation>

<assertions>
${assertionList}
</assertions>

Evaluate each assertion against the conversation. Return JSON with your verdict for each.`;

  const result = await generate(JUDGE_MODEL, JUDGE_SYSTEM, prompt, { maxTokens: 2048, temperature: 0, timeout: 30000 });

  const text = result.text || '';

  // Parse JSON from response
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  const start = text.indexOf('{');
  if (start !== -1) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
  }
  return null;
}

async function runScenario(scenario, phoneNumber) {
  // Clear session
  await fetch(`${BASE}/api/eval/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneNumber, session: null }),
  });

  const conversation = [];
  let turnNumber = 0;

  for (const userTurn of scenario.user_turns) {
    turnNumber = userTurn.turn;
    conversation.push({ turn: turnNumber, sender: 'user', message: userTurn.message });

    let res, data;
    try {
      res = await fetch(`${BASE}/api/sms/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: userTurn.message, From: phoneNumber, ...(BRAIN_MODEL && { Model: BRAIN_MODEL }) }),
        signal: AbortSignal.timeout(28000), // abort before Railway's 30s proxy timeout
      });
      data = await res.json().catch(() => ({ error: `HTTP ${res.status} (non-JSON response)` }));
    } catch (err) {
      const msg = err.name === 'TimeoutError' ? 'fetch timeout (28s)' : err.message;
      conversation.push({ turn: turnNumber, sender: 'pulse', message: `[ERROR: ${msg}]` });
      continue;
    }

    if (!res.ok) {
      conversation.push({ turn: turnNumber, sender: 'pulse', message: `[ERROR: ${data.error || res.status}]` });
      continue;
    }

    const traceSummary = data.trace_summary || null;
    const trace = data.trace || null;
    const messages = data.messages || [];
    for (const msg of messages) {
      conversation.push({ turn: turnNumber, sender: 'pulse', message: msg.body, trace_summary: traceSummary, trace });
    }

    if (messages.length === 0) {
      conversation.push({ turn: turnNumber, sender: 'pulse', message: '[NO RESPONSE]' });
    }

    // Small delay between turns for session to settle
    await new Promise(r => setTimeout(r, 300));
  }

  return conversation;
}

async function main() {
  const fixturesPath = path.join(__dirname, '..', 'data', 'fixtures', 'regression-scenarios.json');
  if (!fs.existsSync(fixturesPath)) {
    console.error('No fixtures found at data/fixtures/regression-scenarios.json');
    process.exit(1);
  }

  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const principles = fixtures.behavioral_principles;
  let scenarios = fixtures.scenarios;

  if (nameFilter) {
    const lower = nameFilter.toLowerCase();
    scenarios = scenarios.filter(s => s.name.toLowerCase().includes(lower));
    console.log(`Filtered to ${scenarios.length} scenarios matching "${nameFilter}"`);
  }
  if (principleFilter) {
    const pid = principleFilter.toUpperCase();
    scenarios = scenarios.filter(s => s.tests_principles.includes(pid));
    console.log(`Filtered to ${scenarios.length} scenarios testing principle ${pid}`);
  }

  if (scenarios.length === 0) {
    console.log('No scenarios to run.');
    process.exit(0);
  }

  console.log(`Running ${scenarios.length} regression scenarios against ${BASE} (concurrency: ${CONCURRENCY})${BRAIN_MODEL ? ` [model: ${BRAIN_MODEL}]` : ''}\n`);

  // Fetch cache metadata for reproducibility
  let cacheMeta = null;
  try {
    const cacheRes = await fetch(`${BASE}/api/eval/cache-meta`);
    cacheMeta = await cacheRes.json();
  } catch {}

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    brain_model: BRAIN_MODEL || '(server default)',
    judge_model: JUDGE_MODEL,
    cache_meta: cacheMeta,
    principles,
    total_scenarios: scenarios.length,
    scenarios_passed: 0,
    scenarios_failed: 0,
    scenarios_errored: 0,
    total_assertions: 0,
    assertions_passed: 0,
    by_principle: {},
    scenarios: [],
  };

  // Initialize principle counters
  for (const p of principles) {
    report.by_principle[p.id] = { name: p.name, total: 0, passed: 0 };
  }

  // Run-unique prefix to avoid session contamination across eval runs
  const runId = Date.now() % 10000;

  // Run one scenario and return result object
  async function runOne(scenario, index) {
    const phoneNumber = `+1666${String(runId).padStart(4, '0')}${String(index).padStart(3, '0')}`;
    try {
      const conversation = await runScenario(scenario, phoneNumber);
      let judgment;
      if (NO_JUDGE) {
        judgment = { assertions: scenario.assertions.map(a => ({ id: a.id, pass: null, evidence: null, reasoning: 'Judge skipped (pass --judge to enable)' })) };
      } else {
        judgment = await judgeScenario(scenario, conversation);
        if (!judgment || !judgment.assertions) {
          throw new Error('Judge returned unparseable response');
        }
      }

      // Run code evals on every pulse turn that has a trace
      const codeEvalFailures = [];
      let codeEvalTotal = 0;
      for (const turn of conversation) {
        if (turn.sender === 'pulse' && turn.trace) {
          const results = runCodeEvals(turn.trace);
          codeEvalTotal += results.length;
          for (const r of results) {
            if (!r.pass) codeEvalFailures.push(r);
          }
        }
      }

      // Replace full trace with key fields for debuggability
      for (const turn of conversation) {
        if (turn.trace) {
          turn.trace_debug = {
            active_filters: turn.trace.composition?.active_filters || null,
            output_intent: turn.trace.output_intent || null,
            input_message: turn.trace.input_message || null,
          };
          delete turn.trace;
        }
      }

      // Build a lookup from judge results
      const judgedById = {};
      for (const a of judgment.assertions) {
        judgedById[a.id] = a;
      }

      // Score assertions
      let scenarioPassed = 0;
      const scenarioTotal = scenario.assertions.length;
      const assertionResults = [];

      for (const assertion of scenario.assertions) {
        const result = judgedById[assertion.id];
        const pass = result?.pass === null ? null : (result?.pass ?? false);
        assertionResults.push({
          id: assertion.id,
          principle: assertion.principle,
          check: assertion.check,
          pass,
          evidence: result?.evidence || null,
          reasoning: result?.reasoning || null,
        });
        if (pass === true) scenarioPassed++;
      }

      const allSkipped = assertionResults.every(a => a.pass === null);
      return {
        name: scenario.name,
        pass: allSkipped ? null : scenarioPassed === scenarioTotal,
        assertions_passed: scenarioPassed,
        assertions_total: scenarioTotal,
        assertions: assertionResults,
        conversation,
        code_eval_failures: codeEvalFailures,
        code_eval_total: codeEvalTotal,
      };
    } catch (err) {
      return { name: scenario.name, pass: false, error: err.message };
    }
  }

  // Run scenarios with concurrency, print results in order
  const results = new Array(scenarios.length);
  let nextToPrint = 0;
  let completed = 0;

  async function worker(startIdx) {
    for (let i = startIdx; i < scenarios.length; i += CONCURRENCY) {
      results[i] = await runOne(scenarios[i], i);
      completed++;

      // Print all consecutive completed results from nextToPrint
      while (nextToPrint < scenarios.length && results[nextToPrint]) {
        const r = results[nextToPrint];
        const idx = nextToPrint + 1;
        const codeFailNames = (r.code_eval_failures || []).map(f => f.name);
        const codeTag = codeFailNames.length > 0
          ? `  \x1b[33mCode: ${[...new Set(codeFailNames)].join(', ')}\x1b[0m`
          : '';

        if (r.error) {
          console.log(`[${idx}/${scenarios.length}] ${r.name}... \x1b[33mERROR\x1b[0m  ${r.error}`);
        } else if (r.pass === null) {
          console.log(`[${idx}/${scenarios.length}] ${r.name}... \x1b[36mRAN\x1b[0m (judge skipped)${codeTag}`);
        } else if (r.pass) {
          console.log(`[${idx}/${scenarios.length}] ${r.name}... \x1b[32mPASS\x1b[0m (${r.assertions_passed}/${r.assertions_total} assertions)${codeTag}`);
        } else {
          console.log(`[${idx}/${scenarios.length}] ${r.name}... \x1b[31mFAIL\x1b[0m (${r.assertions_passed}/${r.assertions_total} assertions)`);
          for (const ar of (r.assertions || [])) {
            if (!ar.pass) {
              console.log(`       ${ar.id} [${ar.principle}]: ${ar.reasoning || ar.check}`);
            }
          }
          if (codeTag) console.log(`      ${codeTag}`);
        }
        nextToPrint++;
      }
    }
  }

  // Launch workers
  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, scenarios.length); w++) {
    workers.push(worker(w));
  }
  await Promise.all(workers);

  // Aggregate results into report
  for (const r of results) {
    if (r.error) {
      report.scenarios_errored++;
    } else if (r.pass === null) {
      // Judge skipped — count as ran but not scored
    } else if (r.pass) {
      report.scenarios_passed++;
    } else {
      report.scenarios_failed++;
    }

    // Aggregate assertions (skip null/skipped)
    for (const ar of (r.assertions || [])) {
      if (ar.pass === null) continue;
      report.total_assertions++;
      if (ar.pass) report.assertions_passed++;
      const pid = ar.principle;
      if (report.by_principle[pid]) {
        report.by_principle[pid].total++;
        if (ar.pass) report.by_principle[pid].passed++;
      }
    }

    report.scenarios.push(r);
  }

  // Summary
  const totalScenarios = report.total_scenarios;
  const pctAssertions = report.total_assertions > 0
    ? ((report.assertions_passed / report.total_assertions) * 100).toFixed(1)
    : '0.0';

  console.log(`\n${'='.repeat(60)}`);
  console.log('REGRESSION EVAL RESULTS');
  console.log(`Scenarios: ${report.scenarios_passed}/${totalScenarios} passed`);
  console.log(`Assertions: ${report.assertions_passed}/${report.total_assertions} passed (${pctAssertions}%)`);

  console.log('\nBy principle:');
  for (const p of principles) {
    const stats = report.by_principle[p.id];
    if (stats.total === 0) continue;
    const pct = ((stats.passed / stats.total) * 100).toFixed(0);
    const color = stats.passed === stats.total ? '\x1b[32m' : '\x1b[31m';
    console.log(`  ${color}${p.id} ${p.name}: ${stats.passed}/${stats.total} (${pct}%)\x1b[0m`);
  }
  console.log(`${'='.repeat(60)}`);

  // Code eval summary
  const codeEvalStats = { total: 0, passed: 0, failed: 0, by_name: {} };
  for (const s of report.scenarios) {
    codeEvalStats.total += s.code_eval_total || 0;
    const failCount = (s.code_eval_failures || []).length;
    codeEvalStats.failed += failCount;
    codeEvalStats.passed += (s.code_eval_total || 0) - failCount;
    for (const f of (s.code_eval_failures || [])) {
      if (!codeEvalStats.by_name[f.name]) codeEvalStats.by_name[f.name] = 0;
      codeEvalStats.by_name[f.name]++;
    }
  }
  report.code_evals = codeEvalStats;

  if (codeEvalStats.total > 0) {
    const cePct = ((codeEvalStats.passed / codeEvalStats.total) * 100).toFixed(1);
    console.log(`\nCode evals: ${codeEvalStats.passed}/${codeEvalStats.total} passed (${cePct}%)`);
    if (Object.keys(codeEvalStats.by_name).length > 0) {
      for (const [name, count] of Object.entries(codeEvalStats.by_name).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${name}: ${count} failures`);
      }
    }
  }

  // Save report
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(reportsDir, `regression-eval-${now}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);

  process.exit(report.scenarios_failed + report.scenarios_errored > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
