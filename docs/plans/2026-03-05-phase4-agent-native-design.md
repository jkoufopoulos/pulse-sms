# Phase 4: Agent-Native Details and More

> Design approved 2026-03-05. Moves mechanical handlers into the agent brain, drops numbered list formatting, and collapses tool surface from 3 to 2.

## Summary

Phase 4 removes `checkMechanical` for everything except help and TCPA opt-out. The agent brain handles details, "more", greetings, thanks, bye — all of it. The numbered pick list is replaced with natural prose. `get_details` is deleted as a tool; `search_events` gains `more` and `details` intents.

## Tool Surface: 3 to 2

| Tool | Purpose |
|------|---------|
| `search_events` | All event intents: search, refine, pivot, more, details |
| `respond` | Pure conversation: greetings, thanks, bye, off-topic |

`get_details` is deleted.

### Enhanced `search_events` params

```
search_events({
  neighborhood, categories, time_filter, date_range, free_only,  // existing
  intent: "search" | "refine" | "pivot" | "more" | "details",   // add "more" + "details"
  pick_reference: "2" | "the comedy one" | "Elsewhere"           // new, optional, for details
})
```

Handler branches on intent:
- **search/refine/pivot**: existing `buildSearchPool` flow, returns events via functionResponse
- **more**: pulls unseen events from session pool, applies dedup/time gates, returns next batch. On exhaustion, returns `{ events: [], exhausted: true, suggestions: ["Bed-Stuy", "Williamsburg"] }`
- **details**: matches `pick_reference` against `lastPicks` by index, event name, or venue name. Returns full event details (description, URL, price, etc.)

In all cases the agent writes the SMS via continuation.

## SMS Composition: Natural Prose

Before (numbered list):
```
1. Jazz at Blue Note, 7:30pm — $20
2. Comedy at Tiny Cupboard, 8pm — free
3. DJ set at Elsewhere, 10pm — $15
Reply 1-3 for details, MORE for more
```

After (natural prose):
```
Blue Note has a killer jazz quartet at 7:30 ($20), Tiny Cupboard's got free standup at 8, and Elsewhere has a late-night DJ set at 10 ($15). Any of these sound good?
```

- Still 480 chars max
- Agent still returns structured `picks` array in continuation JSON for dedup (P1 preserved)
- Users reference picks however they want: "the comedy one", "Tiny Cupboard", "2", "tell me more about the DJ set"
- Detail responses are also natural: "Tiny Cupboard's standup tonight is a free open mic, doors at 7:30. 269 Meserole St in Bushwick. tinyurl.com/..."

## `checkMechanical` Reduction

Before (8+ patterns): help, bare numbers, more, greetings, thanks, bye, satisfied-exit, decline, acknowledgments.

After (2 patterns):
- `help` / `?` — canned response ($0)
- TCPA opt-out (STOP, UNSUBSCRIBE, etc.) — silent drop ($0)

Everything else hits the agent brain.

## Handler Flow

```
message -> checkMechanical (help + TCPA only, $0)
  -> match: handleHelp / silent drop
  -> no match: handleAgentBrainRequest (Gemini tool calling)
    -> search_events (search/refine/pivot/more/details)
    -> respond (greetings, thanks, bye, off-topic)
```

## Cost Impact

The 15-20% of messages that were $0 (mechanical) now cost ~$0.0005 each via Gemini Flash Lite. Net increase: ~$0.002 per session (~20 messages). Negligible vs Twilio send cost ($0.008/msg). Daily budget of $0.10/user still allows 125+ messages.

Model unchanged: Gemini Flash Lite. Fallback chain unchanged: continuation failure -> brainCompose, Gemini failure -> Anthropic Haiku.

## Implementation Changes

1. **`checkMechanical`** — reduce to help + TCPA only
2. **`search_events` handler** — add `more` branch (reuse handleMore pool/dedup logic, return events instead of composing) and `details` branch (match pick_reference against lastPicks, return full event data)
3. **`get_details`** — delete from BRAIN_TOOLS, delete executeGetDetails
4. **`dispatchPreRouterIntent`** — remove details/more/conversational branches; only referral + help remain
5. **Prompts** — rewrite BRAIN_SYSTEM examples and continuation instructions to drop numbered lists, add natural prose examples, add more/details intent examples
6. **Evals** — update code evals that check for numbered formatting or mechanical intent routing

## What Stays Unchanged

- `saveResponseFrame`, `buildSearchPool`, session shape (12 fields), Twilio, traces, fallback chain
- Phase 3 compatibility: session fields Phase 3 removes (`lastNeighborhood`, `lastFilters`) become dead code once the agent derives context natively — no conflict
