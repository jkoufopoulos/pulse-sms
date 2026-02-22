# Implementation Plan: Tagged Event Pool + Deterministic Filter State

## Overview

Move filter state management from the LLM to deterministic handler code. The LLM's job becomes: select and compose from a pre-tagged event pool. The handler's job becomes: resolve active filters, build the tagged pool, and persist filter state.

```
CURRENT:
  handler → pre-filter events → unifiedRespond(events_filtered) → LLM guesses filters → save

NEW:
  handler → resolve activeFilters (merge lastFilters + preDetected)
          → buildTaggedPool(events, activeFilters) → [MATCH] tags + sparse flag
          → unifiedRespond(taggedEvents, activeFilters, isSparse)
          → LLM composes from tagged pool, can signal clear_filters
          → handler saves activeFilters as lastFilters
```

## File Changes

### 1. `src/pipeline.js` — Add `buildTaggedPool` and `mergeFilters`

**`mergeFilters(existing, incoming)`**

Compounds filters. Incoming values override existing, but `null`/`undefined` incoming values preserve existing.

```js
function mergeFilters(existing, incoming) {
  if (!existing && !incoming) return {};
  if (!existing) return incoming || {};
  if (!incoming) return existing;
  return {
    free_only: incoming.free_only ?? existing.free_only ?? false,
    category: incoming.category ?? existing.category ?? null,
    vibe: incoming.vibe ?? existing.vibe ?? null,
    time_after: incoming.time_after ?? existing.time_after ?? null,
  };
}
```

Note: `??` preserves `false` for `free_only` — only overrides on `null`/`undefined`. If the pre-router detects `{free_only: false, category: 'comedy'}`, the `false` for `free_only` won't override an existing `true`. We need `||` for `free_only` or explicit truthy check. Actually: pre-router always sets `free_only: false` as default. So mergeFilters needs to only merge non-default values from incoming:

```js
function mergeFilters(existing, incoming) {
  if (!existing && !incoming) return {};
  const base = existing || {};
  const next = incoming || {};
  return {
    free_only: next.free_only || base.free_only || false,
    category: next.category || base.category || null,
    vibe: next.vibe || base.vibe || null,
    time_after: next.time_after || base.time_after || null,
  };
}
```

Using `||` means any truthy incoming value wins, any falsy incoming value falls back to existing. This correctly handles:
- `"later tonight"` → incoming `{time_after: '22:00', category: null}` + existing `{category: 'comedy'}` → `{category: 'comedy', time_after: '22:00'}`
- `"free"` → incoming `{free_only: true}` + existing `{category: 'comedy'}` → `{free_only: true, category: 'comedy'}`

**`buildTaggedPool(events, activeFilters)`**

Returns an array of events with `filter_match` tags, matched events first, padded to 15 total. Also returns metadata.

```js
function buildTaggedPool(events, activeFilters) {
  const hasFilters = activeFilters && Object.values(activeFilters).some(Boolean);
  if (!hasFilters) {
    return {
      pool: events.slice(0, 15).map(e => ({ ...e, filter_match: false })),
      matchCount: 0,
      isSparse: false,
    };
  }

  const matched = [];
  const unmatched = [];

  for (const e of events) {
    if (eventMatchesFilters(e, activeFilters)) {
      matched.push({ ...e, filter_match: true });
    } else {
      unmatched.push({ ...e, filter_match: false });
    }
  }

  const pool = [
    ...matched.slice(0, 10),
    ...unmatched.slice(0, Math.max(0, 15 - Math.min(matched.length, 10))),
  ];

  return {
    pool,
    matchCount: matched.length,
    isSparse: matched.length > 0 && matched.length < 3,
  };
}
```

**`eventMatchesFilters(event, filters)`** — helper

Checks ALL active filter dimensions. An event matches only if it passes every active filter.

```js
function eventMatchesFilters(event, filters) {
  if (filters.free_only && !event.is_free) return false;
  if (filters.category && event.category !== filters.category) return false;
  if (filters.time_after) {
    // Reuse filterByTimeAfter logic: parse event start time, compare to filter
    // Events without parseable times are considered matching (soft behavior)
    const eventTime = parseStartTime(event.start_time_local);
    if (eventTime !== null) {
      const filterTime = parseHHMM(filters.time_after);
      if (eventTime < filterTime) return false;
    }
  }
  // vibe has no event field to match against — skip (LLM handles vibe selection)
  return true;
}
```

Time parsing helpers — extract from `geo.js:filterByTimeAfter` or import. Need `parseStartTime` (extracts HH:MM from event) and `parseHHMM` (parses filter time). Handle after-midnight wrapping (01:00 = 25:00 when filter is 22:00+).

**Exports:** Add `mergeFilters`, `buildTaggedPool` to `module.exports`.

---

### 2. `src/pre-router.js` — Add CLEAR_FILTERS intent

Add before the existing filter follow-up block (before line 90), still inside the session check:

```js
// Explicit filter clearing
if (session?.lastFilters && Object.values(session.lastFilters).some(Boolean)) {
  if (/^(show me everything|all events|no filter|drop the filter|clear filters?|forget the .+|never mind the .+|just regular stuff|everything|show all)$/i.test(msg)) {
    return { ...base, intent: 'clear_filters', neighborhood: session.lastNeighborhood };
  }
}
```

This requires an active session with non-empty `lastFilters`. Returns `intent: 'clear_filters'` which the handler processes by clearing `lastFilters` and falling through to the unified branch with no filters.

**Not trying to catch everything** — phrases like "nah forget it, just show me what's good" are too semantic for regex. The LLM handles those via `clear_filters: true` in its JSON response.

---

### 3. `src/handler.js` — Restructure unified branch

**a) Handle `clear_filters` intent (in the pre-routed mechanical branch):**

After the `preDetectedFilters` block (line 276), add clear_filters handling:

```js
if (preRouted && preRouted.intent === 'clear_filters') {
  // Clear filters and fall through to unified branch with no filters
  setSession(phone, { lastFilters: null, pendingFilters: null });
  session = getSession(phone);
  // Don't set preDetectedFilters — unified branch runs with no filters
  trace.routing.pre_routed = true;
  trace.routing.result = { intent: 'clear_filters', neighborhood: preRouted.neighborhood, confidence: 1.0 };
  trace.routing.latency_ms = 0;
  console.log(`Pre route (pre): intent=clear_filters → unified with no filters`);
}
```

Adjust the `if (preRouted && !preDetectedFilters)` condition to also exclude `clear_filters`:

```js
if (preRouted && !preDetectedFilters && preRouted.intent !== 'clear_filters') {
  // mechanical shortcuts (help, conversational, details, more)
```

**b) Replace event pre-filtering with tagged pool (unified branch):**

Replace lines 379-380:
```js
// OLD:
const pendingFilters = session?.pendingFilters || {};
events = filterKidsEvents(applyFilters(raw, pendingFilters));
```

With:
```js
// NEW: Resolve active filters and build tagged pool
const activeFilters = mergeFilters(
  session?.lastFilters,
  preDetectedFilters || session?.pendingFilters || null
);
const curated = filterKidsEvents(raw);
const { pool, matchCount, isSparse } = buildTaggedPool(curated, activeFilters);
events = pool;

// Merge perennial picks (mark as unmatched)
const perennialPicks = getPerennialPicks(hood);
const localPerennials = validatePerennialActivity(toEventObjects(perennialPicks.local, hood));
const perennialCap = Math.min(4, 15 - Math.min(events.length, 15));
const taggedPerennials = localPerennials.slice(0, perennialCap).map(e => ({ ...e, filter_match: false }));
events = [...events, ...taggedPerennials];
```

Note: `filterKidsEvents` runs BEFORE `buildTaggedPool` so kids events are excluded from both matched and unmatched pools.

**c) Pass filter context to unifiedRespond:**

Update the `unifiedRespond` call (around line 397):
```js
const result = await unifiedRespond(message, {
  session,
  events,          // now tagged with filter_match
  neighborhood: hood,
  nearbyHoods,
  conversationHistory: history,
  currentTime: now,
  validNeighborhoods: NEIGHBORHOOD_NAMES,
  activeFilters,   // NEW
  isSparse,        // NEW
  matchCount,      // NEW
});
```

**d) Filter state management after LLM response:**

After the unified call, replace the pending state clearing (lines 417-420) with:

```js
// Filter state management
if (result.clear_filters) {
  // LLM detected user wants to drop filters (e.g. "forget the comedy")
  setSession(phone, { lastFilters: null, pendingFilters: null, pendingMessage: null, pendingNearby: null });
} else if (session?.pendingNearby || session?.pendingFilters) {
  setSession(phone, { pendingNearby: null, pendingFilters: null, pendingMessage: null });
}
```

In the `saveResponseFrame` call for `event_picks` (around line 467), save `activeFilters` (not the LLM's `filters_used`) as the authoritative filters:

```js
saveResponseFrame(phone, {
  picks: result.picks,
  eventMap,
  neighborhood: result.neighborhood_used || hood,
  filters: activeFilters,  // CHANGED: deterministic, not LLM-derived
  offeredIds: events.map(e => e.id),
  pending: suggestedHood ? {
    neighborhood: suggestedHood,
    filters: activeFilters,  // CHANGED: carry filters through nudge
  } : null,
});
```

For `conversational` and empty-picks responses, also persist `activeFilters`:

```js
if (result.type === 'conversational') {
  if (hood) {
    const sessionUpdate = { lastNeighborhood: hood };
    // Persist active filters through conversational responses
    if (Object.values(activeFilters).some(Boolean)) {
      sessionUpdate.lastFilters = activeFilters;
    }
    const suggestedHood = result.suggested_neighborhood && nearbyHoods.includes(result.suggested_neighborhood)
      ? result.suggested_neighborhood : null;
    if (suggestedHood) sessionUpdate.pendingNearby = suggestedHood;
    setSession(phone, sessionUpdate);
  }
  // ...
}
```

---

### 4. `src/ai.js` — Format tagged events in prompt

**In `unifiedRespond`, accept new params:**

Update function signature:
```js
async function unifiedRespond(message, { session, events, neighborhood, nearbyHoods,
  conversationHistory, currentTime, validNeighborhoods,
  activeFilters, isSparse, matchCount })
```

**Format event list with [MATCH] tags:**

Replace the current event list formatting with:

```js
const hasActiveFilter = activeFilters && Object.values(activeFilters).some(Boolean);
const filterLabel = hasActiveFilter
  ? Object.entries(activeFilters).filter(([,v]) => v).map(([k,v]) => `${k}=${v}`).join(', ')
  : 'none';

const eventList = events.map((e, i) => {
  const tag = e.filter_match ? '[MATCH] ' : '';
  return `${tag}${i + 1}. ${e.name} — ${e.venue || 'TBA'}, ${e.start_time_local || 'time TBD'}. ${e.category || ''}${e.is_free ? ' [FREE]' : ''}`;
}).join('\n');
```

**Add filter context block to the user prompt:**

Before the EVENT_LIST, add:

```
ACTIVE_FILTER: ${filterLabel}
MATCH_COUNT: ${matchCount || 0} of ${events.length} events match
SPARSE: ${isSparse ? 'true — few matches, acknowledge honestly' : 'false'}
```

---

### 5. `src/prompts.js` — Update UNIFIED_SYSTEM with selection rules

Add to `<composing_event_picks>` section, replacing the existing FILTER CONTINUITY rule:

```
FILTER-AWARE SELECTION:
- Events tagged [MATCH] satisfy the user's active filter. Prefer these.
- If SPARSE is false and [MATCH] events exist: at least 2 of your picks MUST be [MATCH] events. Lead with a [MATCH] event.
- If SPARSE is true: open with honest framing like "Not many [category] options tonight in [hood]." Then recommend your best 2-3 picks from the full list, noting any [MATCH] events first.
- If ACTIVE_FILTER is none: pick freely from the full list.
- NEVER invent events not in the list. NEVER claim an event matches a filter it doesn't match.
```

**Add `clear_filters` to the JSON response schema:**

In the output format section, add:
```
"clear_filters": boolean — set to true ONLY when the user explicitly asks to remove/drop/forget their active filter. Examples: "forget the comedy", "just show me everything", "drop the filter", "no more free stuff". Do NOT set this when the user adds or changes a filter.
```

---

### 6. `src/pre-router.js` — Fix mergeFilters interaction

The pre-router currently returns `filters` with the `base` template which sets all non-detected values to `null`/`false`:
```js
const base = { filters: { free_only: false, category: null, vibe: null, time_after: null }, ... };
```

This is fine because `mergeFilters` uses `||` — falsy incoming values fall back to existing. So `"how about comedy"` returns `{free_only: false, category: 'comedy', vibe: null, time_after: null}`, and mergeFilters correctly preserves any existing `free_only: true` or `time_after` from `lastFilters`.

**No changes needed to existing pre-router filter patterns.**

---

## Session State Flow — Example

```
Turn 1: "east village"
  → pre-router: null
  → activeFilters: mergeFilters(null, null) = {}
  → buildTaggedPool: no filters, all events untagged
  → LLM composes freely
  → saveResponseFrame: lastFilters = {}

Turn 2: "how about comedy"
  → pre-router: {intent:'events', filters:{category:'comedy'}}
  → activeFilters: mergeFilters({}, {category:'comedy'}) = {category:'comedy'}
  → buildTaggedPool: comedy events tagged [MATCH], others untagged
  → LLM picks from [MATCH] events (plenty of comedy in EV)
  → saveResponseFrame: lastFilters = {category:'comedy'}

Turn 3: "later tonight"
  → pre-router: {intent:'events', filters:{time_after:'22:00'}}
  → activeFilters: mergeFilters({category:'comedy'}, {time_after:'22:00'}) = {category:'comedy', time_after:'22:00'}
  → buildTaggedPool: late comedy events tagged, others untagged
  → LLM picks late comedy [MATCH] events
  → saveResponseFrame: lastFilters = {category:'comedy', time_after:'22:00'}

Turn 4: "try williamsburg"
  → pre-router: null (neighborhood, not filter)
  → activeFilters: mergeFilters({category:'comedy', time_after:'22:00'}, null) = {category:'comedy', time_after:'22:00'}
  → buildTaggedPool: Williamsburg events, late comedy tagged [MATCH]
  → If 5+ comedy matches: LLM picks from [MATCH] events
  → If 1-2 comedy matches: isSparse=true, LLM says "slim comedy options in Williamsburg" + shows best available
  → If 0 comedy matches: matchCount=0, LLM composes from full pool but notes no comedy found
  → saveResponseFrame: lastFilters = {category:'comedy', time_after:'22:00'}

Turn 5: "forget the comedy"
  → pre-router: {intent:'clear_filters'} (regex match)
  → handler clears lastFilters → falls through to unified
  → activeFilters: mergeFilters(null, null) = {}
  → buildTaggedPool: no filters, all untagged
  → LLM composes freely (but time_after also cleared — acceptable trade-off, or we could parse "forget the comedy" to only clear category)

Turn 5 (alt): "nah actually just show me whatever's good"
  → pre-router: null (too semantic for regex)
  → activeFilters: mergeFilters({category:'comedy', time_after:'22:00'}, null) = {category:'comedy', time_after:'22:00'}
  → LLM sees tagged pool, but user clearly wants to reset
  → LLM returns clear_filters: true in JSON
  → handler clears lastFilters on next response save
```

### Nudge Accept Flow

```
Turn 1: "washington heights"
  → activeFilters: {} (no prior filters)
  → events=0, LLM suggests Harlem
  → conversational handler saves pendingNearby='Harlem'

Turn 2: "yeah sure"
  → pre-router: null
  → hood resolved from pendingNearby = 'Harlem'
  → activeFilters: mergeFilters({}, null) = {}
  → buildTaggedPool for Harlem, no tags
  → Works correctly — no filter to carry

Turn 1b: "washington heights" (with prior comedy filter)
  → activeFilters: {category:'comedy'} from lastFilters
  → events=0, LLM suggests Harlem
  → handler persists lastFilters={category:'comedy'}

Turn 2b: "yeah sure"
  → hood = pendingNearby = 'Harlem'
  → activeFilters: mergeFilters({category:'comedy'}, null) = {category:'comedy'}
  → buildTaggedPool for Harlem, comedy events tagged [MATCH]
  → Filters carry through nudge automatically ✓
```

---

## What Changes Per File

| File | Changes |
|------|---------|
| `src/pipeline.js` | Add `mergeFilters()`, `buildTaggedPool()`, `eventMatchesFilters()`. Export them. |
| `src/pre-router.js` | Add `clear_filters` intent pattern (before existing filter block). |
| `src/handler.js` | Handle `clear_filters` intent. Replace event pre-filtering with tagged pool. Pass `activeFilters`/`isSparse`/`matchCount` to unifiedRespond. Save `activeFilters` (not LLM's `filters_used`) as `lastFilters`. Persist filters through conversational/empty-picks responses. |
| `src/ai.js` | Accept `activeFilters`/`isSparse`/`matchCount` params. Format events with `[MATCH]` tags. Add `ACTIVE_FILTER`/`SPARSE` context block to prompt. Parse `clear_filters` from LLM response. |
| `src/prompts.js` | Replace FILTER CONTINUITY rule with FILTER-AWARE SELECTION rules. Add `clear_filters` to JSON response schema. |
| `test/unit/pre-router.test.js` | Add tests for `clear_filters` patterns. |
| `test/unit/pipeline.test.js` | Add tests for `mergeFilters`, `buildTaggedPool`, `eventMatchesFilters`. |

## What Does NOT Change

| Component | Status |
|-----------|--------|
| `src/session.js` | Unchanged — `lastFilters` field already exists |
| `src/events.js` | Unchanged — `getEvents()` returns raw events |
| `src/curation.js` | Unchanged — `filterKidsEvents` runs before tagging |
| `src/formatters.js` | Unchanged |
| `src/intent-handlers.js` | Unchanged — handleMore/handleDetails/etc unaffected |
| `src/neighborhoods.js` | Unchanged |
| `src/skills/` | Unchanged |
| `applyFilters()` in pipeline.js | Unchanged — still available but no longer used in unified branch |

## Verification

1. `npm test` — all existing tests pass
2. New unit tests for `mergeFilters`, `buildTaggedPool`, `eventMatchesFilters`, `clear_filters` pre-router
3. Manual testing via `/test` simulator:
   - "east village" → "how about comedy" → "try williamsburg" (filters persist)
   - "east village" → "free" → "later tonight" (filters compound)
   - "east village" → "how about comedy" → "forget the comedy" (filters clear)
   - "washington heights" → "yeah sure" (nudge without filter)
   - "east village" → "how about comedy" → "washington heights" → "yeah sure" (nudge WITH filter carry)
4. Run scenario evals: `node scripts/run-scenario-evals.js`
   - Target: 38+/51 (up from 35/51)
   - Filter drift scenarios (#41, #43, #47, #51) should improve
   - No regressions in happy_path, edge_case, abuse_off_topic

## Risk Mitigation

**Risk: Stale filters narrow pools too aggressively**
Mitigation: Tagged pool always includes 5+ unmatched events. LLM has fallback material. Sparse flag triggers honest framing.

**Risk: LLM ignores [MATCH] tags**
Mitigation: Explicit SELECTION RULES in system prompt. If LLM still ignores, the response is still reasonable (just not filter-focused). No worse than current behavior.

**Risk: clear_filters regex misses edge cases**
Mitigation: LLM `clear_filters: true` field catches semantic clearing. Hybrid approach — regex for 80%, LLM for 20%.

**Risk: mergeFilters compounds stale filters indefinitely**
Mitigation: Session TTL is 2 hours. User can explicitly clear. Over time, conversation naturally moves on and filters become irrelevant (LLM will note mismatches via sparse framing).
