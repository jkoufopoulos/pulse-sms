# Discovery Conversation Design

## Problem

Pulse dumps event picks on first contact with zero context about the user. This feels like a newsletter, not a friend. A plugged-in friend would ask what you're in the mood for before recommending.

## Design

### Conversational opener replaces cold picks

**First message from new user (greeting):** Model introduces itself, asks a question. No events.
```
Hey! I'm Pulse — your plugged-in friend for NYC nightlife.
What neighborhood are you in tonight, and what's the vibe?
```

**Vague request (bare neighborhood, broad time):** Model has partial context, asks one narrowing question.
```
Greenpoint tonight — what's the vibe? Date night, friends, solo adventure?
```

**Specific request (2+ signals):** Skip questions, go straight to picks.
```
"comedy in bushwick tonight" → search_events directly
```

**`show_welcome` top picks:** Gated to returning users with conversation history only.

### When to ask vs. recommend

- **Ask** when request is vague: bare neighborhood, casual greeting, broad time range
- **Recommend** when request has 2+ signals: neighborhood + category, neighborhood + time, specific vibe
- **One question max** — pick the most useful missing dimension:
  - No neighborhood → "What neighborhood?"
  - Neighborhood, no context → "What's the vibe?"
  - Broad time, no vibe → "What are you in the mood for?"

### Implementation

Prompt-level change only. No new tools or code paths.

| What | Change |
|------|--------|
| `show_welcome` tool description | Gate: "ONLY for returning users with conversation history" |
| System prompt TOOL FLOW | New user greeting → respond with intro + question |
| System prompt SMS VOICE | "Ask before recommending when context is missing. One question max." |

### Inspiration

Claude movie recommendation conversation: asks mood → energy level → platform before recommending. Each question halves the space. Pulse should feel the same — 1-2 questions, then a tight recommendation with reasoning.
