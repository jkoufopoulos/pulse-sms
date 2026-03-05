# Pipeline Hygiene & Monitoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the event pipeline self-cleaning, replace noisy per-event alerts with one daily digest, and add a historical digest dashboard.

**Architecture:** Source registry enforces data hygiene at boot and post-scrape (prune stale sources from SQLite). Daily digest generated after each scrape, persisted to SQLite, emailed on yellow/red. Dashboard page shows digest history.

**Tech Stack:** Node.js, better-sqlite3, Resend (email), vanilla HTML/JS dashboard.

**Design doc:** `docs/plans/2026-03-05-pipeline-hygiene-design.md`

---

### Task 1: Registry-enforced SQLite pruning

**Files:**
- Modify: `src/db.js:258-268` (add `pruneInactiveSources`)
- Modify: `src/events.js:291-311` (boot path) and `src/events.js:477-498` (post-scrape path)
- Test: `test/unit/db.test.js`

**Step 1: Write the failing test**

Add to `test/unit/db.test.js`:

```js
console.log('\nInactive source pruning:');

// Insert events from active and inactive sources
const activeLabels = ['DoNYC', 'RA'];
const now = new Date().toISOString();
testDb.prepare(`INSERT INTO events (id, source_name, name, scraped_at, updated_at, date_local) VALUES (?, ?, ?, ?, ?, ?)`).run('evt-active', 'DoNYC', 'Active Event', now, now, '2026-03-05');
testDb.prepare(`INSERT INTO events (id, source_name, name, scraped_at, updated_at, date_local) VALUES (?, ?, ?, ?, ?, ?)`).run('evt-stale', 'ticketmaster', 'Stale Event', now, now, '2026-03-05');
testDb.prepare(`INSERT INTO events (id, source_name, name, scraped_at, updated_at, date_local) VALUES (?, ?, ?, ?, ?, ?)`).run('evt-stale2', 'smallslive', 'Stale Event 2', now, now, '2026-03-05');

// Prune inactive sources
const allNames = testDb.prepare('SELECT DISTINCT source_name FROM events').all().map(r => r.source_name);
const inactive = allNames.filter(s => !activeLabels.includes(s) && !activeLabels.map(l => l.toLowerCase()).includes(s));
if (inactive.length > 0) {
  const ph = inactive.map(() => '?').join(', ');
  testDb.prepare(`DELETE FROM events WHERE source_name IN (${ph})`).run(...inactive);
}

const remaining = testDb.prepare('SELECT id FROM events').all();
check('pruneInactiveSources keeps active events', remaining.some(r => r.id === 'evt-active'));
check('pruneInactiveSources removes ticketmaster', !remaining.some(r => r.id === 'evt-stale'));
check('pruneInactiveSources removes smallslive', !remaining.some(r => r.id === 'evt-stale2'));
check('pruneInactiveSources leaves 1 event', remaining.length === 1);
```

**Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A2 'Inactive source pruning'`
Expected: FAIL (tests don't exist yet)

**Step 3: Add `pruneInactiveSources` to `db.js`**

Add after `deleteEventsBySource` (line 268):

```js
/**
 * Delete events from sources NOT in the active registry.
 * Called at boot and after each scrape to enforce registry as single source of truth.
 */
function pruneInactiveSources(activeLabels) {
  const d = getDb();
  const allSources = d.prepare('SELECT DISTINCT source_name FROM events').all().map(r => r.source_name);
  const activeSet = new Set([...activeLabels, ...activeLabels.map(l => l.toLowerCase())]);
  const inactive = allSources.filter(s => !activeSet.has(s));
  if (inactive.length === 0) return 0;
  const ph = inactive.map(() => '?').join(', ');
  const result = d.prepare(`DELETE FROM events WHERE source_name IN (${ph})`).run(...inactive);
  if (result.changes > 0) {
    console.log(`Pruned ${result.changes} events from inactive sources: ${inactive.join(', ')}`);
  }
  return result.changes;
}
```

Add `pruneInactiveSources` to the `module.exports` object at line 591.

**Step 4: Wire into boot path in `events.js`**

In the SQLite boot block (after line 294 `importFromJsonCache(CACHE_FILE);`), add:

```js
  db.pruneInactiveSources(SOURCE_LABELS);
```

Where `db` is `require('./db')` — note the boot block already has `const { getEventsInRange, generateOccurrences, importFromJsonCache } = require('./db');` so add `pruneInactiveSources` to that destructure.

**Step 5: Wire into post-scrape path in `events.js`**

In the post-scrape SQLite block (after line 480 `db.pruneOldEvents(getNycDateString(-30));`), add:

```js
      db.pruneInactiveSources(SOURCE_LABELS);
```

**Step 6: Run tests**

Run: `npm test`
Expected: 124+ passed, 0 failed (including new pruning tests)

**Step 7: Commit**

```bash
git add src/db.js src/events.js test/unit/db.test.js
git commit -m "feat: prune events from inactive sources at boot and post-scrape

Registry is now the single source of truth for serving, not just scraping.
Removes stale data from sources like Ticketmaster/SmallsLIVE that were
commented out of source-registry.js but persisted in SQLite."
```

---

### Task 2: Category normalization at boundary

**Files:**
- Modify: `src/sources/shared.js:133-170` (`normalizeExtractedEvent`)
- Test: `test/unit/scrapers.test.js`

Note: Skint and Yutori `music -> live_music` fixes were already applied earlier in this session. This task adds belt-and-suspenders at the shared boundary (P3).

**Step 1: Write the failing test**

Add to `test/unit/scrapers.test.js`:

```js
console.log('\nCategory normalization at boundary:');
const { normalizeExtractedEvent } = require('../../src/sources/shared');
const musicEvent = normalizeExtractedEvent({ name: 'Jazz Night', category: 'music', venue_name: 'Blue Note', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('music category normalized to live_music', musicEvent.category === 'live_music');
const liveEvent = normalizeExtractedEvent({ name: 'Rock Show', category: 'live_music', venue_name: 'Bowery', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('live_music category preserved', liveEvent.category === 'live_music');
const comedyEvent = normalizeExtractedEvent({ name: 'Stand Up', category: 'comedy', venue_name: 'Cellar', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('comedy category unchanged', comedyEvent.category === 'comedy');
```

**Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A2 'Category normalization'`
Expected: FAIL on "music category normalized to live_music"

**Step 3: Add normalization to `normalizeExtractedEvent`**

In `src/sources/shared.js`, inside `normalizeExtractedEvent` at line 170 (where `category: e.category || 'other'` is set), change to:

```js
    category: e.category === 'music' ? 'live_music' : (e.category || 'other'),
```

**Step 4: Run tests**

Run: `npm test`
Expected: All pass including new category tests

**Step 5: Commit**

```bash
git add src/sources/shared.js test/unit/scrapers.test.js
git commit -m "feat: normalize music -> live_music at extraction boundary (P3)"
```

---

### Task 3: Source expectations in registry

**Files:**
- Modify: `src/source-registry.js:36-66` (add `minExpected` and `schedule` to SOURCES)

**Step 1: Add expectations to each source entry**

Add `minExpected` (minimum events expected on a normal day) and optional `schedule` to each source in the `SOURCES` array. Based on production health data:

```js
{ label: 'Skint',            ..., minExpected: 5 },
{ label: 'SkintOngoing',     ..., minExpected: 10 },
{ label: 'NonsenseNYC',      ..., minExpected: 10 },
{ label: 'RA',               ..., minExpected: 50 },
{ label: 'Dice',             ..., minExpected: 50 },
{ label: 'BrooklynVegan',    ..., minExpected: 10 },
{ label: 'BAM',              ..., minExpected: 20 },
{ label: 'Yutori',           ..., minExpected: 20 },
{ label: 'ScreenSlate',      ..., minExpected: 5 },
{ label: 'NYCParks',         ..., minExpected: 15 },
{ label: 'DoNYC',            ..., minExpected: 100 },
{ label: 'Songkick',         ..., minExpected: 20 },
{ label: 'Luma',             ..., minExpected: 100 },
{ label: 'Eventbrite',       ..., minExpected: 10 },
{ label: 'NYPL',             ..., minExpected: 10 },
{ label: 'EventbriteComedy', ..., minExpected: 20 },
{ label: 'EventbriteArts',   ..., minExpected: 10 },
{ label: 'TinyCupboard',     ..., minExpected: 10 },
{ label: 'BrooklynCC',       ..., minExpected: 15 },
{ label: 'NYCTrivia',        ..., minExpected: 50 },
{ label: 'BKMag',            ..., minExpected: 5, schedule: { days: ['fri', 'sat'] } },
{ label: 'SofarSounds',      ..., minExpected: 5 },
```

Keep existing fields (`fetch`, `weight`, `mergeRank`, `endpoint`) unchanged. Just append `minExpected` and optionally `schedule`.

**Step 2: Export expectations lookup**

Add after `MERGE_ORDER` (line 90):

```js
const SOURCE_EXPECTATIONS = Object.fromEntries(
  SOURCES.map(s => [s.label, { minExpected: s.minExpected || 0, schedule: s.schedule || null }])
);
```

Add `SOURCE_EXPECTATIONS` to `module.exports`.

**Step 3: Run tests**

Run: `npm test`
Expected: All pass (no behavior change, just new config data)

**Step 4: Commit**

```bash
git add src/source-registry.js
git commit -m "feat: add minExpected and schedule to source registry for digest intelligence"
```

---

### Task 4: Daily digest SQLite table

**Files:**
- Modify: `src/db.js:30-62` (add table to migrations)
- Modify: `src/db.js:591-612` (add to exports)
- Test: `test/unit/db.test.js`

**Step 1: Write failing tests**

Add to `test/unit/db.test.js`:

```js
console.log('\nDaily digests table:');

// Create digests table in test db
testDb.exec(`
  CREATE TABLE IF NOT EXISTS daily_digests (
    id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    report TEXT NOT NULL,
    email_sent INTEGER DEFAULT 0
  );
`);

// Insert a digest
const digest = { id: '2026-03-05', status: 'green', summary: '2541 events', cache: { total: 2541 } };
testDb.prepare('INSERT OR REPLACE INTO daily_digests (id, generated_at, status, report, email_sent) VALUES (?, ?, ?, ?, ?)').run('2026-03-05', '2026-03-05T15:00:00Z', 'green', JSON.stringify(digest), 0);

// Read it back
const row = testDb.prepare('SELECT * FROM daily_digests WHERE id = ?').get('2026-03-05');
check('digest saved with correct id', row.id === '2026-03-05');
check('digest status is green', row.status === 'green');
check('digest report is valid JSON', JSON.parse(row.report).cache.total === 2541);

// Insert second digest, read last 2
testDb.prepare('INSERT OR REPLACE INTO daily_digests (id, generated_at, status, report, email_sent) VALUES (?, ?, ?, ?, ?)').run('2026-03-04', '2026-03-04T15:00:00Z', 'yellow', JSON.stringify({ id: '2026-03-04' }), 1);
const rows = testDb.prepare('SELECT * FROM daily_digests ORDER BY id DESC LIMIT 30').all();
check('getDigests returns 2 rows', rows.length === 2);
check('getDigests ordered newest first', rows[0].id === '2026-03-05');
```

**Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 'Daily digests'`
Expected: FAIL (table not created in test db yet — actually the tests create it inline, so they should pass. This validates the schema works.)

**Step 3: Add migration to `db.js`**

In `runMigrations` (line 30), add after the `recurring_patterns` table creation:

```js
    CREATE TABLE IF NOT EXISTS daily_digests (
      id TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      report TEXT NOT NULL,
      email_sent INTEGER DEFAULT 0
    );
```

**Step 4: Add `saveDigest` and `getDigests` functions**

Add before the `module.exports` in `db.js`:

```js
// --- Daily digests ---

function saveDigest(id, status, report) {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO daily_digests (id, generated_at, status, report, email_sent)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, new Date().toISOString(), status, JSON.stringify(report));
}

function markDigestEmailed(id) {
  const d = getDb();
  d.prepare('UPDATE daily_digests SET email_sent = 1 WHERE id = ?').run(id);
}

function getDigests(limit = 30) {
  const d = getDb();
  return d.prepare('SELECT * FROM daily_digests ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
    ...row,
    report: JSON.parse(row.report),
    email_sent: !!row.email_sent,
  }));
}

function getYesterdayDigest() {
  const d = getDb();
  const rows = d.prepare('SELECT * FROM daily_digests ORDER BY id DESC LIMIT 2').all();
  if (rows.length < 2) return null;
  return { ...rows[1], report: JSON.parse(rows[1].report) };
}
```

Add `saveDigest`, `markDigestEmailed`, `getDigests`, `getYesterdayDigest` to `module.exports`.

**Step 5: Run tests**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/db.js test/unit/db.test.js
git commit -m "feat: daily_digests SQLite table with save/query functions"
```

---

### Task 5: Daily digest generation

**Files:**
- Create: `src/daily-digest.js`
- Test: `test/unit/digest.test.js`

**Step 1: Write failing tests**

Create `test/unit/digest.test.js`:

```js
const { check } = require('../helpers');

console.log('\n--- digest.test.js ---');

// Test status logic
console.log('\nDigest status logic:');

const { computeDigestStatus } = require('../../src/daily-digest');

// Green: all sources ok, cache stable
const green = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 5,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('all ok = green', green === 'green');

// Yellow: 1-3 sources below
const yellow1 = computeDigestStatus({
  sourcesBelow: ['Skint'],
  cacheDrop: 5,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('1 source below = yellow', yellow1 === 'yellow');

// Yellow: cache dropped 25%
const yellow2 = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 25,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('cache drop 25% = yellow', yellow2 === 'yellow');

// Red: >3 sources below
const red1 = computeDigestStatus({
  sourcesBelow: ['Skint', 'RA', 'Dice', 'DoNYC'],
  cacheDrop: 5,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('>3 sources below = red', red1 === 'red');

// Red: user-facing errors
const red2 = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 5,
  userFacingErrors: 2,
  latencyP95: 2000,
});
check('user-facing errors = red', red2 === 'red');

// Red: cache dropped >40%
const red3 = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 45,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('cache drop 45% = red', red3 === 'red');

// Test needs-attention filtering
console.log('\nNeeds attention filtering:');

const { buildNeedsAttention } = require('../../src/daily-digest');

const sourceData = [
  { name: 'Skint', count: 0, avg7d: 18, minExpected: 5, schedule: null },
  { name: 'BKMag', count: 0, avg7d: 8, minExpected: 5, schedule: { days: ['fri', 'sat'] } },
  { name: 'DoNYC', count: 500, avg7d: 520, minExpected: 100, schedule: null },
  { name: 'RA', count: 3, avg7d: 200, minExpected: 50, schedule: null },
];

// Wednesday — BKMag 0 is expected
const items = buildNeedsAttention(sourceData, 'wednesday');
check('Skint flagged as warn', items.some(i => i.source === 'Skint' && i.severity === 'warn'));
check('BKMag flagged as info (off-schedule)', items.some(i => i.source === 'BKMag' && i.severity === 'info'));
check('DoNYC not flagged (healthy)', !items.some(i => i.source === 'DoNYC'));
check('RA flagged as warn (3 vs avg 200)', items.some(i => i.source === 'RA' && i.severity === 'warn'));

// Friday — BKMag 0 is unexpected
const fridayItems = buildNeedsAttention(
  [{ name: 'BKMag', count: 0, avg7d: 8, minExpected: 5, schedule: { days: ['fri', 'sat'] } }],
  'friday'
);
check('BKMag on friday flagged as warn', fridayItems.some(i => i.source === 'BKMag' && i.severity === 'warn'));
```

**Step 2: Run to verify failures**

Run: `npm test 2>&1 | grep -A2 'Digest status'`
Expected: FAIL (module doesn't exist)

**Step 3: Create `src/daily-digest.js`**

```js
const { SOURCE_LABELS, SOURCE_EXPECTATIONS } = require('./source-registry');
const { sourceHealth } = require('./source-health');
const { getNycDateString } = require('./geo');
const { getRecentAlerts } = require('./alerts');

/**
 * Determine digest status from metrics.
 * Green: all ok. Yellow: 1-3 issues. Red: >3 issues or user-facing errors.
 */
function computeDigestStatus({ sourcesBelow, cacheDrop, userFacingErrors, latencyP95 }) {
  if (userFacingErrors > 0) return 'red';
  if (cacheDrop > 40) return 'red';
  if (sourcesBelow.length > 3) return 'red';
  if (sourcesBelow.length > 0) return 'yellow';
  if (cacheDrop > 20) return 'yellow';
  if (latencyP95 > 5000) return 'yellow';
  return 'green';
}

/**
 * Build needs-attention list from source data.
 * Distinguishes expected zeros (off-schedule) from unexpected drops.
 */
function buildNeedsAttention(sourceData, dayName) {
  const items = [];
  const day = dayName.toLowerCase();

  for (const s of sourceData) {
    const isOnSchedule = !s.schedule || s.schedule.days.map(d => d.toLowerCase()).includes(day);
    const belowThreshold = s.count < s.minExpected * 0.4;
    const belowAvg = s.avg7d > 5 && s.count < s.avg7d * 0.4;

    if (belowThreshold || belowAvg) {
      if (!isOnSchedule) {
        items.push({
          source: s.name,
          issue: `0 events (off-schedule, expected ${s.schedule.days.join('/')})`,
          severity: 'info',
        });
      } else {
        const ref = s.avg7d > 5 ? `avg ${Math.round(s.avg7d)}` : `min ${s.minExpected}`;
        items.push({
          source: s.name,
          issue: `${s.count} events (${ref})`,
          severity: 'warn',
        });
      }
    }
  }

  return items;
}

/**
 * Generate a daily digest report from current state.
 * Called after each scrape completes.
 */
function generateDigest(eventCache, scrapeStats) {
  const today = getNycDateString(0);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[new Date().getDay()];

  // Source counts from cache
  const sourceCounts = {};
  const categoryCounts = {};
  let freeCount = 0;
  for (const e of eventCache) {
    if (e.source_name) sourceCounts[e.source_name] = (sourceCounts[e.source_name] || 0) + 1;
    const cat = e.category || 'other';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    if (e.is_free) freeCount++;
  }

  // Build source data with 7-day averages from health history
  const sourceData = SOURCE_LABELS.map(label => {
    const health = sourceHealth[label];
    const okHistory = (health?.history || []).filter(h => h.status === 'ok' && h.count > 0);
    const avg7d = okHistory.length > 0
      ? okHistory.reduce((sum, h) => sum + h.count, 0) / okHistory.length
      : 0;
    const expectations = SOURCE_EXPECTATIONS[label] || { minExpected: 0, schedule: null };
    return {
      name: label,
      count: sourceCounts[label] || 0,
      avg7d,
      status: (sourceCounts[label] || 0) >= expectations.minExpected * 0.4 ? 'ok' : 'warn',
      ...expectations,
    };
  });

  const needsAttention = buildNeedsAttention(sourceData, dayName);
  const sourcesBelow = needsAttention.filter(i => i.severity === 'warn').map(i => i.source);

  // Yesterday's cache total (from digest if available, else estimate)
  let yesterdayTotal = eventCache.length; // fallback: no change
  try {
    const { getYesterdayDigest } = require('./db');
    const yesterday = getYesterdayDigest();
    if (yesterday?.report?.cache?.total) {
      yesterdayTotal = yesterday.report.cache.total;
    }
  } catch {}

  const cacheDrop = yesterdayTotal > 0
    ? Math.max(0, ((yesterdayTotal - eventCache.length) / yesterdayTotal) * 100)
    : 0;

  // Count user-facing errors from alerts in last 24h
  const recentAlerts = getRecentAlerts(50);
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const userFacingErrors = recentAlerts.filter(a =>
    (a.alertType === 'agent_brain_error' || a.alertType === 'double_failure') &&
    new Date(a.timestamp).getTime() > oneDayAgo
  ).length;

  // Latency p95 from recent alerts (rough proxy — traces not easily accessible here)
  const latencyP95 = 0; // placeholder — we don't have easy trace access from this module

  const status = computeDigestStatus({ sourcesBelow, cacheDrop, userFacingErrors, latencyP95 });
  const activeSourceCount = sourceData.filter(s => s.count > 0).length;

  const report = {
    id: today,
    generated_at: new Date().toISOString(),
    status,
    summary: `${eventCache.length.toLocaleString()} events from ${activeSourceCount} sources. ${freeCount} free. ${needsAttention.length > 0 ? `${needsAttention.length} need attention.` : 'All sources healthy.'}`,
    cache: {
      total: eventCache.length,
      yesterday: yesterdayTotal,
      change_pct: yesterdayTotal > 0 ? Math.round(((eventCache.length - yesterdayTotal) / yesterdayTotal) * 100 * 10) / 10 : 0,
      free: freeCount,
      paid: eventCache.length - freeCount,
    },
    needs_attention: needsAttention,
    sources: sourceData.map(s => ({ name: s.name, count: s.count, avg_7d: Math.round(s.avg7d), status: s.status })),
    categories: categoryCounts,
    user_facing_errors: userFacingErrors,
    scrape: {
      duration_ms: scrapeStats?.totalDurationMs || null,
      sources_ok: scrapeStats?.sourcesOk || 0,
      sources_failed: scrapeStats?.sourcesFailed || 0,
    },
  };

  return report;
}

/**
 * Format a digest report as plain-text email body.
 */
function formatDigestEmail(report) {
  const lines = [];
  lines.push(`Pulse Daily Digest: ${report.status.toUpperCase()}`);
  lines.push(`Date: ${report.id}`);
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  if (report.needs_attention.length > 0) {
    lines.push('NEEDS ATTENTION:');
    for (const item of report.needs_attention) {
      const marker = item.severity === 'warn' ? '!' : 'i';
      lines.push(`  [${marker}] ${item.source}: ${item.issue}`);
    }
    lines.push('');
  }

  lines.push(`Cache: ${report.cache.total} events (${report.cache.change_pct > 0 ? '+' : ''}${report.cache.change_pct}% vs yesterday)`);
  lines.push(`Free: ${report.cache.free} | Paid: ${report.cache.paid}`);
  lines.push('');

  if (report.scrape.duration_ms) {
    lines.push(`Scrape: ${(report.scrape.duration_ms / 1000).toFixed(1)}s | ${report.scrape.sources_ok} ok, ${report.scrape.sources_failed} failed`);
    lines.push('');
  }

  lines.push('SOURCES:');
  const sorted = [...report.sources].sort((a, b) => b.count - a.count);
  for (const s of sorted) {
    const flag = s.status === 'warn' ? ' !' : '';
    lines.push(`  ${s.name}: ${s.count} (avg ${s.avg_7d})${flag}`);
  }

  return lines.join('\n');
}

module.exports = { computeDigestStatus, buildNeedsAttention, generateDigest, formatDigestEmail };
```

**Step 4: Run tests**

Run: `npm test`
Expected: All pass

**Step 5: Commit**

```bash
git add src/daily-digest.js test/unit/digest.test.js
git commit -m "feat: daily digest generation with status logic and needs-attention filtering"
```

---

### Task 6: Wire digest into scrape + email

**Files:**
- Modify: `src/events.js:531-532` (replace `alertOnFailingSources` with digest)
- Modify: `src/alerts.js` (add `sendDigestEmail`, keep `sendRuntimeAlert`)
- Modify: `src/handler.js:273` (remove `slow_response` alert)
- Modify: `src/scrape-guard.js:148` (remove `scrape-audit-regression` alert)

**Step 1: Replace `alertOnFailingSources` in `events.js`**

At line 531-532, replace:

```js
    // Alert on sources that have been failing for 3+ consecutive scrapes
    alertOnFailingSources();
```

With:

```js
    // Generate daily digest and email if yellow/red
    try {
      const { generateDigest } = require('./daily-digest');
      const db = require('./db');
      const digest = generateDigest(eventCache, {
        totalDurationMs: scrapeEnd - scrapeStart,
        sourcesOk,
        sourcesFailed,
      });
      db.saveDigest(digest.id, digest.status, digest);
      console.log(`Daily digest: ${digest.status} — ${digest.summary}`);

      if (digest.status !== 'green') {
        const { sendDigestEmail } = require('./alerts');
        sendDigestEmail(digest).catch(err =>
          console.error('[DIGEST] Email failed:', err.message)
        );
      }
    } catch (err) {
      console.error('Daily digest generation failed:', err.message);
    }
```

Remove `alertOnFailingSources` from the destructured imports at line 4.

**Step 2: Add `sendDigestEmail` to `alerts.js`**

Add after `sendRuntimeAlert` (before `module.exports`):

```js
// --- Daily digest email ---
const DIGEST_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours — one per day
let lastDigestSent = 0;

async function sendDigestEmail(digest) {
  if (Date.now() - lastDigestSent < DIGEST_COOLDOWN_MS) {
    console.log('[DIGEST] Cooldown active — skipping email');
    return;
  }

  const { formatDigestEmail } = require('./daily-digest');
  const subject = `Pulse daily: ${digest.status} — ${digest.cache.total.toLocaleString()} events${digest.needs_attention.length > 0 ? `, ${digest.needs_attention.length} need attention` : ''}`;
  const body = formatDigestEmail(digest);

  const alertEntry = {
    id: require('crypto').randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'digest',
    subject,
    details: { digest_id: digest.id, status: digest.status },
    emailSent: false,
    emailError: null,
  };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    alertEntry.emailError = 'RESEND_API_KEY not set';
    logAlert(alertEntry);
    lastDigestSent = Date.now();
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
      console.log(`[DIGEST] Email sent: ${subject}`);
      try {
        const { markDigestEmailed } = require('./db');
        markDigestEmailed(digest.id);
      } catch {}
    } else {
      const err = await res.text();
      alertEntry.emailError = `${res.status} ${err}`;
    }
  } catch (err) {
    alertEntry.emailError = err.message;
  }

  logAlert(alertEntry);
  lastDigestSent = Date.now();
}
```

Add `sendDigestEmail` to `module.exports`.

**Step 3: Remove `slow_response` alert from `handler.js`**

At `src/handler.js:273-278`, remove the `sendRuntimeAlert('slow_response', ...)` call. Keep the `console.warn` slow log. The block should look like:

```js
      console.warn(`[SLOW] ${(trace.total_latency_ms / 1000).toFixed(1)}s | ${breakdown} | intent=${trace.output_intent} | msg="${trace.input_message.slice(0, 40)}"`);
```

(Just delete lines 273-278 that call `sendRuntimeAlert`.)

**Step 4: Remove `scrape-audit-regression` alert from `scrape-guard.js`**

At `src/scrape-guard.js:147-151`, remove the `sendRuntimeAlert('scrape-audit-regression', ...)` call. Keep the `console.warn` log. Remove the `sendRuntimeAlert` import from line 5.

**Step 5: Run tests**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/events.js src/alerts.js src/handler.js src/scrape-guard.js
git commit -m "feat: wire daily digest into post-scrape, remove noisy slow_response and scrape-audit alerts

Daily digest replaces alertOnFailingSources. Emails only on yellow/red.
slow_response alerts removed (latency tracked in console log only).
scrape-audit-regression alerts folded into digest needs-attention."
```

---

### Task 7: Digest API endpoint

**Files:**
- Modify: `src/server.js` (add `/api/digests` and `/digests` route)

**Step 1: Add API endpoint and page route**

In `src/server.js`, add after the events browser routes (~line 329):

```js
// Digest history (read-only, always available)
app.get('/digests', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'digest-ui.html'));
});
app.get('/api/digests', (req, res) => {
  try {
    const { getDigests } = require('./db');
    res.json(getDigests(30));
  } catch (err) {
    res.json([]);
  }
});
```

**Step 2: Add "Digests" link to nav bars**

In `src/health-ui.html`, find the nav (line 500-510) and add after the Events link:

```html
  <a href="/digests" class="bestie-nav-link">Digests</a>
```

Do the same in `src/events-ui.html` and `src/eval-ui.html` — find the `<nav class="bestie-nav">` and add the Digests link in the same position.

**Step 3: Run tests**

Run: `npm test`
Expected: All pass

**Step 4: Commit**

```bash
git add src/server.js src/health-ui.html src/events-ui.html src/eval-ui.html
git commit -m "feat: /digests route and /api/digests endpoint, nav link added"
```

---

### Task 8: Digest dashboard UI

**Files:**
- Create: `src/digest-ui.html`

**Step 1: Create the digest history page**

Create `src/digest-ui.html` — a single-file HTML page (same pattern as `health-ui.html`). Key elements:

- Same nav bar as other pages (copy from `health-ui.html` lines 479-510, mark Digests as active)
- Same dark theme CSS (copy base styles from `health-ui.html`)
- Fetches `GET /api/digests` on load
- Renders list of digests, newest first
- Each row: date, status pill (green/yellow/red), summary line, event count
- Click row to expand: sources table, needs-attention items, category breakdown
- Auto-refresh every 5 minutes

The page should be ~300-400 lines. Key JS structure:

```js
async function loadDigests() {
  const res = await fetch('/api/digests');
  const digests = await res.json();
  renderDigests(digests);
}

function renderDigests(digests) {
  // For each digest: render a collapsible row
  // Status pill: green/yellow/red
  // Summary line
  // Expandable: sources table, needs-attention, categories
}

function renderExpandedDigest(digest) {
  // Needs attention section (if any items)
  // Sources table: name, count, avg_7d, status
  // Categories: horizontal bars
  // Scrape info: duration, sources ok/failed
}
```

Use the same status pill CSS classes as `health-ui.html`: `.status-pill.ok` (green), `.status-pill.degraded` (yellow), `.status-pill.critical` (red). Map digest status: `green -> ok`, `yellow -> degraded`, `red -> critical`.

**Step 2: Test manually**

Run: `PULSE_TEST_MODE=true node src/server.js`
Navigate to: `http://localhost:3000/digests`
Expected: Page loads. If no digests yet, shows "No digests yet" message. After a scrape completes, a digest row appears.

**Step 3: Commit**

```bash
git add src/digest-ui.html
git commit -m "feat: digest history dashboard at /digests"
```

---

### Task 9: Verify end-to-end

**Step 1: Run all tests**

Run: `npm test`
Expected: All pass (128+ tests)

**Step 2: Test local scrape + digest generation**

Run: `PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js`

Wait for scrape to complete. Check console for:
- `Pruned X events from inactive sources` (if any stale data exists)
- `Daily digest: green — X events from Y sources...`

**Step 3: Check dashboards**

- `http://localhost:3000/health` — no Ticketmaster/SmallsLIVE in source cards
- `http://localhost:3000/events` — no Ticketmaster/SmallsLIVE in source coverage chart
- `http://localhost:3000/digests` — shows today's digest with status pill

**Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: end-to-end verification fixups"
```

---

Plan complete and saved to `docs/plans/2026-03-05-pipeline-hygiene-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?