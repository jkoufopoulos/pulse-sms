#!/usr/bin/env node
/**
 * Multi-turn scenario eval runner.
 *
 * Plays each scenario turn-by-turn through the live pipeline,
 * then uses Claude as a judge to grade the actual conversation
 * against expected_behavior and failure_modes.
 *
 * Usage:
 *   node scripts/run-scenario-evals.js                        # Run all
 *   node scripts/run-scenario-evals.js --category happy_path  # Filter
 *   node scripts/run-scenario-evals.js --name "quiet"         # Name match
 *   node scripts/run-scenario-evals.js --url http://...       # Custom server
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const args = process.argv.slice(2);
const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1]
  || (args.includes('--category') ? args[args.indexOf('--category') + 1] : null);
const nameFilter = args.find(a => a.startsWith('--name='))?.split('=')[1]
  || (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);
const BASE = args.find(a => a.startsWith('--url='))?.split('=')[1] || 'http://localhost:3000';
const JUDGE_MODEL = process.env.PULSE_MODEL_JUDGE || 'claude-sonnet-4-5-20250929';

const client = new Anthropic();

const JUDGE_SYSTEM = `You are a QA judge for Pulse, an SMS bot that recommends NYC events.

You will be given:
1. A test scenario with expected behavior and failure modes
2. The actual conversation that played out when we ran the scenario through the live system

Your job: grade whether the actual conversation meets the expected behavior and avoids the failure modes.

GRADING RULES:
- Events, venues, and URLs will differ from the example — that's fine. Judge the BEHAVIOR, not the specific content.
- Focus on: correct intent handling, appropriate tone, proper formatting, honest responses, session continuity.
- A response can use different words/events and still PASS if the behavior matches.
- Only FAIL if the actual response clearly violates expected behavior or triggers a listed failure mode.

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

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 15000 });

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

  const actualConversation = [];
  const userTurns = scenario.turns.filter(t => t.sender === 'user');

  for (const turn of userTurns) {
    // Send user message
    actualConversation.push({ sender: 'user', message: turn.message });

    const res = await fetch(`${BASE}/api/sms/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Body: turn.message, From: phoneNumber }),
    });

    const data = await res.json();

    if (!res.ok) {
      actualConversation.push({ sender: 'pulse', message: `[ERROR: ${data.error || res.status}]` });
      continue;
    }

    // Collect all response messages (main text + follow-up links)
    const messages = data.messages || [];
    for (const msg of messages) {
      actualConversation.push({ sender: 'pulse', message: msg.body });
    }

    if (messages.length === 0) {
      actualConversation.push({ sender: 'pulse', message: '[NO RESPONSE]' });
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

  if (scenarios.length === 0) {
    console.log('No scenarios to run.');
    process.exit(0);
  }

  console.log(`Running ${scenarios.length} multi-turn scenarios against ${BASE}\n`);

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    judge_model: JUDGE_MODEL,
    total: scenarios.length,
    passed: 0,
    failed: 0,
    errors: 0,
    scenarios: [],
  };

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    const phoneNumber = `+1555${String(i).padStart(7, '0')}`;
    const userTurnCount = scenario.turns.filter(t => t.sender === 'user').length;

    process.stdout.write(`[${i + 1}/${scenarios.length}] ${scenario.name} (${userTurnCount} user turns)... `);

    try {
      // Step 1: Play through the conversation
      const actualConversation = await runScenario(scenario, phoneNumber);

      // Step 2: Judge the conversation
      const judgment = await judgeSenario(scenario, actualConversation);

      if (!judgment) {
        throw new Error('Judge returned unparseable response');
      }

      const passed = judgment.overall_pass;
      const triggeredFailures = judgment.failure_modes_triggered || [];

      if (passed) {
        report.passed++;
        console.log('\x1b[32mPASS\x1b[0m');
      } else {
        report.failed++;
        console.log(`\x1b[31mFAIL\x1b[0m  ${judgment.overall_note}`);
        if (triggeredFailures.length > 0) {
          console.log(`       Failure modes: ${triggeredFailures.join(', ')}`);
        }
      }

      report.scenarios.push({
        name: scenario.name,
        category: scenario.category,
        pass: passed,
        user_turns: userTurnCount,
        actual_conversation: actualConversation,
        judgment,
      });

    } catch (err) {
      report.errors++;
      console.log(`\x1b[33mERROR\x1b[0m  ${err.message}`);
      report.scenarios.push({
        name: scenario.name,
        category: scenario.category,
        pass: false,
        error: err.message,
      });
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTAL: ${report.total}  PASS: ${report.passed}  FAIL: ${report.failed}  ERROR: ${report.errors}`);
  console.log(`Pass rate: ${((report.passed / report.total) * 100).toFixed(1)}%`);
  console.log(`${'='.repeat(60)}`);

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
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);

  process.exit(report.failed + report.errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
