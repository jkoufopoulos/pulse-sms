# Post-Scrape LLM Enrichment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After scraping, send any event with missing critical fields through LLM extraction to fill gaps — catching parser limitations and source drift automatically.

**Architecture:** Skint's deterministic parser stashes `_rawText` on each event. After `refreshCache()` merges all events, `enrichIncompleteEvents()` collects every event that has `_rawText` and is missing `start_time_local` (excluding ongoing/series events), batches them to `extractEvents()`, and merges LLM-extracted fields back. No threshold — if it's missing, try to fill it.

**Tech Stack:** Node.js, existing `extractEvents()` / `normalizeExtractedEvent()` pipeline.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/source-health.js` | Modify | Add `start_time_local` and `neighborhood` to `computeFieldCoverage` |
| `src/scrape-guard.js` | Modify | Update `getBaselineStats` to track new fields |
| `src/enrichment.js` | Create | `enrichIncompleteEvents(events)` — collect incomplete events, send raw text to LLM, merge results back |
| `src/events.js` | Modify | Wire `enrichIncompleteEvents()` into `refreshCache()` after geocoding, before SQLite write |
| `src/sources/skint.js` | Modify | Stash `_rawText` on deterministically-parsed events; remove inline Skint-specific LLM enrichment |
| `test/run-all.js` | Modify | Add tests for enrichment and expanded field coverage |

---

## Chunk 1: Field Coverage + `_rawText`

### Task 1: Expand field coverage tracking

**Files:**
- Modify: `src/source-health.js:72-81` (`computeFieldCoverage`)
- Modify: `src/scrape-guard.js:25-41` (`getBaselineStats`)
- Test: `test/run-all.js`

- [ ] **Step 1: Write failing test for expanded field coverage**

In `test/run-all.js`, add to the source health section:

```js
// computeFieldCoverage includes start_time_local and neighborhood
const { computeFieldCoverage } = require('../src/source-health');
const coverageEvents = [
  { name: 'A', venue_name: 'V', date_local: '2026-03-13', start_time_local: '2026-03-13T19:00:00', neighborhood: 'Williamsburg' },
  { name: 'B', venue_name: 'V', date_local: '2026-03-13', start_time_local: null, neighborhood: 'Bushwick' },
  { name: 'C', venue_name: null, date_local: '2026-03-13', start_time_local: '2026-03-13T20:00:00', neighborhood: null },
];
const coverage = computeFieldCoverage(coverageEvents);
assert(Math.abs(coverage.start_time_local - 0.667) < 0.01, 'start_time_local coverage is 2/3');
assert(Math.abs(coverage.neighborhood - 0.667) < 0.01, 'neighborhood coverage is 2/3');
assert(coverage.name === 1, 'name coverage is 1');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `coverage.start_time_local` is undefined

- [ ] **Step 3: Expand `computeFieldCoverage` to include time and neighborhood**

In `src/source-health.js`, change `computeFieldCoverage`:

```js
function computeFieldCoverage(events) {
  if (!events.length) return { name: 0, venue_name: 0, date_local: 0, start_time_local: 0, neighborhood: 0 };
  const fields = ['name', 'venue_name', 'date_local', 'start_time_local', 'neighborhood'];
  const coverage = {};
  for (const field of fields) {
    const filled = events.filter(e => e[field] != null).length;
    coverage[field] = filled / events.length;
  }
  return coverage;
}
```

- [ ] **Step 4: Update `getBaselineStats` in `scrape-guard.js` to track the new fields**

In `src/scrape-guard.js`, expand the `avgCoverage` computation (lines 25-39):

```js
  const avgCoverage = { name: 0, venue_name: 0, date_local: 0, start_time_local: 0, neighborhood: 0 };
  let coverageEntries = 0;
  for (const h of okEntries) {
    if (h.fieldCoverage) {
      for (const field of Object.keys(avgCoverage)) {
        avgCoverage[field] += h.fieldCoverage[field] || 0;
      }
      coverageEntries++;
    }
  }
  if (coverageEntries > 0) {
    for (const field of Object.keys(avgCoverage)) {
      avgCoverage[field] /= coverageEntries;
    }
  }
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/source-health.js src/scrape-guard.js test/run-all.js
git commit -m "feat: track start_time and neighborhood in source field coverage"
```

---

### Task 2: Add `_rawText` to Skint deterministic parser

**Files:**
- Modify: `src/sources/skint.js` (both `parseSkintParagraph` and `parseOngoingParagraph`)
- Modify: `src/sources/skint.js:441-490` (remove inline Skint-specific LLM enrichment)
- Test: `test/run-all.js`

- [ ] **Step 1: Write failing test for `_rawText` on parsed events**

```js
// Skint deterministic parser stashes _rawText
const { parseSkintParagraph } = require('../src/sources/skint');
const result = parseSkintParagraph('fri 7pm: comedy night: stand-up showcase. Mercury Lounge (Lower East Side), $15.', '2026-03-13');
assert(result._rawText, 'parseSkintParagraph sets _rawText');
assert(result._rawText.includes('comedy night'), '_rawText contains original text');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `result._rawText` is undefined

- [ ] **Step 3: Add `_rawText` to both parser functions**

In `src/sources/skint.js`, add `_rawText: text` to the return object in `parseSkintParagraph` (~line 282):

```js
  return {
    _rawText: text,
    name: eventName,
    // ... rest unchanged
  };
```

Same in `parseOngoingParagraph` (~line 672):

```js
  return {
    _rawText: text,
    name: eventName,
    // ... rest unchanged
  };
```

- [ ] **Step 4: Remove the inline Skint-specific LLM enrichment block**

Replace the Phase 2 enrichment block (the `missingRate > 0.10` code) with the original simple version:

```js
    let events;
    if (captureRate >= 0.6) {
      events = parsed
        .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9))
        .filter(e => e.name && e.completeness >= 0.5);
      console.log(`Skint: ${events.length} events (deterministic)`);
    } else {
      // LLM fallback — send all paragraphs (existing code, unchanged)
      ...
    }
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sources/skint.js test/run-all.js
git commit -m "feat: stash _rawText on Skint parsed events, remove inline enrichment"
```

---

## Chunk 2: Enrichment Engine + Wiring

### Task 3: Create `enrichment.js`

**Files:**
- Create: `src/enrichment.js`
- Test: `test/run-all.js`

- [ ] **Step 1: Write failing test for `collectIncompleteEvents`**

```js
// collectIncompleteEvents finds all events with _rawText missing start_time
const { collectIncompleteEvents } = require('../src/enrichment');
const testEvents = [
  { name: 'A', source_name: 'theskint', start_time_local: '2026-03-13T19:00:00', series_end: null, _rawText: 'fri 7pm: A' },
  { name: 'B', source_name: 'theskint', start_time_local: null, series_end: null, _rawText: 'fri: B: desc. Venue (LES), free.' },
  { name: 'C', source_name: 'theskint', start_time_local: null, series_end: null, _rawText: 'sat: C: desc. Bar (Bushwick), $10.' },
  { name: 'D', source_name: 'theskint', start_time_local: '2026-03-13T20:00:00', series_end: null, _rawText: 'fri 8pm: D' },
  { name: 'E', source_name: 'theskint', start_time_local: null, series_end: '2026-04-01', _rawText: 'thru april: E' },
  { name: 'F', source_name: 'dice', start_time_local: null, series_end: null },
];
const result = collectIncompleteEvents(testEvents);
assert(result.length === 2, 'finds 2 incomplete daily events with _rawText');
assert(result[0].name === 'B', 'first is B');
assert(result[1].name === 'C', 'second is C');
// E excluded (series_end), F excluded (no _rawText), A/D excluded (have time)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Write `enrichment.js`**

Create `src/enrichment.js`:

```js
const { extractEvents } = require('./ai');
const { normalizeExtractedEvent } = require('./sources/shared');

/**
 * Collect all events that have _rawText but are missing start_time_local.
 * Excludes ongoing/series events (they legitimately lack times).
 */
function collectIncompleteEvents(events) {
  return events.filter(e => e._rawText && !e.start_time_local && !e.series_end);
}

/**
 * Post-scrape enrichment: send any event with _rawText and missing
 * start_time through LLM extraction, merge results back.
 * Mutates events in place. Returns enrichment stats.
 */
async function enrichIncompleteEvents(events) {
  const incomplete = collectIncompleteEvents(events);

  if (incomplete.length === 0) {
    return { sent: 0, enriched: 0 };
  }

  console.log(`[ENRICHMENT] ${incomplete.length} events missing start_time — sending to LLM`);

  try {
    const today = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const content = `Published: ${today}\n\n` + incomplete.map(e => e._rawText).join('\n\n');
    const result = await extractEvents(content, 'enrichment', 'enrichment:post-scrape');
    const llmEvents = (result.events || [])
      .map(e => normalizeExtractedEvent(e, 'enrichment', 'curated', 0.9))
      .filter(e => e.name && e.start_time_local);

    let enriched = 0;
    for (const llmEvent of llmEvents) {
      const llmName = llmEvent.name.toLowerCase().slice(0, 30);
      const match = incomplete.find(e =>
        e.name.toLowerCase().slice(0, 30) === llmName
      );
      if (match) {
        match.start_time_local = llmEvent.start_time_local;
        if (llmEvent.end_time_local) match.end_time_local = llmEvent.end_time_local;
        if ((!match.venue_name || match.venue_name === 'TBA') && llmEvent.venue_name && llmEvent.venue_name !== 'TBA') {
          match.venue_name = llmEvent.venue_name;
        }
        if (!match.neighborhood && llmEvent.neighborhood) {
          match.neighborhood = llmEvent.neighborhood;
        }
        enriched++;
      }
    }

    console.log(`[ENRICHMENT] Enriched ${enriched}/${incomplete.length} events`);
    return { sent: incomplete.length, enriched };
  } catch (err) {
    console.warn(`[ENRICHMENT] Failed (non-fatal): ${err.message}`);
    return { sent: incomplete.length, enriched: 0, error: err.message };
  }
}

/**
 * Strip _rawText from all events (call after enrichment, before persistence).
 */
function stripRawText(events) {
  for (const e of events) {
    delete e._rawText;
  }
}

module.exports = { collectIncompleteEvents, enrichIncompleteEvents, stripRawText };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Write test for `stripRawText`**

```js
// stripRawText removes _rawText from events
const { stripRawText } = require('../src/enrichment');
const evts = [{ name: 'A', _rawText: 'raw' }, { name: 'B' }];
stripRawText(evts);
assert(!evts[0]._rawText, '_rawText removed');
assert(evts[0].name === 'A', 'other fields preserved');
```

- [ ] **Step 6: Run tests and verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/enrichment.js test/run-all.js
git commit -m "feat: post-scrape LLM enrichment engine"
```

---

### Task 4: Wire enrichment into `refreshCache()`

**Files:**
- Modify: `src/events.js` — insert after venue persist (~line 610), before SQLite write (~line 612)

- [ ] **Step 1: Add enrichment step**

Insert after the venue persist block and before the SQLite write:

```js
    // Post-scrape LLM enrichment: fill missing fields using _rawText provenance
    try {
      const { enrichIncompleteEvents, stripRawText } = require('./enrichment');
      const enrichStats = await enrichIncompleteEvents(validEvents);
      if (enrichStats.enriched > 0) {
        console.log(`[ENRICHMENT] Total: ${enrichStats.enriched}/${enrichStats.sent} events enriched`);
      }
      stripRawText(validEvents);
    } catch (err) {
      console.error('[ENRICHMENT] Post-scrape enrichment failed (non-fatal):', err.message);
    }
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/events.js
git commit -m "feat: wire post-scrape LLM enrichment into refreshCache"
```

---

## Design Decisions

1. **No threshold** — Every event with `_rawText` and missing `start_time_local` gets sent to the LLM. The cost is negligible (~$0.0003 per batch of 6 events at Haiku pricing), and a missing time is always worth trying to fill. Ongoing/series events are excluded since they legitimately lack specific times.

2. **`_rawText` on the event object, not a side-channel** — Carries provenance with the data. Stripped before persistence so it never hits disk or the serving cache.

3. **Enrichment after geocoding, before SQLite** — Enriched fields (time, venue, neighborhood) are available for all downstream processing: SQLite storage, JSON cache, daily digest, post-scrape audit.

4. **Non-fatal on failure** — LLM enrichment is best-effort. If it fails, deterministic data is still served. try/catch ensures scrape completion is never blocked.

5. **Skint-only `_rawText` for now** — Other deterministic scrapers (Eventbrite, Dice, RA) parse structured APIs where raw text wouldn't help an LLM. Architecture supports adding `_rawText` to other text-based scrapers later.

6. **Parenthetical time fix stays** — The deterministic fix for `(7pm)` style times reduces how many events need LLM enrichment. Deterministic first, LLM as catcher.
