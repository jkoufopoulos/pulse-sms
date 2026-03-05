# Scrape Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect silent data rot and structural scraper breakage at scrape time, quarantining bad sources before their events enter the cache.

**Architecture:** New `src/scrape-guard.js` module with pure-function baseline checks. Extends `source-health.js` history entries with field coverage stats. Integrates into `events.js` `refreshCache` between fetch and merge. Post-scrape audit wires existing eval checks to alerting.

**Tech Stack:** Node.js, existing source-health/alerts/eval infrastructure. No new dependencies.

---

### Task 1: Extend source-health history with field coverage

**Files:**
- Modify: `src/source-health.js:67-93` (updateSourceHealth)
- Modify: `src/source-health.js:11-22` (makeHealthEntry)
- Test: `test/unit/scrape-guard.test.js` (new)

**Step 1: Write the failing test**

Create `test/unit/scrape-guard.test.js`:

```js
const { check } = require('../helpers');

// --- updateSourceHealth stores field coverage ---
console.log('\nupdateSourceHealth field coverage:');

const { makeHealthEntry, updateSourceHealth, sourceHealth } = require('../../src/source-health');

// Inject a test source
sourceHealth['TestSource'] = makeHealthEntry();

const testEvents = [
  { name: 'Event A', venue_name: 'Venue 1', date_local: '2026-03-05' },
  { name: 'Event B', venue_name: null, date_local: '2026-03-05' },
  { name: 'Event C', venue_name: 'Venue 3', date_local: null },
  { name: null, venue_name: null, date_local: null },
];

updateSourceHealth('TestSource', { events: testEvents, durationMs: 100, status: 'ok', error: null });

const entry = sourceHealth['TestSource'].history[0];
check('history entry has fieldCoverage', !!entry.fieldCoverage);
check('name coverage is 0.75', entry.fieldCoverage.name === 0.75);
check('venue_name coverage is 0.5', entry.fieldCoverage.venue_name === 0.5);
check('date_local coverage is 0.5', entry.fieldCoverage.date_local === 0.5);

// Clean up
delete sourceHealth['TestSource'];
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/scrape-guard.test.js`
Expected: FAIL — `fieldCoverage` is undefined because history entries don't include it yet.

**Step 3: Implement field coverage in updateSourceHealth**

In `src/source-health.js`, modify `updateSourceHealth` (line 67-93). After line 88 (`health.history.push(...)`), compute field coverage from the events array and include it in the history entry:

```js
function updateSourceHealth(label, { events, durationMs, status, error }) {
  const health = sourceHealth[label];
  if (!health) return;

  const now = new Date().toISOString();
  health.lastCount = events.length;
  health.lastStatus = status;
  health.lastError = error;
  health.lastDurationMs = durationMs;
  health.lastScrapeAt = now;
  health.totalScrapes++;
  if (events.length > 0) {
    health.totalSuccesses++;
    health.consecutiveZeros = 0;
  } else {
    health.consecutiveZeros++;
    if (health.consecutiveZeros >= HEALTH_WARN_THRESHOLD) {
      console.warn(`[HEALTH] ${label} has returned 0 events for ${health.consecutiveZeros} consecutive refreshes`);
    }
  }

  // Compute field coverage for baseline comparison
  const fieldCoverage = computeFieldCoverage(events);

  // Push to history (capped at HISTORY_MAX)
  health.history.push({ timestamp: now, count: events.length, durationMs, status, fieldCoverage });
  if (health.history.length > HISTORY_MAX) {
    health.history.shift();
  }
}

function computeFieldCoverage(events) {
  if (events.length === 0) return { name: 0, venue_name: 0, date_local: 0 };
  const n = events.length;
  return {
    name: events.filter(e => !!e.name).length / n,
    venue_name: events.filter(e => !!e.venue_name).length / n,
    date_local: events.filter(e => !!e.date_local).length / n,
  };
}
```

Export `computeFieldCoverage` from the module (add to `module.exports`).

**Step 4: Run test to verify it passes**

Run: `node test/unit/scrape-guard.test.js`
Expected: PASS

**Step 5: Run existing tests**

Run: `npm test`
Expected: All existing tests still pass.

**Step 6: Commit**

```bash
git add src/source-health.js test/unit/scrape-guard.test.js
git commit -m "feat: extend source health history with field coverage stats"
```

---

### Task 2: Create scrape-guard.js with checkBaseline

**Files:**
- Create: `src/scrape-guard.js`
- Modify: `test/unit/scrape-guard.test.js`

**Step 1: Write the failing tests**

Append to `test/unit/scrape-guard.test.js`:

```js
// --- checkBaseline ---
console.log('\ncheckBaseline:');

const { checkBaseline } = require('../../src/scrape-guard');
const { sourceHealth: sh, makeHealthEntry: mkEntry } = require('../../src/source-health');

// Helper: build history with consistent counts and coverage
function buildHistory(count, entries, fieldCoverage = { name: 0.95, venue_name: 0.90, date_local: 0.85 }) {
  const history = [];
  for (let i = 0; i < entries; i++) {
    history.push({ timestamp: new Date().toISOString(), count, durationMs: 100, status: 'ok', fieldCoverage });
  }
  return history;
}

// --- Count drift ---
sh['TestGuard'] = { ...mkEntry(), history: buildHistory(100, 5) };
const countDrift = checkBaseline('TestGuard', new Array(30).fill({ name: 'E', venue_name: 'V', date_local: '2026-03-05' }));
check('count drift: quarantined (30 vs avg 100)', countDrift.quarantined === true);
check('count drift: reason mentions count', countDrift.reason.includes('count'));

sh['TestGuard'] = { ...mkEntry(), history: buildHistory(100, 5) };
const countOk = checkBaseline('TestGuard', new Array(80).fill({ name: 'E', venue_name: 'V', date_local: '2026-03-05' }));
check('count ok: not quarantined (80 vs avg 100)', countOk.quarantined === false);

// --- Field coverage drift ---
sh['TestFieldDrift'] = { ...mkEntry(), history: buildHistory(50, 5, { name: 0.95, venue_name: 0.90, date_local: 0.85 }) };
const badVenues = [];
for (let i = 0; i < 50; i++) {
  badVenues.push({ name: `Event ${i}`, venue_name: i < 15 ? 'V' : null, date_local: '2026-03-05' });
}
const fieldDrift = checkBaseline('TestFieldDrift', badVenues);
check('field drift: quarantined (venue coverage 0.30 vs avg 0.90)', fieldDrift.quarantined === true);
check('field drift: reason mentions venue_name', fieldDrift.reason.includes('venue_name'));

// --- Duplicate spike ---
sh['TestDupes'] = { ...mkEntry(), history: buildHistory(50, 5) };
const dupeEvents = new Array(50).fill({ name: 'Same Name', venue_name: 'V', date_local: '2026-03-05' });
const dupResult = checkBaseline('TestDupes', dupeEvents);
check('duplicate spike: quarantined', dupResult.quarantined === true);
check('duplicate spike: reason mentions duplicate', dupResult.reason.includes('duplicate'));

// --- Date sanity ---
sh['TestDates'] = { ...mkEntry(), history: buildHistory(50, 5, { name: 0.95, venue_name: 0.90, date_local: 0.95 }) };
const farFuture = new Array(50).fill({ name: 'E', venue_name: 'V', date_local: '2026-06-01' });
const dateResult = checkBaseline('TestDates', farFuture);
check('date sanity: quarantined (all events far future)', dateResult.quarantined === true);
check('date sanity: reason mentions date', dateResult.reason.includes('date'));

// --- Insufficient history: skip checks ---
sh['TestNewSource'] = { ...mkEntry(), history: buildHistory(50, 2) };
const newResult = checkBaseline('TestNewSource', new Array(5).fill({ name: 'E', venue_name: 'V', date_local: '2026-03-05' }));
check('new source (<3 history): not quarantined', newResult.quarantined === false);

// Clean up
for (const k of ['TestGuard', 'TestFieldDrift', 'TestDupes', 'TestDates', 'TestNewSource']) {
  delete sh[k];
}
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/scrape-guard.test.js`
Expected: FAIL — `scrape-guard.js` doesn't exist.

**Step 3: Write scrape-guard.js**

Create `src/scrape-guard.js`:

```js
const { sourceHealth } = require('./source-health');
const { getNycDateString } = require('./geo');

const MIN_HISTORY = 3;
const COUNT_DRIFT_THRESHOLD = 0.4;
const FIELD_DRIFT_THRESHOLD = 0.25;
const DATE_SANITY_THRESHOLD = 0.2;
const DATE_SANITY_BASELINE_MIN = 0.6;
const DUPLICATE_THRESHOLD = 0.5;

function getBaselineStats(label) {
  const health = sourceHealth[label];
  if (!health || health.history.length < MIN_HISTORY) return null;

  const okEntries = health.history.filter(h => h.status === 'ok' && h.count > 0);
  if (okEntries.length < MIN_HISTORY) return null;

  const avgCount = okEntries.reduce((sum, h) => sum + h.count, 0) / okEntries.length;

  const avgCoverage = { name: 0, venue_name: 0, date_local: 0 };
  let coverageEntries = 0;
  for (const h of okEntries) {
    if (h.fieldCoverage) {
      avgCoverage.name += h.fieldCoverage.name;
      avgCoverage.venue_name += h.fieldCoverage.venue_name;
      avgCoverage.date_local += h.fieldCoverage.date_local;
      coverageEntries++;
    }
  }
  if (coverageEntries > 0) {
    avgCoverage.name /= coverageEntries;
    avgCoverage.venue_name /= coverageEntries;
    avgCoverage.date_local /= coverageEntries;
  }

  return { avgCount, avgCoverage, entries: okEntries.length };
}

function checkBaseline(label, events) {
  const baseline = getBaselineStats(label);
  if (!baseline) return { quarantined: false, reason: null };

  // 1. Count drift
  if (events.length < baseline.avgCount * COUNT_DRIFT_THRESHOLD &&
      baseline.avgCount >= 10) {
    return {
      quarantined: true,
      reason: `count drift: ${events.length} events vs ${Math.round(baseline.avgCount)} avg`,
    };
  }

  if (events.length === 0) return { quarantined: false, reason: null };

  // 2. Field coverage drift
  const n = events.length;
  const fields = ['name', 'venue_name', 'date_local'];
  for (const field of fields) {
    const coverage = events.filter(e => !!e[field]).length / n;
    const avgCoverage = baseline.avgCoverage[field];
    if (avgCoverage - coverage > FIELD_DRIFT_THRESHOLD) {
      return {
        quarantined: true,
        reason: `${field} coverage drift: ${(coverage * 100).toFixed(0)}% vs ${(avgCoverage * 100).toFixed(0)}% avg`,
      };
    }
  }

  // 3. Date sanity
  const today = getNycDateString(0);
  const weekOut = getNycDateString(7);
  const datedEvents = events.filter(e => !!e.date_local);
  if (datedEvents.length > 0) {
    const nearbyPct = datedEvents.filter(e => e.date_local >= today && e.date_local <= weekOut).length / datedEvents.length;
    const avgDateCoverage = baseline.avgCoverage.date_local;
    if (nearbyPct < DATE_SANITY_THRESHOLD && avgDateCoverage >= DATE_SANITY_BASELINE_MIN) {
      return {
        quarantined: true,
        reason: `date sanity: ${(nearbyPct * 100).toFixed(0)}% events within 7 days (expected >${(DATE_SANITY_THRESHOLD * 100)}%)`,
      };
    }
  }

  // 4. Duplicate spike
  const nameCounts = {};
  for (const e of events) {
    const name = (e.name || '').toLowerCase().trim();
    if (name) nameCounts[name] = (nameCounts[name] || 0) + 1;
  }
  const maxDupes = Math.max(0, ...Object.values(nameCounts));
  if (events.length > 5 && maxDupes / events.length > DUPLICATE_THRESHOLD) {
    return {
      quarantined: true,
      reason: `duplicate spike: "${Object.entries(nameCounts).find(([_, c]) => c === maxDupes)?.[0]}" appears ${maxDupes}/${events.length} times`,
    };
  }

  return { quarantined: false, reason: null };
}

module.exports = { checkBaseline, getBaselineStats, MIN_HISTORY };
```

**Step 4: Run test to verify it passes**

Run: `node test/unit/scrape-guard.test.js`
Expected: All checks PASS.

**Step 5: Run existing tests**

Run: `npm test`
Expected: All existing tests still pass.

**Step 6: Commit**

```bash
git add src/scrape-guard.js test/unit/scrape-guard.test.js
git commit -m "feat: scrape-guard with baseline checks for count, field, date, dupe drift"
```

---

### Task 3: Integrate checkBaseline into refreshCache

**Files:**
- Modify: `src/events.js:393-418` (merge loop in refreshCache)

**Step 1: Add import at top of events.js**

At `src/events.js` line 12 (after the existing requires), add:

```js
const { checkBaseline, postScrapeAudit } = require('./scrape-guard');
```

**Step 2: Add baseline gate before merge**

Replace the merge loop at lines 397-418 with a version that gates on `checkBaseline`. The key change: after `updateSourceHealth` records the result, call `checkBaseline`. If quarantined, zero out the events before merge.

```js
    let sourcesOk = 0, sourcesFailed = 0, sourcesEmpty = 0, sourcesQuarantined = 0;
    let totalRaw = 0;

    // Merge in priority order (highest weight first, then mergeRank)
    for (const label of MERGE_ORDER) {
      const result = fetchMap[label];
      totalRaw += result.events.length;

      // Record health BEFORE baseline check (so history accumulates)
      updateSourceHealth(label, result);

      if (result.status === 'error' || result.status === 'timeout') {
        console.error(`${label} failed:`, result.error);
        sourcesFailed++;
        continue;
      }

      // Baseline gate: quarantine sources with suspicious output
      if (result.status === 'ok') {
        const verdict = checkBaseline(label, result.events);
        if (verdict.quarantined) {
          console.warn(`[SCRAPE-GUARD] Quarantined ${label}: ${verdict.reason}`);
          result.status = 'quarantined';
          result.quarantineReason = verdict.reason;
          sourcesQuarantined++;
          continue; // skip merge — cache retains yesterday's events for this source
        }
      }

      for (const e of result.events) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }

      if (result.status === 'ok') sourcesOk++;
      else if (result.status === 'empty') sourcesEmpty++;
    }

    if (sourcesQuarantined > 0) {
      console.warn(`[SCRAPE-GUARD] ${sourcesQuarantined} source(s) quarantined this scrape`);
    }
```

**Step 3: Update scrape stats to include quarantine count**

At the `updateScrapeStats` call (~line 500), add `sourcesQuarantined`:

```js
    updateScrapeStats({
      startedAt: scrapeStart.toISOString(),
      completedAt: scrapeEnd.toISOString(),
      totalDurationMs: scrapeEnd - scrapeStart,
      totalEvents: totalRaw,
      dedupedEvents: validEvents.length,
      sourcesOk,
      sourcesFailed,
      sourcesEmpty,
      sourcesQuarantined,
    });
```

**Step 4: Run existing tests**

Run: `npm test`
Expected: All tests still pass. The integration is in `refreshCache` which isn't called in unit tests.

**Step 5: Commit**

```bash
git add src/events.js
git commit -m "feat: integrate scrape-guard baseline gates into refreshCache"
```

---

### Task 4: Wire post-scrape audit with alerting

**Files:**
- Modify: `src/scrape-guard.js` (add `postScrapeAudit`)
- Modify: `src/events.js:514-534` (replace inline audit calls)
- Modify: `test/unit/scrape-guard.test.js`

**Step 1: Write the failing test**

Append to `test/unit/scrape-guard.test.js`:

```js
// --- postScrapeAudit ---
console.log('\npostScrapeAudit:');

const { postScrapeAudit } = require('../../src/scrape-guard');

// Mock fetchMap with a source that has low completeness pass rate
const mockFetchMap = {
  BAM: {
    events: [
      { id: '1', source_name: 'BAM', name: 'Show', venue_name: null, is_free: false, category: 'theater', date_local: '2026-03-05' },
      { id: '2', source_name: 'BAM', name: 'Film', venue_name: null, is_free: false, category: 'film', date_local: '2026-03-05' },
    ],
    status: 'ok',
    durationMs: 100,
    error: null,
  },
};

const auditResult = postScrapeAudit(mockFetchMap, mockFetchMap.BAM.events, {});
check('postScrapeAudit returns alerts array', Array.isArray(auditResult.alerts));
check('postScrapeAudit returns completeness results', !!auditResult.completeness);
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/scrape-guard.test.js`
Expected: FAIL — `postScrapeAudit` not yet exported.

**Step 3: Add postScrapeAudit to scrape-guard.js**

Append to `src/scrape-guard.js`, before `module.exports`:

```js
const { checkSourceCompleteness } = require('./evals/source-completeness');
const { runExtractionAudit } = require('./evals/extraction-audit');
const { sendRuntimeAlert } = require('./alerts');

const COMPLETENESS_ALERT_THRESHOLD = 0.8;
const EXTRACTION_ALERT_THRESHOLD = 0.7;

function postScrapeAudit(fetchMap, events, extractionInputs) {
  const alerts = [];

  // 1. Source field-completeness check
  let completeness = {};
  try {
    completeness = checkSourceCompleteness(fetchMap);
    for (const [label, result] of Object.entries(completeness)) {
      if (result.total === 0) continue;
      const passRate = result.passed / result.total;
      if (passRate < COMPLETENESS_ALERT_THRESHOLD) {
        const msg = `${label}: ${(passRate * 100).toFixed(0)}% completeness (${result.failed}/${result.total} failed)`;
        alerts.push({ type: 'completeness', label, passRate, message: msg });
      }
    }
  } catch (err) {
    console.error('[SCRAPE-GUARD] Source completeness check failed:', err.message);
  }

  // 2. Extraction audit (Claude-extracted sources only)
  let extraction = {};
  try {
    const report = runExtractionAudit(events, extractionInputs);
    extraction = report;
    if (report.sourceStats) {
      for (const [label, stats] of Object.entries(report.sourceStats)) {
        if (stats.total === 0) continue;
        const passRate = stats.passed / stats.total;
        if (passRate < EXTRACTION_ALERT_THRESHOLD) {
          const msg = `${label}: ${(passRate * 100).toFixed(0)}% extraction audit pass rate (${stats.total - stats.passed}/${stats.total} issues)`;
          alerts.push({ type: 'extraction', label, passRate, message: msg });
        }
      }
    }
  } catch (err) {
    console.error('[SCRAPE-GUARD] Extraction audit failed:', err.message);
  }

  // Send alerts
  if (alerts.length > 0) {
    const summary = alerts.map(a => a.message).join('\n');
    console.warn(`[SCRAPE-GUARD] Post-scrape audit found ${alerts.length} issue(s):\n${summary}`);
    sendRuntimeAlert('scrape-audit-regression', {
      issues: alerts.length,
      details: summary,
    }).catch(err => console.error('[SCRAPE-GUARD] Alert send failed:', err.message));
  }

  return { alerts, completeness, extraction };
}
```

Update `module.exports` to include `postScrapeAudit`.

**Step 4: Replace inline audit calls in events.js**

In `src/events.js`, replace lines 514-534 (the existing inline extraction audit and source completeness blocks) with a single call:

```js
    // Post-scrape audit: completeness + extraction quality checks with alerting
    try {
      const auditResult = postScrapeAudit(fetchMap, validEvents, getExtractionInputs());
      if (auditResult.extraction?.summary?.total > 0) {
        console.log(`Extraction audit: ${auditResult.extraction.summary.passed}/${auditResult.extraction.summary.total} events pass (${auditResult.extraction.summary.passRate})`);
        const reportsDir = path.join(__dirname, '../data/reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const reportFile = path.join(reportsDir, `extraction-audit-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(reportFile, JSON.stringify(auditResult.extraction, null, 2));
      }
    } catch (err) {
      console.error('Post-scrape audit failed:', err.message);
    }
```

Also remove the now-unused `runExtractionAudit` and `checkSourceCompleteness` imports from `events.js` lines 10-11 (they're now imported by `scrape-guard.js`).

**Step 5: Run tests**

Run: `node test/unit/scrape-guard.test.js && npm test`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/scrape-guard.js src/events.js test/unit/scrape-guard.test.js
git commit -m "feat: post-scrape audit with alerting, replaces inline eval calls"
```

---

### Task 5: Wire test runner and add to health dashboard

**Files:**
- Modify: `test/run-all.js`
- Modify: `src/source-health.js:150-183` (getHealthStatus)

**Step 1: Add scrape-guard tests to test runner**

In `test/run-all.js`, add after the existing requires (line 10 area):

```js
require('./unit/scrape-guard.test');
```

**Step 2: Expose quarantine status in health dashboard**

In `src/source-health.js` `getHealthStatus` (line 150), add quarantine info to each source's status output. The `lastStatus` field already covers this since we set it to `'quarantined'` in the merge loop — but add the reason. Modify `updateSourceHealth` to also store `lastQuarantineReason`:

In `makeHealthEntry` (line 11), add:
```js
lastQuarantineReason: null,
```

In `getHealthStatus` (line 153-165), add `quarantine_reason` to the source object:
```js
sources[label] = {
  status: h.lastStatus,
  last_count: h.lastCount,
  consecutive_zeros: h.consecutiveZeros,
  duration_ms: h.lastDurationMs,
  last_error: h.lastError,
  last_scrape: h.lastScrapeAt,
  quarantine_reason: h.lastQuarantineReason,
  success_rate: h.totalScrapes > 0
    ? Math.round((h.totalSuccesses / h.totalScrapes) * 100) + '%'
    : null,
  history: h.history,
};
```

Then in `events.js`, when quarantining, also update the health entry:

```js
if (verdict.quarantined) {
  console.warn(`[SCRAPE-GUARD] Quarantined ${label}: ${verdict.reason}`);
  result.status = 'quarantined';
  result.quarantineReason = verdict.reason;
  sourceHealth[label].lastStatus = 'quarantined';
  sourceHealth[label].lastQuarantineReason = verdict.reason;
  sourcesQuarantined++;
  continue;
}
```

This requires importing `sourceHealth` in events.js — it's already imported on the existing line 4.

**Step 3: Add 'quarantined' to degraded status check**

In `getHealthStatus` (line 168), update the status checks to include quarantined:

```js
const anyFailed = Object.values(sourceHealth).some(h => h.lastStatus === 'error' || h.lastStatus === 'timeout' || h.lastStatus === 'quarantined');
const allFailed = Object.values(sourceHealth).every(h => h.lastStatus === 'error' || h.lastStatus === 'timeout' || h.lastStatus === 'quarantined');
```

**Step 4: Run full test suite**

Run: `npm test`
Expected: All pass including new scrape-guard tests.

**Step 5: Commit**

```bash
git add test/run-all.js src/source-health.js src/events.js
git commit -m "feat: scrape-guard in test runner, quarantine status in health dashboard"
```

---

### Task 6: Update ROADMAP.md

**Files:**
- Modify: `ROADMAP.md`

**Step 1: Add to Source + Quality section**

In `ROADMAP.md` under "Source + Quality" (~line 172), mark the self-healing item as done and add a brief entry:

```markdown
- Self-healing scraper pipeline -- **Done (2026-03-05).** `scrape-guard.js`: baseline gates (count drift, field coverage drift, date sanity, duplicate spike) quarantine broken sources at scrape time. Post-scrape audit wires `checkSourceCompleteness` + `runExtractionAudit` to alerting. Yesterday's cached events serve as automatic fallback.
```

**Step 2: Add to Completed Work**

Add to the Mar 5 row in the Completed Work table.

**Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark scrape guard as complete in roadmap"
```
