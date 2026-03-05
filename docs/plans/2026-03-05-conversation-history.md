# Conversation History as State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the agent structured conversation history (tool calls, params, picks) so it can make personal, context-aware responses.

**Architecture:** Replace plain-text history entries with structured entries that include tool calls and results. Update `addToHistory` to accept structured entries, update `buildBrainSystemPrompt` to render them richly. Session fields kept for deterministic code; structured history is for the LLM only.

**Tech Stack:** Pure JS refactor of session.js and agent-brain.js. No new dependencies.

---

### Task 1: Extend addToHistory to support structured entries

**Files:**
- Modify: `src/session.js:92-104` (addToHistory + MAX_HISTORY_TURNS)

**Step 1: Update addToHistory to accept structured metadata**

Change `addToHistory(phone, role, content)` to `addToHistory(phone, role, content, meta)` where `meta` is an optional object with tool call info.

```javascript
const MAX_HISTORY_TURNS = 10; // was 6

function addToHistory(phone, role, content, meta) {
  const session = sessions.get(phone) || sessions.get(hashPhone(phone));
  if (!session) return;
  if (!session.conversationHistory) session.conversationHistory = [];
  const entry = { role, content: content.slice(0, 300) };
  if (meta) entry.meta = meta;
  session.conversationHistory.push(entry);
  if (session.conversationHistory.length > MAX_HISTORY_TURNS) {
    session.conversationHistory = session.conversationHistory.slice(-MAX_HISTORY_TURNS);
  }
  session.timestamp = Date.now();
  scheduleDiskWrite();
}
```

The `meta` parameter is optional so all existing callers work unchanged. Structured entries look like:
- Tool call: `addToHistory(phone, 'tool_call', '', { name: 'search_events', params: { neighborhood: 'Bushwick' } })`
- Tool result: `addToHistory(phone, 'tool_result', '', { picks: [...], match_count: 5, neighborhood: 'Bushwick' })`

**Step 2: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass. Extra param is additive.

**Step 3: Commit**

```bash
git add src/session.js
git commit -m "feat: extend addToHistory with optional structured metadata, bump cap to 10"
```

---

### Task 2: Record tool calls and results in history

**Files:**
- Modify: `src/agent-brain.js:1266-1370` (handleAgentBrainRequest)

**Step 1: Add tool_call history entry after brain returns**

In `handleAgentBrainRequest`, after the brain result is recorded (around line 1319), add the tool call to history:

```javascript
// After: console.log(`Agent brain: tool=${brainResult.tool}...`);
// Add tool call to structured history
addToHistory(phone, 'tool_call', '', {
  name: brainResult.tool,
  params: brainResult.params,
});
```

**Step 2: Add tool_result history entry after search_events execution**

In the search_events branch, after the single-turn flow or executeSearchEvents completes, add the result to history. This goes right before `execResult = { sms: ... }` in both the single-turn path and the fallback path.

For the single-turn path (after validPicks is computed, before setting execResult):
```javascript
// Add tool result to structured history
addToHistory(phone, 'tool_result', '', {
  picks: validPicks.slice(0, 3).map(p => {
    const evt = eventMap[p.event_id];
    return { name: evt?.name, category: evt?.category, neighborhood: evt?.neighborhood };
  }),
  match_count: poolResult.matchCount,
  neighborhood: poolResult.hood || poolResult.borough || 'citywide',
  sparse: poolResult.isSparse || false,
});
```

For the fallback path (executeSearchEvents), add the same after it returns:
```javascript
if (!brainResult.chat) {
  // Anthropic path — add tool_result from execResult
  if (execResult.picks?.length) {
    addToHistory(phone, 'tool_result', '', {
      picks: execResult.picks.slice(0, 3).map(p => {
        const evt = execResult.eventMap?.[p.event_id];
        return { name: evt?.name, category: evt?.category, neighborhood: evt?.neighborhood };
      }),
      match_count: execResult.picks.length,
      neighborhood: execResult.activeFilters?.neighborhood || 'unknown',
    });
  }
}
```

Also add for zero match:
```javascript
if (poolResult.zeroMatch) {
  addToHistory(phone, 'tool_result', '', { match_count: 0, neighborhood: 'unknown' });
  execResult = poolResult.zeroMatch;
}
```

**Step 3: Add tool_result for respond and get_details**

For `respond` tool (after executeRespond returns):
```javascript
// No tool_result needed — the assistant SMS is the result
```

For `get_details` tool (before dispatching to handleDetails):
```javascript
addToHistory(phone, 'tool_call', '', {
  name: 'get_details',
  params: brainResult.params,
});
// Note: the tool_call was already added above for all tools, so this is already handled
```

**Step 4: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: record tool calls and results in structured conversation history"
```

---

### Task 3: Update buildBrainSystemPrompt to render structured history

**Files:**
- Modify: `src/agent-brain.js:124-148` (buildBrainSystemPrompt)

**Step 1: Replace the historyBlock rendering**

Replace the current flat rendering (lines 143-147):

```javascript
  const historyBlock = session?.conversationHistory?.length > 0
    ? '\nRecent conversation:\n' + session.conversationHistory.slice(-6).map(h =>
      `${h.role === 'user' ? 'User' : 'Pulse'}: ${h.content.slice(0, 120)}`
    ).join('\n')
    : '';
```

With structured rendering:

```javascript
  const historyBlock = session?.conversationHistory?.length > 0
    ? '\nRecent conversation:\n' + session.conversationHistory.slice(-10).map(h => {
      if (h.role === 'user') return `User: "${h.content.slice(0, 150)}"`;
      if (h.role === 'tool_call' && h.meta) {
        const params = Object.entries(h.meta.params || {})
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(', ');
        return `> ${h.meta.name}(${params})`;
      }
      if (h.role === 'tool_result' && h.meta) {
        if (h.meta.match_count === 0) return '> No matches found';
        const picks = (h.meta.picks || []).map(p => `${p.name} (${p.category})`).join(', ');
        return `> ${h.meta.match_count} matches${h.meta.neighborhood ? ' in ' + h.meta.neighborhood : ''}${picks ? '. Showed: ' + picks : ''}`;
      }
      if (h.role === 'assistant') return `Pulse: "${h.content.slice(0, 150)}"`;
      return null;
    }).filter(Boolean).join('\n')
    : '';
```

This renders history like:
```
Recent conversation:
User: "something weird in bushwick"
> search_events(neighborhood: "Bushwick", intent: "new_search")
> 5 matches in Bushwick. Showed: Comedy at Tiny Cupboard (comedy), Open Mic at Pine Box (live_music)
Pulse: "Tonight in Bushwick: 1) Comedy at Tiny Cupboard..."

User: "how about something free"
> search_events(free_only: true, intent: "refine")
> 2 matches in Bushwick. Showed: Open Mic Night (live_music)
Pulse: "Free stuff in Bushwick tonight..."
```

**Step 2: Remove the explicit sessionContext lines that are now redundant**

The `sessionContext` block (lines 125-141) currently renders `Current neighborhood`, `Active filters`, `Last picks shown`, and `Pending suggestion`. With structured history, the agent can see all of this from the tool call history.

BUT — keep `sessionContext` for now. It's a safety net: if history is empty (first message) or the history is too short, the explicit fields ensure the agent still knows the state. The sessionContext is cheap (~50 tokens) and provides redundancy.

Do NOT remove sessionContext. Just update the history rendering.

**Step 3: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: render structured conversation history in brain system prompt"
```

---

### Task 4: Run evals and verify

**Step 1: Start local server**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_AGENT_BRAIN=true node src/server.js`

Wait for cache loaded.

**Step 2: Run scenario evals**

Run: `node scripts/run-scenario-evals.js --pipeline agent_brain --concurrency 3`

Check code eval pass rate >= 99%.

**Step 3: Run regression evals**

Run: `node scripts/run-regression-evals.js --pipeline agent_brain`

Check code eval pass rate >= 98%.

**Step 4: Spot-check multi-turn quality**

Test a 3-turn conversation via `/api/sms/test`:
1. `"something weird in bushwick"` — check SMS
2. `"how about something free"` — should reference weird vibe AND add free filter
3. `"try williamsburg"` — should keep free filter, switch hood

The SMS should feel connected across turns — not generic.

**Step 5: Commit if new baseline**

```bash
git add -A
git commit -m "chore: Phase 3 eval verification — structured conversation history"
```

---

### Task 5: Deploy and update ROADMAP.md

**Step 1: Deploy**

Run: `railway up`

Wait 2-3 min.

**Step 2: Verify on Railway**

Run: `node scripts/run-scenario-evals.js --pipeline agent_brain --url https://web-production-c8fdb.up.railway.app --concurrency 3`

**Step 3: Update ROADMAP.md**

Mark Phase 3 as partially done (structured history added, session field removal deferred):

```
**Phase 3: Conversation History as State** -- **Partial (2026-03-05)**

Added structured conversation history (tool calls, params, picks summaries). Agent sees its own decisions across turns. History cap bumped 6 → 10. Session fields kept for deterministic code — removal deferred to future phase.
```

**Step 4: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark Phase 3 structured history as partial complete"
```
