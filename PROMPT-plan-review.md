# Prompt: Review this agent architecture refactor plan

I'm building Pulse, an SMS-based AI agent that recommends NYC nightlife events, bars, and restaurants. Users text a neighborhood and get curated picks via Twilio. The agent brain uses Gemini 2.5 Flash with tool calling in a multi-turn loop (max 3 iterations).

## Current architecture (what exists today)

- **5 tools**: `search_events`, `search_places`, `compose_sms`, `respond`, `show_welcome`
- **15-field session state**: `lastPicks`, `lastEvents`, `lastPlaceMap`, `lastResultType`, `lastNeighborhood`, `lastFilters`, `visitedHoods`, `pendingNearby`, etc. — atomically replaced via `setResponseState` after each response
- **2 LLM iterations per search**: model calls `search_events` → gets event pool → calls `compose_sms` with structured picks → we validate → send SMS
- **~2,900 token system prompt**: routing tables (events vs places), 20 curation rules, tool flow decision trees, 12-bullet voice guide, 75 neighborhood names
- **Mutual exclusion**: events and places have separate session fields. Switching between them requires clearing the other's state across 4 files.
- **Fuzzy pick extraction**: `extractPicksFromSms` substring-matches event names in SMS text to recover which events the model recommended — used for session state and URL sending

**Pain point**: Every new entity type (we just added places/bars, want to add transit, reservations, weather) requires touching 4 files, adding 3+ session fields, updating mutual exclusion logic, and adding routing rules to the system prompt.

## Proposed refactor (4 independent steps)

The plan below migrates to:
- **2 tools**: unified `search` (handles events + places + blended queries) and `respond`
- **3-field session**: `{ messages, offeredIds, timestamp }` — conversation history IS the state
- **1 LLM iteration per search**: model writes SMS as plain text after seeing results (no compose_sms round-trip)
- **~800 token system prompt**: curation rules move into pre-computed `recommended: true, why: "one-off, underground radar pick"` fields on result items

---

[PASTE THE PLAN HERE — the contents of PLAN-unified-agent.md]

---

## What I want your feedback on

1. **Sequencing risk**: I propose doing Step 1 (drop compose_sms) first because it's lowest risk and biggest latency win. Then Step 4 (slim prompt) to validate the model handles less guidance before changing tools. Then Step 2 (unified search) and Step 3 (conversation-as-state). Is this the right order? Would you reorder?

2. **Conversation-as-state tradeoff**: Full conversation history as session state means the model derives context from what it said before, instead of stored fields. This is cleaner but means:
   - Tool results (event/place pools) persist in the message history = more tokens per turn
   - State derivation (`extractLastResults`, `getShownIds`) walks the message array each request
   - If the model's SMS didn't mention an event, we have no structured record of what it recommended (only what was in the pool)

   Is this the right tradeoff? Are there hybrid approaches worth considering?

3. **Unified search tool design**: One `search` tool with `types: ['events', 'bars']` vs keeping separate tools but adding a meta-orchestrator. The unified approach means the model can't call events and places in parallel (it's one tool call). But the tool implementation runs them in parallel internally. Is this the right abstraction level?

4. **Prompt slimming risk**: Moving from 2,900 tokens of detailed rules to 800 tokens of concise rules + metadata-on-results. The model gets `recommended: true, why: "one-off, underground radar pick, tiny room"` instead of reading curation rules. My concern: will the model's editorial voice degrade without the detailed voice guidelines? Or is 3 sentences + good examples enough?

5. **What am I missing?** Blind spots, failure modes I haven't considered, alternative approaches worth exploring. Particularly around:
   - SMS-specific constraints (480 chars, no rich formatting, async delivery)
   - Cost optimization beyond what I've identified
   - How this architecture handles future features (proactive recommendations, group threads, location-based suggestions)
