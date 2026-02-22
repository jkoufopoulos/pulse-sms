# Filter Drift Architecture Problem — Seeking Fresh Approaches

## Context

I'm building an SMS-based event recommendation service for NYC nightlife. Users text a neighborhood name and get curated picks. The entire UX happens in a single SMS thread — no app, no account.

A typical multi-turn conversation:
```
User: "williamsburg"         → 3 event picks in Williamsburg
User: "how about comedy"     → comedy events in Williamsburg (filter applied)
User: "2"                    → details on pick #2
User: "try bushwick"         → should show comedy in Bushwick (filter persists)
User: "later tonight"        → should show late comedy in Bushwick (filter compounds)
User: "forget the comedy"    → should show all late events in Bushwick (filter dropped)
```

Session state (neighborhood, last picks, active filters) persists for 2 hours per phone number.

## Architecture

Two-tier routing:

1. **Pre-router (deterministic)** — Pattern-matches common intents with zero latency: greetings, "more", number replies for details, and simple filter follow-ups ("how about comedy", "free", "later tonight") when the user has an active session.

2. **Unified LLM call (Claude Haiku)** — Handles everything else: bare neighborhoods, compound requests, off-topic, ambiguous messages. Single call that both understands intent AND composes the SMS response.

```
Incoming message
      │
  pre-router ──match──► handler dispatches (help, details, more, conversational)
      │
   no match
      │
      ▼
  Unified LLM call (Haiku)
      │
      ▼
  Returns: { type, sms_text, picks, filters_used, suggested_neighborhood }
      │
      ▼
  Handler saves session state (lastPicks, lastNeighborhood, lastFilters, etc.)
```

Event pre-filtering happens BEFORE the LLM call:
```js
const pendingFilters = session?.pendingFilters || {};
events = applyFilters(rawEvents, pendingFilters); // soft mode: falls back to unfiltered if 0 category matches
```

The LLM receives up to 15 pre-filtered events and composes 1-3 picks into a 480-char SMS.

## The Problem: Filter Drift

When a user switches neighborhoods while filters are active, the filters get lost. The LLM sees "Active filters: {category: 'comedy'}" in session context but ignores it ~60% of the time.

**Example failure:**
```
User: "east village"          → comedy, music, art picks
User: "how about comedy"      → pre-router catches this, injects comedy filter
                                → events pre-filtered to comedy → LLM composes comedy picks ✓
User: "try williamsburg"      → pre-router returns null (it's a neighborhood, not a filter)
                                → unified LLM handles it
                                → handler fetches Williamsburg events WITHOUT comedy filter
                                → LLM sees "Active filters: {category: 'comedy'}" in session context
                                → LLM ignores it, serves generic Williamsburg picks ✗
```

Filter drift accounts for 4-7 of our eval failures (out of 51 scenarios). Our eval pass rate is 35/51 (68.6%) vs a 42/51 (82.4%) baseline from before we consolidated to the unified LLM approach.

## What We've Tried

### Approach 1: Pure LLM (unified single call)
Move ALL understanding to one LLM call. The LLM receives session context including active filters and is responsible for maintaining them.

**Result:** 33/51 (64.7%). Haiku doesn't reliably maintain filter state across turns. It treats each message semi-independently, dropping filters on neighborhood switches, nudge accepts, and compound modifications.

### Approach 2: Pre-router filter detection + injection
Add deterministic filter patterns back to the pre-router for simple cases ("how about comedy", "free", "later tonight"). Pre-router returns detected filters, handler injects them as `pendingFilters` before event pre-filtering, then falls through to the unified LLM for composition.

**Result:** 35/51 (68.6%). Fixes same-neighborhood filter follow-ups but doesn't address filter persistence across neighborhood switches (the pre-router only matches filter patterns, not "try williamsburg").

### Approach 3: lastFilters carry-over for event pre-filtering
When user provides a new neighborhood, carry forward `session.lastFilters` as a fallback for event pre-filtering:
```js
const filters = session?.pendingFilters || session?.lastFilters || {};
events = applyFilters(rawEvents, filters);
```

**Result:** Major regression (dropped from 5/8 to 2/8 on extended scenarios). The problem: carry-over narrows event pools too aggressively. Fort Greene went from 96 events to 2 (only 2 matched the comedy filter from Park Slope). The LLM got a tiny event pool and composed poorly. `applyFilters` uses "soft mode" that falls back to unfiltered when there are ZERO matches — but 2 matches is still a match, so no fallback.

### Approach 4: Prompt engineering
Added "FILTER CONTINUITY" rules and "Active filters" labels to the session context in the LLM prompt. Told Haiku to maintain filters unless explicitly dropped.

**Result:** No reliable improvement. Haiku follows these rules ~40% of the time. Not deterministic enough.

## The Fundamental Tension

- **Evals want filter carry-over:** "try williamsburg" with active comedy filter should show comedy in Williamsburg
- **Filter carry-over narrows pools:** Williamsburg might have 94 events total but only 3 comedy events. Pre-filtering to 3 events gives the LLM too little to work with.
- **Soft mode doesn't help when there ARE matches:** It only falls back to unfiltered when there are 0 matches. 2-3 matches is technically a success but practically too few.
- **Prompt-based approaches are unreliable:** Haiku doesn't consistently follow filter maintenance instructions.

## Constraints

- **Cost:** $0.10/day budget per user. Haiku costs ~$0.001/call. Sonnet is ~10x more expensive. Most users send 3-7 messages per session.
- **Latency:** SMS users expect fast responses. Single LLM call takes ~1-2s. Two calls would be ~2-4s.
- **SMS format:** 480 chars max. No rich UI, no buttons, no state indicators visible to user.
- **Event data:** ~750 events cached daily. Events have `category` field (comedy, live_music, nightlife, art, theater, community) but categories are coarse — "jazz" and "rock" both map to `live_music`.
- **Model:** Claude Haiku 4.5 for both routing and composition. Gemini Flash available for routing but has JSON truncation issues.

## What I'm Looking For

Fresh architectural approaches to solve filter persistence without:
1. Over-narrowing event pools on neighborhood switches
2. Relying on Haiku to maintain state (it can't reliably)
3. Doubling LLM costs (though modest increases are acceptable)
4. Adding significant latency

Some ideas I haven't fully explored:
- Two-pool approach (filtered + unfiltered events, LLM picks from filtered first)
- Minimum threshold (if filtered < N events, include unfiltered as fallback)
- Lightweight "filter extraction" call before the main compose call
- Structured filter state in the prompt (not just text, but formatted constraints)
- Different approach to `applyFilters` soft mode

What architectural patterns would you suggest?
