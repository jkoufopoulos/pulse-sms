# Welcome Experience Design

## Problem

Phase 5 deleted the deterministic welcome path (`handleWelcome`). Now when a new user texts "hey", the agent calls `respond` and sends a generic "Text me a neighborhood to get started!" — a dead-end requiring another round trip. The old welcome immediately showed curated picks, which was a superior first impression.

## Design

### Architecture: Agent-routed, mechanically-executed

The LLM decides whether to show the welcome — but the welcome itself is deterministic. This preserves the agent's intelligence for classification while keeping the welcome response at $0 and sub-second.

**Flow:**
1. First message arrives, session is fresh (no history)
2. System prompt tells the agent this is a new user (session context: "New session — first message")
3. Agent decides what to do:
   - "hey" / "hi" / "yo" → agent calls `show_welcome` tool → deterministic picks, $0
   - "bushwick" → agent calls `search_events` as normal
   - "how do I use you" → agent calls `respond` with explanation
   - abuse → agent calls `respond`, redirects to purpose
4. `show_welcome` tool execution is mechanical: `getTopPicks`, format, `saveResponseFrame`

The agent pays ~$0.001 for the classification call, but the welcome response itself costs $0 and is instant after the tool call returns. The key principle: **the LLM owns routing decisions, deterministic code owns execution.**

### The `show_welcome` tool

Added to `BRAIN_TOOLS`. Available on every call but the system prompt instructs the agent to only use it for first-session greetings.

```
{
  name: 'show_welcome',
  description: 'Show tonight\'s top picks as a welcome message. ONLY use this on the very first message of a new session when the user sends a casual greeting (hey, hi, yo, etc). Never use for returning users or specific requests.',
  parameters: {
    type: 'object',
    properties: {},
  }
}
```

No parameters — the welcome is always citywide top picks. The tool execution calls `getTopPicks(5)`, takes top 3, formats deterministically, returns the SMS text to the agent. The agent does NOT compose — it passes the tool result through as the final response.

### When the agent should call `show_welcome`

- New session (system prompt shows "first message") AND casual greeting
- "hey", "hi", "yo", "hello", "what's up", "sup"

### When the agent should NOT call `show_welcome`

- **Neighborhood names** — "bushwick", "LES" → `search_events`
- **Category/vibe requests** — "comedy tonight", "something weird" → `search_events`
- **Questions** — "how do I use you", "what is this" → `respond`
- **Abuse/profanity** → `respond` (redirect to purpose)
- **Returning users** — any session with history → never `show_welcome`

### The welcome response

Format:
```
I'm Pulse — here's what's good tonight:

1) 🎭 Comedy Show — Union Hall, Park Slope, 8pm ($10)
2) 🎵 DJ Set — Elsewhere, Bushwick, 10pm (free)
3) ✨ Art Opening — Signal, Dumbo, 7pm (free)

Any of those? Or tell me what you're in the mood for
```

If no events in cache (edge case — scraper down), tool returns a fallback string:
```
Hey, I'm Pulse — your plugged-in friend for NYC nightlife. Tell me what you're in the mood for tonight.
```

### CTA shift

Old: "text me a neighborhood" → New: "tell me what you're in the mood for"

Nudges users toward vibe/mood-based requests instead of geography.

### Session handling

- `saveResponseFrame` with picks, eventMap, `neighborhood: 'citywide'`
- Conversation history updated normally by `saveSessionFromToolCalls` (records the `show_welcome` tool call)
- Subsequent messages see history → agent never calls `show_welcome` again

### Code changes

| File | Change |
|------|--------|
| `brain-llm.js` | Add `show_welcome` to `BRAIN_TOOLS`. Update `buildBrainSystemPrompt` to indicate first-session status |
| `brain-execute.js` | Restore `handleWelcome`, `formatWelcomePick`, `welcomeTimeLabel`, `WELCOME_EMOJI` from commit `01e74a9` with updated CTA |
| `agent-loop.js` | Handle `show_welcome` tool call in `executeTool` — call `handleWelcome`, return result |
| `events.js` | Verify `getTopPicks` still exists (or restore) |
| `handler.js` | No change |
| `agent-brain.js` | No change — `checkMechanical` stays help/TCPA only |

### What doesn't change

`checkMechanical` (stays help/TCPA only). Session schema. Agent loop structure. Existing tools.

### Principles

- **P6 compliant** — LLM classifies (smart), execution is mechanical (cheap). Same pattern as the agent calling `search_events` where buildSearchPool is deterministic.
- **P4 compliant** — ends with `saveResponseFrame`.
- **P1 compliant** — tool call params own the routing decision (agent chose `show_welcome`). Session state saved deterministically from the tool execution.

## Trade-offs

- **Pro:** Immediate value on first text. Deterministic response is $0 and sub-second after the routing call.
- **Pro:** LLM intelligence for edge cases — questions, abuse, specific requests all handled naturally.
- **Pro:** Vibe-focused CTA teaches users the right interaction pattern.
- **Pro:** No new mechanical bypass — stays within the agent loop architecture.
- **Con:** Still costs ~$0.001 for the agent classification call (vs $0 for a fully mechanical path). Acceptable given the routing quality.
- **Con:** Deterministic picks lack LLM curation taste. Mitigated by interestingness scoring + category diversity in `getTopPicks`.
