#!/usr/bin/env node
/**
 * Compare two eval reports and surface regressions.
 *
 * Usage:
 *   node scripts/compare-eval-reports.js                    # Compare latest 2 scenario reports
 *   node scripts/compare-eval-reports.js --type regression  # Compare latest 2 regression reports
 *   node scripts/compare-eval-reports.js --threshold 5      # Alert if pass rate drops >5% (default)
 *   node scripts/compare-eval-reports.js --file1 X --file2 Y  # Compare specific files
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const reportType = args.find(a => a.startsWith('--type='))?.split('=')[1]
  || (args.includes('--type') ? args[args.indexOf('--type') + 1] : 'scenario');
const threshold = parseFloat(args.find(a => a.startsWith('--threshold='))?.split('=')[1]
  || (args.includes('--threshold') ? args[args.indexOf('--threshold') + 1] : '5'));
const file1 = args.find(a => a.startsWith('--file1='))?.split('=')[1]
  || (args.includes('--file1') ? args[args.indexOf('--file1') + 1] : null);
const file2 = args.find(a => a.startsWith('--file2='))?.split('=')[1]
  || (args.includes('--file2') ? args[args.indexOf('--file2') + 1] : null);

const REPORTS_DIR = path.join(__dirname, '../data/reports');

function findReports(prefix) {
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  return files.map(f => path.join(REPORTS_DIR, f));
}

function loadReport(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function passRate(report) {
  if (!report.total || report.total === 0) return 0;
  return ((report.passed / report.total) * 100);
}

function codeEvalRate(report) {
  const ce = report.code_evals;
  if (!ce || !ce.total) return null;
  return ((ce.passed / ce.total) * 100);
}

function categoryBreakdown(report) {
  const cats = {};
  for (const s of (report.scenarios || [])) {
    const cat = s.category || 'unknown';
    if (!cats[cat]) cats[cat] = { total: 0, passed: 0 };
    cats[cat].total++;
    if (s.pass) cats[cat].passed++;
  }
  return cats;
}

function diffBreakdown(prev, curr) {
  const allCats = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const rows = [];
  for (const cat of [...allCats].sort()) {
    const p = prev[cat] || { total: 0, passed: 0 };
    const c = curr[cat] || { total: 0, passed: 0 };
    const pRate = p.total > 0 ? (p.passed / p.total * 100) : 0;
    const cRate = c.total > 0 ? (c.passed / c.total * 100) : 0;
    const delta = cRate - pRate;
    rows.push({ cat, prevRate: pRate, currRate: cRate, delta, prevN: p.total, currN: c.total });
  }
  return rows;
}

function newFailures(prev, curr) {
  const prevFails = new Set((prev.scenarios || []).filter(s => !s.pass).map(s => s.name));
  const currFails = (curr.scenarios || []).filter(s => !s.pass).map(s => s.name);
  return currFails.filter(name => !prevFails.has(name));
}

function newPasses(prev, curr) {
  const prevPasses = new Set((prev.scenarios || []).filter(s => s.pass).map(s => s.name));
  const currPasses = (curr.scenarios || []).filter(s => s.pass).map(s => s.name);
  return currPasses.filter(name => !prevPasses.has(name));
}

// --- Main ---

let prevPath, currPath;

if (file1 && file2) {
  prevPath = file1;
  currPath = file2;
} else {
  const prefix = reportType === 'regression' ? 'regression-eval-' : 'scenario-eval-';
  const reports = findReports(prefix);
  if (reports.length < 2) {
    console.log(`Need at least 2 ${reportType} reports in data/reports/. Found ${reports.length}.`);
    process.exit(0);
  }
  prevPath = reports[reports.length - 2];
  currPath = reports[reports.length - 1];
}

const prev = loadReport(prevPath);
const curr = loadReport(currPath);

const prevRate = passRate(prev);
const currRate = passRate(curr);
const delta = currRate - prevRate;
const regressed = delta < -threshold;

console.log(`\n## Eval Comparison — ${reportType}`);
console.log(`\nPrevious: ${path.basename(prevPath)}`);
console.log(`Current:  ${path.basename(currPath)}`);
console.log(`\n### Overall`);
console.log(`  Pass rate: ${prevRate.toFixed(1)}% → ${currRate.toFixed(1)}% (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`);
console.log(`  Scenarios: ${prev.total} → ${curr.total}`);

const prevCE = codeEvalRate(prev);
const currCE = codeEvalRate(curr);
if (prevCE !== null && currCE !== null) {
  const ceDelta = currCE - prevCE;
  console.log(`  Code evals: ${prevCE.toFixed(1)}% → ${currCE.toFixed(1)}% (${ceDelta >= 0 ? '+' : ''}${ceDelta.toFixed(1)}%)`);
}

// Category breakdown
const prevCats = categoryBreakdown(prev);
const currCats = categoryBreakdown(curr);
const diff = diffBreakdown(prevCats, currCats);

console.log(`\n### By Category`);
console.log(`  ${'Category'.padEnd(20)} ${'Prev'.padStart(8)} ${'Curr'.padStart(8)} ${'Delta'.padStart(8)}`);
for (const row of diff) {
  const marker = row.delta < -threshold ? ' ⚠' : row.delta > threshold ? ' ✓' : '';
  console.log(`  ${row.cat.padEnd(20)} ${(row.prevRate.toFixed(1) + '%').padStart(8)} ${(row.currRate.toFixed(1) + '%').padStart(8)} ${((row.delta >= 0 ? '+' : '') + row.delta.toFixed(1) + '%').padStart(8)}${marker}`);
}

// New failures / new passes
const newFails = newFailures(prev, curr);
const newPass = newPasses(prev, curr);

if (newFails.length > 0) {
  console.log(`\n### New Failures (${newFails.length})`);
  for (const name of newFails.slice(0, 15)) {
    console.log(`  - ${name}`);
  }
  if (newFails.length > 15) console.log(`  ... and ${newFails.length - 15} more`);
}

if (newPass.length > 0) {
  console.log(`\n### New Passes (${newPass.length})`);
  for (const name of newPass.slice(0, 10)) {
    console.log(`  + ${name}`);
  }
  if (newPass.length > 10) console.log(`  ... and ${newPass.length - 10} more`);
}

// Code eval failures by name
if (curr.code_evals?.by_name) {
  const prevByName = prev.code_evals?.by_name || {};
  const currByName = curr.code_evals.by_name;
  const allChecks = new Set([...Object.keys(prevByName), ...Object.keys(currByName)]);
  const ceChanges = [];
  for (const check of allChecks) {
    const p = prevByName[check] || 0;
    const c = currByName[check] || 0;
    if (p !== c) ceChanges.push({ check, prev: p, curr: c, delta: c - p });
  }
  if (ceChanges.length > 0) {
    console.log(`\n### Code Eval Changes`);
    for (const ch of ceChanges.sort((a, b) => b.delta - a.delta)) {
      const marker = ch.delta > 0 ? '⚠' : '✓';
      console.log(`  ${marker} ${ch.check}: ${ch.prev} → ${ch.curr} (${ch.delta > 0 ? '+' : ''}${ch.delta})`);
    }
  }
}

console.log('');

if (regressed) {
  console.error(`\n❌ REGRESSION: pass rate dropped ${Math.abs(delta).toFixed(1)}% (threshold: ${threshold}%)\n`);
  process.exit(1);
} else if (delta > 0) {
  console.log(`✅ Improvement: +${delta.toFixed(1)}%\n`);
} else {
  console.log(`— No significant change\n`);
}
