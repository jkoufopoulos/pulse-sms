# Phase 2: Single-Turn Agent — Design

**Goal:** The agent that understands what the user wants is the same one that writes the SMS. One Gemini chat session, not two isolated LLM calls.

**Problem today:** User texts "something weird and lowkey in bushwick." The routing LLM understands intent and calls `search_events({neighborhood: "Bushwick", vibe: "weird"})`. Events are fetched deterministically. Then a *separate* LLM call (`brainCompose`) sees only "Filter: weird events" and a flat event list — it never saw the user's message, conversation history, or how they asked. The SMS reads generic.

**After:** One Gemini chat session. The model calls `search_events`, gets event results back as a `functionResponse`, and continues generating the SMS in the same context. It remembers "something weird and lowkey" and writes copy that connects to what the user said.

## Architecture

**Current (two isolated calls):**
```
User message → callAgentBrain() → {tool: search_events, params}
                                        ↓
                              executeSearchEvents() → event pool
                                        ↓
                              brainCompose(events) → SMS  ← NEW Gemini call, no user context
```

**New (one chat session, two round-trips):**
```
User message → Gemini chat session → functionCall: search_events(params)
                                        ↓
                              executeSearchEvents() → event pool
                                        ↓
                    functionResponse(events) → same session → SMS  ← same context
```

## Key Decisions

- **Gemini multi-turn tool calling** — send `functionCall` result back to the same chat, model continues generating. Supported natively by Gemini SDK.
- **`brainCompose` deleted** for the search_events path. The compose prompt (`BRAIN_COMPOSE_SYSTEM`) is merged into the main brain system prompt so the model knows how to format SMS from the start.
- **`handleMore` keeps a standalone compose** — "more" is mechanical, no user intent to carry through. Can migrate later.
- **`respond` tool unchanged** — agent already writes conversational SMS directly.
- **`get_details` unchanged** — dispatches to existing handleDetails.
- **`welcomeCompose` unchanged** — separate flow for first-time users.
- **Anthropic fallback** — same pattern. If Gemini fails on the initial call, fall back to Anthropic with tool calling. If Gemini succeeds on routing but fails on compose continuation, fall back to standalone brainCompose as degraded path.
- **JSON schema enforcement** — Gemini's `responseMimeType: 'application/json'` with `responseSchema` on the continuation call ensures structured output (sms_text + picks).

## What Changes

### `callAgentBrain` → returns chat session + tool call
Instead of returning just `{tool, params, usage}`, returns the Gemini chat object so we can continue the conversation after tool execution.

### `executeSearchEvents` → returns event pool for continuation
Currently returns `{sms, intent, picks}` after calling `brainCompose` internally. New version returns the event pool and metadata without composing — the caller feeds it back to the chat session.

### New `continueWithResults` function
Takes the chat session + event pool, sends `functionResponse`, gets the SMS back. Enforces JSON schema on the continuation.

### Brain system prompt updated
Merge `BRAIN_COMPOSE_SYSTEM` formatting rules into `buildBrainSystemPrompt`. The model needs to know from the start that after tool execution, it will write an SMS.

### `handleAgentBrainRequest` orchestrator updated
```
1. callAgentBrain(message) → {chat, toolCall, usage}
2. if search_events:
     pool = executeSearchEvents(toolCall.params)  // no compose
     result = continueWithResults(chat, pool)       // same session writes SMS
     saveResponseFrame + sendSMS
3. if get_details: dispatch to handleDetails (unchanged)
4. if respond: send message (unchanged)
```

## What Stays the Same

- `checkMechanical` — $0 shortcuts for help/numbers/more/greetings
- `executeSearchEvents` event fetching + filtering logic — deterministic, unchanged
- `saveResponseFrame` — P4 compliant atomic session save
- `buildTaggedPool`, `mergeFilters`, `buildZeroMatchResponse` — all pipeline.js unchanged
- `handleMore` — still uses standalone compose (brainCompose kept for this path)
- `validatePicks` — still validates LLM picks against event pool
- Trace recording — same fields, same structure

## Cost & Latency

- **Cost:** ~$0.0006-0.0008/msg (up from ~$0.0005). The continuation call includes input context from the first call. Marginal increase.
- **Latency:** Similar or slightly better. The continuation call is smaller (just event data + "write the SMS") and the model is already warmed up.
- **Fallback cost:** Anthropic fallback unchanged (~$0.002 on Haiku, <1% of requests).

## Risks

- **Gemini chat session state** — need to verify the SDK supports sending `functionResponse` after `functionCall` cleanly. The [docs](https://ai.google.dev/gemini-api/docs/function-calling) confirm this.
- **480-char compliance** — the model writes SMS directly instead of through a focused compose prompt. Mitigated by putting formatting rules in the system prompt and using `smartTruncate` as a safety net.
- **brainCompose still needed** for `handleMore` — two compose paths to maintain. Acceptable for now.
