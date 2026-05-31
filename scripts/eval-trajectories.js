/**
 * eval-trajectories.js — Replay-based trajectory eval over data/traces/*.jsonl
 *
 * Trajectory eval is the complement to output-text eval: instead of asking
 * "did the SMS look right?" it asks "did the agent take a healthy *path*
 * to get there?". Uses trace.stateHistory (added in PR #2) so it works on
 * data we already have on disk — no LLM calls, no money, ~instant.
 *
 * Two failure-class checks, each motivated by a real production failure:
 *
 *   1. no_silent_fallback — would have caught the silent Sonnet 4.6 ID drift
 *      bug (stale date-pinned model 404'd, Gemini fallback silently masked).
 *      Flags: (a) stateHistory contains 'fallback_model' state, or
 *             (b) brain_provider != expected provider.
 *
 *   2. preempt_latency — would catch a regression where the pre-empt SMS
 *      slips past its user-perception budget. Time-to-first-response is
 *      approximately sum of stateHistory ms from entry through agent.
 *      Budget: 4000ms (Sonnet typical ~2-3s; gives headroom).
 *
 * Pre-PR#2 traces (no stateHistory) are skipped, not failed.
 *
 * Usage:
 *   npm run eval:trajectories                       # all trace files
 *   node scripts/eval-trajectories.js --since 2026-05-28   # only since date
 *
 * Exit code: 0 if no failures, 1 if any check failed.
 */

const fs = require('fs');
const path = require('path');

const TRACES_DIR = path.join(__dirname, '..', 'data', 'traces');
const EXPECTED_BRAIN_PROVIDER = process.env.PULSE_EVAL_EXPECTED_PROVIDER || 'anthropic';
const PREEMPT_BUDGET_MS = parseInt(process.env.PULSE_EVAL_PREEMPT_BUDGET_MS || '4000', 10);

// --- arg parsing ---
const args = process.argv.slice(2);
const sinceIdx = args.indexOf('--since');
const sinceDate = sinceIdx >= 0 ? args[sinceIdx + 1] : null; // YYYY-MM-DD

// --- trace loading ---
function loadTraces() {
  if (!fs.existsSync(TRACES_DIR)) {
    console.error(`No traces directory at ${TRACES_DIR}`);
    process.exit(2);
  }
  const files = fs.readdirSync(TRACES_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .filter(f => !sinceDate || f >= `traces-${sinceDate}.jsonl`)
    .sort();
  const traces = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(TRACES_DIR, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const t = JSON.parse(line);
        t._file = file;
        traces.push(t);
      } catch (_) { /* skip malformed line */ }
    }
  }
  return traces;
}

function hasGraphSupport(t) {
  return Array.isArray(t.stateHistory) && t.stateHistory.length > 0;
}

// --- checks: each returns array of {msg} violations (empty = pass) ---

function checkNoSilentFallback(t) {
  const violations = [];
  if (t.stateHistory.some(s => s.state === 'fallback_model')) {
    violations.push({ msg: `stateHistory contains 'fallback_model' state` });
  }
  if (t.brain_provider && t.brain_provider !== EXPECTED_BRAIN_PROVIDER) {
    violations.push({ msg: `brain_provider='${t.brain_provider}' (expected '${EXPECTED_BRAIN_PROVIDER}')` });
  }
  return violations;
}

function checkPreemptLatency(t) {
  // Only applies when pre-empt actually fired
  if (!t.preempt || !t.preempt.fired) return [];
  let cumulative = 0;
  for (const step of t.stateHistory) {
    cumulative += step.ms || 0;
    if (step.state === 'agent') break;
  }
  if (cumulative > PREEMPT_BUDGET_MS) {
    return [{ msg: `time-to-first-response ${cumulative}ms > ${PREEMPT_BUDGET_MS}ms budget` }];
  }
  return [];
}

const CHECKS = [
  { name: 'no_silent_fallback', fn: checkNoSilentFallback },
  { name: 'preempt_latency',    fn: checkPreemptLatency },
];

// --- main ---

(function main() {
  const traces = loadTraces();
  console.log(`Loaded ${traces.length} traces from ${TRACES_DIR}${sinceDate ? ` (since ${sinceDate})` : ''}`);
  console.log(`Expected brain provider: ${EXPECTED_BRAIN_PROVIDER}`);
  console.log(`Pre-empt budget: ${PREEMPT_BUDGET_MS}ms`);
  console.log('');

  let passed = 0;
  let skipped = 0;
  const failures = [];
  const checkCounts = Object.fromEntries(CHECKS.map(c => [c.name, 0]));

  for (const t of traces) {
    if (!hasGraphSupport(t)) {
      skipped++;
      continue;
    }
    const violations = [];
    for (const check of CHECKS) {
      const v = check.fn(t);
      for (const item of v) {
        violations.push({ check: check.name, msg: item.msg });
        checkCounts[check.name]++;
      }
    }
    if (violations.length === 0) {
      passed++;
    } else {
      failures.push({
        id: t.id,
        file: t._file,
        input: (t.input_message || '').slice(0, 60),
        violations,
      });
    }
  }

  const evaluated = passed + failures.length;
  console.log(`Evaluated: ${evaluated} (skipped ${skipped} pre-graph traces)`);
  console.log(`  ${passed} pass / ${failures.length} fail`);
  for (const [name, count] of Object.entries(checkCounts)) {
    if (count > 0) console.log(`    ${name}: ${count} violation${count === 1 ? '' : 's'}`);
  }
  console.log('');

  if (failures.length > 0) {
    console.log('Failures (up to 30 shown):');
    for (const f of failures.slice(0, 30)) {
      console.log(`  [${f.file}] ${(f.id || '').slice(0, 8)}  input="${f.input}"`);
      for (const v of f.violations) {
        console.log(`      ✗ ${v.check}: ${v.msg}`);
      }
    }
    if (failures.length > 30) {
      console.log(`  ... and ${failures.length - 30} more`);
    }
    process.exit(1);
  }

  console.log('✓ All trajectory checks passed');
  process.exit(0);
})();
