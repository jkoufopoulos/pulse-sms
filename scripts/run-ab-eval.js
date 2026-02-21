#!/usr/bin/env node
/**
 * A/B compose eval — runs the same compose inputs through two models
 * and compares output quality using judges + code evals.
 *
 * Usage:
 *   node scripts/run-ab-eval.js                          # Haiku vs Sonnet (default)
 *   node scripts/run-ab-eval.js --model-a haiku --model-b sonnet
 *   node scripts/run-ab-eval.js --tag vibe_filter         # Filter cases by tag
 *   node scripts/run-ab-eval.js --id ab-004               # Run single case
 *   node scripts/run-ab-eval.js --runs 3                  # Multiple runs per case (reduces noise)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { composeResponse } = require('../src/ai');
const { getNycDateString } = require('../src/geo');
const { judgeTone, judgePickRelevance, judgePreference } = require('../src/evals/judge-evals');

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name) {
  const flag = `--${name}=`;
  const found = args.find(a => a.startsWith(flag));
  if (found) return found.split('=')[1];
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
}

const MODEL_MAP = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929',
  'gemini-flash': 'gemini-2.5-flash',
};

const modelALabel = getArg('model-a') || 'haiku';
const modelBLabel = getArg('model-b') || 'gemini-flash';
const MODEL_A = MODEL_MAP[modelALabel] || modelALabel;
const MODEL_B = MODEL_MAP[modelBLabel] || modelBLabel;
const tagFilter = getArg('tag');
const idFilter = getArg('id');
const runsPerCase = parseInt(getArg('runs') || '1', 10);

// Fail fast if a Gemini model is requested without API key
if ((MODEL_A.startsWith('gemini-') || MODEL_B.startsWith('gemini-')) && !process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is required to run evals with a Gemini model. Add it to .env and retry.');
  process.exit(1);
}

// --- Cost constants (per 1M tokens, as of Feb 2026) ---
const COSTS = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
};

function estimateCost(modelId, inputTokens, outputTokens) {
  const rates = COSTS[modelId] || { input: 3.0, output: 15.0 };
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

// --- Date placeholder resolution ---
function resolveDate(str) {
  if (!str) return str;
  const today = getNycDateString(0);
  const tomorrow = getNycDateString(1);
  return str.replace(/__TODAY__/g, today).replace(/__TOMORROW__/g, tomorrow);
}

function resolveEvents(events) {
  return events.map(e => ({
    ...e,
    date_local: resolveDate(e.date_local),
    start_time_local: resolveDate(e.start_time_local),
    end_time_local: resolveDate(e.end_time_local),
  }));
}

// --- Build a mock trace for judge evals ---
function buildTrace(userMessage, neighborhood, events, result) {
  return {
    input_message: userMessage,
    output_sms: result.sms_text || '',
    output_sms_length: (result.sms_text || '').length,
    output_intent: 'events',
    routing: { result: { intent: 'events', neighborhood } },
    composition: {
      picks: result.picks || [],
      neighborhood_used: result.neighborhood_used || neighborhood,
    },
    events: {
      sent_ids: events.map(e => e.id),
    },
  };
}

// --- Code checks (subset relevant to compose quality) ---
function runComposeChecks(smsText, events, picks) {
  const results = [];

  // Char limit
  const len = (smsText || '').length;
  results.push({
    name: 'char_limit',
    pass: len <= 480,
    detail: `${len} chars${len > 480 ? ` (${len - 480} over)` : ''}`,
  });

  // Numbered format
  const hasNumbered = /\d\)/.test(smsText || '');
  results.push({
    name: 'numbered_format',
    pass: hasNumbered,
    detail: hasNumbered ? 'has numbered picks' : 'missing numbered format',
  });

  // Valid picks — all picked IDs must be in events
  const validIds = new Set(events.map(e => e.id));
  const invalidPicks = (picks || []).filter(p => !validIds.has(p.event_id));
  results.push({
    name: 'valid_picks',
    pass: invalidPicks.length === 0,
    detail: invalidPicks.length > 0 ? `hallucinated: ${invalidPicks.map(p => p.event_id).join(', ')}` : `${(picks || []).length} picks valid`,
  });

  // Not empty
  results.push({
    name: 'not_empty',
    pass: (smsText || '').trim().length > 0,
    detail: (smsText || '').trim().length > 0 ? 'has content' : 'empty',
  });

  // URL-free (compose should not include URLs)
  const hasUrl = /https?:\/\//.test(smsText || '');
  results.push({
    name: 'no_urls_in_sms',
    pass: !hasUrl,
    detail: hasUrl ? 'contains URL (should be separate message)' : 'clean',
  });

  return results;
}

// --- Main ---
async function main() {
  const casesPath = path.join(__dirname, '..', 'data', 'fixtures', 'ab-compose-cases.json');
  if (!fs.existsSync(casesPath)) {
    console.error('No AB compose cases found at data/fixtures/ab-compose-cases.json');
    process.exit(1);
  }

  let cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

  if (idFilter) {
    cases = cases.filter(c => c.id === idFilter);
  }
  if (tagFilter) {
    cases = cases.filter(c => c.tags.includes(tagFilter));
  }

  if (cases.length === 0) {
    console.log('No cases to run.');
    process.exit(0);
  }

  console.log(`A/B Compose Eval: ${modelALabel} vs ${modelBLabel}`);
  console.log(`Models: ${MODEL_A} vs ${MODEL_B}`);
  console.log(`Cases: ${cases.length}, Runs per case: ${runsPerCase}\n`);

  const report = {
    timestamp: new Date().toISOString(),
    model_a: { id: MODEL_A, label: modelALabel },
    model_b: { id: MODEL_B, label: modelBLabel },
    total_cases: cases.length,
    runs_per_case: runsPerCase,
    summary: {
      preference: { [modelALabel]: 0, [modelBLabel]: 0, tie: 0, error: 0 },
      tone: { [modelALabel]: { pass: 0, fail: 0 }, [modelBLabel]: { pass: 0, fail: 0 } },
      relevance: { [modelALabel]: { pass: 0, fail: 0 }, [modelBLabel]: { pass: 0, fail: 0 } },
      code_checks: { [modelALabel]: { pass: 0, fail: 0 }, [modelBLabel]: { pass: 0, fail: 0 } },
      cost: { [modelALabel]: 0, [modelBLabel]: 0 },
    },
    cases: [],
  };

  for (const testCase of cases) {
    const events = resolveEvents(testCase.events);

    for (let run = 0; run < runsPerCase; run++) {
      const runLabel = runsPerCase > 1 ? ` run ${run + 1}/${runsPerCase}` : '';
      process.stdout.write(`${testCase.id}${runLabel} "${testCase.description.slice(0, 45)}"... `);

      try {
        // Call both models
        const [resultA, resultB] = await Promise.all([
          composeResponse(testCase.message, events, testCase.neighborhood, testCase.filters, {
            model: MODEL_A,
            excludeIds: testCase.excludeIds,
            extraContext: testCase.extraContext,
          }),
          composeResponse(testCase.message, events, testCase.neighborhood, testCase.filters, {
            model: MODEL_B,
            excludeIds: testCase.excludeIds,
            extraContext: testCase.extraContext,
          }),
        ]);

        // Build traces for judge evals
        const traceA = buildTrace(testCase.message, testCase.neighborhood, events, resultA);
        const traceB = buildTrace(testCase.message, testCase.neighborhood, events, resultB);

        // Run judges in parallel
        const [toneA, toneB, relA, relB, pref] = await Promise.all([
          judgeTone(traceA),
          judgeTone(traceB),
          judgePickRelevance(traceA),
          judgePickRelevance(traceB),
          judgePreference(testCase.message, testCase.neighborhood, resultA.sms_text, resultB.sms_text, modelALabel, modelBLabel),
        ]);

        // Code checks
        const codeA = runComposeChecks(resultA.sms_text, events, resultA.picks);
        const codeB = runComposeChecks(resultB.sms_text, events, resultB.picks);

        // Aggregate results
        report.summary.preference[pref.winner] = (report.summary.preference[pref.winner] || 0) + 1;
        report.summary.tone[modelALabel][toneA.pass ? 'pass' : 'fail']++;
        report.summary.tone[modelBLabel][toneB.pass ? 'pass' : 'fail']++;
        report.summary.relevance[modelALabel][relA.pass ? 'pass' : 'fail']++;
        report.summary.relevance[modelBLabel][relB.pass ? 'pass' : 'fail']++;

        for (const c of codeA) report.summary.code_checks[modelALabel][c.pass ? 'pass' : 'fail']++;
        for (const c of codeB) report.summary.code_checks[modelBLabel][c.pass ? 'pass' : 'fail']++;

        // Cost tracking — use actual usage from compose result, fall back to estimate
        const usageA = resultA._usage || { input_tokens: 2000, output_tokens: Math.ceil((resultA.sms_text || '').length / 3) };
        const usageB = resultB._usage || { input_tokens: 2000, output_tokens: Math.ceil((resultB.sms_text || '').length / 3) };
        report.summary.cost[modelALabel] += estimateCost(MODEL_A, usageA.input_tokens, usageA.output_tokens);
        report.summary.cost[modelBLabel] += estimateCost(MODEL_B, usageB.input_tokens, usageB.output_tokens);

        // Color-code preference
        const prefColor = pref.winner === modelALabel ? '\x1b[36m' : pref.winner === modelBLabel ? '\x1b[33m' : '\x1b[90m';
        console.log(`${prefColor}${pref.winner}\x1b[0m (${pref.confidence}) | tone: ${toneA.pass ? 'P' : 'F'}/${toneB.pass ? 'P' : 'F'} | rel: ${relA.pass ? 'P' : 'F'}/${relB.pass ? 'P' : 'F'}`);

        report.cases.push({
          id: testCase.id,
          run: run + 1,
          description: testCase.description,
          model_a_sms: resultA.sms_text,
          model_a_picks: resultA.picks,
          model_b_sms: resultB.sms_text,
          model_b_picks: resultB.picks,
          preference: pref,
          tone: { [modelALabel]: toneA, [modelBLabel]: toneB },
          relevance: { [modelALabel]: relA, [modelBLabel]: relB },
          code_checks: { [modelALabel]: codeA, [modelBLabel]: codeB },
        });
      } catch (err) {
        console.log(`\x1b[31mERROR\x1b[0m ${err.message}`);
        report.cases.push({
          id: testCase.id,
          run: run + 1,
          error: err.message,
        });
      }
    }
  }

  // --- Summary ---
  console.log(`\n${'='.repeat(70)}`);
  console.log('A/B COMPOSE EVAL RESULTS');
  console.log(`${'='.repeat(70)}\n`);

  const pref = report.summary.preference;
  const totalPrefs = pref[modelALabel] + pref[modelBLabel] + pref.tie;
  console.log('HEAD-TO-HEAD PREFERENCE:');
  console.log(`  ${modelALabel}: ${pref[modelALabel]}/${totalPrefs} (${totalPrefs > 0 ? ((pref[modelALabel] / totalPrefs) * 100).toFixed(0) : 0}%)`);
  console.log(`  ${modelBLabel}: ${pref[modelBLabel]}/${totalPrefs} (${totalPrefs > 0 ? ((pref[modelBLabel] / totalPrefs) * 100).toFixed(0) : 0}%)`);
  console.log(`  tie: ${pref.tie}/${totalPrefs} (${totalPrefs > 0 ? ((pref.tie / totalPrefs) * 100).toFixed(0) : 0}%)`);
  if (pref.error > 0) console.log(`  errors: ${pref.error}`);

  console.log('\nTONE JUDGE (sounds like a friend):');
  const toneS = report.summary.tone;
  for (const label of [modelALabel, modelBLabel]) {
    const total = toneS[label].pass + toneS[label].fail;
    console.log(`  ${label}: ${toneS[label].pass}/${total} pass (${total > 0 ? ((toneS[label].pass / total) * 100).toFixed(0) : 0}%)`);
  }

  console.log('\nRELEVANCE JUDGE (right events for the request):');
  const relS = report.summary.relevance;
  for (const label of [modelALabel, modelBLabel]) {
    const total = relS[label].pass + relS[label].fail;
    console.log(`  ${label}: ${relS[label].pass}/${total} pass (${total > 0 ? ((relS[label].pass / total) * 100).toFixed(0) : 0}%)`);
  }

  console.log('\nCODE CHECKS (format compliance):');
  const codeS = report.summary.code_checks;
  for (const label of [modelALabel, modelBLabel]) {
    const total = codeS[label].pass + codeS[label].fail;
    console.log(`  ${label}: ${codeS[label].pass}/${total} pass (${total > 0 ? ((codeS[label].pass / total) * 100).toFixed(0) : 0}%)`);
  }

  console.log('\nESTIMATED COST (this eval run):');
  for (const label of [modelALabel, modelBLabel]) {
    console.log(`  ${label}: $${report.summary.cost[label].toFixed(4)}`);
  }
  const savings = report.summary.cost[modelBLabel] > 0
    ? ((1 - report.summary.cost[modelALabel] / report.summary.cost[modelBLabel]) * 100).toFixed(0)
    : 0;
  console.log(`  ${modelALabel} is ${savings}% cheaper per compose call`);

  console.log(`\n${'='.repeat(70)}`);

  // Show individual case results with SMS text for comparison
  console.log('\nSIDE-BY-SIDE RESPONSES:\n');
  for (const c of report.cases) {
    if (c.error) {
      console.log(`${c.id}: ERROR — ${c.error}\n`);
      continue;
    }
    console.log(`--- ${c.id}: ${c.description} ---`);
    console.log(`Preference: ${c.preference.winner} (${c.preference.confidence}) — ${c.preference.detail}`);
    console.log(`\n  [${modelALabel}]:`);
    console.log(`  ${(c.model_a_sms || '').replace(/\n/g, '\n  ')}`);
    console.log(`  (${(c.model_a_sms || '').length} chars, ${(c.model_a_picks || []).length} picks)`);
    console.log(`\n  [${modelBLabel}]:`);
    console.log(`  ${(c.model_b_sms || '').replace(/\n/g, '\n  ')}`);
    console.log(`  (${(c.model_b_sms || '').length} chars, ${(c.model_b_picks || []).length} picks)\n`);
  }

  // Save report
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(reportsDir, `ab-eval-${modelALabel}-vs-${modelBLabel}-${now}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
