# Phase 3: Conversation History as State — Design

**Goal:** The agent sees its own conversation as structured history — what the user said, what tools it called, what events it showed, how the user reacted. This makes conversations feel personal instead of each message being treated in isolation.

**Problem today:** History stores plain text ("User: bushwick", "Bestie: Tonight in Bushwick..."). The agent can't see its own decisions — what it searched for, what it showed, what filters it applied. So it can't connect follow-up responses to prior context.

**After:** Each history entry is structured. The agent sees tool calls, params, pick summaries, and match counts alongside user messages and its own SMS responses.

## History Format

Current (plain text, 6 entries, 300 chars each):
```
{ role: 'user', content: 'something weird in bushwick' }
{ role: 'assistant', content: 'Tonight in Bushwick: 1) Comedy at Tiny Cupboard...' }
```

New (structured, 10 entries):
```
{ role: 'user', content: 'something weird in bushwick' }
{ role: 'tool_call', name: 'search_events', params: { neighborhood: 'Bushwick', intent: 'new_search' } }
{ role: 'tool_result', picks: [{ name: 'Comedy at Tiny Cupboard', category: 'comedy' }], match_count: 5 }
{ role: 'assistant', content: 'Tonight in Bushwick: 1) Comedy at...' }
```

For non-search tools:
- `respond` tool: just `{ role: 'assistant', content: '...' }` (no tool_call/tool_result)
- `get_details`: `{ role: 'tool_call', name: 'get_details', params: { pick_number: 2 } }` + assistant response
- `welcome` flow: `{ role: 'assistant', content: '...' }` with picks in tool_result

## System Prompt Rendering

`buildBrainSystemPrompt` renders the structured history in a format the model can reason about:

```
Recent conversation:
User: "something weird in bushwick"
> search_events(neighborhood: "Bushwick", intent: "new_search") → 5 matches
> Showed: 1) Comedy at Tiny Cupboard (comedy), 2) Open Mic at Elsewhere (live_music)
Bestie: "Tonight in Bushwick: 1) Comedy at Tiny Cupboard..."

User: "how about something free"
> search_events(free_only: true, intent: "refine") → 2 matches
> Showed: 1) Open Mic Night at Pine Box (live_music, free)
Bestie: "Free stuff in Bushwick tonight..."
```

This replaces the current flat rendering AND the explicit session context lines (`Current neighborhood: X`, `Active filters: Y`). The agent derives that context from the history.

## Session Fields

**Remove** (derivable from tool call history):
- `lastNeighborhood` — last search_events neighborhood param
- `lastFilters` — last search_events filter params
- `lastBorough` — last search_events borough param
- `pendingNearby` — last suggested neighborhood in tool_result
- `pendingFilters` — filters from the pending suggestion
- `pendingMessage` — message associated with pending suggestion

**Keep** (accumulators / caches not derivable from recent history):
- `lastPicks` — current pick list for details handler
- `lastEvents` — event map cache for details handler
- `allPicks` / `allOfferedIds` — dedup accumulators across full session
- `visitedHoods` — neighborhood history for diversity
- `lastResponseHadPicks` — controls bare number handling
- `conversationHistory` — the structured history itself
- `lastZeroMatch` — zero-match state flag

Session: 14 fields → 8 fields.

## History Cap

Bump from 6 to 10 entries. Each full search turn = 4 entries (user + tool_call + tool_result + assistant), so 10 entries = ~2.5 full search turns visible. This is enough for the agent to understand context without excessive tokens.

Content truncation: user messages 300 chars (unchanged), SMS 300 chars (unchanged), tool_result picks summary ~50 chars each (name + category only).

## What Stays the Same

- `checkMechanical` — $0 shortcuts unchanged
- `saveResponseFrame` — one save path (P4)
- `brainCompose` for handleMore — unchanged
- Tool call params own state (P1) — activeFilters derived from tool params, not history
- `buildSearchPool` / `continueWithResults` — unchanged
- `validatePicks` — unchanged

## Cost & Risk

- **Cost:** ~$0.001/msg (up from ~$0.0008). Extra tokens from structured history. Marginal.
- **Risk:** Agent may over-rely on history and ignore explicit tool params. Mitigated by P1 — code still derives filters deterministically from tool params, not from history.
- **Risk:** History truncation loses early context. Mitigated by 10-entry cap covering ~2.5 turns, which is the typical decision window.
