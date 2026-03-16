# Plan: Unified Agent Architecture — COMPLETED 2026-03-16

**Goal**: Refactor from 5-tool / 15-field session / multi-iteration loop to 2-tool / conversation-as-state / single-iteration loop. 4 independent steps, each shippable alone.

**Status**: All 4 steps implemented and deployed. See commit `9fa5a2b`.

**Why**: Every new entity type (places, transit, reservations) currently requires touching 4 files, adding session fields, updating routing in the system prompt. This refactor makes new entities one function in one file.

**Impact**: -47% LLM cost, -50% latency, -380 lines, natural "dinner and a show" blending.

---

## Sequencing

```
Step 1 (drop compose_sms)        ← lowest risk, biggest latency win
    ↓
Step 2 (unified search tool)     ← simplifies tool surface before touching state
    ↓
Step 3 (conversation-as-state)   ← gut session once tools are clean
    ↓
Step 4 (slim prompt)             ← safe to remove routing rules once plumbing is simple
```

Rationale (revised per Gemini review): Slim the prompt LAST, not second. If you remove the 2,900 tokens of routing rules while the model still has to navigate 5 tools and 15 session fields, it breaks. Once tools are unified and state is simple, the routing rules are dead weight and can be safely deleted.

---

## Step 1: Drop compose_sms

**Lowest risk, biggest latency win. Do this first.**

The model currently calls `search_events` → gets pool → calls `compose_sms` → we validate/rebuild. That's 2 LLM iterations. The model can just write SMS as plain text after seeing results — this path already works (it's the current fallback when compose_sms fails).

### Files changed

**`src/brain-llm.js`**
- Remove `compose_sms` from `BRAIN_TOOLS` array
- Add to system prompt TOOL FLOW: "After search_events returns results, write your SMS as plain text. Do NOT call compose_sms."
- Remove compose_sms from `show_welcome` description

**`src/agent-loop.js`**
- Remove `compose_sms` from `stopTools` in `runAgentLoop` call (line ~743)
- Remove `validateComposeSms` function (~25 lines)
- Simplify SMS determination in `handleAgentRequest`:
  ```javascript
  // Before: compose_sms > respond > loopResult.text > template fallback
  // After:  respond > loopResult.text > fallback
  const lastRespond = rawResults.reverse().find(r => r.name === 'respond');
  let smsText = lastRespond?.params?.message || loopResult.text;
  ```
- Remove price injection block (model sees `price_display` in pool already)
- In `saveSessionFromToolCalls`: remove `lastCompose` references, use `extractPicksFromSms` for all pick detection
- Remove `compose_sms` handling from `deriveIntent`

**`src/brain-llm.js`** — `serializePoolForContinuation`
- Ensure `price_display` is included in serialized events (already is)
- No other changes needed

### Critical: 480-char enforcement

Removing compose_sms removes the structured validation that caught oversized SMS. Without it, the model WILL occasionally write 600+ char responses. Failsafes:

1. **Prompt**: "HARD LIMIT: 480 characters" (already in prompt, keep it)
2. **`smartTruncate`**: already runs on every SMS as final safety net (keep as-is)
3. **`rewriteIfTooLong`**: single-attempt LLM rewrite for >480 chars (keep for now, evaluate removing in Step 4)

This is NOT new risk — the same failsafes protect the plain-text fallback path today. We're just making it the primary path.

### What to verify
- `npm test` — all existing tests pass
- Eval: run `npm run eval:quality` — SMS quality stays same or improves (model has more editorial freedom)
- Manual: "williamsburg" → model writes SMS directly after seeing pool → 1 iteration, ~500ms faster
- Manual: "2" → details still work (search_events with intent: details)
- Manual: "more" → more still works
- Verify: no SMS exceeds 480 chars in 20-query test run

### Risk
Low. This code path already works — it's what happens when compose_sms fails validation today. We're just making it the primary path.

### Impact
- -1 LLM iteration per search request
- ~500ms latency reduction
- ~30% cost reduction per search
- Delete ~60 lines (validateComposeSms, price injection, compose_sms SMS extraction)

---

## Step 2: Unified search tool

**Merge `search_events` + `search_places` + `show_welcome` into one `search` tool.**

The model is good at parsing intent ("dive bar and live music") into parameters. It's bad at orchestrating parallel tool calls. Let the model define what it wants once; let the backend fan out requests in parallel.

### New tool definition

```javascript
{
  name: 'search',
  description: 'Search for things to do in NYC — events, bars, restaurants, or all of the above. Returns a curated pool ranked by interestingness. Write your SMS as plain text after seeing results.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language: "bars in williamsburg", "live music tonight", "dinner and a show in LES"',
      },
      neighborhood: { type: 'string', nullable: true },
      types: {
        type: 'array',
        items: { type: 'string', enum: ['events', 'bars', 'restaurants'] },
        description: 'What to search for. Inferred from query if omitted.',
      },
      filters: {
        type: 'object', nullable: true,
        properties: {
          categories: { type: 'array', items: { type: 'string' }, nullable: true },
          free_only: { type: 'boolean' },
          time_after: { type: 'string', nullable: true },
          date_range: { type: 'string', enum: ['today', 'tomorrow', 'this_weekend', 'this_week'], nullable: true },
          vibe: { type: 'string', nullable: true },
        },
      },
      intent: {
        type: 'string',
        enum: ['discover', 'more', 'details'],
      },
      reference: { type: 'string', nullable: true },
    },
    required: ['intent'],
  },
}
```

### Files changed

**`src/brain-llm.js`**
- Replace `search_events`, `search_places`, `show_welcome` in `BRAIN_TOOLS` with single `search` tool
- Remove routing rules from system prompt (events vs places)
- `serializePoolForContinuation` → `serializeUnifiedResults` (unified format with `type` tag on each item)

**`src/agent-loop.js`**
- `executeTool`: collapse `search_events` + `search_places` + `show_welcome` branches into one `search` handler
- New `inferTypesFromQuery` helper: regex-based type inference from query text
- Fire event + place searches in parallel via `Promise.all` when types include both
- `saveSessionFromToolCalls`: simplify to handle one `search` tool instead of 3
- `deriveIntent`: simplify — `search` with intent field determines intent directly

**`src/brain-execute.js`**
- `buildSearchPool` stays as-is (called internally by unified search)
- `executeMore` stays as-is (called internally)

**`src/places.js`**
- No changes. `searchPlaces` called internally by unified search handler.

### Unified result format

```javascript
{
  neighborhood: 'Williamsburg',
  count: 8,
  items: [
    { type: 'event', id: 'e1', name: 'Puma Blue', venue: 'Music Hall', time: '...', category: 'live_music', recommended: true, why: 'one-off, underground radar pick' },
    { type: 'bar', id: 'p1', name: 'The Commodore', price: '$', rating: 4.5, summary: 'Laid-back bar with Southern fare', features: 'patio, groups' },
    { type: 'event', id: 'e2', name: 'Comedy Open Mic', venue: 'Houdini Kitchen', ... },
    ...
  ]
}
```

Model sees events and places together. Can naturally write: "Grab a drink at The Commodore then catch Puma Blue around the corner at Music Hall."

### What to verify
- All existing tests pass (update test mocks for new tool name)
- Eval: quality maintained on event-only queries
- Manual: "best bars in williamsburg" → places results
- Manual: "dinner and a show" → both events + places in one result
- Manual: "2" after mixed results → details for correct item (event or place)
- Manual: "more" → excludes previously shown items

### Risk
Medium. The model needs to correctly use one tool for all cases. Prompt may need tuning. Run evals.

### Impact
- "Dinner and a show" in 1 iteration (was 2+)
- Simpler prompt (no routing rules needed)
- Delete ~40 lines of tool-specific branching
- Natural blending of events + places in responses

---

## Step 3: Conversation-as-state

**Replace 15-field session with `{ messages, offeredIds, timestamp }`.**

### Design decision: hybrid state (Gemini review revision)

Pure conversation-as-state stores raw tool results (10 events + 8 bars per search) in the message history. Over a 10-turn conversation, that's massive token bloat.

**Hybrid approach**: Store the conversation flow (user messages, assistant SMS, tool call params) but NOT the raw tool result pools. Instead, store only the `recommended_ids` from each search.

```javascript
{
  messages: [
    { role: 'user', content: 'williamsburg' },
    { role: 'tool_call', name: 'search', params: { neighborhood: 'williamsburg', intent: 'discover' } },
    { role: 'search_summary', neighborhood: 'Williamsburg', count: 8, recommended_ids: ['e1', 'p1'] },
    { role: 'assistant', content: 'Williamsburg tonight — Puma Blue at Music Hall...' },
    { role: 'user', content: '2' },
    // ...
  ],
  offeredIds: ['e1', 'e2', 'e3', 'p1', 'p2'],  // all shown, for "more" dedup
  timestamp: Date.now(),
}
```

The full tool result pool is still passed to the model within the agent loop's current turn (via the tool_result message in the LLM conversation). It's just not persisted in the session history for future turns. On "details" or "more", the tool re-fetches from cache (events cache is in-memory, places cache is SQLite with 24hr TTL).

**Why not full structured output?** Gemini suggested using `response_schema` to force the model to return `{ sms_body, recommended_ids }`. This is appealing but adds complexity: we'd need to parse structured output, validate the IDs exist, and handle malformed responses. The hybrid approach gets the same benefit (no fuzzy pick extraction) with less risk — we extract `recommended_ids` from the tool result's `recommended: true` items, not from the model's SMS text.

### State derivation (replaces stored fields)

| Old field | New derivation |
|-----------|---------------|
| `lastPicks` | Last `search_summary` recommended_ids |
| `lastEvents` / `lastPlaceMap` | Re-fetch from cache using recommended_ids |
| `lastNeighborhood` | Last `tool_call` params.neighborhood |
| `lastFilters` | Last `tool_call` params.filters |
| `lastResultType` | Inferred from last search_summary (events vs bars/restaurants) |
| `allOfferedIds` | `session.offeredIds` (accumulated) |
| `visitedHoods` | Scan all `tool_call` params.neighborhood |
| `pendingNearby` | Last `search_summary` suggested_neighborhood |
| `lastResponseHadPicks` | Last `search_summary` count > 0 |
| `conversationHistory` | `session.messages` (user + assistant turns, full text) |

### Files changed

**`src/session.js`**
- `setResponseState` → delete (replaced by `saveMessage`)
- New `saveMessage(phone, role, content, meta)` — appends to messages array, accumulates offeredIds
- `getSession` returns `{ messages, offeredIds, timestamp }`
- Disk persistence: write messages + offeredIds instead of 15 fields
- Trim messages to last 20 entries (~10 exchanges)

**`src/pipeline.js`**
- Delete `saveResponseFrame` function
- Keep: `buildTaggedPool`, `eventMatchesFilters`, `buildExhaustionMessage`, etc. (pure functions, still needed)

**`src/agent-loop.js`**
- Delete `saveSessionFromToolCalls` (170 lines, 6 branches)
- `handleAgentRequest`: call `saveMessage` for each conversation turn inline
- Delete `extractPicksFromSms` (fuzzy matching) — picks come from `recommended: true` items in tool result
- Keep `findMentionedItems` only for URL sending after details

**`src/brain-llm.js`**
- `buildBrainSystemPrompt`: build session context from `messages` array instead of 15 session fields
- Include search_summary entries in prompt context (lightweight: neighborhood + count + IDs)

**`src/handler.js`**
- Minor: `handleMessageAI` passes `session.messages` instead of session object
- `addToHistory` calls → replaced by `saveMessage` in agent loop

**`src/brain-execute.js`**
- `executeMore`: accept `offeredIds` for dedup instead of reading from session fields
- Details intent: re-fetch full item data from cache using IDs from search_summary

### Token budget for history

```
Per turn stored in history:
  user message:     ~50 tokens
  tool_call:        ~30 tokens (name + params, no result)
  search_summary:   ~20 tokens (neighborhood, count, 2-3 IDs)
  assistant SMS:    ~120 tokens

Total per exchange: ~220 tokens
10 exchanges:       ~2,200 tokens

vs. current (truncated snippets): ~750 tokens
vs. raw tool results in history:  ~5,000+ tokens (the bloat Gemini warned about)
```

The hybrid approach costs ~1,450 more tokens than current truncated snippets, but ~2,800 LESS than storing raw pools. Net cost at turn 10: +$0.000145/request (Gemini Flash). Recovered by prompt slimming in Step 4.

### Migration strategy

1. Add `saveMessage` alongside existing session functions
2. Wire `handleAgentRequest` to call `saveMessage` for each turn
3. Update `executeMore` and detail resolution to use offeredIds + cache re-fetch
4. Delete old session functions and `saveSessionFromToolCalls`
5. Migrate disk persistence format (one-time migration on boot: convert old format → new on load)

### What to verify
- All tests pass (rewrite session-dependent tests)
- "more" still deduplicates correctly (offeredIds accumulated from search_summary)
- "2" after events → correct event details (re-fetched from cache)
- "2" after places → correct place details (re-fetched from SQLite cache)
- Session TTL still works (2hr expiry)
- Disk persistence round-trips correctly
- Cache re-fetch doesn't miss: events cache is in-memory (always warm during session TTL), places cache is SQLite (24hr TTL > 2hr session TTL)

### Risk
Higher. Session is the backbone — every feature touches it. Incremental migration within this step (keep old functions, add new ones, switch callers one at a time). The cache re-fetch pattern introduces a new dependency: if event cache refreshes mid-conversation (10am daily scrape), old IDs may not resolve. Mitigation: details handler returns "those picks expired, want fresh ones?" if IDs miss.

### Impact
- Delete ~250 lines (saveResponseFrame, setResponseState, saveSessionFromToolCalls, extractPicksFromSms)
- No mutual exclusion logic (events/places coexist in conversation naturally)
- Adding new entity types = zero session changes
- Better model context without token bloat

---

## Step 4: Slim the system prompt

**Move curation logic from prompt text into tool result metadata. Replace rules with few-shot examples.**

Do this LAST — once tools are unified and state is simple, the routing tables and decision trees in the prompt are dead weight. Safe to delete.

### Core idea

Instead of 20 prompt bullet points telling the model how to interpret `source_vibe`, `venue_size`, `scarcity`, etc., pre-compute a `recommended: true, why: "one-off, underground radar pick, tiny room"` field on each result item. Same editorial output, zero prompt tokens.

For voice: replace 12 bullet points of style rules with 2-3 few-shot examples. The model mimics tone, structure, and brevity from examples far better than from abstract rules.

### Files changed

**`src/brain-llm.js`**
- `buildBrainSystemPrompt`: shrink from ~2,900 tokens to ~800 tokens
- Remove: CURATION TASTE block, NEIGHBORHOOD list, routing tables, tool flow decision tree, 12-bullet voice guide
- Keep: role definition, time, 8 concise rules
- Add: 2-3 few-shot examples (~150 tokens) showing ideal input→SMS pairs
- New `buildRecommendationReason(event)`: converts metadata to natural language reason

**`src/pipeline.js`** (or new `src/ranking.js`)
- New `rankAndAnnotate(pool)`: sort by interestingness, add `_rank` and `recommended` flags to top items
- Called during pool serialization, before model sees results

**`src/brain-llm.js`** — `serializeUnifiedResults`
- Add `recommended: true/false` and `why: "..."` to each item
- Model sees pre-digested curation signals instead of raw metadata

### New system prompt (~800 tokens)

```
You are Pulse, an NYC nightlife SMS bot. You text like a plugged-in friend — warm, opinionated, max 480 chars.

TIME: {nycNow}

RULES:
- Search first, ask later. Contrasting picks > clarifying questions.
- 1-2 picks. Lead with WHY it's good. Trust "recommended" and "why" from results.
- Events and places mix naturally: "Grab a drink at [bar] then catch [show] around the corner."
- For details: venue feel first, then event, then logistics.
- After details, the system sends the URL automatically.
- "more" = different results. "2" or name = details.
- Under 480 chars. No URLs in main SMS. No prices in initial picks.
- Write SMS as plain text after search results.

EXAMPLES:

User: "bushwick"
→ search({neighborhood: "bushwick", intent: "discover"})
SMS: "Bushwick tonight — there's a one-off noise show at Alphaville, tiny room, gonna be loud and weird in the best way. Or Mood Ring has a vinyl DJ set if you want something mellower. Which sounds more like your night?"

User: "tell me more about the vinyl thing"
→ search({intent: "details", reference: "the vinyl thing"})
SMS: "Mood Ring is one of those places that looks like nothing from outside but has this perfect dark room with a great sound system. Tonight's a local DJ spinning funk and soul on vinyl, no cover. Starts at 9, but it doesn't really fill up til 10:30."
```

### What to verify
- `npm run eval:quality` — SMS quality maintained or improved
- Eval: curation taste still biases toward discovery/niche, intimate venues, one-night-only
- Eval: model still uses natural conversational voice (not listing format)
- Manual: compare SMS output before/after for 10 representative queries
- A/B: run 20 queries with old prompt and new prompt, blind-compare outputs

### Risk
Medium. Prompt changes = behavior changes. Few-shot examples anchor the voice better than rules, but need the right examples. Plan for 2-3 prompt iterations with eval runs between.

### Impact
- -2,100 input tokens per request
- Cleaner model compliance (fewer rules = fewer ignored)
- Curation logic testable as code instead of embedded in prompt text
- Voice maintained through examples rather than rules

---

## Cost summary

| Milestone | Cost/5-msg conversation | Latency/search | Net lines deleted |
|-----------|------------------------|----------------|-------------------|
| Current | $0.0030 | 2-3s | — |
| After Step 1 (drop compose_sms) | $0.0021 (-30%) | 1.5-2s | ~60 |
| After Step 2 (unified search) | $0.0019 (-37%) | 1-1.5s | ~100 |
| After Step 3 (conversation-as-state) | $0.0020 (-33%) | 1-1.5s | ~350 |
| After Step 4 (slim prompt) | $0.0016 (-47%) | 1-1.5s | ~380 |

Step 3 adds ~$0.0001 back (hybrid history costs more tokens than truncated snippets) but Step 4 recovers it. The architectural payoff — zero-touch entity addition — is the point.

---

## Definition of done

Each step is done when:
1. `npm test` passes (all existing + new tests)
2. `npm run eval:quality` scores equal or better than baseline
3. Manual smoke test: "williamsburg" → "2" → "more" → "best bars" → "what's happening tonight" all work
4. No regressions in Twilio SMS delivery (test endpoint + live)
5. No SMS exceeds 480 chars in a 20-query stress test

---

## Review notes

This plan was reviewed by Gemini 2.5 Pro. Key revisions incorporated:

1. **Sequencing reordered to 1→2→3→4** (was 1→4→2→3). Slim the prompt last, not second — removing routing rules while the model still navigates 5 tools and 15 session fields risks breakage.

2. **Hybrid state instead of pure conversation-as-state**. Don't persist raw tool result pools in message history (token bloat). Store `search_summary` with neighborhood + count + recommended_ids. Re-fetch full data from cache when needed.

3. **Few-shot examples for voice**. Replace 12-bullet voice guide with 2-3 ideal input→SMS pairs. Models mimic examples better than they follow abstract style rules.

4. **480-char enforcement explicitly called out**. Removing compose_sms removes its validation. `smartTruncate` + `rewriteIfTooLong` are the safety net. Must verify in testing.

5. **Token cost of hybrid history**: ~2,200 tokens for 10 turns (vs 750 current, vs 5,000+ with raw pools). Acceptable tradeoff — recovered by prompt slimming.
