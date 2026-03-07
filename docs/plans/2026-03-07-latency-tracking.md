# Latency Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track SMS response latency end-to-end, expose percentile stats via API, wire into daily digest and health monitoring, and surface outliers in testing.

**Architecture:** `runAgentLoop` returns `elapsed_ms` and per-iteration timing. A new `computeLatencyStats()` function in `traces.js` computes p50/p95/p99/max from the ring buffer. `/api/health/latency` endpoint exposes stats. Daily digest replaces the `latencyP95 = 0` placeholder with real data.

**Tech Stack:** Express (existing), traces.js ring buffer (existing), no new dependencies.

---

### Task 1: Return elapsed_ms from runAgentLoop

**Files:**
- Modify: `src/llm.js:391-470` (runAgentLoop function)
- Test: `test/unit/llm.test.js`

**Step 1: Write the failing test**

Add to `test/unit/llm.test.js`:

```js
// ---- runAgentLoop returns elapsed_ms ----
console.log('\nrunAgentLoop elapsed_ms:');

// We can't easily test the real function without API keys,
// but we can verify the return shape contract by checking
// that elapsed_ms is documented in the module exports.
// The actual timing test happens in Task 3 (traces integration).
```

No new unit test needed here -- `runAgentLoop` requires API keys. We'll verify the field flows through in Task 3's trace-level tests.

**Step 2: Add elapsed_ms to runAgentLoop return values**

In `src/llm.js`, the function already tracks `loopStart = Date.now()` at line 394. Add `elapsed_ms` to every return statement.

For the Gemini provider block, every `return` statement (lines 438, 449, 463, 470) gets `elapsed_ms: Date.now() - loopStart` added to the return object.

For the Anthropic provider block, every `return` statement (lines 496, 505, 517) gets the same.

**Step 3: Add per-iteration timing array**

Track `iterationTimings` array. Before each tool execution, record the start. After, record elapsed. Return as `iterations` in the result.

In `src/llm.js`, after the `toolCalls` declaration (line 395), add:

```js
const iterations = [];
```

In the Gemini loop body (inside `for (let i = 0; i < maxIterations; i++)`), wrap tool execution:

```js
const iterStart = Date.now();
// ... existing tool execution + sendMessage ...
iterations.push({ tool: toolName, ms: Date.now() - iterStart });
```

Same pattern for Anthropic loop. Add `iterations` to all return objects.

**Step 4: Commit**

```bash
git add src/llm.js
git commit -m "feat: return elapsed_ms and per-iteration timing from runAgentLoop"
```

---

### Task 2: Populate brain_latency_ms on trace

**Files:**
- Modify: `src/agent-loop.js:405-419` (after runAgentLoop call)
- Test: `test/unit/agent-loop.test.js`

**Step 1: Write the failing test**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- deriveIntent already tested above ----
// brain_latency_ms population is verified via integration traces.
// The field is set in handleAgentRequest after runAgentLoop returns.
```

No isolated unit test possible -- `handleAgentRequest` requires full dependency chain. Verified via scenario evals (code eval `latency_under_10s` already exists).

**Step 2: Set brain_latency_ms and brain_iterations from loopResult**

In `src/agent-loop.js`, after line 416 (`trace.brain_provider = loopResult.provider;`), add:

```js
trace.brain_latency_ms = loopResult.elapsed_ms || null;
trace.brain_iterations = loopResult.iterations || [];
```

Also set it in the fallback path (after line 502 `recordAICost`):

```js
trace.brain_latency_ms = (trace.brain_latency_ms || 0) + (fallbackResult.elapsed_ms || 0);
trace.brain_iterations = [...(trace.brain_iterations || []), ...(fallbackResult.iterations || [])];
```

**Step 3: Add brain_iterations to trace schema**

In `src/traces.js`, in `startTrace()`, after line 66 (`brain_latency_ms: null`), add:

```js
brain_iterations: [],   // per-iteration timing [{tool, ms}]
```

**Step 4: Commit**

```bash
git add src/agent-loop.js src/traces.js
git commit -m "feat: populate brain_latency_ms and per-iteration timing on traces"
```

---

### Task 3: computeLatencyStats in traces.js

**Files:**
- Modify: `src/traces.js` (new function + export)
- Test: `test/unit/traces-latency.test.js` (new file)

**Step 1: Write the failing test**

Create `test/unit/traces-latency.test.js`:

```js
const { check } = require('../helpers');

console.log('\n--- traces-latency.test.js ---');

const { computeLatencyStats } = require('../../src/traces');

// Empty traces
const empty = computeLatencyStats([]);
check('empty returns zeroes', empty.count === 0 && empty.p50 === 0 && empty.p95 === 0);

// Single trace
const single = computeLatencyStats([{ total_latency_ms: 500, brain_latency_ms: 300 }]);
check('single trace p50 = 500', single.p50 === 500);
check('single trace p95 = 500', single.p95 === 500);
check('single trace max = 500', single.max === 500);
check('single trace brain_p50 = 300', single.brain_p50 === 300);

// Multiple traces with known percentiles
const traces = [];
for (let i = 1; i <= 100; i++) {
  traces.push({ total_latency_ms: i * 100, brain_latency_ms: i * 50 });
}
const stats = computeLatencyStats(traces);
check('count is 100', stats.count === 100);
check('p50 ~ 5000', stats.p50 === 5000);
check('p95 ~ 9500', stats.p95 === 9500);
check('p99 ~ 9900', stats.p99 === 9900);
check('max = 10000', stats.max === 10000);
check('brain_p50 ~ 2500', stats.brain_p50 === 2500);
check('brain_p95 ~ 4750', stats.brain_p95 === 4750);
check('avg is reasonable', stats.avg > 4000 && stats.avg < 6000);

// Traces with missing brain_latency_ms
const partial = [
  { total_latency_ms: 1000, brain_latency_ms: null },
  { total_latency_ms: 2000, brain_latency_ms: 800 },
];
const partialStats = computeLatencyStats(partial);
check('partial brain_p50 uses available data', partialStats.brain_p50 === 800);
check('total p50 uses all traces', partialStats.p50 >= 1000);

// Outlier detection
check('has outliers array', Array.isArray(stats.outliers));
```

**Step 2: Run test to verify it fails**

```bash
node test/unit/traces-latency.test.js
```

Expected: FAIL with `computeLatencyStats is not a function`

**Step 3: Write the implementation**

Add to `src/traces.js` before `module.exports`:

```js
/**
 * Compute latency percentile stats from an array of traces.
 * @param {Array} traces - trace objects with total_latency_ms and brain_latency_ms
 * @returns {{ count, avg, p50, p95, p99, max, brain_p50, brain_p95, outliers }}
 */
function computeLatencyStats(traces) {
  const zero = { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, brain_p50: 0, brain_p95: 0, outliers: [] };
  if (!traces?.length) return zero;

  const totals = traces.map(t => t.total_latency_ms || 0).sort((a, b) => a - b);
  const brains = traces.filter(t => t.brain_latency_ms != null).map(t => t.brain_latency_ms).sort((a, b) => a - b);

  function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p / 100 * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  const p95 = percentile(totals, 95);
  const outlierThreshold = Math.max(p95 * 1.5, 8000);
  const outliers = traces
    .filter(t => (t.total_latency_ms || 0) > outlierThreshold)
    .map(t => ({
      id: t.id,
      total_ms: t.total_latency_ms,
      brain_ms: t.brain_latency_ms,
      intent: t.output_intent,
      message: (t.input_message || '').slice(0, 40),
      timestamp: t.timestamp,
    }))
    .slice(0, 10);

  return {
    count: totals.length,
    avg: Math.round(totals.reduce((a, b) => a + b, 0) / totals.length),
    p50: percentile(totals, 50),
    p95,
    p99: percentile(totals, 99),
    max: totals[totals.length - 1],
    brain_p50: percentile(brains, 50),
    brain_p95: percentile(brains, 95),
    outliers,
  };
}
```

**Step 4: Export computeLatencyStats**

Add `computeLatencyStats` to the `module.exports` object in `src/traces.js`.

**Step 5: Run test to verify it passes**

```bash
node test/unit/traces-latency.test.js
```

Expected: all checks PASS

**Step 6: Register test in run-all.js**

Add `'./unit/traces-latency.test.js'` to the test list in `test/run-all.js`.

**Step 7: Run full test suite**

```bash
npm test
```

Expected: all pass including new tests.

**Step 8: Commit**

```bash
git add src/traces.js test/unit/traces-latency.test.js test/run-all.js
git commit -m "feat: computeLatencyStats with percentiles and outlier detection"
```

---

### Task 4: /api/health/latency endpoint

**Files:**
- Modify: `src/server.js` (new route after `/api/health/costs`)

**Step 1: Add the endpoint**

In `src/server.js`, after the `/api/health/costs` route (after line 120), add:

```js
// Latency stats API -- same auth gating as /health
app.get('/api/health/latency', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;

  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { computeLatencyStats } = require('./traces');
  const traces = getRecentTraces(200);

  const nycToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayTraces = traces.filter(t => {
    if (!t.timestamp) return false;
    const traceDate = new Date(t.timestamp).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return traceDate === nycToday;
  });

  res.json({
    today: computeLatencyStats(todayTraces),
    recent: computeLatencyStats(traces),
  });
});
```

**Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: /api/health/latency endpoint with percentiles and outliers"
```

---

### Task 5: Wire latencyP95 into daily digest

**Files:**
- Modify: `src/daily-digest.js:130`
- Test: `test/unit/digest.test.js` (existing test already covers `latencyP95 > 5000 = yellow`)

**Step 1: Replace the placeholder**

In `src/daily-digest.js`, replace line 130:

```js
const latencyP95 = 0; // placeholder -- traces not easily accessible from this module
```

With:

```js
const { computeLatencyStats, getRecentTraces } = require('./traces');
const recentTraces = getRecentTraces(200);
const latencyP95 = computeLatencyStats(recentTraces).p95;
```

**Step 2: Add latency stats to the report object**

In `src/daily-digest.js`, in the `report` object (after `scrape:`), add:

```js
latency: {
  p50: computeLatencyStats(recentTraces).p50,
  p95: latencyP95,
  max: computeLatencyStats(recentTraces).max,
  outlier_count: computeLatencyStats(recentTraces).outliers.length,
},
```

Optimization: compute once. Refactor to:

```js
const { computeLatencyStats, getRecentTraces } = require('./traces');
const latencyStats = computeLatencyStats(getRecentTraces(200));
const latencyP95 = latencyStats.p95;
```

Then in the report object:

```js
latency: {
  p50: latencyStats.p50,
  p95: latencyStats.p95,
  max: latencyStats.max,
  outlier_count: latencyStats.outliers.length,
},
```

**Step 3: Add latency line to digest email**

In `formatDigestEmail`, after the scrape line block (after line 188), add:

```js
if (report.latency) {
  lines.push(`Latency: p50 ${(report.latency.p50 / 1000).toFixed(1)}s | p95 ${(report.latency.p95 / 1000).toFixed(1)}s | max ${(report.latency.max / 1000).toFixed(1)}s${report.latency.outlier_count > 0 ? ` | ${report.latency.outlier_count} outliers` : ''}`);
  lines.push('');
}
```

**Step 4: Run existing tests**

```bash
npm test
```

Expected: all pass (existing digest tests pass `latencyP95` as a param to `computeDigestStatus`, which is independent of the require).

**Step 5: Commit**

```bash
git add src/daily-digest.js
git commit -m "feat: wire real latencyP95 into daily digest, add latency section to report"
```

---

### Task 6: Add slow-request breakdown to trace

**Files:**
- Modify: `src/handler.js:210-218` (slow request log)

**Step 1: Enhance slow-request logging with brain breakdown**

In `src/handler.js`, update the `finalizeTrace` slow-request logging block to include brain latency and iteration details:

Replace the breakdown construction (lines 211-216) with:

```js
const breakdown = [
  `route: ${trace.routing.latency_ms}ms`,
  trace.brain_latency_ms != null ? `brain: ${trace.brain_latency_ms}ms` : null,
  trace.events.getEvents_ms != null ? `events: ${trace.events.getEvents_ms}ms` : null,
  `compose: ${trace.composition.latency_ms}ms`,
  `total: ${trace.total_latency_ms}ms`,
  trace.brain_iterations?.length > 1 ? `iterations: ${trace.brain_iterations.map(it => `${it.tool}:${it.ms}ms`).join(',')}` : null,
].filter(Boolean).join(' | ');
```

**Step 2: Commit**

```bash
git add src/handler.js
git commit -m "feat: include brain latency and iteration breakdown in slow-request logs"
```

---

### Task 7: Verify end-to-end

**Step 1: Run full test suite**

```bash
npm test
```

Expected: all pass.

**Step 2: Manual verification (if Railway available)**

```bash
# After deploy, check the latency endpoint
curl "https://web-production-c8fdb.up.railway.app/api/health/latency"
```

Expected: JSON with `today` and `recent` objects containing `count`, `p50`, `p95`, `p99`, `max`, `brain_p50`, `brain_p95`, `outliers`.

**Step 3: Commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: latency tracking fixups from end-to-end verification"
```
