# Scraper Failure Resilience Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-disable sources after 7 consecutive failures, probe them daily for recovery, and send graduated alert emails (yellow/red) based on severity.

**Architecture:** Extend `source-health.js` with disable/recovery logic (3 new fields, 2 new exports). Wire skip logic into `events.js` fetch loops. Add `sendGraduatedAlert` to `alerts.js`, called from digest generation in `events.js`. Remove dead `alertOnFailingSources`.

**Tech Stack:** Node.js, existing Resend email integration, existing `check()` test helper.

---

### Task 1: Auto-disable + auto-recovery in source-health.js

**Files:**
- Modify: `src/source-health.js:7-8` (new constants)
- Modify: `src/source-health.js:11-24` (new fields in `makeHealthEntry`)
- Modify: `src/source-health.js:79-106` (disable/recovery logic in `updateSourceHealth`)
- Modify: `src/source-health.js:112-121` (remove `alertOnFailingSources`)
- Modify: `src/source-health.js:199-210` (new exports, remove old export)
- Test: `test/unit/source-health-disable.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/source-health-disable.test.js`:

```javascript
const { check } = require('../helpers');

const { sourceHealth, makeHealthEntry, updateSourceHealth, isSourceDisabled, shouldProbeDisabled } = require('../../src/source-health');

console.log('\nauto-disable after 7 consecutive zeros:');

// --- Auto-disable at threshold ---
sourceHealth['TestDisable'] = makeHealthEntry();
for (let i = 0; i < 7; i++) {
  updateSourceHealth('TestDisable', { events: [], durationMs: 100, status: 'ok', error: null });
}
check('disabled after 7 consecutive zeros', sourceHealth['TestDisable'].disabled === true);
check('disabledAt is set', sourceHealth['TestDisable'].disabledAt !== null);
check('isSourceDisabled returns true', isSourceDisabled('TestDisable') === true);

// --- Not disabled at 6 ---
sourceHealth['TestNotYet'] = makeHealthEntry();
for (let i = 0; i < 6; i++) {
  updateSourceHealth('TestNotYet', { events: [], durationMs: 100, status: 'ok', error: null });
}
check('not disabled at 6 zeros', sourceHealth['TestNotYet'].disabled === false);
check('isSourceDisabled returns false', isSourceDisabled('TestNotYet') === false);

// --- Auto-recovery ---
console.log('\nauto-recovery:');
sourceHealth['TestRecover'] = makeHealthEntry();
for (let i = 0; i < 7; i++) {
  updateSourceHealth('TestRecover', { events: [], durationMs: 100, status: 'ok', error: null });
}
check('disabled before recovery', sourceHealth['TestRecover'].disabled === true);

updateSourceHealth('TestRecover', {
  events: [{ name: 'E', venue_name: 'V', date_local: '2026-03-13' }],
  durationMs: 100, status: 'ok', error: null,
});
check('recovered after successful scrape', sourceHealth['TestRecover'].disabled === false);
check('disabledAt cleared', sourceHealth['TestRecover'].disabledAt === null);
check('consecutiveZeros reset', sourceHealth['TestRecover'].consecutiveZeros === 0);

// --- shouldProbeDisabled ---
console.log('\nshouldProbeDisabled:');
sourceHealth['TestProbe'] = makeHealthEntry();
sourceHealth['TestProbe'].disabled = true;
sourceHealth['TestProbe'].disabledAt = new Date().toISOString();
sourceHealth['TestProbe'].lastProbeAt = null;
check('should probe: never probed', shouldProbeDisabled('TestProbe') === true);

sourceHealth['TestProbe'].lastProbeAt = new Date().toISOString();
check('should not probe: just probed', shouldProbeDisabled('TestProbe') === false);

sourceHealth['TestProbe'].lastProbeAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
check('should probe: probed >24h ago', shouldProbeDisabled('TestProbe') === true);

// Not disabled = no probe needed
sourceHealth['TestProbeOk'] = makeHealthEntry();
check('should not probe: not disabled', shouldProbeDisabled('TestProbeOk') === false);

// Unknown source
check('should not probe: unknown source', shouldProbeDisabled('NonExistent') === false);

// Clean up
for (const k of ['TestDisable', 'TestNotYet', 'TestRecover', 'TestProbe', 'TestProbeOk']) {
  delete sourceHealth[k];
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/source-health-disable.test.js`
Expected: FAIL — `isSourceDisabled` and `shouldProbeDisabled` are not exported yet.

- [ ] **Step 3: Add new fields to makeHealthEntry**

In `src/source-health.js`, update `makeHealthEntry()` to add:

```javascript
disabled: false,
disabledAt: null,
lastProbeAt: null,
```

- [ ] **Step 4: Add AUTO_DISABLE_THRESHOLD constant**

In `src/source-health.js` line 8, after `HISTORY_MAX`:

```javascript
const AUTO_DISABLE_THRESHOLD = 7;
```

- [ ] **Step 5: Add disable/recovery logic to updateSourceHealth**

In `src/source-health.js`, in the `updateSourceHealth` function, after the existing `consecutiveZeros` logic (lines 90-97), add auto-disable:

```javascript
// Auto-disable after sustained failures
if (health.consecutiveZeros >= AUTO_DISABLE_THRESHOLD && !health.disabled) {
  health.disabled = true;
  health.disabledAt = new Date().toISOString();
  console.warn(`[HEALTH] ${label} auto-disabled after ${health.consecutiveZeros} consecutive failures`);
}
```

And in the `events.length > 0` branch (after line 92 `health.consecutiveZeros = 0`), add auto-recovery:

```javascript
if (health.disabled) {
  console.log(`[HEALTH] ${label} auto-recovered — ${events.length} events returned`);
  health.disabled = false;
  health.disabledAt = null;
}
```

- [ ] **Step 6: Add isSourceDisabled and shouldProbeDisabled exports**

After `getHealthStatus` function, add:

```javascript
const PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isSourceDisabled(label) {
  return sourceHealth[label]?.disabled === true;
}

function shouldProbeDisabled(label) {
  const health = sourceHealth[label];
  if (!health || !health.disabled) return false;
  if (!health.lastProbeAt) return true;
  return Date.now() - new Date(health.lastProbeAt).getTime() > PROBE_INTERVAL_MS;
}
```

- [ ] **Step 7: Remove alertOnFailingSources, update exports**

Remove the `alertOnFailingSources` function (lines 112-121). Remove `sendHealthAlert` import at line 4. Update `module.exports`:

```javascript
module.exports = {
  sourceHealth,
  makeHealthEntry,
  saveHealthData,
  updateSourceHealth,
  updateScrapeStats,
  computeEventMix,
  getHealthStatus,
  computeFieldCoverage,
  isSourceDisabled,
  shouldProbeDisabled,
  HEALTH_WARN_THRESHOLD,
  AUTO_DISABLE_THRESHOLD,
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node test/unit/source-health-disable.test.js`
Expected: All PASS.

Run: `npm test`
Expected: All existing tests still pass (no regressions from removing `alertOnFailingSources`).

- [ ] **Step 9: Commit**

```bash
git add src/source-health.js test/unit/source-health-disable.test.js
git commit -m "feat: auto-disable sources after 7 consecutive failures with auto-recovery"
```

---

### Task 2: Skip disabled sources in events.js

**Files:**
- Modify: `src/events.js:4` (add new imports)
- Modify: `src/events.js:456-458` (filter disabled from fetch in refreshCache)
- Modify: `src/events.js:477-484` (handle disabled in merge loop)
- Modify: `src/events.js:718-719` (filter disabled from email poll)

- [ ] **Step 1: Add imports in events.js**

At line 4, add `isSourceDisabled` and `shouldProbeDisabled` to the destructured import from `./source-health`:

```javascript
const { sourceHealth, saveHealthData, updateSourceHealth, updateScrapeStats, computeEventMix, getHealthStatus: _getHealthStatus, isSourceDisabled, shouldProbeDisabled } = require('./source-health');
```

- [ ] **Step 2: Add disabled skip + probe logic in refreshCache**

The current flow fetches ALL sources via `Promise.allSettled(SOURCES.map(...))`, then iterates in `MERGE_ORDER`. The cleanest integration point is in the `MERGE_ORDER` loop (line 477), right before `updateSourceHealth`. This way disabled sources still get fetched (they're in the `Promise.allSettled` batch) but we can skip them or mark them as probes.

Actually, better: filter disabled sources OUT of the fetch array to avoid wasting HTTP calls, but still track them. Replace lines 456-459:

```javascript
// Determine which sources to skip (disabled, not due for probe)
const disabledSkipped = new Set();
const disabledProbing = new Set();
for (const s of SOURCES) {
  if (isSourceDisabled(s.label)) {
    if (shouldProbeDisabled(s.label)) {
      disabledProbing.add(s.label);
    } else {
      disabledSkipped.add(s.label);
    }
  }
}

if (disabledSkipped.size > 0) {
  console.log(`[HEALTH] Skipping ${disabledSkipped.size} disabled source(s): ${[...disabledSkipped].join(', ')}`);
}
if (disabledProbing.size > 0) {
  console.log(`[HEALTH] Probing ${disabledProbing.size} disabled source(s): ${[...disabledProbing].join(', ')}`);
}

const activeSources = SOURCES.filter(s => !disabledSkipped.has(s.label));

// SOURCES drives the fetch array — no positional coupling
const fetchResults = await Promise.allSettled(
  activeSources.map(s => timedFetch(s.fetch, s.label, s.weight)),
);
```

Then update the fetchMap construction (lines 464-471) to use `activeSources`:

```javascript
// Map fetch results back to labels — activeSources[i] corresponds to fetchResults[i]
const fetchMap = {};
for (let i = 0; i < activeSources.length; i++) {
  const settled = fetchResults[i];
  fetchMap[activeSources[i].label] = settled.status === 'fulfilled'
    ? settled.value
    : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message || 'unknown' };
}
```

And in the MERGE_ORDER loop (line 477), skip sources not in fetchMap and update probe timestamp:

```javascript
for (const label of MERGE_ORDER) {
  if (disabledSkipped.has(label)) continue; // skipped entirely
  const result = fetchMap[label];
  if (!result) continue; // not fetched (shouldn't happen, but defensive)
  totalRaw += result.events.length;

  // Update probe timestamp for disabled sources being probed
  if (disabledProbing.has(label)) {
    sourceHealth[label].lastProbeAt = new Date().toISOString();
  }

  // Record health BEFORE baseline check (so history accumulates)
  updateSourceHealth(label, result);
```

- [ ] **Step 3: Add disabled skip + probe logic in refreshEmailSources**

In the email poll (lines 714-720), filter disabled sources the same way:

```javascript
const activeEmailSources = EMAIL_SOURCES.filter(s => {
  if (!isSourceDisabled(s.label)) return true;
  if (shouldProbeDisabled(s.label)) {
    console.log(`[EMAIL-POLL] Probing disabled source: ${s.label}`);
    return true;
  }
  console.log(`[EMAIL-POLL] Skipping disabled source: ${s.label}`);
  return false;
});

const fetchResults = await Promise.allSettled(
  activeEmailSources.map(s => timedFetch(s.fetch, s.label, s.weight)),
);
```

And update the loop index (line 725) to use `activeEmailSources`:

```javascript
for (let i = 0; i < activeEmailSources.length; i++) {
  const label = activeEmailSources[i].label;
```

Also update the probe timestamp after `updateSourceHealth`:

```javascript
// Update health tracking
updateSourceHealth(label, result);
if (isSourceDisabled(label)) {
  sourceHealth[label].lastProbeAt = new Date().toISOString();
}
```

Wait — there's a subtlety. If the source was disabled before this poll but `updateSourceHealth` just recovered it (events > 0), the `isSourceDisabled` check after will be false. That's correct — no probe timestamp needed for a recovered source. But if it's still disabled (probe returned 0 events), we do need the timestamp. Let me fix: check disabled state BEFORE the update, then set probe timestamp if it was probing:

```javascript
const wasProbing = disabledProbing?.has?.(label); // use a set like refreshCache
updateSourceHealth(label, result);
if (wasProbing && isSourceDisabled(label)) {
  sourceHealth[label].lastProbeAt = new Date().toISOString();
}
```

Actually, simpler: just build the probing set before the fetch, same pattern as refreshCache. Let me revise the email poll approach to be consistent:

Before the `Promise.allSettled`:

```javascript
const emailDisabledProbing = new Set();
const activeEmailSources = EMAIL_SOURCES.filter(s => {
  if (!isSourceDisabled(s.label)) return true;
  if (shouldProbeDisabled(s.label)) {
    emailDisabledProbing.add(s.label);
    console.log(`[EMAIL-POLL] Probing disabled source: ${s.label}`);
    return true;
  }
  console.log(`[EMAIL-POLL] Skipping disabled source: ${s.label}`);
  return false;
});
```

Then after `updateSourceHealth` in the loop:

```javascript
if (emailDisabledProbing.has(label)) {
  sourceHealth[label].lastProbeAt = new Date().toISOString();
}
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All pass. No unit test specifically exercises the events.js wiring (it requires network), but smoke tests should not break.

- [ ] **Step 5: Commit**

```bash
git add src/events.js
git commit -m "feat: skip disabled sources in scrape, probe daily for recovery"
```

---

### Task 3: Graduated alerting

**Files:**
- Modify: `src/alerts.js` (add `sendGraduatedAlert`)
- Modify: `src/events.js:641-658` (call graduated alert from digest generation)
- Modify: `src/daily-digest.js:86-106` (add disabled source count to source data)
- Test: `test/unit/graduated-alert.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/graduated-alert.test.js`:

```javascript
const { check } = require('../helpers');
const { computeDigestStatus } = require('../../src/daily-digest');

console.log('\ngraduated alert severity:');

// Green — no alert
check('green: no issues', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 0, userFacingErrors: 0, latencyP95: 1000,
}) === 'green');

// Yellow — 1-2 sources
check('yellow: 1 source below', computeDigestStatus({
  sourcesBelow: ['Skint'], cacheDrop: 5, userFacingErrors: 0, latencyP95: 1000,
}) === 'yellow');

// Yellow — cache drop 25%
check('yellow: cache drop 25%', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 25, userFacingErrors: 0, latencyP95: 1000,
}) === 'yellow');

// Red — >5 sources
check('red: 6 sources below', computeDigestStatus({
  sourcesBelow: ['A', 'B', 'C', 'D', 'E', 'F'], cacheDrop: 0, userFacingErrors: 0, latencyP95: 1000,
}) === 'red');

// Red — cache drop 50%
check('red: cache drop 50%', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 50, userFacingErrors: 0, latencyP95: 1000,
}) === 'red');

// Red — user-facing errors
check('red: user-facing errors', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 0, userFacingErrors: 2, latencyP95: 1000,
}) === 'red');
```

- [ ] **Step 2: Run test — should pass already**

Run: `node test/unit/graduated-alert.test.js`
Expected: All PASS — `computeDigestStatus` already has this logic. This test documents the existing behavior as a safety net.

- [ ] **Step 3: Add sendGraduatedAlert to alerts.js**

Add after the `sendDigestEmail` function:

```javascript
async function sendGraduatedAlert(digest) {
  if (digest.status === 'green') return;

  const severity = digest.status; // 'yellow' or 'red'
  const prefix = severity === 'red' ? 'ACTION REQUIRED' : 'Needs attention';
  const subject = `Pulse: ${prefix} — ${digest.needs_attention.length} source issue(s)`;

  const lines = [];
  lines.push(`Severity: ${severity.toUpperCase()}`);
  lines.push(`Date: ${digest.id}`);
  lines.push('');

  if (digest.needs_attention.length > 0) {
    for (const item of digest.needs_attention) {
      const marker = item.severity === 'warn' ? '!' : 'i';
      lines.push(`  [${marker}] ${item.source}: ${item.issue}`);
    }
    lines.push('');
  }

  lines.push(`Cache: ${digest.cache.total} events (${digest.cache.change_pct > 0 ? '+' : ''}${digest.cache.change_pct}% vs yesterday)`);

  if (severity === 'red') {
    lines.push('');
    lines.push('Recommended: check source health dashboard at /health');
  }

  const body = lines.join('\n');

  const alertEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'graduated',
    severity,
    subject,
    details: {
      status: digest.status,
      needs_attention: digest.needs_attention,
      cache_total: digest.cache.total,
      cache_change_pct: digest.cache.change_pct,
    },
    emailSent: false,
    emailError: null,
  };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    alertEntry.emailError = 'RESEND_API_KEY not set';
    logAlert(alertEntry);
    console.warn(`[ALERT] Graduated alert (${severity}) logged without email`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Pulse Alerts <onboarding@resend.dev>',
        to: ALERT_EMAIL,
        subject,
        text: body,
      }),
    });

    if (res.ok) {
      alertEntry.emailSent = true;
      console.log(`[ALERT] Graduated alert (${severity}) sent to ${ALERT_EMAIL}`);
    } else {
      const err = await res.text();
      alertEntry.emailError = `${res.status} ${err}`;
      console.error(`[ALERT] Resend API error: ${res.status} ${err}`);
    }
  } catch (err) {
    alertEntry.emailError = err.message;
    console.error(`[ALERT] Graduated alert send failed:`, err.message);
  }

  logAlert(alertEntry);
}
```

Export it: add `sendGraduatedAlert` to `module.exports`.

- [ ] **Step 4: Add disabled sources to digest needs_attention**

In `src/daily-digest.js`, in the `buildNeedsAttention` function, after the existing loop body (inside the `for (const s of sourceData)` loop), add a check for disabled sources. First, update `generateDigest` to include `isDisabled` in sourceData.

In `generateDigest`, update the `SOURCE_LABELS.map` (line 86) to include disabled status:

```javascript
const { isSourceDisabled } = require('./source-health');
```

Add to the return object in the map (after `...expectations`):

```javascript
isDisabled: isSourceDisabled(label),
```

Then in `buildNeedsAttention`, add after the existing loop:

```javascript
// Disabled sources always get flagged
if (s.isDisabled) {
  items.push({
    source: s.name,
    issue: `auto-disabled (${sourceHealth[s.name]?.consecutiveZeros || '?'} consecutive failures)`,
    severity: 'warn',
  });
}
```

Wait — `buildNeedsAttention` doesn't have access to `sourceHealth`. Simpler: just include the consecutive zeros in the sourceData. Add to the map:

```javascript
consecutiveZeros: health?.consecutiveZeros || 0,
```

Then in `buildNeedsAttention`:

```javascript
if (s.isDisabled && !items.some(i => i.source === s.name)) {
  items.push({
    source: s.name,
    issue: `auto-disabled (${s.consecutiveZeros} consecutive failures)`,
    severity: 'warn',
  });
}
```

- [ ] **Step 5: Wire graduated alert into events.js digest generation**

In `src/events.js` around line 653, after `sendDigestEmail`, add:

```javascript
// Graduated alert: separate from digest email, escalated subject line for yellow/red
const { sendGraduatedAlert } = require('./alerts');
sendGraduatedAlert(digest).catch(err =>
  console.error('[ALERT] Graduated alert failed:', err.message)
);
```

Actually, the digest email already only sends on non-green. The graduated alert serves the same purpose with a different subject line / format. These would double up. Better: **replace** the `sendDigestEmail` call with `sendGraduatedAlert` for non-green digests. Keep `sendDigestEmail` for green (informational daily summary).

Revised: In `events.js` lines 653-658, change to:

```javascript
if (digest.status !== 'green') {
  const { sendGraduatedAlert } = require('./alerts');
  sendGraduatedAlert(digest).catch(err =>
    console.error('[ALERT] Graduated alert failed:', err.message)
  );
} else {
  const { sendDigestEmail } = require('./alerts');
  sendDigestEmail(digest).catch(err =>
    console.error('[DIGEST] Email failed:', err.message)
  );
}
```

Wait — actually the current code only sends digest email on non-green. Green gets no email. Let's keep that behavior and just replace the non-green path:

```javascript
if (digest.status !== 'green') {
  const { sendGraduatedAlert } = require('./alerts');
  sendGraduatedAlert(digest).catch(err =>
    console.error('[ALERT] Graduated alert failed:', err.message)
  );
}
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass.

Run: `node test/unit/graduated-alert.test.js`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/alerts.js src/daily-digest.js src/events.js test/unit/graduated-alert.test.js
git commit -m "feat: graduated alerting — yellow/red severity emails from digest"
```

---

### Task 4: Remove dead code + wire into test runner

**Files:**
- Modify: `test/run-all.js` (add new test files)
- Modify: `src/source-health.js` (verify `alertOnFailingSources` removed — should be done in Task 1)

- [ ] **Step 1: Add new test files to run-all.js**

Read `test/run-all.js` to find the pattern, then add the two new test files.

- [ ] **Step 2: Verify alertOnFailingSources is fully removed**

Grep for any remaining references to `alertOnFailingSources` outside of docs/plans. If found in any source file, remove.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All pass including new tests.

- [ ] **Step 4: Commit**

```bash
git add test/run-all.js
git commit -m "chore: add auto-disable and graduated alert tests to runner"
```

---

### Task 5: Update ROADMAP.md

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Mark completed items in Phase 11**

Check off the completed items in the Phase 11 section:

```markdown
- [x] Source health scoring: rolling 7-day health per source (event count trend, extraction confidence avg, consecutive failures)
- [x] Auto-disable after 7 consecutive failures
- [x] Graduated alerting: yellow at 20% drop, red at 50% drop
- [ ] Complete scrape resilience plan: volatile baseline (median not mean) for Yutori/NonsenseNYC, duplicate spike tolerance for multi-show venues
```

Note: The volatile baseline and duplicate spike tolerance are already implemented (in `scrape-guard.js`), so check that off too:

```markdown
- [x] Complete scrape resilience plan: volatile baseline (median not mean) for Yutori/NonsenseNYC, duplicate spike tolerance for multi-show venues
```

- [ ] **Step 2: Add to Completed Work table**

```markdown
| Scraper Failure Resilience | Mar 13 | Auto-disable after 7 consecutive failures with daily probe for recovery. Graduated alerting (yellow/red) replaces flat health emails. Dead `alertOnFailingSources` removed. |
```

- [ ] **Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark Phase 11 Story 1 (scraper failure resilience) complete"
```
