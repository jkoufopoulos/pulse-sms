#!/usr/bin/env node
/**
 * Eval runner — runs synthetic cases through the live pipeline.
 *
 * Usage:
 *   node scripts/run-evals.js                   # Run all cases
 *   node scripts/run-evals.js --tag bushwick     # Filter by tag
 *   node scripts/run-evals.js --judges           # Include LLM judges
 *   node scripts/run-evals.js --url http://...   # Custom server URL
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runCodeEvals } = require('../src/evals/code-evals');
const { runExpectationEvals } = require('../src/evals/expectation-evals');

const args = process.argv.slice(2);
const tagFilter = args.find(a => a.startsWith('--tag='))?.split('=')[1]
  || (args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null);
const useJudges = args.includes('--judges');
const BASE = args.find(a => a.startsWith('--url='))?.split('=')[1] || 'http://localhost:3000';

async function main() {
  // Load synthetic cases
  const casesPath = path.join(__dirname, '..', 'data', 'fixtures', 'synthetic-cases.json');
  if (!fs.existsSync(casesPath)) {
    console.error('No synthetic cases found. Run: node scripts/gen-synthetic.js');
    process.exit(1);
  }
  let cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

  if (tagFilter) {
    cases = cases.filter(c => c.tags.includes(tagFilter));
    console.log(`Filtered to ${cases.length} cases with tag "${tagFilter}"`);
  }

  if (cases.length === 0) {
    console.log('No cases to run.');
    process.exit(0);
  }

  let runJudgeEvals = null;
  if (useJudges) {
    runJudgeEvals = require('../src/evals/judge-evals').runJudgeEvals;
    console.log('LLM judges enabled.\n');
  }

  console.log(`Running ${cases.length} cases against ${BASE}...\n`);

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    total: cases.length,
    passed: 0,
    failed: 0,
    errors: 0,
    cases: [],
  };

  for (const testCase of cases) {
    process.stdout.write(`${testCase.id} "${testCase.message.slice(0, 40)}"... `);

    try {
      // Step 1: Reset session, then inject if test case specifies one
      await fetch(`${BASE}/api/eval/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+10000000000', session: testCase.session || null }),
      });

      // Step 2: Send message through pipeline
      const smsRes = await fetch(`${BASE}/api/sms/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: testCase.message, From: '+10000000000' }),
      });
      const smsData = await smsRes.json();

      if (!smsRes.ok) {
        throw new Error(smsData.error || `HTTP ${smsRes.status}`);
      }

      // Step 3: Wait briefly, then fetch most recent trace
      await new Promise(r => setTimeout(r, 500));
      const tracesRes = await fetch(`${BASE}/api/eval/traces?limit=1`);
      const traces = await tracesRes.json();
      const trace = traces[0];

      if (!trace) {
        throw new Error('No trace found after sending message');
      }

      // Step 4: Run code evals
      const codeResults = runCodeEvals(trace);

      // Step 5: Run expectation evals
      const expResults = testCase.expected
        ? runExpectationEvals(trace, testCase.expected)
        : [];

      // Step 6: Optionally run judge evals
      let judgeResults = [];
      if (runJudgeEvals && trace.output_intent === 'events') {
        judgeResults = await runJudgeEvals(trace);
      }

      const allResults = [...codeResults, ...expResults, ...judgeResults];
      const allPassed = allResults.every(r => r.pass);
      const failures = allResults.filter(r => !r.pass);

      if (allPassed) {
        report.passed++;
        console.log('\x1b[32mPASS\x1b[0m');
      } else {
        report.failed++;
        console.log(`\x1b[31mFAIL\x1b[0m  ${failures.map(f => `${f.name}: ${f.detail}`).join(' | ')}`);
      }

      report.cases.push({
        id: testCase.id,
        message: testCase.message,
        pass: allPassed,
        trace_id: trace.id,
        results: allResults,
        sms_response: (smsData.messages || []).map(m => m.body).join(' | '),
      });

    } catch (err) {
      report.errors++;
      console.log(`\x1b[33mERROR\x1b[0m  ${err.message}`);
      report.cases.push({
        id: testCase.id,
        message: testCase.message,
        pass: false,
        error: err.message,
        results: [],
      });
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTAL: ${report.total}  PASS: ${report.passed}  FAIL: ${report.failed}  ERROR: ${report.errors}`);
  console.log(`Pass rate: ${((report.passed / report.total) * 100).toFixed(1)}%`);
  console.log(`${'='.repeat(60)}`);

  // Failure breakdown
  const failureCounts = {};
  for (const c of report.cases) {
    for (const r of (c.results || [])) {
      if (!r.pass) {
        failureCounts[r.name] = (failureCounts[r.name] || 0) + 1;
      }
    }
  }
  if (Object.keys(failureCounts).length > 0) {
    console.log('\nFailure breakdown:');
    for (const [name, count] of Object.entries(failureCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${count}`);
    }
  }

  // Save report
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(reportsDir, `eval-${now}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);

  process.exit(report.failed + report.errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
