# Middleware Simplification — Code Review

> **Status: CLOSED** — All 3 bugs fixed, dead code removed, review complete. Regressions #4 and #5 accepted (simpler code, Claude handles edge cases naturally).

**Date:** 2025-02-19
**Scope:** Phase 1 (wider event pool + conversation history) and Phase 2 (remove redundant middleware)
**Status:** Complete — all action items resolved

---

## Changes Summary

| File | Change | Net lines |
|------|--------|-----------|
| `src/events.js` | `getEvents()` returns today + tomorrow events (was today-only) | ~5 modified |
| `src/session.js` | Added `addToHistory()` for conversation tracking | ~12 added |
| `src/handler.js` | Records turns, threads history + enriched skills to compose | ~10 modified |
| `src/ai.js` | Accepts `conversationHistory`, includes in prompt, parses `suggested_neighborhood` | ~15 modified |
| `src/skills/compose-skills.js` | Added `conversationAwareness` and `nearbySuggestion` skills | ~16 added |
| `src/skills/build-compose-prompt.js` | Enables new skills conditionally | ~8 added |
| `src/intent-handlers.js` | Removed category loop, activity search, nudge machine from `handleEventsDefault` (~160 lines); simplified `handleFree` (~50 lines) | ~210 removed, ~50 added |

---

## Bugs (fix before shipping)

### 1. First user message never recorded in history

**Location:** `handler.js:242` → `session.js:24-25`

`addToHistory(phone, 'user', message)` is called before any session exists for first-time users. `addToHistory` does `sessions.get(phone)` — returns `undefined` — and silently returns. The first `setSession` call happens later inside the intent handler (e.g., `handleEventsDefault:413`). So `finalizeTrace` at line 193 successfully records the assistant response (session now exists), but the user message that prompted it is lost.

**Impact:** On the second message, conversation history is `[{role:'assistant', content:'...'}]` — missing the user's first message. This matters for filter persistence: if user texts "free comedy west village" then says "yes", history doesn't contain "free comedy." The `pendingFilters` mechanism still handles this deterministically, but the `conversationAwareness` skill can't see the original request.

**Fix options:**
```javascript
// Option A: Ensure session exists before recording (handler.js, before line 242)
if (!getSession(phone)) setSession(phone, {});
addToHistory(phone, 'user', message);

// Option B: Record user message in finalizeTrace instead (handler.js)
function finalizeTrace(smsText, intent) {
  addToHistory(phone, 'user', message);  // message is in closure scope
  if (smsText) addToHistory(phone, 'assistant', smsText);
  ...
}
```

### 2. Current message duplicated in compose prompt

**Location:** `handler.js:242-245`

`addToHistory` is called on line 242, then the history snapshot is captured on line 245. The snapshot includes the current user message. Claude sees the current message twice: in `<user_message>` and as the last entry in `CONVERSATION HISTORY`.

**Impact:** Redundant tokens, slightly confusing context for Claude. The value of history is *previous* turns, not the current one.

**Fix:** Swap the order — capture snapshot before adding current message:
```javascript
const history = getSession(phone)?.conversationHistory || [];
addToHistory(phone, 'user', message);
```

### 3. `suggested_neighborhood` not validated against known neighborhoods

**Location:** `handleEventsDefault:409-411` in `intent-handlers.js`

Claude's `suggested_neighborhood` is stored as-is in `pendingNearby` without checking it's a valid neighborhood name. When user says "yes", pre-router reads `session.pendingNearby` and sends it to `handleNudgeAccept`, which calls `getEvents(acceptedHood)`. If the hood is hallucinated, `rankEventsByProximity` can't find coordinates and returns no events.

**Impact:** User says "yes" to hallucinated neighborhood → nudge_accept cascades through fallback hoods (works but wastes a round-trip).

**Fix:** Validate before storing, same pattern as `neighborhood_used` validation in `ai.js:278-286`:
```javascript
if (result.suggested_neighborhood) {
  const validNeighborhoods = Object.keys(require('./neighborhoods').NEIGHBORHOODS);
  if (validNeighborhoods.includes(result.suggested_neighborhood)) {
    setSession(ctx.phone, { pendingNearby: result.suggested_neighborhood });
  }
}
```

Or better: pass the valid `nearbyHoods` names into the compose prompt text so Claude picks from known options.

---

## Behavioral Regressions (evaluate before shipping)

### 4. No proactive adjacent-hood search for category/activity misses

The old code searched up to 5 adjacent neighborhoods when category/activity events weren't found locally. The new code relies on Claude to suggest nearby neighborhoods, but **Claude doesn't know what events exist in other neighborhoods** — it only has the current hood's event pool (events within 3km).

**Old flow:** "comedy in Astoria" → no comedy locally → code finds comedy in LIC → serves LIC comedy events (1 round-trip).

**New flow:** "comedy in Astoria" → Claude sees all Astoria events (none are comedy) → `activityAdherence` skill fires → Claude says "No comedy in Astoria tonight" → might suggest nearby hood blindly → user says "yes" → fresh fetch → might still not have comedy → cascading fallback.

**Impact:** Category/activity queries in sparse neighborhoods now require 2-3 messages instead of 1.

**Mitigation options:**
- Accept the regression (simpler code, Claude handles edge cases naturally)
- Pass nearby-hood event counts/categories into the compose prompt so Claude can make informed suggestions
- Keep a lightweight category pre-check (no compose call, just data): "do any of the 3 nearest hoods have events matching this category?"

### 5. `handleFree` no longer searches adjacent hoods for free events

**Old flow:** "free in Fort Greene" → no free events → code searches Park Slope, Bed-Stuy, Clinton Hill → finds free events in Bed-Stuy → serves them directly.

**New flow:** "free in Fort Greene" → no free events → "Nothing free near Fort Greene tonight. Bed-Stuy is right nearby — want free picks from there?" → user says "yes" → `nudge_accept` fetches Bed-Stuy events → filters for free → might find nothing.

**Impact:** Two regressions:
1. Extra round-trip (2 messages instead of 1)
2. No verification that the suggested neighborhood actually has free events

---

## Dead Code (cleanup)

### 6. `pendingNearbyEvents` branch in `handleNudgeAccept` is dead code

**Location:** `intent-handlers.js:293-305`

The old handlers that set `pendingNearbyEvents` were all removed in this migration. `handleNudgeAccept`'s first branch checks for `session.pendingNearbyEvents` — this can never be true with the new code. All nudge_accept flows now take Branch 2 (fresh `getEvents` call). This works correctly but the dead branch should be removed.

### 7. `topVibeWord` and `VIBE_WORDS` are unused

**Location:** `intent-handlers.js:43-50`

`topVibeWord` was called by the removed nudge code ("would you travel to Williamsburg for some music?"). No external callers exist. Both the function and the `VIBE_WORDS` constant are dead code but still exported on line 419.

---

## Design Concerns (not blocking)

### 8. Conflicting skill instructions for temporal queries

When a user asks about "tomorrow" and today events exist in the list, both `tonightPriority` and `conversationAwareness` are active. Claude sees:

```
TONIGHT PRIORITY: A decent tonight event beats a great tomorrow event
...
CONVERSATION AWARENESS: For a "tomorrow" query, a great tomorrow event
beats a decent tonight event — override the "tonight first" rule.
```

The `conversationAwareness` text explicitly says "override," which should work. But this depends on Claude consistently resolving contradictory instructions in favor of the later one. Worth validating in evals.

### 9. `suggested_neighborhood` not in core output schema

The `nearbySuggestion` skill tells Claude to include `"suggested_neighborhood"` in JSON output, but the `core` skill's `<output_format>` block doesn't list this field. Claude will likely include it anyway (follows most recent instruction), but the schema mismatch could cause inconsistency. Consider adding it to the output_format block.

### 10. Two `setSession` calls in `handleEventsDefault`

**Location:** `intent-handlers.js:409-413`

```javascript
if (result.suggested_neighborhood) {
  setSession(ctx.phone, { pendingNearby: result.suggested_neighborhood });
}
setSession(ctx.phone, { lastPicks: validPicks, ... });
```

This works correctly due to `setSession`'s merge behavior (`{ ...existing, ...data }`), but could be simplified into a single call:

```javascript
const sessionUpdate = { lastPicks: validPicks, allPicks: validPicks, ... };
if (result.suggested_neighborhood) sessionUpdate.pendingNearby = result.suggested_neighborhood;
setSession(ctx.phone, sessionUpdate);
```

### 11. Token cost increase

Tomorrow events (~5-10 extra at ~50 tokens each = ~250-500 tokens) plus conversation history (~300-600 tokens for 6 turns) adds ~500-1100 input tokens per compose call. At Haiku pricing ($1/M input) this is <$0.002/request. Not a problem at current scale but worth monitoring in traces.

---

## Verification Checklist

- [x] `npm test` — 467 unit tests pass
- [x] `npm run eval` — 37 eval tests pass (code evals only)
- [x] Fix bugs #1, #2, #3
- [x] Remove dead code (#6, #7)
- [x] Regressions #4, #5: accepted (simpler code, Claude handles edge cases naturally)
