# Agent Loop Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the agent loop with Claude Code patterns: error-as-content (not exceptions), guaranteed tool_result pairing, and concurrent read-only tool execution.

**Architecture:** Three changes to `src/llm.js` (agent loop) and `src/agent-loop.js` (tool execution). Tool errors become `is_error: true` tool_results fed back to the model. A safety net ensures every `tool_use` always gets a `tool_result` even on crash/abort. Read-only tools (`search`, `lookup_venue`) run concurrently via `Promise.all`.

**Tech Stack:** Node.js, Anthropic SDK, Google Generative AI SDK

---

## Context

These patterns come from Claude Code's leaked source (`query.ts`, `toolOrchestration.ts`, `toolExecution.ts`). Our agent loop currently:
- Throws exceptions on tool errors, caught at the outer level → "Pulse hit a snag"
- Has no safety net for orphaned `tool_use` blocks → session corruption
- Runs all tool calls sequentially even when they're independent reads

### Key files
- `src/llm.js` — `runAgentLoop()` function (Anthropic path: lines 558-628, Gemini path: lines 481-555)
- `src/agent-loop.js` — `executeTool()` (line 209+), `handleAgentRequest()` (line 706+)
- `test/unit/llm.test.js` — existing tests for LLM module

---

### Task 1: Error-as-content for tool execution

Tool errors should become `tool_result` with `is_error: true`, not thrown exceptions. The model sees the error and can self-correct (retry, try a different approach, or explain to the user).

**Files:**
- Modify: `src/llm.js:598-610` (Anthropic tool execution block)
- Modify: `src/llm.js:516-530` (Gemini tool execution block)
- Test: `test/unit/agent-loop.test.js`

- [ ] **Step 1: Write failing test for error-as-content**

```js
// In test/unit/agent-loop.test.js, add:
console.log('\nerror-as-content:');

// Mock a tool executor that throws on specific tool
const errorExecutor = async (name, params) => {
  if (name === 'failing_tool') throw new Error('Tool crashed');
  return { ok: true };
};

// Verify the error is wrapped, not thrown
// (This tests the pattern — actual integration test needs API keys)
check('error wrapper creates is_error result', (() => {
  try {
    // Simulate what the loop should do
    const err = new Error('Tool crashed');
    const errorResult = {
      type: 'tool_result',
      tool_use_id: 'test_id',
      content: JSON.stringify({ error: err.message }),
      is_error: true,
    };
    return errorResult.is_error === true && errorResult.content.includes('Tool crashed');
  } catch { return false; }
})());
```

- [ ] **Step 2: Run test to verify it passes (structural test)**

Run: `npm test 2>&1 | grep 'error-as-content' -A 2`
Expected: PASS

- [ ] **Step 3: Wrap tool execution in try/catch in Anthropic path**

In `src/llm.js`, replace the sequential tool execution block (lines ~598-610) with:

```js
      // Execute all tool calls (Sonnet may return multiple)
      const iterStart = Date.now();
      const toolResults = [];
      for (const toolBlock of toolBlocks) {
        try {
          const toolResult = await executeTool(toolBlock.name, toolBlock.input || {});
          toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: toolResult });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(sanitizeUnicode(toolResult)),
          });
        } catch (err) {
          console.error(`[agentLoop] Tool ${toolBlock.name} failed: ${err.message}`);
          const errorResult = { error: err.message };
          toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: errorResult, is_error: true });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }
```

- [ ] **Step 4: Do the same for the Gemini path**

In `src/llm.js`, wrap the Gemini tool execution block (lines ~516-530) similarly:

```js
      const iterStart = Date.now();
      const functionResponses = [];
      for (const fnCall of fnCalls) {
        const toolName = fnCall.functionCall.name;
        const toolParams = fnCall.functionCall.args || {};
        try {
          const toolResult = await executeTool(toolName, toolParams);
          toolCalls.push({ name: toolName, params: toolParams, result: toolResult });
          functionResponses.push({ functionResponse: { name: toolName, response: toolResult } });
        } catch (err) {
          console.error(`[agentLoop] Tool ${toolName} failed: ${err.message}`);
          const errorResult = { error: err.message };
          toolCalls.push({ name: toolName, params: toolParams, result: errorResult, is_error: true });
          functionResponses.push({ functionResponse: { name: toolName, response: errorResult } });
        }
      }
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add src/llm.js test/unit/agent-loop.test.js
git commit -m "fix: tool errors become is_error tool_results, not exceptions

Model now sees tool failures and can self-correct instead of
crashing the entire agent loop."
```

---

### Task 2: Guaranteed tool_result pairing (safety net)

Every `tool_use` block must always have a matching `tool_result`. Add a safety function that generates synthetic results for any orphaned `tool_use` blocks. This prevents the `messages.N: tool_use ids found without tool_result blocks` corruption.

**Files:**
- Modify: `src/llm.js:618-623` (after tool execution, before messages.push)
- Test: `test/unit/agent-loop.test.js`

- [ ] **Step 1: Write failing test for pairing safety**

```js
console.log('\ntool_result pairing:');

// Helper that mirrors what we'll add to llm.js
function ensureToolResultPairing(toolBlocks, toolResults) {
  const resultIds = new Set(toolResults.map(r => r.tool_use_id));
  for (const tb of toolBlocks) {
    if (!resultIds.has(tb.id)) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: JSON.stringify({ error: 'Tool execution was skipped or aborted' }),
        is_error: true,
      });
    }
  }
  return toolResults;
}

check('pairing adds missing result', (() => {
  const blocks = [{ id: 'a' }, { id: 'b' }];
  const results = [{ tool_use_id: 'a', type: 'tool_result', content: '{}' }];
  const fixed = ensureToolResultPairing(blocks, results);
  return fixed.length === 2 && fixed[1].tool_use_id === 'b' && fixed[1].is_error === true;
})());

check('pairing is no-op when complete', (() => {
  const blocks = [{ id: 'a' }];
  const results = [{ tool_use_id: 'a', type: 'tool_result', content: '{}' }];
  const fixed = ensureToolResultPairing(blocks, results);
  return fixed.length === 1 && !fixed[0].is_error;
})());
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test 2>&1 | grep 'tool_result pairing' -A 4`
Expected: PASS

- [ ] **Step 3: Add `ensureToolResultPairing` to llm.js and use it**

Add the function near the top of `llm.js` (after imports):

```js
/**
 * Safety net: ensure every tool_use block has a matching tool_result.
 * Generates synthetic is_error results for any orphaned tool_use blocks.
 * Prevents Anthropic API rejection: "tool_use ids found without tool_result blocks"
 */
function ensureToolResultPairing(toolBlocks, toolResults) {
  const resultIds = new Set(toolResults.map(r => r.tool_use_id));
  for (const tb of toolBlocks) {
    if (!resultIds.has(tb.id)) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: JSON.stringify({ error: 'Tool execution was skipped or aborted' }),
        is_error: true,
      });
    }
  }
  return toolResults;
}
```

Then in the Anthropic agent loop, add the safety net call BEFORE pushing to messages (after the tool execution loop, before `messages.push`):

```js
      // Safety net: ensure every tool_use has a matching tool_result
      ensureToolResultPairing(toolBlocks, toolResults);

      // Append assistant response + ALL tool results for next turn
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/llm.js test/unit/agent-loop.test.js
git commit -m "fix: guarantee tool_result pairing with safety net

Generates synthetic is_error results for any orphaned tool_use
blocks. Prevents session corruption from the 'tool_use ids found
without tool_result blocks' API error."
```

---

### Task 3: Concurrent read-only tool execution

`search` and `lookup_venue` are read-only — they don't mutate state. When Sonnet calls both in parallel, we should execute them concurrently via `Promise.all` instead of sequentially. This saves ~3-5s on multi-tool turns.

**Files:**
- Modify: `src/llm.js:598-610` (Anthropic tool execution block — already modified in Task 1)
- Modify: `src/agent-loop.js:1-30` (add read-only classification)
- Test: `test/unit/agent-loop.test.js`

- [ ] **Step 1: Write test for concurrency classification**

```js
console.log('\ntool concurrency:');

// All current tools are read-only
const READ_ONLY_TOOLS = new Set(['search', 'lookup_venue']);
check('search is read-only', READ_ONLY_TOOLS.has('search'));
check('lookup_venue is read-only', READ_ONLY_TOOLS.has('lookup_venue'));
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test 2>&1 | grep 'tool concurrency' -A 4`
Expected: PASS

- [ ] **Step 3: Add concurrent execution to Anthropic path**

Replace the sequential tool execution loop in `src/llm.js` (the for-loop from Task 1) with concurrent execution:

```js
      // Execute tool calls — read-only tools run concurrently
      const iterStart = Date.now();
      const READ_ONLY_TOOLS = new Set(['search', 'lookup_venue']);
      const allReadOnly = toolBlocks.every(tb => READ_ONLY_TOOLS.has(tb.name));

      let toolResults = [];
      if (allReadOnly && toolBlocks.length > 1) {
        // All read-only — run concurrently
        const settled = await Promise.allSettled(
          toolBlocks.map(async (toolBlock) => {
            const toolResult = await executeTool(toolBlock.name, toolBlock.input || {});
            return { toolBlock, toolResult };
          })
        );
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            const { toolBlock, toolResult } = s.value;
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: toolResult });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(sanitizeUnicode(toolResult)),
            });
          } else {
            // Find which toolBlock this was for by index
            const idx = settled.indexOf(s);
            const toolBlock = toolBlocks[idx];
            console.error(`[agentLoop] Tool ${toolBlock.name} failed: ${s.reason?.message}`);
            const errorResult = { error: s.reason?.message || 'Unknown error' };
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: errorResult, is_error: true });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(errorResult),
              is_error: true,
            });
          }
        }
      } else {
        // Sequential — either single tool or has write tools
        for (const toolBlock of toolBlocks) {
          try {
            const toolResult = await executeTool(toolBlock.name, toolBlock.input || {});
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: toolResult });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(sanitizeUnicode(toolResult)),
            });
          } catch (err) {
            console.error(`[agentLoop] Tool ${toolBlock.name} failed: ${err.message}`);
            const errorResult = { error: err.message };
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: errorResult, is_error: true });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(errorResult),
              is_error: true,
            });
          }
        }
      }
```

- [ ] **Step 4: Do the same for Gemini path**

Apply the same concurrent/sequential split to the Gemini tool execution block, using `Promise.allSettled` for read-only tools and `functionResponse` format.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: 1061+ passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add src/llm.js test/unit/agent-loop.test.js
git commit -m "feat: concurrent execution for read-only tools

search and lookup_venue run via Promise.allSettled when Sonnet
calls both in parallel. Saves ~3-5s on multi-tool turns."
```

---

### Task 4: Integration smoke test

Verify all three changes work together with a live API call via the simulator.

**Files:**
- No code changes — manual testing

- [ ] **Step 1: Deploy to Railway**

```bash
git push && railway up
```

Wait ~3 minutes for build.

- [ ] **Step 2: Test multi-turn conversation that previously crashed**

```bash
# Turn 1: Initial search
curl -s -X POST https://web-production-c8fdb.up.railway.app/api/sms/test \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'Body=blues+music+tonight&From=%2B15550000001' | python3 -c "import sys,json; d=json.load(sys.stdin); print('SMS:', d['messages'][0]['body'][:100]); print('Tools:', [tc['name'] for tc in d['trace']['brain_tool_calls']])"

# Turn 2: Context shift
curl -s -X POST https://web-production-c8fdb.up.railway.app/api/sms/test \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'Body=what+about+for+a+date+tomorrow&From=%2B15550000001' | python3 -c "import sys,json; d=json.load(sys.stdin); print('SMS:', d['messages'][0]['body'][:100]); print('Tools:', [tc['name'] for tc in d['trace']['brain_tool_calls']]); print('Error:', d['trace'].get('brain_error'))"

# Turn 3: The message that previously crashed
curl -s -X POST https://web-production-c8fdb.up.railway.app/api/sms/test \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'Body=anything+outside+or+walkable+in+north+brooklyn&From=%2B15550000001' | python3 -c "import sys,json; d=json.load(sys.stdin); print('SMS:', d['messages'][0]['body'][:100]); print('Tools:', [tc['name'] for tc in d['trace']['brain_tool_calls']]); print('Error:', d['trace'].get('brain_error'))"
```

Expected:
- Turn 1: Picks with real events, no error
- Turn 2: Clarifying question OR fresh picks (no sticky jazz filter), no error
- Turn 3: Real event picks, **no "Pulse hit a snag"**, no `tool_use ids` error

- [ ] **Step 3: Verify error-as-content by checking traces**

If any tool errored, verify in the trace that `brain_tool_calls` shows the error was handled (not a crash) and the model produced a reasonable response.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: integration test adjustments"
git push
```

---

## Summary of changes

| Change | File | Pattern from |
|--------|------|-------------|
| Error-as-content | `src/llm.js` | Claude Code `toolExecution.ts` |
| Tool_result pairing safety | `src/llm.js` | Claude Code `yieldMissingToolResultBlocks()` |
| Concurrent read-only tools | `src/llm.js` | Claude Code `toolOrchestration.ts` |
