#!/usr/bin/env node
/**
 * Multi-turn scenario eval runner.
 *
 * Plays each scenario turn-by-turn through the live pipeline,
 * then uses Claude as a judge to grade the actual conversation
 * against expected_behavior and failure_modes.
 *
 * Usage:
 *   node scripts/run-scenario-evals.js                            # Run all
 *   node scripts/run-scenario-evals.js --category happy_path      # Filter by category
 *   node scripts/run-scenario-evals.js --difficulty must_pass     # Filter by difficulty tier
 *   node scripts/run-scenario-evals.js --name "quiet"             # Name match
 *   node scripts/run-scenario-evals.js --url http://...           # Custom server
 *   node scripts/run-scenario-evals.js --concurrency 15          # Parallel scenarios (default: 10)
 *   node scripts/run-scenario-evals.js --judge                   # Enable LLM judge (off by default)
 *   node scripts/run-scenario-evals.js --pipeline agent_brain    # Run agent brain scenarios
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { runCodeEvals } = require('../src/evals/code-evals');

const args = process.argv.slice(2);
const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1]
  || (args.includes('--category') ? args[args.indexOf('--category') + 1] : null);
const nameFilter = args.find(a => a.startsWith('--name='))?.split('=')[1]
  || (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);
const difficultyFilter = args.find(a => a.startsWith('--difficulty='))?.split('=')[1]
  || (args.includes('--difficulty') ? args[args.indexOf('--difficulty') + 1] : null);
const BASE = args.find(a => a.startsWith('--url='))?.split('=')[1]
  || (args.includes('--url') ? args[args.indexOf('--url') + 1] : null)
  || 'http://localhost:3000';
const isRemote = BASE !== 'http://localhost:3000';
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]
  || (args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : null)
  || (isRemote ? '5' : '10'), 10);
const JUDGE_MODEL = process.env.PULSE_MODEL_JUDGE || 'claude-haiku-4-5-20251001';
const BUDGET_LIMIT = parseFloat(args.find(a => a.startsWith('--budget='))?.split('=')[1]
  || (args.includes('--budget') ? args[args.indexOf('--budget') + 1] : null)
  || '2.00');
const NO_JUDGE = !args.includes('--judge');
const pipelineFilter = args.find(a => a.startsWith('--pipeline='))?.split('=')[1]
  || (args.includes('--pipeline') ? args[args.indexOf('--pipeline') + 1] : null);

const client = new Anthropic();

// Cost tracking for judge calls (Haiku pricing: $0.80/M input, $4/M output)
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80 / 1_000_000, output: 4.0 / 1_000_000 },
  'claude-sonnet-4-5-20250929': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};
let judgeCostTotal = 0;
let budgetExceeded = false;

const JUDGE_SYSTEM = `You are a QA judge for Bestie, an SMS bot that recommends NYC events.

You will be given:
1. A test scenario with expected behavior and failure modes
2. The actual conversation that played out when we ran the scenario through the live system

Your job: grade whether the actual conversation meets the expected behavior and avoids the failure modes.

GRADING RULES:
- Events, venues, and URLs will differ from the example — that's fine. Judge the BEHAVIOR, not the specific content.
- Focus on: correct intent handling, appropriate tone, proper formatting, honest responses, session continuity.
- A response can use different words/events and still PASS if the behavior matches.
- Only FAIL if the actual response clearly violates expected behavior or triggers a listed failure mode.
- Sign-offs: A warm sign-off (1-2 sentences) that includes future engagement prompts ("Hit me up anytime!", "Text me when you're heading out!") is ACCEPTABLE and SHOULD PASS. Only FAIL sign-offs that are excessively long (3+ sentences), ignore the user's exit intent, or are robotically formal. Brief sign-offs ("enjoy!") and warm sign-offs ("Have fun tonight! Hit me up anytime.") are BOTH acceptable.
- Nearby expansion: When a neighborhood has few or no matching events, Bestie is DESIGNED to transparently expand to nearby neighborhoods ("not much in LES, but nearby East Village has..."). This is CORRECT behavior, not a failure. Only FAIL if the system silently serves wrong-neighborhood events without acknowledging the expansion.
- Thin coverage: If the requested neighborhood genuinely has zero events for the given filter (or zero events at all), an honest "not much here" response with alternatives is CORRECT behavior. Do not fail a scenario just because no events exist — judge the system's HANDLING of the empty state. This applies even when the user explicitly requests a neighborhood ("actually dumbo") — if there's nothing there, a transparent "not much in DUMBO, but Fort Greene is next door" with a nudge is PREFERRED over delivering zero results. It saves the user an extra message round-trip.
- MORE numbering: Bestie restarts pick numbering at 1 after MORE (new batch = new numbers). Sequential numbering (4-6 continuing from 1-3) is NOT expected. Do not fail for restarting numbering.
- Nudge accepts: When Bestie asks "want me to check [nearby neighborhood]?" or "want picks from there?", user responses like "sounds good thx", "sure", "yeah", "ok", "bet", "cool", "down", "yes please" are ACCEPTING the offer — NOT exit intent or sign-offs. Judge these in conversational context. "sounds good thx" after a question is agreement, not goodbye.
- Nudge acknowledgments: After a user accepts a nearby nudge, Bestie may send a brief acknowledgment ("Got it! Checking Red Hook for you — give me a sec") before delivering picks in a follow-up message. This is CORRECT behavior. Do not fail for an acknowledgment-only response when it follows a nudge accept — the eval may not capture the follow-up SMS with actual picks.

For each user turn, grade pass/fail and explain briefly.
Then give an overall scenario verdict.

Return STRICT JSON:
{
  "turns": [
    {
      "turn": 1,
      "user_message": "the user message",
      "pass": true,
      "note": "Brief explanation"
    }
  ],
  "overall_pass": true,
  "overall_note": "1-2 sentence summary",
  "failure_modes_triggered": []
}`;

async function judgeSenario(scenario, actualConversation) {
  const prompt = `<scenario>
Name: ${scenario.name}
Category: ${scenario.category}
Testing: ${scenario.testing}
Expected behavior: ${scenario.expected_behavior}
Failure modes: ${JSON.stringify(scenario.failure_modes)}
</scenario>

<expected_conversation>
${scenario.turns.map(t => `${t.sender.toUpperCase()}: ${t.message}`).join('\n\n')}
</expected_conversation>

<actual_conversation>
${actualConversation.map(t => `${t.sender.toUpperCase()}: ${t.message}`).join('\n\n')}
</actual_conversation>

Grade each user turn's response and give an overall verdict.`;

  if (budgetExceeded) throw new Error(`Budget exceeded ($${judgeCostTotal.toFixed(2)}/$${BUDGET_LIMIT.toFixed(2)})`);

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 15000 });

  // Track judge cost
  const pricing = PRICING[JUDGE_MODEL] || PRICING['claude-haiku-4-5-20251001'];
  const cost = (response.usage?.input_tokens || 0) * pricing.input
    + (response.usage?.output_tokens || 0) * pricing.output;
  judgeCostTotal += cost;
  if (judgeCostTotal >= BUDGET_LIMIT) budgetExceeded = true;

  const text = response.content?.[0]?.text || '';

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

/**
 * Check deterministic assertions on bestie turns.
 * Returns { passed, allAsserted, results[] }.
 * - allAsserted: true if every bestie turn has an assertion (can skip judge)
 * - results: per-turn assertion details for reporting
 */
function checkAssertions(scenario, actualConversation) {
  const expectedBestieTurns = scenario.turns.filter(t => t.sender === 'bestie');
  const actualBestieTurns = actualConversation.filter(t => t.sender === 'bestie');
  const results = [];
  let allPassed = true;
  let assertedCount = 0;

  for (let i = 0; i < expectedBestieTurns.length; i++) {
    const expected = expectedBestieTurns[i];
    if (!expected.assert) continue;

    assertedCount++;
    const actual = actualBestieTurns[i];
    if (!actual) {
      results.push({ turn: i + 1, assert_type: expected.assert, expected: expected.message, actual: null, passed: false });
      allPassed = false;
      continue;
    }

    let passed;
    if (expected.assert === 'exact') {
      passed = actual.message === expected.message;
    } else if (expected.assert === 'contains') {
      passed = actual.message.includes(expected.message);
    } else {
      passed = false;
    }

    results.push({ turn: i + 1, assert_type: expected.assert, expected: expected.message, actual: actual.message, passed });
    if (!passed) allPassed = false;
  }

  const allAsserted = assertedCount > 0 && assertedCount === expectedBestieTurns.length;
  return { passed: assertedCount === 0 ? null : allPassed, allAsserted, results };
}

async function runScenario(scenario, phoneNumber) {
  // Clear session
  await fetch(`${BASE}/api/eval/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneNumber, session: null }),
  });

  const actualConversation = [];
  const userTurns = scenario.turns.filter(t => t.sender === 'user');

  for (const turn of userTurns) {
    // Send user message
    actualConversation.push({ sender: 'user', message: turn.message });

    let res, data;
    try {
      res = await fetch(`${BASE}/api/sms/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: turn.message, From: phoneNumber }),
        signal: AbortSignal.timeout(28000), // abort before Railway's 30s proxy timeout
      });
      data = await res.json().catch(() => ({ error: `HTTP ${res.status} (non-JSON response)` }));
    } catch (err) {
      const msg = err.name === 'TimeoutError' ? 'fetch timeout (28s)' : err.message;
      actualConversation.push({ sender: 'bestie', message: `[ERROR: ${msg}]` });
      continue;
    }

    if (!res.ok) {
      actualConversation.push({ sender: 'bestie', message: `[ERROR: ${data.error || res.status}]` });
      continue;
    }

    // Collect all response messages (main text + follow-up links)
    const traceSummary = data.trace_summary || null;
    const trace = data.trace || null;
    const messages = data.messages || [];
    for (const msg of messages) {
      actualConversation.push({ sender: 'bestie', message: msg.body, trace_summary: traceSummary, trace });
    }

    if (messages.length === 0) {
      actualConversation.push({ sender: 'bestie', message: '[NO RESPONSE]' });
    }

    // Small delay between turns for session to settle
    await new Promise(r => setTimeout(r, 300));
  }

  return actualConversation;
}

async function main() {
  const scenariosPath = path.join(__dirname, '..', 'data', 'fixtures', 'multi-turn-scenarios.json');
  if (!fs.existsSync(scenariosPath)) {
    console.error('No scenarios found at data/fixtures/multi-turn-scenarios.json');
    process.exit(1);
  }

  let { scenarios } = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));

  if (categoryFilter) {
    scenarios = scenarios.filter(s => s.category === categoryFilter);
    console.log(`Filtered to ${scenarios.length} scenarios in category "${categoryFilter}"`);
  }
  if (nameFilter) {
    const lower = nameFilter.toLowerCase();
    scenarios = scenarios.filter(s => s.name.toLowerCase().includes(lower));
    console.log(`Filtered to ${scenarios.length} scenarios matching "${nameFilter}"`);
  }
  if (difficultyFilter) {
    scenarios = scenarios.filter(s => s.difficulty === difficultyFilter);
    console.log(`Filtered to ${scenarios.length} scenarios with difficulty "${difficultyFilter}"`);
  }
  if (pipelineFilter) {
    scenarios = scenarios.filter(s => s.pipeline === pipelineFilter);
    console.log(`Filtered to ${scenarios.length} scenarios for pipeline "${pipelineFilter}"`);
  } else {
    // Exclude pipeline-specific scenarios by default (e.g. agent_brain)
    scenarios = scenarios.filter(s => !s.pipeline);
  }

  if (scenarios.length === 0) {
    console.log('No scenarios to run.');
    process.exit(0);
  }

  console.log(`Running ${scenarios.length} multi-turn scenarios against ${BASE} (concurrency: ${CONCURRENCY})\n`);

  // Fetch cache metadata for reproducibility
  let cacheMeta = null;
  try {
    const cacheRes = await fetch(`${BASE}/api/eval/cache-meta`);
    cacheMeta = await cacheRes.json();
  } catch {}

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    judge_model: JUDGE_MODEL,
    concurrency: CONCURRENCY,
    budget_limit: BUDGET_LIMIT,
    cache_meta: cacheMeta,
    total: scenarios.length,
    passed: 0,
    failed: 0,
    errors: 0,
    scenarios: [],
  };

  // Run-unique prefix to avoid session contamination across eval runs
  const runId = Date.now() % 10000;

  // Run a single scenario and return result object
  async function runOne(scenario, index) {
    const nameHash = scenario.name.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0) >>> 0;
    const phoneNumber = `+1555${String(runId).padStart(4, '0')}${String(nameHash % 1000).padStart(3, '0')}`;
    const userTurnCount = scenario.turns.filter(t => t.sender === 'user').length;

    try {
      const actualConversation = await runScenario(scenario, phoneNumber);
      const assertions = checkAssertions(scenario, actualConversation);

      // Run code evals on every bestie turn that has a trace
      const codeEvalFailures = [];
      let codeEvalTotal = 0;
      for (const turn of actualConversation) {
        if (turn.sender === 'bestie' && turn.trace) {
          const results = runCodeEvals(turn.trace);
          codeEvalTotal += results.length;
          for (const r of results) {
            if (!r.pass) codeEvalFailures.push(r);
          }
        }
      }

      // Replace full trace with key fields for debuggability
      for (const turn of actualConversation) {
        if (turn.trace) {
          turn.trace_debug = {
            active_filters: turn.trace.composition?.active_filters || null,
            output_intent: turn.trace.output_intent || null,
            input_message: turn.trace.input_message || null,
          };
          delete turn.trace;
        }
      }

      if (assertions.passed === false) {
        return {
          index, name: scenario.name, category: scenario.category,
          difficulty: scenario.difficulty, pass: false, user_turns: userTurnCount,
          actual_conversation: actualConversation, assertions: assertions.results, judgment: null,
          code_eval_failures: codeEvalFailures, code_eval_total: codeEvalTotal,
        };
      }

      let judgment = null;
      if (assertions.allAsserted) {
        judgment = { overall_pass: true, overall_note: 'All assertions passed (deterministic)', turns: [], failure_modes_triggered: [] };
      } else if (NO_JUDGE) {
        judgment = { overall_pass: null, overall_note: 'Judge skipped (pass --judge to enable)', turns: [], failure_modes_triggered: [] };
      } else {
        judgment = await judgeSenario(scenario, actualConversation);
        if (!judgment) throw new Error('Judge returned unparseable response');
      }

      return {
        index, name: scenario.name, category: scenario.category,
        difficulty: scenario.difficulty, pass: judgment.overall_pass,
        user_turns: userTurnCount, actual_conversation: actualConversation,
        assertions: assertions.results.length > 0 ? assertions.results : undefined,
        judgment,
        code_eval_failures: codeEvalFailures, code_eval_total: codeEvalTotal,
      };
    } catch (err) {
      return {
        index, name: scenario.name, category: scenario.category,
        difficulty: scenario.difficulty, pass: false, error: err.message,
      };
    }
  }

  // Concurrency-limited parallel execution
  let completed = 0;
  const startTime = Date.now();
  const results = new Array(scenarios.length);

  async function worker(taskQueue) {
    while (taskQueue.length > 0) {
      const { scenario, index } = taskQueue.shift();
      const result = await runOne(scenario, index);
      results[index] = result;
      completed++;

      // Print result as it completes
      const pct = ((completed / scenarios.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const prefix = `[${completed}/${scenarios.length} ${pct}% ${elapsed}s]`;

      const codeFailNames = (result.code_eval_failures || []).map(f => f.name);
      const codeTag = codeFailNames.length > 0
        ? `  \x1b[33mCode: ${[...new Set(codeFailNames)].join(', ')}\x1b[0m`
        : '';

      if (result.error) {
        console.log(`${prefix} \x1b[33mERROR\x1b[0m  ${result.name}: ${result.error}`);
      } else if (!result.pass && !result.judgment) {
        console.log(`${prefix} \x1b[31mFAIL\x1b[0m  ${result.name} (assertion)`);
        for (const r of (result.assertions || []).filter(r => !r.passed)) {
          const truncExpected = r.expected.length > 60 ? r.expected.slice(0, 60) + '...' : r.expected;
          const truncActual = r.actual ? (r.actual.length > 60 ? r.actual.slice(0, 60) + '...' : r.actual) : '[missing]';
          console.log(`  Turn ${r.turn}: expected ${r.assert_type} ${JSON.stringify(truncExpected)} got ${JSON.stringify(truncActual)}`);
        }
        if (codeTag) console.log(`      ${codeTag}`);
      } else if (result.pass) {
        const det = result.judgment?.overall_note?.includes('deterministic') ? ' (deterministic)' : '';
        console.log(`${prefix} \x1b[32mPASS\x1b[0m  ${result.name}${det}${codeTag}`);
      } else {
        console.log(`${prefix} \x1b[31mFAIL\x1b[0m  ${result.name}: ${result.judgment?.overall_note || 'no detail'}`);
        const triggered = result.judgment?.failure_modes_triggered || [];
        if (triggered.length > 0) {
          console.log(`       Failure modes: ${triggered.join(', ')}`);
        }
        if (codeTag) console.log(`      ${codeTag}`);
      }
    }
  }

  // Build task queue and launch workers
  const taskQueue = scenarios.map((scenario, index) => ({ scenario, index }));
  const workers = Array.from({ length: Math.min(CONCURRENCY, scenarios.length) }, () => worker(taskQueue));
  await Promise.all(workers);

  // Collect results into report (in original order)
  for (const r of results) {
    if (r.error) report.errors++;
    else if (r.pass) report.passed++;
    else report.failed++;
    report.scenarios.push(r);
  }

  // Summary
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTAL: ${report.total}  PASS: ${report.passed}  FAIL: ${report.failed}  ERROR: ${report.errors}`);
  console.log(`Pass rate: ${((report.passed / report.total) * 100).toFixed(1)}%`);
  console.log(`Time: ${totalElapsed}s (concurrency: ${CONCURRENCY})`);
  console.log(`Judge cost: $${judgeCostTotal.toFixed(2)} (budget: $${BUDGET_LIMIT.toFixed(2)})`);
  console.log(`${'='.repeat(60)}`);

  // Difficulty tier breakdown
  const byDifficulty = {};
  for (const s of report.scenarios) {
    const diff = s.difficulty || 'unknown';
    if (!byDifficulty[diff]) byDifficulty[diff] = { pass: 0, fail: 0, error: 0 };
    if (s.error) byDifficulty[diff].error++;
    else if (s.pass) byDifficulty[diff].pass++;
    else byDifficulty[diff].fail++;
  }
  const tierOrder = ['must_pass', 'should_pass', 'stretch'];
  console.log('\nBy difficulty:');
  for (const tier of tierOrder) {
    const counts = byDifficulty[tier];
    if (!counts) continue;
    const total = counts.pass + counts.fail + counts.error;
    const pct = total > 0 ? ((counts.pass / total) * 100).toFixed(0) : '0';
    const allPass = counts.pass === total;
    const icon = allPass ? ' \u2713' : '';
    console.log(`  ${tier}: ${counts.pass}/${total} passed (${pct}%)${icon}`);
  }

  // Category breakdown
  const byCategory = {};
  for (const s of report.scenarios) {
    const cat = s.category || 'unknown';
    if (!byCategory[cat]) byCategory[cat] = { pass: 0, fail: 0, error: 0 };
    if (s.error) byCategory[cat].error++;
    else if (s.pass) byCategory[cat].pass++;
    else byCategory[cat].fail++;
  }
  console.log('\nBy category:');
  for (const [cat, counts] of Object.entries(byCategory)) {
    const total = counts.pass + counts.fail + counts.error;
    console.log(`  ${cat}: ${counts.pass}/${total} passed`);
  }

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

  // Failure details
  const failures = report.scenarios.filter(s => !s.pass && !s.error);
  if (failures.length > 0) {
    console.log('\nFailed scenarios:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.judgment?.overall_note || 'no detail'}`);
      for (const fm of (f.judgment?.failure_modes_triggered || [])) {
        console.log(`    [!] ${fm}`);
      }
    }
  }

  // Save report
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(reportsDir, `scenario-eval-${now}.json`);
  report.judge_cost = parseFloat(judgeCostTotal.toFixed(4));
  report.elapsed_seconds = parseFloat(totalElapsed);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);

  process.exit(report.failed + report.errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
