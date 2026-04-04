# Data Quality & Pool Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing event pool fully usable for the "standing on a corner" user by filling data gaps at scrape time, adding coverage diagnostics, and improving pool matching for time/location.

**Architecture:** Three phases that each deliver independently. Phase 1 adds a scrape-time enrichment pipeline (search → fetch → verify) that fills missing URLs, times, and descriptions. Phase 2 adds a coverage diagnostics matrix to the health dashboard. Phase 3 improves pool matching with "happening now" scoring and automatic neighborhood expansion.

**Tech Stack:** Node.js, Tavily API (already integrated), Claude Haiku (via existing `llm.js`), custom test harness (`test/helpers.js`)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/enrich.js` | Create | Scrape-time enrichment pipeline: search, fetch, verify, fill gaps |
| `src/events.js` | Modify | Call `enrichEvents()` after extraction, call `backfillNeighborhoodFromVenue()` at scrape time, add `computeCoverageMatrix()` |
| `src/source-health.js` | Modify | Add `computeCoverageMatrix()`, wire into `getHealthStatus()` |
| `src/health-ui.html` | Modify | Add coverage heatmap section |
| `src/brain-execute.js` | Modify | Add `isHappeningNow()` boost, auto-expand to adjacent hoods on sparse |
| `src/pipeline.js` | Modify | Add time-proximity scoring |
| `test/unit/enrich.test.js` | Create | Tests for enrichment pipeline |
| `test/unit/coverage.test.js` | Create | Tests for coverage matrix |
| `test/unit/time-proximity.test.js` | Create | Tests for happening-now scoring |

---

## Phase 1: Enrichment Pipeline (fill data gaps at scrape time)

### Task 1: Enrichment module — search for missing URLs

**Files:**
- Create: `src/enrich.js`
- Create: `test/unit/enrich.test.js`

- [ ] **Step 1: Write failing tests for URL enrichment**

```js
// test/unit/enrich.test.js
const { check } = require('../helpers');

console.log('enrich.test.js');

// Test: identifyGaps flags events missing URLs
const { identifyGaps } = require('../../src/enrich');

const complete = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: 'https://example.com', start_time_local: '2026-04-04T20:00:00', description_short: 'Live jazz' };
const missingUrl = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: null, ticket_url: null, start_time_local: '2026-04-04T20:00:00', description_short: 'Live jazz' };
const missingTime = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: 'https://example.com', start_time_local: null, description_short: 'Live jazz' };
const missingDesc = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: 'https://example.com', start_time_local: '2026-04-04T20:00:00', description_short: null, description: null };
const missingAll = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: null, ticket_url: null, start_time_local: null, description_short: null, description: null };

const gaps = identifyGaps([complete, missingUrl, missingTime, missingDesc, missingAll]);
check('identifyGaps: complete event has no gaps', gaps.get(complete) === undefined);
check('identifyGaps: missing URL flagged', gaps.get(missingUrl).includes('url'));
check('identifyGaps: missing time flagged', gaps.get(missingTime).includes('time'));
check('identifyGaps: missing desc flagged', gaps.get(missingDesc).includes('description'));
check('identifyGaps: missing all has 3 gaps', gaps.get(missingAll).length === 3);

// Test: buildSearchQuery creates sensible query
const { buildSearchQuery } = require('../../src/enrich');
check('buildSearchQuery: includes name and venue', buildSearchQuery(missingUrl) === '"Jazz Night" "Blue Note" NYC');
check('buildSearchQuery: no venue uses name only', buildSearchQuery({ name: 'Jazz Night', venue_name: null }) === '"Jazz Night" NYC');

module.exports = { check };
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/enrich.test.js`
Expected: FAIL — `Cannot find module '../../src/enrich'`

- [ ] **Step 3: Implement identifyGaps and buildSearchQuery**

```js
// src/enrich.js
/**
 * Scrape-time enrichment pipeline.
 * Fills missing URLs, times, and descriptions by searching the web.
 * Runs after extraction, before cache persistence.
 */

/**
 * Identify which events have data gaps worth filling.
 * Returns a Map<event, string[]> of gap types.
 */
function identifyGaps(events) {
  const gaps = new Map();
  for (const e of events) {
    const missing = [];
    if (!e.source_url && !e.ticket_url) missing.push('url');
    if (!e.start_time_local) missing.push('time');
    if (!e.description_short && !e.description) missing.push('description');
    if (missing.length > 0 && e.name && e.venue_name) {
      gaps.set(e, missing);
    }
  }
  return gaps;
}

/**
 * Build a search query for an event with missing data.
 */
function buildSearchQuery(event) {
  const parts = [`"${event.name}"`];
  if (event.venue_name) parts.push(`"${event.venue_name}"`);
  parts.push('NYC');
  return parts.join(' ');
}

module.exports = { identifyGaps, buildSearchQuery };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/unit/enrich.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/enrich.js test/unit/enrich.test.js
git commit -m "feat: enrichment module with gap identification and search query builder"
```

### Task 2: Enrichment module — fetch and extract metadata from search results

**Files:**
- Modify: `src/enrich.js`
- Modify: `test/unit/enrich.test.js`

- [ ] **Step 1: Write failing tests for metadata extraction**

Append to `test/unit/enrich.test.js`:

```js
// Test: extractMetaFromHtml pulls og tags and time patterns
const { extractMetaFromHtml } = require('../../src/enrich');

const html1 = `<html><head>
  <meta property="og:url" content="https://dice.fm/event/jazz-night">
  <meta property="og:description" content="Live jazz at Blue Note featuring the quartet.">
</head><body><p>Doors at 8:00 PM</p></body></html>`;

const meta1 = extractMetaFromHtml(html1);
check('extractMeta: finds og:url', meta1.url === 'https://dice.fm/event/jazz-night');
check('extractMeta: finds og:description', meta1.description === 'Live jazz at Blue Note featuring the quartet.');

const html2 = '<html><head></head><body>Nothing useful here</body></html>';
const meta2 = extractMetaFromHtml(html2);
check('extractMeta: empty when no og tags', meta2.url === null && meta2.description === null);

const html3 = '<html><head><meta property="og:description" content="A short one"></head><body></body></html>';
const meta3 = extractMetaFromHtml(html3);
check('extractMeta: description without url', meta3.url === null && meta3.description === 'A short one');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/enrich.test.js`
Expected: FAIL — `extractMetaFromHtml is not a function`

- [ ] **Step 3: Implement extractMetaFromHtml**

Add to `src/enrich.js`:

```js
/**
 * Extract useful metadata from an HTML page.
 * Pulls og:url, og:description from <meta> tags.
 */
function extractMetaFromHtml(html) {
  const result = { url: null, description: null };

  const ogUrl = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  if (ogUrl) result.url = ogUrl[1];

  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (ogDesc) result.description = ogDesc[1];

  // Also check content-first attribute order
  if (!result.url) {
    const ogUrl2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
    if (ogUrl2) result.url = ogUrl2[1];
  }
  if (!result.description) {
    const ogDesc2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
    if (ogDesc2) result.description = ogDesc2[1];
  }

  return result;
}
```

Add to module.exports: `extractMetaFromHtml`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/unit/enrich.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/enrich.js test/unit/enrich.test.js
git commit -m "feat: extract og metadata from HTML for enrichment"
```

### Task 3: Enrichment orchestrator — enrichEvents() with Tavily search

**Files:**
- Modify: `src/enrich.js`

- [ ] **Step 1: Implement enrichEvents()**

Add to `src/enrich.js`:

```js
const ENRICHMENT_CONCURRENCY = 5;
const ENRICHMENT_TIMEOUT_MS = 10_000;
const MAX_ENRICH_PER_SCRAPE = 50; // cap to control cost

/**
 * Enrich events with missing data by searching the web.
 * Called after extraction, before cache persistence.
 * Modifies events in-place. Returns count of events enriched.
 */
async function enrichEvents(events) {
  const gaps = identifyGaps(events);
  if (gaps.size === 0) {
    console.log('[ENRICH] No events need enrichment');
    return 0;
  }

  // Skip events already attempted
  const toEnrich = [];
  for (const [event, missing] of gaps) {
    if (event.enrichment_attempted) continue;
    toEnrich.push({ event, missing });
  }

  if (toEnrich.length === 0) {
    console.log('[ENRICH] All gap events already attempted');
    return 0;
  }

  // Cap per scrape to control cost
  const batch = toEnrich.slice(0, MAX_ENRICH_PER_SCRAPE);
  console.log(`[ENRICH] Enriching ${batch.length}/${toEnrich.length} events (${gaps.size} total with gaps)`);

  let enriched = 0;

  // Process in parallel batches
  for (let i = 0; i < batch.length; i += ENRICHMENT_CONCURRENCY) {
    const chunk = batch.slice(i, i + ENRICHMENT_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(({ event, missing }) => enrichSingleEvent(event, missing))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) enriched++;
    }
  }

  console.log(`[ENRICH] Enriched ${enriched}/${batch.length} events`);
  return enriched;
}

/**
 * Enrich a single event. Searches Tavily, fetches first result, extracts metadata.
 * Modifies event in-place. Returns true if any field was filled.
 */
async function enrichSingleEvent(event, missing) {
  event.enrichment_attempted = true;
  let filled = false;

  try {
    const query = buildSearchQuery(event);

    // Use Tavily if available, otherwise skip
    let searchUrl = null;
    let searchDescription = null;

    try {
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!tavilyKey) return false;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ENRICHMENT_TIMEOUT_MS);

      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          max_results: 3,
          include_answer: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        const results = data.results || [];
        if (results.length > 0) {
          searchUrl = results[0].url;
          searchDescription = results[0].content?.slice(0, 300) || null;
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn(`[ENRICH] Search failed for "${event.name}":`, err.message);
      }
      return false;
    }

    // Fill gaps from search results
    if (missing.includes('url') && searchUrl) {
      event.source_url = searchUrl;
      event.enrichment_source = 'tavily';
      filled = true;
    }
    if (missing.includes('description') && searchDescription) {
      event.description_short = searchDescription;
      event.enrichment_source = 'tavily';
      filled = true;
    }

    return filled;
  } catch (err) {
    console.warn(`[ENRICH] Failed for "${event.name}":`, err.message);
    return false;
  }
}
```

Add to module.exports: `enrichEvents`.

- [ ] **Step 2: Run full test suite to verify no breakage**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add src/enrich.js
git commit -m "feat: enrichEvents orchestrator with Tavily search"
```

### Task 4: Wire enrichment into scrape pipeline

**Files:**
- Modify: `src/events.js:659` (after geocoding, before SQLite write)

- [ ] **Step 1: Add enrichment call to refreshCache()**

In `src/events.js`, after the geocoding block (line ~665) and before the geo bounds filter (line ~669), add:

```js
    // Enrich events missing URLs, times, descriptions
    try {
      const { enrichEvents } = require('./enrich');
      const enrichCount = await enrichEvents(validEvents);
      if (enrichCount > 0) console.log(`Enrichment: filled gaps for ${enrichCount} events`);
    } catch (err) {
      console.warn('Enrichment failed, continuing:', err.message);
    }
```

- [ ] **Step 2: Add enrichment call to refreshSources() too**

In `src/events.js`, in `refreshSources()`, after `await batchGeocodeEvents(validNew)` (line ~994) add the same block:

```js
    // Enrich events missing URLs, times, descriptions
    try {
      const { enrichEvents } = require('./enrich');
      const enrichCount = await enrichEvents(validNew);
      if (enrichCount > 0) console.log(`Enrichment: filled gaps for ${enrichCount} events`);
    } catch (err) {
      console.warn('Enrichment failed, continuing:', err.message);
    }
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 4: Commit**

```bash
git add src/events.js
git commit -m "feat: wire enrichment pipeline into scrape refresh"
```

### Task 5: Move neighborhood backfill to scrape time

**Files:**
- Modify: `src/events.js:662` (in refreshCache, after geocoding)

- [ ] **Step 1: Add backfillNeighborhoodFromVenue call at scrape time**

In `src/events.js`, inside `refreshCache()`, after the geocoding block (line ~665) and after the enrichment block just added, add:

```js
    // Backfill neighborhoods from known venues at scrape time
    // (also runs at query time in applyQualityGates, but scrape-time
    // ensures venue-known events pass the hasValidNeighborhood gate)
    backfillNeighborhoodFromVenue(validEvents);
```

Do the same in `refreshSources()` after `batchGeocodeEvents(validNew)`:

```js
    backfillNeighborhoodFromVenue(validNew);
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add src/events.js
git commit -m "fix: backfill neighborhoods from venues at scrape time, not just query time"
```

---

## Phase 2: Coverage Diagnostics

### Task 6: Coverage matrix computation

**Files:**
- Modify: `src/source-health.js`
- Create: `test/unit/coverage.test.js`

- [ ] **Step 1: Write failing tests for coverage matrix**

```js
// test/unit/coverage.test.js
const { check } = require('../helpers');

console.log('coverage.test.js');

const { computeCoverageMatrix } = require('../../src/source-health');

// Build test events across 2 neighborhoods, 2 categories, 2 dates
const events = [
  { neighborhood: 'Williamsburg', category: 'live_music', date_local: '2026-04-04', start_time_local: '2026-04-04T20:00:00', source_url: 'https://x.com' },
  { neighborhood: 'Williamsburg', category: 'live_music', date_local: '2026-04-04', start_time_local: '2026-04-04T21:00:00', source_url: 'https://x.com' },
  { neighborhood: 'Williamsburg', category: 'comedy', date_local: '2026-04-05', start_time_local: null, source_url: null },
  { neighborhood: 'Bushwick', category: 'live_music', date_local: '2026-04-04', start_time_local: '2026-04-04T22:00:00', source_url: 'https://x.com' },
];

const matrix = computeCoverageMatrix(events);

check('coverage: has neighborhood entries', matrix.byNeighborhood['Williamsburg'] !== undefined);
check('coverage: Williamsburg has 3 events', matrix.byNeighborhood['Williamsburg'].total === 3);
check('coverage: Williamsburg complete is 2', matrix.byNeighborhood['Williamsburg'].complete === 2);
check('coverage: Bushwick has 1 event', matrix.byNeighborhood['Bushwick'].total === 1);
check('coverage: category breakdown exists', matrix.byCategory['live_music'] !== undefined);
check('coverage: live_music count is 3', matrix.byCategory['live_music'].total === 3);
check('coverage: summary has total', matrix.summary.total === 4);
check('coverage: summary has completeRate', matrix.summary.completeRate > 0);

module.exports = { check };
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/coverage.test.js`
Expected: FAIL — `computeCoverageMatrix is not a function`

- [ ] **Step 3: Implement computeCoverageMatrix**

Add to `src/source-health.js`:

```js
/**
 * Compute a coverage matrix: neighborhood × category with completeness stats.
 * An event is "complete" if it has time + neighborhood + (URL or description).
 */
function computeCoverageMatrix(events) {
  const isComplete = e => !!e.start_time_local && !!e.neighborhood && (!!e.source_url || !!e.ticket_url || !!e.description_short);

  const byNeighborhood = {};
  const byCategory = {};
  const byDate = {};
  let totalComplete = 0;

  for (const e of events) {
    const hood = e.neighborhood || 'Unknown';
    const cat = e.category || 'other';
    const date = e.date_local || 'undated';
    const complete = isComplete(e);
    if (complete) totalComplete++;

    if (!byNeighborhood[hood]) byNeighborhood[hood] = { total: 0, complete: 0, categories: {} };
    byNeighborhood[hood].total++;
    if (complete) byNeighborhood[hood].complete++;
    byNeighborhood[hood].categories[cat] = (byNeighborhood[hood].categories[cat] || 0) + 1;

    if (!byCategory[cat]) byCategory[cat] = { total: 0, complete: 0 };
    byCategory[cat].total++;
    if (complete) byCategory[cat].complete++;

    if (!byDate[date]) byDate[date] = { total: 0, complete: 0 };
    byDate[date].total++;
    if (complete) byDate[date].complete++;
  }

  return {
    byNeighborhood,
    byCategory,
    byDate,
    summary: {
      total: events.length,
      complete: totalComplete,
      completeRate: events.length > 0 ? Math.round(totalComplete / events.length * 100) : 0,
      neighborhoods: Object.keys(byNeighborhood).length,
      categories: Object.keys(byCategory).length,
    },
  };
}
```

Add `computeCoverageMatrix` to module.exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/unit/coverage.test.js`
Expected: All PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add src/source-health.js test/unit/coverage.test.js
git commit -m "feat: coverage matrix computation for diagnostics"
```

### Task 7: Wire coverage matrix into health API and dashboard

**Files:**
- Modify: `src/events.js:1376` (getHealthStatus)
- Modify: `src/health-ui.html`

- [ ] **Step 1: Add coverage matrix to health API response**

In `src/events.js`, in `getHealthStatus()`, after `result.eventMix = computeEventMix(eventCache)`, add:

```js
  const { computeCoverageMatrix } = require('./source-health');
  result.coverageMatrix = computeCoverageMatrix(eventCache);
```

- [ ] **Step 2: Add coverage heatmap section to health UI HTML**

In `src/health-ui.html`, after the `data-gaps-section` div, add:

```html
<div class="event-mix-summary" id="coverage-section" style="display:none">
  <h2 style="font-size:16px;font-weight:600;color:#aaa;margin-bottom:12px">Coverage Matrix</h2>
  <div class="summary-row" id="coverage-summary-cards"></div>
  <div id="coverage-heatmap" style="margin-top:12px"></div>
</div>
```

- [ ] **Step 3: Add renderCoverageMatrix function to health UI JS**

In `src/health-ui.html`, after the `renderEventMix` function's closing brace, add:

```js
function renderCoverageMatrix(matrix) {
  const section = $('coverage-section');
  if (!matrix || !matrix.summary) { section.style.display = 'none'; return; }
  section.style.display = '';

  // Summary cards
  $('coverage-summary-cards').innerHTML = [
    { label: 'Usable Events', value: `${matrix.summary.complete}/${matrix.summary.total}`, sub: `${matrix.summary.completeRate}% complete` },
    { label: 'Neighborhoods', value: matrix.summary.neighborhoods, sub: 'with events' },
    { label: 'Categories', value: matrix.summary.categories, sub: 'represented' },
  ].map(c => `<div class="summary-card"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`).join('');

  // Top neighborhoods heatmap (sorted by event count)
  const hoods = Object.entries(matrix.byNeighborhood)
    .filter(([name]) => name !== 'Unknown')
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20);

  if (hoods.length === 0) { $('coverage-heatmap').innerHTML = ''; return; }

  const maxCount = Math.max(...hoods.map(([,h]) => h.total));
  let html = '<div style="font-size:11px;color:#666;margin-bottom:6px">Top 20 neighborhoods by event count</div>';
  for (const [name, data] of hoods) {
    const pct = (data.total / maxCount * 100).toFixed(0);
    const completePct = data.total > 0 ? Math.round(data.complete / data.total * 100) : 0;
    const barColor = completePct >= 80 ? '#4ade80' : completePct >= 50 ? '#fbbf24' : '#f87171';
    html += `<div class="gaps-row" title="${name}: ${data.total} events, ${completePct}% complete">`;
    html += `<span class="gaps-name">${name}</span>`;
    html += `<div class="gaps-track"><div class="gaps-seg" style="width:${pct}%;background:${barColor}" title="${data.complete}/${data.total} complete"></div></div>`;
    html += `<span class="gaps-count">${data.total} (${completePct}%)</span>`;
    html += '</div>';
  }
  $('coverage-heatmap').innerHTML = html;
}
```

- [ ] **Step 4: Call renderCoverageMatrix in the refresh function**

In the health UI's `refresh` callback (where `renderEventMix` is called), add after it:

```js
    safe(() => renderCoverageMatrix(data.coverageMatrix));
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add src/events.js src/source-health.js src/health-ui.html
git commit -m "feat: coverage matrix on health dashboard with neighborhood heatmap"
```

---

## Phase 3: Smarter Pool Matching

### Task 8: Time-proximity scoring — "happening now" boost

**Files:**
- Modify: `src/pipeline.js`
- Create: `test/unit/time-proximity.test.js`

- [ ] **Step 1: Write failing tests for time proximity**

```js
// test/unit/time-proximity.test.js
const { check } = require('../helpers');

console.log('time-proximity.test.js');

const { computeTimeProximityBoost } = require('../../src/pipeline');

// Mock "now" as 9pm
const now = new Date('2026-04-04T21:00:00-04:00');

// Event happening right now (started at 8pm, ends at 11pm)
const happeningNow = { start_time_local: '2026-04-04T20:00:00', end_time_local: '2026-04-04T23:00:00', date_local: '2026-04-04' };
check('happening now gets high boost', computeTimeProximityBoost(happeningNow, now) >= 0.3);

// Event starting in 1 hour
const startingSoon = { start_time_local: '2026-04-04T22:00:00', date_local: '2026-04-04' };
check('starting in 1hr gets moderate boost', computeTimeProximityBoost(startingSoon, now) >= 0.15);

// Event starting in 4 hours
const laterTonight = { start_time_local: '2026-04-05T01:00:00', date_local: '2026-04-05' };
check('starting in 4hr gets small boost', computeTimeProximityBoost(laterTonight, now) >= 0.0);
check('starting in 4hr gets less than starting soon', computeTimeProximityBoost(laterTonight, now) < computeTimeProximityBoost(startingSoon, now));

// Event that already ended
const alreadyEnded = { start_time_local: '2026-04-04T17:00:00', end_time_local: '2026-04-04T19:00:00', date_local: '2026-04-04' };
check('already ended gets zero', computeTimeProximityBoost(alreadyEnded, now) === 0);

// Event with no time
const noTime = { date_local: '2026-04-04' };
check('no time gets zero boost', computeTimeProximityBoost(noTime, now) === 0);

module.exports = { check };
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/time-proximity.test.js`
Expected: FAIL — `computeTimeProximityBoost is not a function`

- [ ] **Step 3: Implement computeTimeProximityBoost**

Add to `src/pipeline.js`:

```js
/**
 * Compute a time-proximity boost for an event relative to "now."
 * Returns 0.0–0.4 bonus score:
 *   - 0.4 if event is happening right now
 *   - 0.2–0.3 if starting within 2 hours
 *   - 0.05–0.15 if starting within 4 hours
 *   - 0 if already ended, no time, or >4 hours away
 */
function computeTimeProximityBoost(event, now = new Date()) {
  if (!event.start_time_local) return 0;

  const start = new Date(event.start_time_local);
  const end = event.end_time_local ? new Date(event.end_time_local) : null;
  const nowMs = now.getTime();

  // Already ended
  if (end && end.getTime() < nowMs) return 0;

  // Happening now (started but not ended)
  if (start.getTime() <= nowMs && (!end || end.getTime() > nowMs)) return 0.4;

  // Future event — boost inversely proportional to time until start
  const hoursUntilStart = (start.getTime() - nowMs) / (1000 * 60 * 60);
  if (hoursUntilStart <= 0) return 0.4; // just started
  if (hoursUntilStart <= 1) return 0.3;
  if (hoursUntilStart <= 2) return 0.2;
  if (hoursUntilStart <= 3) return 0.1;
  if (hoursUntilStart <= 4) return 0.05;
  return 0;
}
```

Add `computeTimeProximityBoost` to module.exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/unit/time-proximity.test.js`
Expected: All PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.js test/unit/time-proximity.test.js
git commit -m "feat: time-proximity boost for happening-now events"
```

### Task 9: Wire time-proximity boost into pool scoring

**Files:**
- Modify: `src/brain-execute.js`

- [ ] **Step 1: Add time proximity boost to scoreAndCurate**

In `src/brain-execute.js`, in the `scoreAndCurate` function (where `scoreInterestingness` is called for each event), add a time proximity boost after the interestingness score is computed.

Find the line where events get scored (in the `fullScoredPool` creation), and after `interestingness` is set, add:

```js
const { computeTimeProximityBoost } = require('./pipeline');
```

At the top of the file (with other requires).

Then in the scoring loop, after each event's interestingness score is computed:

```js
e.interestingness += computeTimeProximityBoost(e);
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add src/brain-execute.js
git commit -m "feat: wire time-proximity boost into pool scoring"
```

### Task 10: Auto-expand to adjacent neighborhoods on sparse results

**Files:**
- Modify: `src/brain-execute.js`

- [ ] **Step 1: Modify buildSearchPool to auto-expand when sparse**

In `src/brain-execute.js`, in `buildSearchPool`, after the pool is built and `isSparse` is determined (around line 339), add automatic expansion logic. Find the section after `taggedResult` is computed:

```js
  // Auto-expand to adjacent neighborhoods when results are sparse
  if (isSparse && hood && !isBorough && !isCitywide) {
    const expandHoods = getAdjacentNeighborhoods(hood, 3);
    if (expandHoods.length > 0) {
      console.log(`[POOL] Sparse results for ${hood} (${matchCount} matches), expanding to: ${expandHoods.join(', ')}`);
      // Get events from adjacent hoods that pass filters
      const qualityEvents = getEvents();
      const adjacentEvents = qualityEvents.filter(e =>
        expandHoods.includes(e.neighborhood) && !curated.some(c => c.id === e.id)
      );
      if (adjacentEvents.length > 0) {
        // Tag adjacent events as [NEARBY] so the model knows
        for (const e of adjacentEvents) {
          e._nearby = true;
          e._nearbyFrom = hood;
        }
        // Add best adjacent events to pool (up to fill poolSize)
        const needed = poolSize - events.length;
        if (needed > 0) {
          const sorted = adjacentEvents.sort((a, b) => (b.interestingness || 0) - (a.interestingness || 0));
          events.push(...sorted.slice(0, needed));
        }
      }
    }
  }
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add src/brain-execute.js
git commit -m "feat: auto-expand to adjacent neighborhoods on sparse results"
```

---

## Phase 3.5: Deploy and Verify

### Task 11: Full test suite and deploy

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 2: Deploy to Railway**

```bash
railway up --detach
```

Wait ~2-3 minutes for build.

- [ ] **Step 3: Trigger a scrape and verify enrichment**

```bash
curl -s -X POST "https://web-production-c8fdb.up.railway.app/api/scrape?sources=yutori" | python3 -c "
import json, sys
data = json.load(sys.stdin)
events = data.get('events', [])
yutori = [e for e in events if 'yutori' in e.get('source_name','')]
enriched = [e for e in yutori if e.get('enrichment_source')]
print(f'Yutori: {len(yutori)} total, {len(enriched)} enriched')
"
```

Expected: Some enriched events (depends on Tavily results).

- [ ] **Step 4: Verify health dashboard shows coverage matrix**

Open `https://web-production-c8fdb.up.railway.app/health` in browser. Confirm:
- Event Mix section shows date coverage, categories, neighborhoods, free/paid
- Event Composition section shows unique/recurring/trivia counts
- Data Gaps section shows all 6 sources
- Coverage Matrix section shows usable event rate and neighborhood heatmap

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "fix: post-deploy adjustments"
```
