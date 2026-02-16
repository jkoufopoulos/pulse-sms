#!/usr/bin/env node
/**
 * Judge alignment — compares LLM judge verdicts against human annotations.
 * Run after ~50+ human annotations exist.
 *
 * Usage: node scripts/judge-alignment.js [--url http://localhost:3000]
 */

require('dotenv').config();

const { runJudgeEvals } = require('../src/evals/judge-evals');

const BASE = process.argv.find(a => a.startsWith('--url='))?.split('=')[1] || 'http://localhost:3000';

async function main() {
  // Fetch annotated traces
  console.log(`Fetching annotated traces from ${BASE}...`);
  const res = await fetch(`${BASE}/api/eval/traces?limit=200`);
  const traces = await res.json();
  const annotated = traces.filter(t => t.annotation?.verdict);

  if (annotated.length < 10) {
    console.log(`Only ${annotated.length} annotated traces found. Need at least 10 for meaningful alignment.`);
    process.exit(0);
  }

  console.log(`Found ${annotated.length} annotated traces. Running judges...\n`);

  const results = { judge_tone: { tp: 0, tn: 0, fp: 0, fn: 0 }, judge_pick_relevance: { tp: 0, tn: 0, fp: 0, fn: 0 } };

  for (const trace of annotated) {
    const humanPass = trace.annotation.verdict === 'pass';
    const judgeResults = await runJudgeEvals(trace);

    for (const jr of judgeResults) {
      const r = results[jr.name];
      if (!r) continue;
      if (jr.pass && humanPass) r.tp++;
      else if (!jr.pass && !humanPass) r.tn++;
      else if (jr.pass && !humanPass) r.fp++;
      else r.fn++;
    }

    process.stdout.write('.');
  }

  console.log('\n\n=== Judge Alignment Report ===\n');

  for (const [judge, r] of Object.entries(results)) {
    const total = r.tp + r.tn + r.fp + r.fn;
    const tpr = total > 0 && (r.tp + r.fn) > 0 ? r.tp / (r.tp + r.fn) : 0;
    const tnr = total > 0 && (r.tn + r.fp) > 0 ? r.tn / (r.tn + r.fp) : 0;
    const accuracy = total > 0 ? (r.tp + r.tn) / total : 0;

    console.log(`${judge}:`);
    console.log(`  TP=${r.tp} TN=${r.tn} FP=${r.fp} FN=${r.fn}`);
    console.log(`  TPR (sensitivity): ${(tpr * 100).toFixed(1)}%  (target: >80%)`);
    console.log(`  TNR (specificity): ${(tnr * 100).toFixed(1)}%  (target: >90%)`);
    console.log(`  Accuracy: ${(accuracy * 100).toFixed(1)}%`);
    console.log(`  ${tpr > 0.8 && tnr > 0.9 ? 'ALIGNED' : 'NEEDS TUNING'}`);
    console.log();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
