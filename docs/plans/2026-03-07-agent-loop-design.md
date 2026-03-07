# Agent Loop Design

## Problem

The current architecture pretends to be an agent but isn't. `handleAgentBrainRequest` is a 400-line switch statement that manually orchestrates tool execution and SMS composition. The LLM picks a tool, then code decides everything else — what to do with the results, how to compose, how to handle edge cases. This causes:

- **Misrouting**: "what are you?" triggers `search_events` because the prompt over-specifies routing rules instead of letting the model use judgment
- **Brittle special cases**: welcome flow, zero-match, exhaustion, more, details — each is a separate code path with its own composition logic
- **Disconnected context**: the routing decision and the composition happen in separate LLM calls, so the model that writes the SMS doesn't fully understand why it's writing it

## Design

### Core Loop

```
user message -> LLM(system prompt + history + tools)
  |
  tool_call? -> execute tool -> feed result back -> loop (max 3 iterations)
  text?      -> that's the SMS, done
  |
save session state from tool calls that happened
send SMS
```

No switch statement. No separate compose step. The LLM decides when it has enough information to write the SMS. When it's ready, it stops calling tools and responds with text — that text is the SMS.

### Tools

Same 2 tools, but the model interacts with them naturally:

**`search_events(neighborhood, category, categories, free_only, time_after, date_range, intent, pick_reference)`**
Returns structured event data. On zero matches, returns `{ match_count: 0, nearby_neighborhoods: [...] }` so the model can decide: call again with broader filters, suggest nearby, or just tell the user.

**`respond(message, intent)`**
For pure conversation — greetings, meta questions, thanks, off-topic. The model writes the SMS in the `message` param. Intent is for tracing only.

### What Changes

| Today | Agent Loop |
|-------|-----------|
| `handleAgentBrainRequest` — 400-line switch | ~30-line loop: call LLM, execute tool, feed back, repeat |
| `handleWelcome` — deterministic first-message bypass | Deleted. "hey" goes through the agent like any other message |
| `continueWithResults` — manual Gemini chat continuation | Replaced by the loop's natural multi-turn |
| `brainCompose` / `welcomeCompose` — separate LLM compose calls | Deleted. The agent writes SMS as its final text output |
| `BRAIN_COMPOSE_SYSTEM` / `WELCOME_COMPOSE_SYSTEM` — compose prompts | Deleted. Compose rules live in the single system prompt |
| Zero-match hardcoded responses | Model sees `match_count: 0`, decides what to do |
| `callWithTools` + `continueChat` in llm.js | New `runAgentLoop` that handles the full tool-call cycle |

### What Stays As Code

- **Tool implementations** — `buildSearchPool`, `executeMore`, `executeDetails` stay as pure functions that return data
- **Session save** — `saveResponseFrame` after the loop ends, based on which tools were called
- **Guard rails** — `smartTruncate` (480 chars), per-user budget, TCPA opt-out, dedup
- **Tracing** — record each tool call, costs, latency per iteration
- **Fallback** — if Gemini fails, retry the whole loop with Haiku

### Loop Constraints

- **Max 3 tool calls** per user message (cost + latency cap, keeps under ~5s)
- **Timeout**: 10s total for the loop
- **Existing per-user daily budget** still applies ($0.10/day prod)

### System Prompt (Simplified)

The prompt shrinks dramatically. No routing rules, no intent examples, no date mapping, no neighborhood aliases. Just:

- Identity: "You are Pulse, an NYC nightlife SMS bot"
- Domain hint: "A bare neighborhood name means show me events there"
- Voice: friend texting, opinionated, concise, warm
- Curation taste: the pick hierarchy and source signal rules
- Format: each pick on its own line with name, venue, time, price. Under 480 chars. No URLs.
- Multi-step hint: "If search returns zero results, you can try again with broader filters or suggest nearby neighborhoods"

### llm.js: New `runAgentLoop` Function

```
runAgentLoop(model, systemPrompt, message, tools, executeTool, options)
```

- `executeTool(toolName, params)` — callback, returns result object
- Handles provider differences (Gemini chat sessions vs Anthropic message threading)
- Returns `{ text, toolCalls: [{ name, params, result }], totalUsage, provider }`
- Respects `maxIterations` (default 3) and `timeout`

### handler.js Changes

The orchestrator becomes:

```javascript
async function handleAgentBrainRequest(phone, message, session, trace, finalizeTrace) {
  // 1. Run the agent loop
  const result = await runAgentLoop(MODELS.brain, systemPrompt, message, BRAIN_TOOLS,
    (tool, params) => executeTool(tool, params, session, phone, trace),
    { maxIterations: 3, timeout: 10000 }
  );

  // 2. Guard rails
  const sms = smartTruncate(result.text);

  // 3. Save session from tool calls
  saveSessionFromToolCalls(phone, session, result.toolCalls);

  // 4. Send
  await sendSMS(phone, sms);
  finalizeTrace(sms, deriveIntent(result.toolCalls));
}
```

### Migration Strategy

1. **Add `runAgentLoop` to llm.js** — new function, no existing code changes
2. **Create `agent-loop.js`** — new orchestrator using the loop, with `executeTool` callback that delegates to existing `buildSearchPool`/`executeMore`/`executeDetails`
3. **Wire into handler.js** — replace `handleAgentBrainRequest` with the new loop-based version
4. **Delete dead code** — `handleWelcome`, `brainCompose`, `welcomeCompose`, `BRAIN_COMPOSE_SYSTEM`, `WELCOME_COMPOSE_SYSTEM`, `continueWithResults`, `serializePoolForContinuation`, the welcome flow in `handleAgentBrainRequest`
5. **Simplify system prompt** — strip routing rules, keep voice + compose + curation
6. **Run evals** — code evals first (structural), then scenario evals on Railway

### Risks

- **Gemini Flash Lite multi-turn tool calling quality** — may struggle with 2-3 turn loops. Mitigation: fall back to Haiku, which handles multi-turn well.
- **Latency** — each tool call adds ~0.5-1s. With max 3 calls, worst case ~4-5s. Acceptable per user's guidance.
- **Cost** — multi-turn uses more tokens. Estimated ~$0.001-0.002/msg vs ~$0.0008 today. Marginal.
- **`respond` tool** — model might still call `search_events` for conversational messages. But without the "prefer search_events" bias in the prompt, this should resolve naturally. Evals will catch regressions.
