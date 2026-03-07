# Scrape Pipeline Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix false quarantines, false duplicate detection, and Yutori extraction garbage — making the scrape pipeline self-correcting instead of self-destructive.

**Architecture:** Four independent fixes to scrape-guard.js, source-registry.js, and Yutori extraction. Each task is independently testable and deployable. No hot-path changes.

**Tech Stack:** Node.js, better-sqlite3, Cheerio. Tests use the project's `check()` helper pattern (no test framework).

---

### Task 1: Volatile Source Baseline — Use Median Instead of Mean

**Problem:** `checkBaseline` uses mean of historical counts. Yutori's email-driven count swings (3→1108→14→258) make the mean meaningless. One big batch inflates it, then every normal scrape triggers false quarantine.

**Files:**
- Modify: `src/source-registry.js` (add `volatile` flag)
- Modify: `src/scrape-guard.js:12-38` (median for volatile sources)
- Test: `test/unit/scrape-guard.test.js`

**Step 1: Write the failing tests**

Add to `test/unit/scrape-guard.test.js` before the cleanup block (before line 86):

```javascript
// --- Volatile source: uses median instead of mean ---
console.log('\nvolatile source baseline:');
const { SOURCES } = require('../../src/source-registry');

// Simulate volatile history: 3, 14, 1108, 74, 43 (median=43, mean=248)
sh['TestVolatile'] = { ...mkEntry(), history: [] };
for (const count of [3, 14, 1108, 74, 43]) {
  sh['TestVolatile'].history.push({
    timestamp: new Date().toISOString(), count, durationMs: 100, status: 'ok',
    fieldCoverage: { name: 0.95, venue_name: 0.90, date_local: 0.85 },
  });
}

// 28 events: below mean*0.4 (248*0.4=99) but above median*0.4 (43*0.4=17)
const volatileEvents = new Array(28).fill({ name: `Event`, venue_name: 'V', date_local: '2026-03-05' });
// Without volatile flag: would quarantine (28 < 99)
// With volatile flag: should NOT quarantine (28 > 17)
// For this test, we mark TestVolatile as volatile in the source health
sh['TestVolatile'].volatile = true;
const volatileResult = checkBaseline('TestVolatile', volatileEvents);
check('volatile source: not quarantined (28 > median*0.4=17)', volatileResult.quarantined === false);

// Same history but truly low count should still quarantine
const veryLowEvents = new Array(5).fill({ name: `Event`, venue_name: 'V', date_local: '2026-03-05' });
const veryLowResult = checkBaseline('TestVolatile', veryLowEvents);
check('volatile source: quarantined when truly low (5 < median*0.4=17)', veryLowResult.quarantined === true);

delete sh['TestVolatile'];
```

**Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "volatile|FAIL|passed"`
Expected: 2 new FAILs (volatile flag not implemented yet)

**Step 3: Add `volatile` flag to source registry**

In `src/source-registry.js`, add `volatile: true` to Yutori and NonsenseNYC entries:

```javascript
{ label: 'NonsenseNYC', ..., volatile: true },
{ label: 'Yutori',      ..., volatile: true },
```

**Step 4: Implement median baseline in scrape-guard.js**

Replace `getBaselineStats` (lines 12-38):

```javascript
function getBaselineStats(label) {
  const health = sourceHealth[label];
  if (!health || health.history.length < MIN_HISTORY) return null;

  const okEntries = health.history.filter(h => h.status === 'ok' && h.count > 0);
  if (okEntries.length < MIN_HISTORY) return null;

  const counts = okEntries.map(h => h.count);
  const avgCount = counts.reduce((sum, c) => sum + c, 0) / counts.length;
  const sorted = [...counts].sort((a, b) => a - b);
  const medianCount = sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

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

  return { avgCount, medianCount, avgCoverage, entries: okEntries.length };
}
```

Update count drift check in `checkBaseline` (lines 44-51) to use median for volatile sources:

```javascript
  // 1. Count drift — use median for volatile sources (email-driven, inherently spiky)
  const isVolatile = sourceHealth[label]?.volatile === true;
  const baselineCount = isVolatile ? baseline.medianCount : baseline.avgCount;
  if (events.length < baselineCount * COUNT_DRIFT_THRESHOLD &&
      baselineCount >= 10) {
    return {
      quarantined: true,
      reason: `count drift: ${events.length} events vs ${Math.round(baselineCount)} ${isVolatile ? 'median' : 'avg'}`,
    };
  }
```

**Step 5: Stamp volatile flag from registry into source health**

In `src/events.js`, in the `refreshSources` function, after sources are initialized, stamp volatile flag. Find where `updateSourceHealth` is called and add before it:

```javascript
// Stamp volatile flag from registry
const sourceEntry = SOURCES.find(s => s.label === label);
if (sourceEntry?.volatile) sourceHealth[label].volatile = true;
```

Look for the line where `updateSourceHealth(label, ...)` is called in the scrape loop (~line 420-460) and add the stamp just before it.

**Step 6: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "volatile|FAIL|passed"`
Expected: Both volatile tests PASS

**Step 7: Commit**

```
git add src/scrape-guard.js src/source-registry.js src/events.js test/unit/scrape-guard.test.js
git commit -m "fix: use median baseline for volatile sources, prevent false quarantine"
```

---

### Task 2: Smarter Duplicate Spike Detection

**Problem:** Scrape guard flags TinyCupboard because "Best of Brooklyn Stand-Up Comedy" appears 19/26 times (73%). But these are legitimate multi-show events — same name, different time slots. The duplicate check uses name only, ignoring `start_time_local`.

**Files:**
- Modify: `src/scrape-guard.js:82-94` (check for distinct times)
- Test: `test/unit/scrape-guard.test.js`

**Step 1: Write the failing test**

Add to `test/unit/scrape-guard.test.js` (before cleanup block):

```javascript
// --- Duplicate spike: legitimate multi-show venue ---
console.log('\nduplicate spike — multi-show:');
sh['TestMultiShow'] = { ...mkEntry(), history: buildHistory(25, 5) };
const multiShowEvents = [];
// Same show name but different time slots (legitimate)
for (let d = 7; d <= 13; d++) {
  for (const time of ['19:00', '20:30', '22:15']) {
    multiShowEvents.push({
      name: 'Best of Brooklyn Stand-Up Comedy',
      venue_name: 'The Tiny Cupboard',
      date_local: `2026-03-${String(d).padStart(2, '0')}`,
      start_time_local: `2026-03-${String(d).padStart(2, '0')}T${time}:00`,
    });
  }
}
// Add a couple unique events
multiShowEvents.push({ name: 'Trivia Night', venue_name: 'The Tiny Cupboard', date_local: '2026-03-07', start_time_local: '2026-03-07T18:00:00' });
multiShowEvents.push({ name: 'Open Mic', venue_name: 'The Tiny Cupboard', date_local: '2026-03-08', start_time_local: '2026-03-08T17:00:00' });
const multiShowResult = checkBaseline('TestMultiShow', multiShowEvents);
check('multi-show venue: NOT quarantined (distinct times)', multiShowResult.quarantined === false);

// True duplication: same name AND same time (extraction error)
sh['TestTrueDupes'] = { ...mkEntry(), history: buildHistory(20, 5) };
const trueDupeEvents = [];
for (let i = 0; i < 15; i++) {
  trueDupeEvents.push({ name: 'Broken Event', venue_name: 'V', date_local: '2026-03-07', start_time_local: '2026-03-07T20:00:00' });
}
for (let i = 0; i < 5; i++) {
  trueDupeEvents.push({ name: `Other ${i}`, venue_name: 'V', date_local: '2026-03-07', start_time_local: '2026-03-07T19:00:00' });
}
const trueDupeResult = checkBaseline('TestTrueDupes', trueDupeEvents);
check('true duplication: quarantined (same name+time)', trueDupeResult.quarantined === true);

delete sh['TestMultiShow'];
delete sh['TestTrueDupes'];
```

**Step 2: Run tests to verify multi-show test fails**

Run: `npm test 2>&1 | grep -E "multi-show|true dup|FAIL|passed"`
Expected: "multi-show venue: NOT quarantined" FAILS

**Step 3: Fix duplicate spike detection**

Replace lines 82-94 in `src/scrape-guard.js`:

```javascript
  // 4. Duplicate spike — but allow legitimate multi-show venues (same name, different times)
  const nameCounts = {};
  const nameTimeCounts = {};
  for (const e of events) {
    const name = (e.name || '').toLowerCase().trim();
    if (!name) continue;
    nameCounts[name] = (nameCounts[name] || 0) + 1;
    const timeKey = `${name}|${(e.start_time_local || '').slice(0, 16)}`;
    nameTimeCounts[timeKey] = (nameTimeCounts[timeKey] || 0) + 1;
  }
  const maxDupes = Math.max(0, ...Object.values(nameCounts));
  if (events.length > 5 && maxDupes / events.length > DUPLICATE_THRESHOLD) {
    // Check if the duplicates have distinct time slots
    const dupeName = Object.entries(nameCounts).find(([_, c]) => c === maxDupes)?.[0];
    const distinctTimes = Object.keys(nameTimeCounts).filter(k => k.startsWith(dupeName + '|')).length;
    // If most occurrences have unique time slots, it's a multi-show venue, not an error
    if (distinctTimes < maxDupes * 0.7) {
      return {
        quarantined: true,
        reason: `duplicate spike: "${dupeName}" appears ${maxDupes}/${events.length} times`,
      };
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "multi-show|true dup|FAIL|passed"`
Expected: Both PASS

**Step 5: Commit**

```
git add src/scrape-guard.js test/unit/scrape-guard.test.js
git commit -m "fix: allow multi-show venues in duplicate spike detection"
```

---

### Task 3: Yutori Extraction Quality — Tighten Filters

**Problem:** Yutori extracts garbage: "Release date: April 1, 2026", Netflix docs, fintech analysis, "Film at Lincoln Center" (venue as event name). Three layers need tightening.

**Files:**
- Modify: `src/sources/yutori/email-filter.js` (add non-event patterns)
- Modify: `src/sources/yutori/fetch.js:187` (revise extraction preamble)
- Modify: `src/sources/yutori/fetch.js:198-211` (strengthen content filters)
- Modify: `src/events.js` (extend `isGarbageName` for venue-as-name patterns)
- Test: `test/unit/events.test.js` (new isGarbageName cases)

**Step 1: Write failing tests for new garbage name patterns**

Add to `test/unit/events.test.js` after existing isGarbageName tests:

```javascript
// Venue-as-name and non-event patterns
check('rejects "Film at Lincoln Center"', isGarbageName('Film at Lincoln Center'));
check('rejects "Release date: April 1, 2026"', isGarbageName('Release date: April 1, 2026'));
check('rejects "Untold: The Death & Life of Lamar Odom"', !isGarbageName('Untold: The Death & Life of Lamar Odom'));
check('keeps "Jazz at Lincoln Center Orchestra"', !isGarbageName('Jazz at Lincoln Center Orchestra'));
check('keeps "Film Forum Double Feature"', !isGarbageName('Film Forum Double Feature'));
```

Note: "Film at Lincoln Center" should be caught (too generic — 3 words, starts with generic noun + "at" + venue). But "Jazz at Lincoln Center Orchestra" is a real event name.

**Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "Film at|Release date|FAIL|passed"`

**Step 3: Extend isGarbageName in events.js**

Add new patterns to the `isGarbageName` function (after the existing patterns):

```javascript
// "Release date:" prefix — movie/product announcements
const RELEASE_DATE_RE = /^release\s+date/i;

function isGarbageName(name) {
  if (!name || name.length < 4) return true;
  if (GARBAGE_NAME_RE.test(name)) return true;
  if (RELEASE_DATE_RE.test(name)) return true;
  // Name is just a date string
  const stripped = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  if (DATE_ONLY_RE.test(stripped)) return true;
  // Too-generic "X at Venue" pattern (e.g. "Film at Lincoln Center")
  // Only flag if the name is 3-5 words and matches "Word at Words"
  const words = name.trim().split(/\s+/);
  if (words.length >= 3 && words.length <= 5 && /^[a-z]+$/i.test(words[0]) && words[1].toLowerCase() === 'at') return true;
  return false;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "Film at|Release|Jazz at|FAIL|passed"`
Expected: All PASS. "Jazz at Lincoln Center Orchestra" has 5+ words so it passes. "Film at Lincoln Center" has 4 words and matches the pattern.

Wait — "Jazz at Lincoln Center Orchestra" is 5 words and matches "Word at Words" pattern too. We need to refine: only flag when the first word is a generic noun (Film, Music, Art, Event, Show). Let me adjust.

Actually, reconsider: "Film at Lincoln Center" is really "Film" + "at Lincoln Center" — the event name is just the word "Film" plus a venue. But "Jazz at Lincoln Center Orchestra" includes "Orchestra" which makes it specific. Better approach: check if removing "at Venue" leaves a single generic word.

Simpler: just check if the first word before "at" is a single common word (< 2 words before "at"):

```javascript
  // Too-generic "X at Venue" — single generic word + "at" + venue name
  // Catches: "Film at Lincoln Center", "Art at The Shed"
  // Keeps: "Jazz at Lincoln Center Orchestra", "Live Music at Brooklyn Bowl"
  const atIdx = words.findIndex(w => w.toLowerCase() === 'at');
  if (atIdx === 1 && words.length <= 5) return true;
```

This catches "Film at Lincoln Center" (1 word before "at") but keeps "Jazz at Lincoln Center Orchestra" (still 1 word before "at", 5 words total)... hmm, that would also catch it.

Actually let me step back. "Film at Lincoln Center" is only garbage because "Film" alone isn't an event name. Let's just use a set of known-generic single words:

```javascript
  const GENERIC_PREFIXES = new Set(['film', 'art', 'music', 'event', 'show', 'concert', 'performance']);
  const atMatch = name.match(/^(\w+)\s+at\s+/i);
  if (atMatch && GENERIC_PREFIXES.has(atMatch[1].toLowerCase())) return true;
```

This catches "Film at Lincoln Center" but keeps "Jazz at Lincoln Center Orchestra" and "Blade Rave at Elsewhere".

**Step 5: Update the tests to match**

```javascript
check('rejects "Film at Lincoln Center"', isGarbageName('Film at Lincoln Center'));
check('rejects "Art at The Shed"', isGarbageName('Art at The Shed'));
check('keeps "Jazz at Lincoln Center Orchestra"', !isGarbageName('Jazz at Lincoln Center Orchestra'));
check('keeps "Blade Rave at Elsewhere"', !isGarbageName('Blade Rave at Elsewhere'));
check('keeps "Live Music at Brooklyn Bowl"', !isGarbageName('Live Music at Brooklyn Bowl'));
```

Wait — "Live Music at Brooklyn Bowl" starts with "Live" not in GENERIC_PREFIXES. But "Music at The Bell House"? "Music" is in the set. Need to think about this more. Actually "Music at The Bell House" probably IS garbage — it's too generic. So the set approach works.

**Step 6: Tighten email-filter.js**

Add new patterns to `NON_EVENT_CATEGORIES` and `NON_EVENT_FILENAMES` in `src/sources/yutori/email-filter.js`:

```javascript
const NON_EVENT_CATEGORIES = [
  // ... existing patterns ...
  // streaming / media releases
  /streaming/i, /netflix/i, /hulu/i, /disney\+/i, /prime\s+video/i, /apple\s+tv/i,
  /release\s+date/i, /coming\s+soon/i,
  // academic / research
  /research/i, /academic/i, /whitepaper/i, /case\s+study/i,
  // AI/tech analysis (not events)
  /\bai\s+architecture/i, /\bllm\b/i, /\bmachine\s+learning/i,
];

const NON_EVENT_FILENAMES = [
  // ... existing patterns ...
  /netflix/i, /streaming/i, /hulu/i, /disney/i,
  /release-date/i, /coming-soon/i,
  /research/i, /whitepaper/i, /case-study/i,
];
```

**Step 7: Revise extraction preamble**

In `src/sources/yutori/fetch.js:187`, change the preamble:

From:
```
Extract ALL events — including listening sessions, art openings, comedy, trivia, and small one-offs.
```

To:
```
Extract events that a person could physically attend in NYC — shows, screenings, openings, comedy, trivia, concerts, workshops, and social gatherings.

DO NOT extract:
- Movie/TV release dates or streaming announcements
- Product launches or tech announcements
- Academic papers, research summaries, or industry analysis
- Personal advice, productivity tips, or career coaching
- News articles or opinion pieces about events (extract the event, not the article)
```

**Step 8: Strengthen content filter**

In `src/sources/yutori/fetch.js`, enhance the content filter at lines 198-211. Add after the existing `hasVenue` check (before the final `if (!hasTime && !hasVenue && !hasUrl)` line):

```javascript
            // Reject events whose name is a known garbage pattern
            if (isGarbageName(e.name)) return false;
```

Import `isGarbageName` at the top of `fetch.js`:

```javascript
const { isGarbageName } = require('../../events');
```

Note: This creates a circular dependency risk since events.js requires sources. Check if `isGarbageName` can be extracted to a shared utility or if the lazy require pattern works. If circular, extract `isGarbageName` to `src/curation.js` instead (already has `filterIncomplete`).

**Step 9: Run all tests**

Run: `npm test 2>&1 | grep -E "FAIL|passed"`
Expected: All pass, no regressions

**Step 10: Commit**

```
git add src/events.js src/sources/yutori/email-filter.js src/sources/yutori/fetch.js test/unit/events.test.js
git commit -m "fix: tighten Yutori extraction — reject garbage names, non-event emails, streaming releases"
```

---

### Task 4: Yutori Category Quality — Reduce "Other" Bucket

**Problem:** 41% of Yutori events categorized as "other" because the extraction prompt's category list is too broad and "other" is an easy default. Many "art" events are actually film screenings.

**Files:**
- Modify: `src/sources/yutori/fetch.js:187` (add category guidance to preamble)
- Modify: `src/sources/shared.js:170` (normalize subcategories)
- Test: manual verification via `node scripts/health-timeline.js` after deploy

**Step 1: Add category guidance to Yutori preamble**

In `src/sources/yutori/fetch.js:187`, append to the preamble (after the DO NOT extract block from Task 3):

```
CATEGORY GUIDANCE:
- "nightlife" — DJ sets, dance parties, raves, club nights, bar events
- "live_music" — concerts, live bands, album release shows, jazz, open mics with music
- "comedy" — stand-up, improv, sketch, roasts, open mics (comedy)
- "art" — gallery openings, exhibitions, art installations, visual art
- "film" — movie screenings, film festivals, repertory cinema, film series
- "theater" — plays, musicals, dance performances, spoken word
- "community" — meetups, workshops, classes, social gatherings, book clubs, board games
- "food_drink" — food festivals, tastings, pop-up dinners, happy hours
- "trivia" — pub trivia, quiz nights
- Prefer a specific category over "other". Only use "other" if the event truly doesn't fit any above.
```

Note: "film" is added as a new category option in the Yutori preamble. The global EXTRACTION_PROMPT uses `art` for film, but we can normalize `film` → `art` with a subcategory in shared.js to avoid breaking downstream.

**Step 2: Add film → art normalization with subcategory**

In `src/sources/shared.js`, update the category normalization at line 170:

```javascript
category: e.category === 'music' ? 'live_music'
  : e.category === 'film' ? 'art'
  : (e.category || 'other'),
subcategory: e.category === 'film' ? 'film'
  : (e.subcategory || null),
```

**Step 3: Run tests**

Run: `npm test 2>&1 | grep -E "FAIL|passed"`
Expected: No regressions

**Step 4: Commit**

```
git add src/sources/yutori/fetch.js src/sources/shared.js
git commit -m "fix: improve Yutori categorization — add film, reduce 'other' bucket"
```

---

## Execution Notes

- Tasks 1-4 are independent and can be done in any order
- Task 3 step 8 has a circular dependency risk — check if `require('../../events')` works from `sources/yutori/fetch.js` or extract `isGarbageName` to `src/curation.js`
- After all tasks, run `npm test` to verify no regressions (expect 894+ pass, 1 pre-existing fail)
- Deploy to Railway and monitor next scrape cycle for: Yutori not quarantined, TinyCupboard not quarantined, fewer "other" category events
