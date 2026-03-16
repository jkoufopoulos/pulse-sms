# Email-Only Polling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Poll Gmail-based event sources (NonsenseNYC, ScreenSlate, Yutori) every 4 hours and merge new events into the live cache, so newsletters that arrive between full scrapes are surfaced within hours instead of missing entirely.

**Architecture:** Add `channel: 'email'` to the source registry. New `refreshEmailSources()` in events.js fetches only email sources, dedup-merges into the live `eventCache`, and persists. A separate timer (`scheduleEmailPolls`) fires at 6am/2pm/10pm ET (the hours not already covered by the full 10am/6pm scrape).

**Tech Stack:** Node.js, existing Gmail/source infrastructure, SQLite (upsert), JSON cache persistence.

---

### Task 1: Add `channel` field to source registry

**Files:**
- Modify: `src/source-registry.js:36-66`
- Test: `test/unit/misc.test.js:43-53`

**Step 1: Write the failing test**

Add to `test/unit/misc.test.js` after the existing SOURCES registry tests (after line 53):

```js
// ---- Email source channel ----
console.log('\nEmail source channel:');
const { EMAIL_SOURCES } = require('../../src/source-registry');
check('EMAIL_SOURCES is an array', Array.isArray(EMAIL_SOURCES));
check('EMAIL_SOURCES has 3 entries', EMAIL_SOURCES.length === 3);
check('NonsenseNYC is email channel', EMAIL_SOURCES.some(s => s.label === 'NonsenseNYC'));
check('Yutori is email channel', EMAIL_SOURCES.some(s => s.label === 'Yutori'));
check('ScreenSlate is email channel', EMAIL_SOURCES.some(s => s.label === 'ScreenSlate'));
check('RA is NOT email channel', !EMAIL_SOURCES.some(s => s.label === 'RA'));
check('all email sources have fetch functions', EMAIL_SOURCES.every(s => typeof s.fetch === 'function'));
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/misc.test.js`
Expected: FAIL — `EMAIL_SOURCES` is not exported from source-registry

**Step 3: Add `channel: 'email'` to 3 source entries and export `EMAIL_SOURCES`**

In `src/source-registry.js`, add `channel: 'email'` to the NonsenseNYC, Yutori, and ScreenSlate entries:

```js
// line 39 — add channel: 'email'
{ label: 'NonsenseNYC', fetch: fetchNonsenseNYC, weight: 0.9, mergeRank: 1, endpoint: 'https://nonsensenyc.com', minExpected: 10, volatile: true, channel: 'email' },
// line 47 — add channel: 'email'
{ label: 'Yutori', fetch: fetchYutoriEvents, weight: 0.8, mergeRank: 4, endpoint: null, minExpected: 20, volatile: true, channel: 'email' },
// line 48 — add channel: 'email'
{ label: 'ScreenSlate', fetch: fetchScreenSlateEvents, weight: 0.9, mergeRank: 2, endpoint: null, minExpected: 5, channel: 'email' },
```

Add derived constant before `module.exports`:

```js
const EMAIL_SOURCES = SOURCES.filter(s => s.channel === 'email');
```

Add `EMAIL_SOURCES` to the `module.exports`.

**Step 4: Run test to verify it passes**

Run: `node test/unit/misc.test.js`
Expected: PASS — all email source checks green

**Step 5: Commit**

```bash
git add src/source-registry.js test/unit/misc.test.js
git commit -m "feat: add channel:'email' to source registry for email-only polling"
```

---

### Task 2: Implement `refreshEmailSources()`

**Files:**
- Modify: `src/events.js:391-600` (add new function after `refreshCache`)
- Test: `test/unit/misc.test.js`

**Step 1: Write the failing test**

Add to `test/unit/misc.test.js`:

```js
// ---- refreshEmailSources ----
console.log('\nrefreshEmailSources:');
const { refreshEmailSources } = require('../../src/events');
check('refreshEmailSources is exported', typeof refreshEmailSources === 'function');
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/misc.test.js`
Expected: FAIL — `refreshEmailSources` not exported

**Step 3: Implement `refreshEmailSources`**

Add this function in `src/events.js` after the `refreshCache` function ends (after line ~600, before the scheduler section). Import `EMAIL_SOURCES` from source-registry at the top of the file (update the existing require).

```js
let emailRefreshPromise = null;

async function refreshEmailSources() {
  if (emailRefreshPromise) return emailRefreshPromise;
  // Skip if a full refresh is already running — it covers email sources
  if (refreshPromise) {
    console.log('Full scrape in progress, skipping email-only poll');
    return;
  }

  emailRefreshPromise = (async () => {
    console.log(`Polling ${EMAIL_SOURCES.length} email sources...`);
    const start = Date.now();

    const fetchResults = await Promise.allSettled(
      EMAIL_SOURCES.map(s => timedFetch(s.fetch, s.label, s.weight)),
    );

    const existingIds = new Set(eventCache.map(e => e.id));
    let added = 0;

    for (let i = 0; i < EMAIL_SOURCES.length; i++) {
      const label = EMAIL_SOURCES[i].label;
      const settled = fetchResults[i];
      const result = settled.status === 'fulfilled'
        ? settled.value
        : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message || 'unknown' };

      // Update health tracking
      updateSourceHealth(label, result);

      if (result.status === 'error' || result.status === 'timeout') {
        console.error(`[EMAIL-POLL] ${label} failed:`, result.error);
        continue;
      }

      // Baseline gate (same as full scrape)
      if (result.status === 'ok') {
        const verdict = checkBaseline(label, result.events);
        if (verdict.quarantined) {
          console.warn(`[EMAIL-POLL] Quarantined ${label}: ${verdict.reason}`);
          sourceHealth[label].lastStatus = 'quarantined';
          sourceHealth[label].lastQuarantineReason = verdict.reason;
          continue;
        }
      }

      // Quality gates on new events
      const gated = applyQualityGates(result.events);

      for (const e of gated) {
        if (!existingIds.has(e.id)) {
          existingIds.add(e.id);
          eventCache.push(e);
          added++;
        }
      }

      console.log(`[EMAIL-POLL] ${label}: ${result.events.length} fetched, ${gated.length} after gates`);
    }

    // Persist if we added anything
    if (added > 0) {
      try {
        // Upsert new events to SQLite
        const db = require('./db');
        const newEvents = eventCache.filter(e => EMAIL_SOURCES.some(s => s.label === e.source_name));
        if (newEvents.length > 0) db.upsertEvents(newEvents);
      } catch (err) {
        console.warn('[EMAIL-POLL] SQLite upsert failed:', err.message);
      }

      try {
        atomicWriteSync(CACHE_FILE, JSON.stringify({ events: eventCache, timestamp: cacheTimestamp }));
      } catch (err) {
        console.error('[EMAIL-POLL] Cache persist failed:', err.message);
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[EMAIL-POLL] Done in ${elapsed}s — ${added} new events added (cache: ${eventCache.length})`);
  })();

  try {
    await emailRefreshPromise;
  } finally {
    emailRefreshPromise = null;
  }
}
```

Add `refreshEmailSources` to `module.exports`.

Update the `require` at the top of events.js to import `EMAIL_SOURCES`:
```js
const { SOURCES, SOURCE_TIERS, SOURCE_LABELS, SOURCE_DB_NAMES, MERGE_ORDER, EMAIL_SOURCES } = require('./source-registry');
```

**Step 4: Run test to verify it passes**

Run: `node test/unit/misc.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/events.js test/unit/misc.test.js
git commit -m "feat: add refreshEmailSources for incremental email-only cache merge"
```

---

### Task 3: Add email polling scheduler

**Files:**
- Modify: `src/events.js:906-958` (scheduler section)
- Modify: `src/server.js:600` (startup)
- Test: `test/unit/misc.test.js`

**Step 1: Write the failing test**

Add to `test/unit/misc.test.js`:

```js
// ---- Email poll scheduler ----
console.log('\nEmail poll scheduler:');
const { scheduleEmailPolls, clearEmailSchedule } = require('../../src/events');
check('scheduleEmailPolls is exported', typeof scheduleEmailPolls === 'function');
check('clearEmailSchedule is exported', typeof clearEmailSchedule === 'function');
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/misc.test.js`
Expected: FAIL

**Step 3: Implement email poll scheduler**

Add in `src/events.js` after the existing `clearSchedule` function (around line 958):

```js
// ============================================================
// Email-only poll scheduler — catches newsletters between full scrapes
// ============================================================

const EMAIL_POLL_HOURS = [6, 14, 22]; // ET hours not covered by full scrape (10, 18)

function msUntilNextEmailPoll() {
  const now = new Date();
  const nycStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [datePart, timePart] = nycStr.split(', ');
  const [hour, minute, second] = timePart.split(':').map(Number);
  const nowSeconds = hour * 3600 + minute * 60 + second;

  let bestMs = Infinity;
  let bestHour = EMAIL_POLL_HOURS[0];
  for (const h of EMAIL_POLL_HOURS) {
    let diffSeconds = h * 3600 - nowSeconds;
    if (diffSeconds <= 0) diffSeconds += 24 * 3600;
    const ms = diffSeconds * 1000;
    if (ms < bestMs) {
      bestMs = ms;
      bestHour = h;
    }
  }
  return { ms: bestMs, hour: bestHour };
}

let emailPollTimer = null;

function scheduleEmailPolls() {
  const { ms, hour } = msUntilNextEmailPoll();
  const hours = (ms / 3600000).toFixed(1);
  console.log(`Next email poll in ${hours} hours (${hour}:00 ET)`);

  emailPollTimer = setTimeout(async () => {
    try {
      await refreshEmailSources();
    } catch (err) {
      console.error('[EMAIL-POLL] Scheduled poll failed:', err.message);
    }
    scheduleEmailPolls();
  }, ms);
}

function clearEmailSchedule() {
  if (emailPollTimer) clearTimeout(emailPollTimer);
}
```

Add `scheduleEmailPolls`, `clearEmailSchedule` to `module.exports`.

**Step 4: Wire into server startup**

In `src/server.js` line 600, add `scheduleEmailPolls()` after `scheduleDailyScrape()`:

```js
  scheduleDailyScrape();
  scheduleEmailPolls();
```

Update the require in `server.js` to import `scheduleEmailPolls` and `clearEmailSchedule`. Add `clearEmailSchedule()` to the `shutdown` function (line ~613, alongside `clearSchedule()`).

**Step 5: Run test to verify it passes**

Run: `node test/unit/misc.test.js`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/events.js src/server.js test/unit/misc.test.js
git commit -m "feat: add email-only polling schedule at 6am/2pm/10pm ET"
```

---

### Task 4: Add health dashboard visibility

**Files:**
- Modify: `src/events.js` (`getCacheStatus`)

**Step 1: Add email poll info to health status**

In `getCacheStatus()` (around line 960), add the email poll schedule info:

```js
function getCacheStatus() {
  const nextEmail = msUntilNextEmailPoll();
  return {
    cache_size: eventCache.length,
    cache_age_minutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
    cache_fresh: eventCache.length > 0,
    sources: { ...sourceHealth },
    next_email_poll_hours: (nextEmail.ms / 3600000).toFixed(1),
    next_email_poll_hour_et: nextEmail.hour,
  };
}
```

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/events.js
git commit -m "feat: expose email poll schedule in health status"
```

---

### Task 5: Manual verification on Railway

**Step 1: Deploy**

```bash
railway up
```

Wait ~2-3 minutes for build.

**Step 2: Check health dashboard**

Visit `https://web-production-c8fdb.up.railway.app/health` and verify:
- `next_email_poll_hours` appears in cache status
- `next_email_poll_hour_et` shows the next poll hour (6, 14, or 22)

**Step 3: Check server logs**

Look for startup messages:
- `Next email poll in X.X hours (HH:00 ET)`

**Step 4: Verify email sources show in source health**

Check that NonsenseNYC, ScreenSlate, Yutori show their last poll status.
