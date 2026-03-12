# Venue Knowledge Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent real venue personality data so SMS responses say "dark cocktail bar with a killer sound system" instead of "intimate venue."

**Architecture:** Venue profiles live in `data/venue-profiles.json`, loaded on boot into a normalized map in `venues.js`. Pool serialization adds a `venue_vibe` one-liner per event. Details intent attaches the full profile (known_for, crowd, tip). System prompt teaches the agent to use both.

**Tech Stack:** Node.js, JSON data file, existing test framework (`check()` helper)

**Spec:** `docs/plans/2026-03-12-venue-knowledge-design.md`

---

## Chunk 1: Profile lookup infrastructure

### Task 1: Add `lookupVenueProfile` to venues.js

**Files:**
- Modify: `src/venues.js:835-970` (add profile map, lookup function, boot loader, export)
- Create: `data/venue-profiles.json` (empty seed file)
- Test: `test/unit/venues.test.js`

- [ ] **Step 1: Create empty profile data file**

Create `data/venue-profiles.json` with a single test entry:

```json
{
  "Mood Ring": {
    "vibe": "dark, moody cocktail bar with a sound system that punches above its size",
    "known_for": "vinyl nights, experimental DJ sets, natural wine",
    "crowd": "bushwick regulars, music nerds, people who came for one drink and stayed till close",
    "tip": "go on a weeknight — weekends get packed and loud"
  }
}
```

- [ ] **Step 2: Write failing tests**

Add to `test/unit/venues.test.js`:

```js
const { lookupVenueProfile } = require('../../src/venues');

console.log('\nlookupVenueProfile:');
check('exact match returns profile', lookupVenueProfile('Mood Ring')?.vibe?.includes('cocktail bar'));
check('case insensitive', lookupVenueProfile('mood ring')?.vibe?.includes('cocktail bar'));
check('returns full profile fields', (() => {
  const p = lookupVenueProfile('Mood Ring');
  return p?.vibe && p?.known_for && p?.crowd && p?.tip;
})());
check('null for unknown venue', lookupVenueProfile('Nonexistent Venue') === null);
check('null for null input', lookupVenueProfile(null) === null);
check('null for empty string', lookupVenueProfile('') === null);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test 2>&1 | grep lookupVenueProfile`
Expected: FAIL — `lookupVenueProfile` is not exported

- [ ] **Step 4: Implement lookupVenueProfile in venues.js**

Add after the `lookupVenueSize` function (around line 848), before the `normalizedMap` section:

```js
// --- Venue profiles (loaded from data/venue-profiles.json on boot) ---
const normalizedProfileMap = new Map();

// Boot-time load
try {
  const profilePath = require('path').join(__dirname, '../data/venue-profiles.json');
  const profileData = JSON.parse(require('fs').readFileSync(profilePath, 'utf8'));
  for (const [name, profile] of Object.entries(profileData)) {
    normalizedProfileMap.set(normalizeName(name), profile);
  }
  console.log(`Loaded ${normalizedProfileMap.size} venue profiles`);
} catch {
  console.log('No venue profiles found (data/venue-profiles.json missing or invalid)');
}

/**
 * Look up venue profile.
 * Returns { vibe, known_for, crowd, tip } or null.
 */
function lookupVenueProfile(name) {
  if (!name) return null;
  return normalizedProfileMap.get(normalizeName(name)) || null;
}
```

Add `lookupVenueProfile` to the `module.exports` at the end of the file:

```js
module.exports = { VENUE_MAP, VENUE_SIZE, lookupVenue, lookupVenueSize, lookupVenueProfile, learnVenueCoords, geocodeVenue, batchGeocodeEvents, exportLearnedVenues, importLearnedVenues };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -A1 lookupVenueProfile`
Expected: All 6 checks PASS

- [ ] **Step 6: Commit**

```bash
git add src/venues.js data/venue-profiles.json test/unit/venues.test.js
git commit -m "feat: add lookupVenueProfile with boot-time JSON loading"
```

---

### Task 2: Wire venue_vibe into pool serialization

**Files:**
- Modify: `src/brain-llm.js:282-299` (add venue_vibe field)
- Modify: `src/brain-llm.js:1` (add import)

- [ ] **Step 1: Add import to brain-llm.js**

At top of `brain-llm.js`, the file does not currently import from venues.js. Add:

```js
const { lookupVenueProfile } = require('./venues');
```

- [ ] **Step 2: Add venue_vibe to pool serialization**

In `serializePoolForContinuation`, inside the `pool.map(e => { ... })` block (around line 292-298), add after the `editorial_note` line:

```js
venue_vibe: lookupVenueProfile(e.venue_name)?.vibe || undefined,
```

- [ ] **Step 3: Add test for pool serialization**

Add to `test/unit/venues.test.js`:

```js
const { serializePoolForContinuation } = require('../../src/brain-llm');

console.log('\nvenue_vibe in pool serialization:');
const testPool = [{ id: 'vp1', name: 'Test Event', venue_name: 'Mood Ring', neighborhood: 'Bushwick', category: 'dj' }];
const serialized = serializePoolForContinuation({ pool: testPool, hood: 'Bushwick', activeFilters: {}, matchCount: 1 });
check('venue_vibe present for profiled venue', serialized.events[0].venue_vibe?.includes('cocktail bar'));
const noProfilePool = [{ id: 'vp2', name: 'Other Event', venue_name: 'Unknown Place', neighborhood: 'Bushwick', category: 'dj' }];
const serialized2 = serializePoolForContinuation({ pool: noProfilePool, hood: 'Bushwick', activeFilters: {}, matchCount: 1 });
check('venue_vibe undefined for unknown venue', serialized2.events[0].venue_vibe === undefined);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -A1 'venue_vibe'`
Expected: Both checks PASS

- [ ] **Step 5: Commit**

```bash
git add src/brain-llm.js test/unit/venues.test.js
git commit -m "feat: wire venue_vibe into pool serialization"
```

---

### Task 3: Wire full profile into details intent

**Files:**
- Modify: `src/agent-loop.js:278-296` (add venue_profile to details events)
- Modify: `src/agent-loop.js` (add import)

Note: The details intent is handled **inline** in `executeTool` in `agent-loop.js:259-297`, NOT via `executeDetails` in `brain-execute.js`. The spec mentioned `brain-execute.js` but the actual code constructs the response directly.

- [ ] **Step 1: Add import to agent-loop.js**

Add to the imports at the top of `agent-loop.js`:

```js
const { lookupVenueProfile } = require('./venues');
```

- [ ] **Step 2: Add venue_profile to details event serialization**

In `agent-loop.js`, find the details intent block (around line 278-290) where events are mapped. Currently:

```js
const events = session.lastPicks.map(p => {
  const e = session.lastEvents[p.event_id];
  if (!e) return null;
  return {
    id: e.id, name: cleanEventName((e.name || '').slice(0, 80)),
    venue_name: e.venue_name, neighborhood: e.neighborhood,
    start_time_local: e.start_time_local, category: e.category,
    is_free: e.is_free, price_display: e.price_display,
    description_short: e.description_short || e.short_detail || '',
    editorial_note: e.editorial_note || undefined,
    recurring: e.is_recurring ? e.recurrence_label : undefined,
  };
}).filter(Boolean);
```

Add `venue_profile` after the `recurring` line:

```js
    venue_profile: lookupVenueProfile(e.venue_name) || undefined,
```

This gives the agent the full profile (`known_for`, `crowd`, `tip`) when composing a details response. The `vibe` field is also included but the agent already has it from the pool — redundant is fine.

- [ ] **Step 3: Commit**

```bash
git add src/agent-loop.js
git commit -m "feat: attach full venue profile to details intent"
```

---

### Task 4: Update system prompt

**Files:**
- Modify: `src/brain-llm.js:237-248` (metadata translation guide)
- Modify: `src/brain-llm.js:230-234` (details structure)

- [ ] **Step 1: Add venue_vibe to metadata translation guide**

In `buildBrainSystemPrompt`, find the "HOW TO TALK ABOUT PICKS" block (around line 237-246). After the line about `recurring` (line 246), add:

```
- venue_vibe → use it directly. "dark cocktail bar with a killer sound system" is better than anything you'd make up. Trust the profile and weave it into your pick description.
```

- [ ] **Step 2: Add venue profile guidance to details structure**

In the "DETAILS RESPONSES" block (around line 230-235), after the line about "End with a PRACTICAL TIP" (line 234), add:

```
- If the event has venue_profile (known_for, crowd, tip), USE IT. Lead with what the venue feels like. The profile tip is the insider knowledge — "gets packed early on free show nights, aim for 8" is gold.
```

- [ ] **Step 3: Verify prompt includes new lines**

Run: `node -e "const { buildBrainSystemPrompt } = require('./src/brain-llm'); const p = buildBrainSystemPrompt({}); console.log(p.includes('venue_vibe'));"`

Expected: `true`

- [ ] **Step 4: Commit**

```bash
git add src/brain-llm.js
git commit -m "feat: teach agent to use venue_vibe and venue_profile in SMS"
```

---

### Task 5: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass, no regressions

- [ ] **Step 2: Commit if any fixes needed**

---

## Chunk 2: Seed venue profiles via web research

### Task 6: Research and draft venue profiles

This task uses web search agents to research each seed venue and draft profiles. The human reviews and edits the results before they go live.

**Files:**
- Modify: `data/venue-profiles.json` (replace test entry with full seed set)

**Seed venues (~30):**

Bushwick/Ridgewood: Mood Ring, House of Yes, Bossa Nova Civic Club, Jupiter Disco, H0L0, Market Hotel, Elsewhere, TV Eye
Williamsburg/Greenpoint: Baby's All Right, Good Room, Purgatory, ALPHAVILLE, Sleepwalk, National Sawdust
Bed-Stuy/Crown Heights: C'mon Everybody, Ode to Babel, Public Records, Friends and Lovers
LES/East Village: Nublu, Pianos, Metrograph, Club Cumming
Gowanus/Park Slope: Bell House, Union Hall, Littlefield
Other: Pioneer Works, Spectacle Theater, Jalopy Theatre, Rockwood Music Hall, Caveat

- [ ] **Step 1: For each venue, spawn a web search agent**

Each agent should:
1. Search: `"[venue name]" NYC reviews vibe what it's like`
2. Read 3-5 results (The Infatuation, TimeOut, blogs, Reddit, Yelp highlights)
3. Synthesize into the 4-field schema:
   - `vibe`: one sentence, what it feels like to walk in (max 100 chars)
   - `known_for`: what the venue is famous for in the local scene
   - `crowd`: who goes there, described like a friend would
   - `tip`: the insider advice a local would give
4. Include a `_sources` array with URLs consulted (stripped before final file)

- [ ] **Step 2: Collect all drafted profiles into data/venue-profiles.json**

- [ ] **Step 3: HUMAN REVIEW GATE**

**Stop here.** Print the drafted profiles for user review. The user edits, approves, or rejects each profile. Only approved profiles remain in `data/venue-profiles.json`.

- [ ] **Step 4: Strip `_sources` from approved profiles**

Remove any `_sources` arrays from the final `data/venue-profiles.json`.

- [ ] **Step 5: Run tests to verify profiles load correctly**

Run: `npm test 2>&1 | grep -A1 lookupVenueProfile`
Expected: All profile tests pass

- [ ] **Step 6: Commit**

```bash
git add data/venue-profiles.json
git commit -m "feat: add seed venue profiles (30 venues, web-researched)"
```

---

## Chunk 3: Roadmap update

### Task 7: Update ROADMAP.md

**Files:**
- Modify: `ROADMAP.md` (Phase 8 section)

- [ ] **Step 1: Update Phase 8 tasks to reflect actual implementation**

Per spec's "Roadmap Reconciliation" section:
- "Create `src/venue-knowledge.js`" → mark done, note: profiles in `data/venue-profiles.json`, lookup in `venues.js`
- "Seed top 50 venues by frequency" → mark done, note: 30 venues curated by local relevance
- "Wire venue profiles into `serializePoolForContinuation()`" → mark done, note: `venue_vibe` one-liner only
- "Wire venue profiles into details responses" → mark done, note: full profile in details intent
- "Run scenario evals to verify agent uses venue knowledge naturally" → leave open

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: update Phase 8 roadmap to reflect venue knowledge implementation"
```
