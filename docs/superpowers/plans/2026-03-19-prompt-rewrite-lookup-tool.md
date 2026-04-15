# Prompt Rewrite + lookup_venue Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the system prompt for truthfulness + editorial voice, and add a `lookup_venue` tool so the model can research venues via Google Places instead of fabricating.

**Architecture:** Replace the `<persona>` and `<composition>` blocks in `buildBrainSystemPrompt` with 5 sections (identity, data contract, composition, examples, name guidance). Add `lookup_venue` as a 3rd tool in `BRAIN_TOOLS`. Implement the tool handler using Google Places Text Search API via a new function in `places.js`, with a JSON file cache separate from hand-written venue profiles.

**Tech Stack:** Node.js, Google Places API (New), existing custom test framework (`check()` in `test/helpers.js`)

**Spec:** `docs/superpowers/specs/2026-03-19-prompt-rewrite-lookup-tool-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/brain-llm.js` | Modify | Rewrite `buildBrainSystemPrompt`, add `lookup_venue` to `BRAIN_TOOLS`, remove serendipity from serializer |
| `src/places.js` | Modify | Add `lookupVenueFromGoogle(name, neighborhood)` — single-venue Google Places lookup |
| `src/agent-loop.js` | Modify | Add `lookup_venue` handler in `executeTool`, add google_maps_url sending in details flow |
| `data/venue-places-cache.json` | Create | Google Places lookup cache (auto-populated, keyed by normalized venue name) |
| `test/unit/agent-loop.test.js` | Modify | Tests for lookup_venue tool, updated prompt structure assertions |
| `test/unit/places.test.js` | Modify | Tests for `lookupVenueFromGoogle` |

---

## Task 1: Rewrite the system prompt

**Files:**
- Modify: `src/brain-llm.js:95-153` (the `buildBrainSystemPrompt` function)
- Modify: `test/unit/agent-loop.test.js:80-92` (prompt structure assertions)

- [ ] **Step 1: Update prompt structure tests**

The existing tests assert `<persona>` and `<composition>` sections exist. Update them to match the new structure. In `test/unit/agent-loop.test.js`, replace lines 80-92:

```javascript
// ---- buildBrainSystemPrompt new prompt structure ----
console.log('\nbuildBrainSystemPrompt prompt structure:');

const anyPrompt = buildBrainSystemPrompt({});
check('prompt has identity section', anyPrompt.includes('<identity>'));
check('prompt has data-contract section', anyPrompt.includes('<data-contract>'));
check('prompt has composition section', anyPrompt.includes('<composition>'));
check('prompt has examples section', anyPrompt.includes('<examples>'));
check('prompt has 480 char limit', anyPrompt.includes('480'));
check('prompt mentions short_detail as trusted field', anyPrompt.includes('short_detail'));
check('prompt mentions lookup_venue tool', anyPrompt.includes('lookup_venue'));
check('prompt has mood mapping', anyPrompt.includes('chill') && anyPrompt.includes('jazz'));
check('prompt has anti-fabrication rule', anyPrompt.includes('fabrication'));
check('prompt has no markdown rule', anyPrompt.includes('no markdown'));
check('prompt does NOT have old serendipity framing', !anyPrompt.includes('serendipity:true'));
check('prompt does NOT have old proactive CTA', !anyPrompt.includes('NOTIFY'));
check('prompt does NOT have old places mixing', !anyPrompt.includes('Grab a drink at'));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/agent-loop.test.js`
Expected: FAIL on "prompt has identity section", "prompt has data-contract section", etc.

- [ ] **Step 3: Rewrite `buildBrainSystemPrompt`**

Replace the return statement (lines 133-152) in `buildBrainSystemPrompt` with the new 5-section prompt. Keep the existing `sessionContext` logic (lines 96-127). **Delete the `proactiveSection` variable** (lines 129-131) — the proactive opt-in CTA feature was deleted and the spec explicitly calls for its removal.

```javascript
  return `<identity>
You are Pulse — a nightlife editor for NYC who texts recommendations. You've read every newsletter, scanned every listing, and your job is to surface the 1-2 things actually worth leaving the apartment for tonight. You're opinionated but honest: when you know why something is special, you say so with conviction. When the data is thin, you lead with the facts and don't dress it up.
TIME: ${nycNow}
NEIGHBORHOODS: ${NEIGHBORHOOD_NAMES.join(', ')}
</identity>

<data-contract>
Your knowledge comes from these fields only:
- short_detail — editorial context from newsletters and listings. This is your best material. When it's rich, use it — this is the "why." (editorial_note is also available in details responses for deeper context.)
- why / recommended — curator signals about what makes a pick interesting (one-night-only, tastemaker pick, tiny room, free). Trust these.
- venue_profile — stored venue context (vibe, what to expect). Trust it when present.
- lookup_venue tool — call this when you're writing a details response and the venue data is thin. Gets you hours, rating, vibe, what to expect.

Everything else is fabrication. Don't invent venue descriptions, atmosphere, crowd vibes, or "what to expect" from your general knowledge. If short_detail says "World premiere of a documentary with expert Q&A" — use that. If an event is just a title + time + venue with no context, say what you know: the name, the time, the place, the category. That's enough. Don't dress it up.
</data-contract>

<composition>
Writing the SMS:
- 1-2 picks in natural prose. Lead with the "why" when you have it, lead with facts when you don't.
- Context before logistics. "One-night-only documentary with expert Q&A" before "7 PM, free."
- Under 480 characters. Plain text only — no markdown, no bold, no italic, no links. This is SMS.
- Only mention price when it's a selling point (free) or the user asked. Don't display uncertain price data.
- End with a short hook that moves the conversation forward.

Choosing what to search:
- Search first, ask later. Contrasting picks > clarifying questions. Only ask when you truly have nothing to go on.
- Mood mapping: "chill" → categories: jazz/film/art, "dance" → categories: dj/nightlife, "weird"/"surprise me" → no category filters, browse the full pool and use judgment.
- When the user asks for bars or restaurants, include those types in your search.

For details responses:
- Call lookup_venue if there's no venue_profile for the venue.
- Lead with what makes this specific event worth going to (from short_detail/editorial_note), then venue context, then logistics (time, price, address).
- If you looked up the venue, weave in what you learned — hours, rating, what to expect. Don't dump raw data.

Event names:
- Refer to events however reads most naturally — by venue, description, or a short version of the name. You don't need to use the full title. "Comedy show at Union Pool" is better than "I Love You... But at Pine Box Rock Shop." For details, use enough of the name that the user knows which event you mean.
</composition>

<examples>
Rich editorial data:
User: "bushwick"
short_detail: "World premiere screening with the director in attendance for Q&A — only NYC date"
SMS: Bushwick tonight — catch the world premiere of [film] at Syndicated (8 PM). Director's doing a Q&A after, and this is the only NYC screening. Free, tiny theater, get there early. Or if you want live music, [band] at Elsewhere (10 PM) is a one-night-only thing. Which one?

Bare data (title + time + venue only):
User: "williamsburg"
short_detail: (empty)
SMS: Williamsburg tonight — there's a comedy show at Union Pool (9 PM, free) and a DJ set at Good Room (11 PM). Don't know much about either but the comedy is free and it's always a good room for it. Want details on one, or a different vibe?

Details with lookup_venue:
User: "tell me about the Union Pool one"
venue_profile: (none — model calls lookup_venue)
SMS: Union Pool is a Williamsburg dive — indoor stage, big outdoor patio, cheap drinks, open til 4 AM. The comedy show starts at 9, no cover. Show up a little early if you want a spot near the stage, it's a small room. You in?
</examples>

<session>
${sessionContext}
</session>`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/unit/agent-loop.test.js`
Expected: All PASS

- [ ] **Step 5: Remove serendipity from serializer**

In `src/brain-llm.js`, in `serializePoolForContinuation` (around line 276), remove the serendipity field from the event serialization:

Remove this line:
```javascript
      serendipity: e.serendipity || undefined,
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass. Some tests may assert on old prompt text — fix any that break.

- [ ] **Step 7: Commit**

```bash
git add src/brain-llm.js test/unit/agent-loop.test.js
git commit -m "feat: rewrite system prompt for editorial voice + truthfulness"
```

---

## Task 2: Add `lookupVenueFromGoogle` to places.js

**Files:**
- Modify: `src/places.js` (add new function + JSON cache)
- Create: `data/venue-places-cache.json` (empty initial cache)
- Modify: `test/unit/places.test.js` (add tests)

- [ ] **Step 1: Create empty cache file**

Create `data/venue-places-cache.json`:
```json
{}
```

- [ ] **Step 2: Write failing tests for `lookupVenueFromGoogle`**

Add to `test/unit/places.test.js`:

```javascript
// ---- lookupVenueFromGoogle ----
console.log('\nlookupVenueFromGoogle:');

const { lookupVenueFromGoogle, getVenuePlacesCache, clearVenuePlacesCache } = require('../../src/places');

// Sync tests
check('lookupVenueFromGoogle is exported', typeof lookupVenueFromGoogle === 'function');
check('getVenuePlacesCache is exported', typeof getVenuePlacesCache === 'function');

// Async tests — wrap in IIFE (matches existing pattern in agent-loop.test.js)
(async () => {
  // Test cache hit path
  const mockResult = {
    name: 'Test Venue',
    address: '123 Test St, Brooklyn, NY',
    rating: 4.2,
    price_level: 2,
    hours: 'Mon-Sun 5PM-2AM',
    editorial_summary: 'A test venue',
    open_now: false,
    google_maps_url: 'https://maps.google.com/test',
    fetched_at: new Date().toISOString(),
  };

  // Inject into cache and verify cache hit
  const cache = getVenuePlacesCache();
  cache['test venue'] = mockResult;

  const cacheHit = await lookupVenueFromGoogle('Test Venue', 'Williamsburg');
  check('cache hit returns cached data', cacheHit.name === 'Test Venue');
  check('cache hit has google_maps_url', cacheHit.google_maps_url === 'https://maps.google.com/test');

  // Test not_found when no API key (cache miss + no key)
  clearVenuePlacesCache();
  const noKeyResult = await lookupVenueFromGoogle('Nonexistent Place', 'SoHo');
  check('no API key returns not_found', noKeyResult.not_found === true);
})();
```

Note: the async tests are wrapped in an IIFE to match the existing test pattern in `agent-loop.test.js`. Cache injection tests the cache-hit path without API calls. The no-API-key path tests the failure fallback.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node test/unit/places.test.js`
Expected: FAIL — `lookupVenueFromGoogle` not exported yet.

- [ ] **Step 4: Implement `lookupVenueFromGoogle`**

Add to `src/places.js` before `module.exports`:

```javascript
// --- Single-venue Google Places lookup with JSON file cache ---

const venuesCachePath = require('path').join(__dirname, '../data/venue-places-cache.json');
let venuePlacesCache = {};
try {
  venuePlacesCache = JSON.parse(require('fs').readFileSync(venuesCachePath, 'utf8'));
  console.log(`Loaded ${Object.keys(venuePlacesCache).length} cached venue lookups`);
} catch {
  console.log('No venue places cache found, starting fresh');
}

function normalizeVenueName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function getVenuePlacesCache() {
  return venuePlacesCache;
}

function clearVenuePlacesCache() {
  venuePlacesCache = {};
}

function saveVenuePlacesCache() {
  try {
    require('fs').writeFileSync(venuesCachePath, JSON.stringify(venuePlacesCache, null, 2));
  } catch (err) {
    console.warn('[places] Failed to save venue places cache:', err.message);
  }
}

/**
 * Look up a single venue by name via Google Places Text Search API.
 * Checks JSON file cache first, then calls API if needed.
 * Returns structured venue data or { not_found: true } on failure.
 */
async function lookupVenueFromGoogle(venueName, neighborhood) {
  const cacheKey = normalizeVenueName(venueName);
  if (!cacheKey) return { not_found: true, message: "No venue name provided." };

  // Cache hit
  if (venuePlacesCache[cacheKey]) {
    return venuePlacesCache[cacheKey];
  }

  // No API key — graceful fallback
  if (!GOOGLE_MAPS_API_KEY) {
    return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
  }

  try {
    const query = `${venueName} ${neighborhood || 'NYC'}`;
    const fieldMask = [
      'places.id', 'places.displayName', 'places.formattedAddress',
      'places.priceLevel', 'places.rating', 'places.googleMapsUri',
      'places.editorialSummary', 'places.regularOpeningHours',
      'places.currentOpeningHours',
    ].join(',');

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });

    if (!response.ok) {
      console.warn(`[places] Venue lookup API error: ${response.status}`);
      return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
    }

    const data = await response.json();
    const place = data.places?.[0];
    if (!place) {
      return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
    }

    const priceLevelMap = {
      'PRICE_LEVEL_FREE': 0, 'PRICE_LEVEL_INEXPENSIVE': 1,
      'PRICE_LEVEL_MODERATE': 2, 'PRICE_LEVEL_EXPENSIVE': 3,
      'PRICE_LEVEL_VERY_EXPENSIVE': 4,
    };

    const hours = place.regularOpeningHours?.weekdayDescriptions;
    const isOpenNow = place.currentOpeningHours?.openNow ?? null;

    const result = {
      name: place.displayName?.text || venueName,
      address: place.formattedAddress || null,
      rating: place.rating ?? null,
      price_level: priceLevelMap[place.priceLevel] ?? null,
      hours: hours ? hours.join(', ') : null,
      editorial_summary: place.editorialSummary?.text || null,
      open_now: isOpenNow,
      google_maps_url: place.googleMapsUri || null,
      fetched_at: new Date().toISOString(),
    };

    // Cache and persist
    venuePlacesCache[cacheKey] = result;
    saveVenuePlacesCache();

    return result;
  } catch (err) {
    console.warn(`[places] Venue lookup failed: ${err.message}`);
    return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
  }
}
```

Add to `module.exports`:
```javascript
module.exports = {
  searchPlaces,
  fetchFromGoogleMaps,
  getCachedPlaces,
  cachePlaces,
  normalizePlace,
  scorePlaceInterestingness,
  filterByVibe,
  serializePlacePoolForContinuation,
  VIBE_FILTERS,
  lookupVenueFromGoogle,
  getVenuePlacesCache,
  clearVenuePlacesCache,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node test/unit/places.test.js`
Expected: All PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/places.js data/venue-places-cache.json test/unit/places.test.js
git commit -m "feat: add lookupVenueFromGoogle with JSON file cache"
```

---

## Task 3: Add `lookup_venue` tool to BRAIN_TOOLS

**Files:**
- Modify: `src/brain-llm.js:19-89` (BRAIN_TOOLS array)
- Modify: `test/unit/agent-loop.test.js` (add tool existence tests)

- [ ] **Step 1: Write failing tests**

Add to `test/unit/agent-loop.test.js` after the existing search tool tests (around line 65):

```javascript
// ---- lookup_venue tool in BRAIN_TOOLS ----
console.log('\nlookup_venue tool:');

const lookupTool = BRAIN_TOOLS.find(t => t.name === 'lookup_venue');
check('lookup_venue tool exists in BRAIN_TOOLS', !!lookupTool);
check('lookup_venue has venue_name required', lookupTool.parameters.required.includes('venue_name'));
check('lookup_venue has neighborhood param', !!lookupTool.parameters.properties.neighborhood);
check('BRAIN_TOOLS has exactly 3 tools', BRAIN_TOOLS.length === 3);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/agent-loop.test.js`
Expected: FAIL on "lookup_venue tool exists"

- [ ] **Step 3: Add `lookup_venue` to BRAIN_TOOLS**

In `src/brain-llm.js`, add after the `respond` tool definition (after line 88, before the closing `]`):

```javascript
  {
    name: 'lookup_venue',
    description: 'Look up venue details from Google Places. Returns hours, rating, price level, vibe, and address. Use when writing a details response and the venue data is thin — no venue_profile, sparse short_detail. Do not call on discover or more requests.',
    parameters: {
      type: 'object',
      properties: {
        venue_name: {
          type: 'string',
          description: 'Name of the venue to look up',
        },
        neighborhood: {
          type: 'string',
          description: 'NYC neighborhood to disambiguate (e.g. "Williamsburg", "LES")',
          nullable: true,
        },
      },
      required: ['venue_name'],
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/unit/agent-loop.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/brain-llm.js test/unit/agent-loop.test.js
git commit -m "feat: add lookup_venue tool definition to BRAIN_TOOLS"
```

---

## Task 4: Wire up `lookup_venue` in `executeTool` + URL sending

**Files:**
- Modify: `src/agent-loop.js:197-513` (`executeTool` function)
- Modify: `src/agent-loop.js:776-798` (URL sending in `handleAgentRequest`)
- Modify: `test/unit/agent-loop.test.js` (add executeTool tests for lookup_venue)

- [ ] **Step 1: Write failing tests**

Add to `test/unit/agent-loop.test.js`:

```javascript
// ---- executeTool lookup_venue ----
console.log('\nexecuteTool lookup_venue:');

// Async tests — wrap in IIFE (matches existing pattern)
(async () => {
  // Test with no API key — should return cached or not_found
  const lookupResult = await executeTool('lookup_venue', { venue_name: 'Some Random Venue', neighborhood: 'SoHo' }, {}, '+10000000000', { events: {}, composition: {} });
  check('lookup_venue returns object', typeof lookupResult === 'object');
  check('lookup_venue without API key returns not_found', lookupResult.not_found === true);

  // Test that lookup_venue handler exists (doesn't return "Unknown tool")
  check('lookup_venue is not unknown tool', !lookupResult.error?.includes('Unknown tool'));
})();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/unit/agent-loop.test.js`
Expected: FAIL — `executeTool` returns `{ error: 'Unknown tool: lookup_venue' }`

- [ ] **Step 3: Add `lookup_venue` handler to `executeTool`**

First, add the import at the top of `src/agent-loop.js` with the other requires (around line 19, after the existing places import):

```javascript
const { lookupVenueFromGoogle } = require('./places');
```

Note: `searchPlaces` is already imported from `./places` on line 19. Merge them into one destructured import:
```javascript
const { searchPlaces, lookupVenueFromGoogle } = require('./places');
```

Then add the handler after the `search` handler block (before the "Unknown tool" fallback around line 512):

```javascript
  if (toolName === 'lookup_venue') {
    const { venue_name, neighborhood } = params;

    // Check hand-written profiles first (richest data)
    const existingProfile = lookupVenueProfile(venue_name);
    if (existingProfile) {
      return { ...existingProfile, name: venue_name, _source: 'venue_profile' };
    }

    // Call Google Places
    const result = await lookupVenueFromGoogle(venue_name, neighborhood);
    if (result._source === undefined) result._source = 'google_places';
    return result;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/unit/agent-loop.test.js`
Expected: All PASS

- [ ] **Step 5: Add Google Maps URL sending for lookup_venue**

In `src/agent-loop.js`, in the `handleAgentRequest` function, **inside** the existing `if (intent === 'details')` block (after the place URL sending around line ~798, but before the closing `}` of the details block), add:

```javascript
      // Google Maps URL from lookup_venue (only if no event/place URL was already sent)
      if (detailPicks.length === 0) {
        const lookupCall = rawResults.find(tc => tc.name === 'lookup_venue' && tc.result?.google_maps_url);
        if (lookupCall) {
          await sendSMS(phone, lookupCall.result.google_maps_url);
        }
      }
```

This sends the Google Maps URL as a follow-up SMS when: (1) intent is details, (2) no event URL was matched and sent via `sendPickUrls`, and (3) a `lookup_venue` call returned a `google_maps_url`.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/agent-loop.js test/unit/agent-loop.test.js
git commit -m "feat: wire up lookup_venue tool execution + Google Maps URL sending"
```

---

## Task 5: Smoke test via simulator

This is a manual testing task using the Railway simulator (or local dev server).

- [ ] **Step 1: Start local dev server**

Run: `npm run dev`
Expected: Server starts on port 3000.

- [ ] **Step 2: Test discover — rich editorial data**

Send: `bushwick`
Verify: Response uses `short_detail` content from events, not fabricated venue descriptions. Plain text (no markdown `**bold**`). Under 480 chars.

- [ ] **Step 3: Test discover — bare data**

Send: `prospect park`
Verify: Response leads with concrete facts (name, time, venue, category). Does NOT fabricate venue atmosphere or "what to expect." Honest about limited info.

- [ ] **Step 4: Test details — should trigger lookup_venue**

Send: `bushwick` then `tell me about [venue name]`
Verify: If the venue has no `venue_profile`, the model calls `lookup_venue` (check server logs for `[places] Venue lookup` log line). Response includes Google Places data (hours, rating). Follow-up SMS with Google Maps URL.

- [ ] **Step 5: Test details — hand-written profile hit**

Send a details request for a venue in `data/venue-profiles.json`.
Verify: No Google Places API call (check logs). Response uses hand-written profile data (vibe, known_for, crowd, tip).

- [ ] **Step 6: Test anti-hallucination**

Send: `williamsburg` then ask for details on an obscure venue.
Verify: Model calls `lookup_venue` instead of fabricating. If lookup returns `not_found`, model composes with just the event data — no invented venue descriptions.

- [ ] **Step 7: Test conversation flow**

Run through: `bushwick` → `anything free?` → `what about the les tonight` → `tell me about [pick]` → `sick thanks`
Verify: Filters work, neighborhood switching works, details work, farewell is clean. Voice is consistent across turns.

- [ ] **Step 8: Deploy and test on Railway**

Run: `railway up`
Wait ~2-3 min for build. Test the same flows at `https://web-production-c8fdb.up.railway.app/test`.

- [ ] **Step 9: Commit any fixes**

If any issues found during testing, fix and commit.

---

## Task 6: Update ROADMAP.md

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Mark roadmap items as done**

In `ROADMAP.md`, update:
- Item 2 (hallucination guardrail): mark as done with date
- Item 3 (voice rewrite): mark as done with date
- Add to "Done (this sprint)" table:
  - `Prompt rewrite + lookup_venue tool | Mar 19 | Editorial voice, data contract, anti-fabrication rule. lookup_venue tool for Google Places research on details requests.`

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark prompt rewrite + lookup_venue as done in roadmap"
```
