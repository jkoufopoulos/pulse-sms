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
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const args = process.argv.slice(2);
const nameFilter = args.find(a => a.startsWith('--name='))?.split('=')[1]
  || (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);
const principleFilter = args.find(a => a.startsWith('--principle='))?.split('=')[1]
  || (args.includes('--principle') ? args[args.indexOf('--principle') + 1] : null);
const BASE = args.find(a => a.startsWith('--url='))?.split('=')[1]
  || (args.includes('--url') ? args[args.indexOf('--url') + 1] : null)
  || 'http://localhost:3000';
const JUDGE_MODEL = process.env.PULSE_MODEL_JUDGE || 'claude-sonnet-4-5-20250929';

const client = new Anthropic();

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

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2048,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 30000 });

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

    const res = await fetch(`${BASE}/api/sms/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Body: userTurn.message, From: phoneNumber }),
    });

    const data = await res.json();

    if (!res.ok) {
      conversation.push({ turn: turnNumber, sender: 'pulse', message: `[ERROR: ${data.error || res.status}]` });
      continue;
    }

    const messages = data.messages || [];
    for (const msg of messages) {
      conversation.push({ turn: turnNumber, sender: 'pulse', message: msg.body });
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

  console.log(`Running ${scenarios.length} regression scenarios against ${BASE}\n`);

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    judge_model: JUDGE_MODEL,
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

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    const phoneNumber = `+1666${String(i).padStart(7, '0')}`;

    process.stdout.write(`[${i + 1}/${scenarios.length}] ${scenario.name}... `);

    try {
      const conversation = await runScenario(scenario, phoneNumber);
      const judgment = await judgeScenario(scenario, conversation);

      if (!judgment || !judgment.assertions) {
        throw new Error('Judge returned unparseable response');
      }

      // Build a lookup from judge results
      const judgedById = {};
      for (const a of judgment.assertions) {
        judgedById[a.id] = a;
      }

      // Score assertions
      let scenarioPassed = 0;
      let scenarioTotal = scenario.assertions.length;
      const assertionResults = [];

      for (const assertion of scenario.assertions) {
        const result = judgedById[assertion.id];
        const pass = result?.pass ?? false;
        assertionResults.push({
          id: assertion.id,
          principle: assertion.principle,
          check: assertion.check,
          pass,
          evidence: result?.evidence || null,
          reasoning: result?.reasoning || null,
        });

        report.total_assertions++;
        if (pass) {
          report.assertions_passed++;
          scenarioPassed++;
        }

        // Principle tracking
        const pid = assertion.principle;
        if (report.by_principle[pid]) {
          report.by_principle[pid].total++;
          if (pass) report.by_principle[pid].passed++;
        }
      }

      const allPassed = scenarioPassed === scenarioTotal;
      if (allPassed) {
        report.scenarios_passed++;
        console.log(`\x1b[32mPASS\x1b[0m (${scenarioPassed}/${scenarioTotal} assertions)`);
      } else {
        report.scenarios_failed++;
        console.log(`\x1b[31mFAIL\x1b[0m (${scenarioPassed}/${scenarioTotal} assertions)`);

        // Print failed assertions
        for (const ar of assertionResults) {
          if (!ar.pass) {
            console.log(`       ${ar.id} [${ar.principle}]: ${ar.reasoning || ar.check}`);
          }
        }
      }

      report.scenarios.push({
        name: scenario.name,
        pass: allPassed,
        assertions_passed: scenarioPassed,
        assertions_total: scenarioTotal,
        assertions: assertionResults,
        conversation,
      });

    } catch (err) {
      report.scenarios_errored++;
      console.log(`\x1b[33mERROR\x1b[0m  ${err.message}`);
      report.scenarios.push({
        name: scenario.name,
        pass: false,
        error: err.message,
      });
    }
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
