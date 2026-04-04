# Clarify Stop-Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `clarify` stop-tool so the agent loop produces structured, trackable clarification turns instead of unstructured plain-text questions.

**Architecture:** `clarify` is a terminal tool — model calls it, loop stops, question becomes the SMS. Session bridges the clarification to the next turn via `pendingClarification` + synthetic history entries. The orchestrator enforces "one clarification max" by removing `clarify` from the tool list when a pending clarification exists.

**Tech Stack:** Node.js, existing `runAgentLoop` in `llm.js`, `BRAIN_TOOLS` in `brain-llm.js`, `handleAgentRequest` in `agent-loop.js`, session store in `session.js`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/brain-llm.js` | Modify | Add `clarify` to `BRAIN_TOOLS`, update system prompt |
| `src/agent-loop.js` | Modify | Handle `clarify` in `executeTool`, edge case guards in orchestrator, session bridging in `handleAgentRequest`, `deriveIntent` update, `saveSessionFromToolCalls` update |
| `src/session.js` | Modify | Add `pendingClarification` to session persistence |
| `test/unit/agent-loop.test.js` | Modify | Tests for clarify tool handling, session bridging, edge cases |
| `test/unit/brain-llm.test.js` | New reference (tests added to existing file) | Tests for prompt structure, tool count |

---

### Task 1: Add `clarify` tool definition to BRAIN_TOOLS

**Files:**
- Modify: `src/brain-llm.js:19-93` (BRAIN_TOOLS array)
- Test: `test/unit/agent-loop.test.js:54-74` (tool checks)

- [ ] **Step 1: Write failing tests for clarify tool in BRAIN_TOOLS**

Add after line 74 in `test/unit/agent-loop.test.js`:

```js
// ---- clarify tool in BRAIN_TOOLS ----
console.log('\nclarify tool:');

const clarifyTool = BRAIN_TOOLS.find(t => t.name === 'clarify');
check('clarify tool exists in BRAIN_TOOLS', !!clarifyTool);
check('clarify has reason required', clarifyTool.parameters.required.includes('reason'));
check('clarify has question required', clarifyTool.parameters.required.includes('question'));
check('clarify has options required', clarifyTool.parameters.required.includes('options'));
check('clarify reason has 4 enum values', clarifyTool.parameters.properties.reason.enum.length === 4);
check('clarify reason includes broad_area', clarifyTool.parameters.properties.reason.enum.includes('broad_area'));
check('clarify reason includes missing_neighborhood', clarifyTool.parameters.properties.reason.enum.includes('missing_neighborhood'));
check('clarify reason includes context_shift', clarifyTool.parameters.properties.reason.enum.includes('context_shift'));
check('clarify reason includes vague_intent', clarifyTool.parameters.properties.reason.enum.includes('vague_intent'));
check('clarify has confidence param', !!clarifyTool.parameters.properties.confidence);
check('clarify has implicit_filters param', !!clarifyTool.parameters.properties.implicit_filters);
check('BRAIN_TOOLS has exactly 3 tools', BRAIN_TOOLS.length === 3);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 'clarify tool'`
Expected: FAIL — `clarify tool exists in BRAIN_TOOLS` fails (tool doesn't exist yet)

- [ ] **Step 3: Add clarify tool definition to BRAIN_TOOLS**

In `src/brain-llm.js`, add after the `lookup_venue` tool object (after line 92, before the closing `]` of BRAIN_TOOLS):

```js
  {
    name: 'clarify',
    description: 'Ask the user a clarifying question before searching. Use when the request is genuinely ambiguous — context shifts, bare boroughs, vague mood queries. Do NOT use when there\'s enough specificity to search. This is a terminal action — the question becomes the SMS.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['broad_area', 'missing_neighborhood', 'context_shift', 'vague_intent'],
          description: 'Why clarification is needed',
        },
        question: {
          type: 'string',
          description: 'The SMS text to send. One short question with 3-4 concrete options baked in. Under 320 characters.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'The 3-4 concrete options offered (for logging/eval, not rendered as buttons)',
        },
        confidence: {
          type: 'number',
          description: '0-1. How close the model was to just searching instead of asking. Higher = nearly had enough info.',
        },
        implicit_filters: {
          type: 'object',
          nullable: true,
          properties: {
            neighborhood: { type: 'string', description: 'Neighborhood already understood', nullable: true },
            category: { type: 'string', description: 'Category already understood', nullable: true },
            time: { type: 'string', description: 'Time constraint already understood', nullable: true },
          },
          description: 'What the model already understood before asking. Partial intent extracted from the ambiguous message.',
        },
      },
      required: ['reason', 'question', 'options'],
    },
  },
```

- [ ] **Step 4: Update the tool count test**

In `test/unit/agent-loop.test.js`, change the existing check on line 74:

```js
// OLD: check('BRAIN_TOOLS has exactly 2 tools', BRAIN_TOOLS.length === 2);
// This line is now replaced by the "BRAIN_TOOLS has exactly 3 tools" check in the new clarify section.
```

Replace:
```js
check('BRAIN_TOOLS has exactly 2 tools', BRAIN_TOOLS.length === 2);
```
With:
```js
check('BRAIN_TOOLS has exactly 3 tools', BRAIN_TOOLS.length === 3);
```

(Remove the duplicate from the clarify section if you added it there — keep it in one place only.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E '(clarify tool|BRAIN_TOOLS has exactly)'`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/brain-llm.js test/unit/agent-loop.test.js
git commit -m "feat: add clarify stop-tool definition to BRAIN_TOOLS"
```

---

### Task 2: Handle `clarify` in executeTool + edge case guards

**Files:**
- Modify: `src/agent-loop.js:209-536` (executeTool function)
- Modify: `src/agent-loop.js:706-` (handleAgentRequest orchestrator)
- Test: `test/unit/agent-loop.test.js`

- [ ] **Step 1: Write failing tests for clarify tool execution**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- clarify tool execution ----
console.log('\nclarify tool execution:');

(async () => {
  const clarifyResult = await executeTool('clarify', {
    reason: 'context_shift',
    question: 'What kind of date — dinner and a show, something active, or low-key?',
    options: ['dinner and a show', 'something active', 'low-key wine bar'],
    confidence: 0.4,
    implicit_filters: { time: 'tomorrow' },
  }, {}, '+1234', { events: {}, composition: {} });

  check('clarify returns question text', clarifyResult.question === 'What kind of date — dinner and a show, something active, or low-key?');
  check('clarify returns reason', clarifyResult.reason === 'context_shift');
  check('clarify returns options', Array.isArray(clarifyResult.options) && clarifyResult.options.length === 3);
  check('clarify returns confidence', clarifyResult.confidence === 0.4);
  check('clarify returns implicit_filters', clarifyResult.implicit_filters?.time === 'tomorrow');

  // No implicit_filters case
  const minResult = await executeTool('clarify', {
    reason: 'vague_intent',
    question: "What are you in the mood for?",
    options: ['live music', 'comedy', 'bars'],
  }, {}, '+1234', { events: {}, composition: {} });
  check('clarify works without optional fields', minResult.reason === 'vague_intent');
  check('clarify confidence defaults to null when missing', minResult.confidence == null);
})();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A1 'clarify tool execution'`
Expected: FAIL — executeTool returns `{ error: 'Unknown tool: clarify' }`

- [ ] **Step 3: Add clarify handler to executeTool**

In `src/agent-loop.js`, add before the `// Unknown tool` block (before line 534):

```js
  if (toolName === 'clarify') {
    return {
      reason: params.reason,
      question: params.question,
      options: params.options || [],
      confidence: params.confidence ?? null,
      implicit_filters: params.implicit_filters || null,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E 'clarify (returns|works|confidence)'`
Expected: All PASS

- [ ] **Step 5: Write failing test for deriveIntent with clarify**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- deriveIntent with clarify ----
console.log('\nderiveIntent with clarify:');

check('clarify -> clarify intent', deriveIntent([{ name: 'clarify', params: { reason: 'broad_area' } }]) === 'clarify');
check('clarify + search -> clarify intent wins', deriveIntent([
  { name: 'clarify', params: { reason: 'broad_area' } },
  { name: 'search', params: { intent: 'discover', neighborhood: 'bushwick' } },
]) === 'clarify');
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npm test 2>&1 | grep 'clarify intent'`
Expected: FAIL — deriveIntent returns 'conversational' for clarify calls

- [ ] **Step 7: Update deriveIntent to recognize clarify**

In `src/agent-loop.js`, in the `deriveIntent` function (around line 178), add at the top of the function body:

```js
  // Clarify intent wins — it's a terminal action
  if (toolCalls.some(tc => tc.name === 'clarify')) return 'clarify';
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test 2>&1 | grep 'clarify intent'`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add src/agent-loop.js test/unit/agent-loop.test.js
git commit -m "feat: handle clarify in executeTool + deriveIntent"
```

---

### Task 3: Wire clarify as stop-tool in orchestrator + session save

**Files:**
- Modify: `src/agent-loop.js:706-` (handleAgentRequest)
- Modify: `src/agent-loop.js:547-` (saveSessionFromToolCalls)
- Test: `test/unit/agent-loop.test.js`

- [ ] **Step 1: Write failing tests for saveSessionFromToolCalls with clarify**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- saveSessionFromToolCalls with clarify ----
console.log('\nsaveSessionFromToolCalls with clarify:');

const { saveSessionFromToolCalls } = require('../../src/agent-loop');
const { getSession, setSession, clearSession } = require('../../src/session');

// Set up a test session
const testPhone = '+10000001234';
setSession(testPhone, { conversationHistory: [] });

const clarifyToolCalls = [{
  name: 'clarify',
  params: {
    reason: 'context_shift',
    question: 'What kind of date?',
    options: ['dinner', 'active', 'low-key'],
    confidence: 0.4,
    implicit_filters: { time: 'tomorrow' },
  },
  result: {
    reason: 'context_shift',
    question: 'What kind of date?',
    options: ['dinner', 'active', 'low-key'],
    confidence: 0.4,
    implicit_filters: { time: 'tomorrow' },
  },
}];

saveSessionFromToolCalls(testPhone, getSession(testPhone), clarifyToolCalls, 'What kind of date?');
const savedSession = getSession(testPhone);
check('pendingClarification saved to session', !!savedSession.pendingClarification);
check('pendingClarification has reason', savedSession.pendingClarification.reason === 'context_shift');
check('pendingClarification has options', savedSession.pendingClarification.options.length === 3);
check('pendingClarification has implicit_filters', savedSession.pendingClarification.implicit_filters?.time === 'tomorrow');
check('pendingClarification has confidence', savedSession.pendingClarification.confidence === 0.4);
check('pendingClarification has question', savedSession.pendingClarification.question === 'What kind of date?');

clearSession(testPhone);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep 'pendingClarification'`
Expected: FAIL — pendingClarification is not saved

- [ ] **Step 3: Add clarify handling to saveSessionFromToolCalls**

In `src/agent-loop.js`, in `saveSessionFromToolCalls` (around line 547), add after the `if (!toolCalls?.length) return;` check and before the `const lastSearch` line:

```js
  // Clarify — save pending clarification for next turn
  const clarifyCall = toolCalls.find(tc => tc.name === 'clarify');
  if (clarifyCall) {
    const { reason, options, implicit_filters, confidence, question } = clarifyCall.params || {};
    setSession(phone, {
      ...session,
      pendingClarification: { reason, options, implicit_filters: implicit_filters || null, confidence: confidence ?? null, question },
    });
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep 'pendingClarification'`
Expected: All PASS

- [ ] **Step 5: Wire clarify as stop-tool and extract SMS from clarify result**

In `src/agent-loop.js`, in `handleAgentRequest` (around line 736), modify the `runAgentLoop` call to add `clarify` to `stopTools`:

Change:
```js
      { maxIterations: 3, timeout: 12000, priorMessages }
```
To:
```js
      { maxIterations: 3, timeout: 12000, priorMessages, stopTools: ['clarify'] }
```

Then, after the `let smsText = loopResult.text;` line (around line 755), add clarify SMS extraction:

```js
    // Clarify stop-tool: use the question text as SMS
    const clarifyCall = loopResult.toolCalls.find(tc => tc.name === 'clarify');
    if (clarifyCall) {
      smsText = clarifyCall.params?.question || smsText;
    }
```

- [ ] **Step 6: Add edge case guard — clarify + search in parallel**

In `src/agent-loop.js`, in `handleAgentRequest`, in the `executeAndTrack` callback (around line 729), add a guard that detects parallel clarify calls:

Replace the existing `executeAndTrack`:
```js
    const rawResults = [];
    const executeAndTrack = async (toolName, params) => {
      const result = await executeTool(toolName, params, session, phone, trace);
      rawResults.push({ name: toolName, params, result });
      return sanitizeForLLM(result);  // LLM only sees clean version
    };
```

With:
```js
    const rawResults = [];
    let clarifySeenInBatch = false;
    const executeAndTrack = async (toolName, params) => {
      // Edge case: clarify + other tools in parallel — clarify wins, skip others
      if (toolName === 'clarify') {
        clarifySeenInBatch = true;
        const result = await executeTool(toolName, params, session, phone, trace);
        rawResults.push({ name: toolName, params, result });
        return sanitizeForLLM(result);
      }
      if (clarifySeenInBatch) {
        console.warn(`[agent-loop] Skipping ${toolName} — clarify was called in same batch`);
        return { skipped: true, reason: 'clarify_in_batch' };
      }
      const result = await executeTool(toolName, params, session, phone, trace);
      rawResults.push({ name: toolName, params, result });
      return sanitizeForLLM(result);
    };
```

Note: Because `runAgentLoop` in `llm.js` executes read-only tools concurrently via `Promise.allSettled`, the order isn't guaranteed. But `clarify` is NOT in `READ_ONLY_TOOLS`, so when it appears with other tools, they'll be executed sequentially. The `clarifySeenInBatch` flag handles the sequential case. For the concurrent case (shouldn't happen since clarify isn't read-only), the `stopTools` mechanism will terminate the loop after the batch regardless.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/agent-loop.js test/unit/agent-loop.test.js
git commit -m "feat: wire clarify as stop-tool with session save + parallel guard"
```

---

### Task 4: Session bridging — pendingClarification on next turn

**Files:**
- Modify: `src/agent-loop.js:706-` (handleAgentRequest)
- Modify: `src/brain-llm.js:246-293` (buildNativeHistory)
- Modify: `src/session.js` (persist pendingClarification)
- Test: `test/unit/agent-loop.test.js`

- [ ] **Step 1: Write failing test for buildNativeHistory with clarify entries**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- buildNativeHistory with clarify entries ----
console.log('\nbuildNativeHistory with clarify:');

const { buildNativeHistory } = require('../../src/brain-llm');

const historyWithClarify = [
  { role: 'user', content: 'date tomorrow' },
  { role: 'tool_call', content: '', meta: { name: 'clarify', params: { reason: 'context_shift', question: 'What kind of date?', implicit_filters: { time: 'tomorrow' } } } },
  { role: 'assistant', content: 'What kind of date?' },
  { role: 'user', content: 'something active' },
  { role: 'tool_call', content: '', meta: { name: 'search', params: { intent: 'discover', neighborhood: 'williamsburg' } } },
  { role: 'assistant', content: 'Check out this comedy show...' },
];

const nativeHistory = buildNativeHistory(historyWithClarify);
check('clarify history has correct turn count', nativeHistory.length === 4); // user/assistant/user/assistant
check('clarify call appears in assistant turn', nativeHistory[1].content.includes('[clarify'));
check('clarify call includes reason', nativeHistory[1].content.includes('context_shift'));
check('user reply follows clarify', nativeHistory[2].role === 'user' && nativeHistory[2].content === 'something active');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep 'clarify history'`
Expected: FAIL — buildNativeHistory doesn't produce `[clarify` in output (it shows generic `[tool_call]`)

- [ ] **Step 3: Verify buildNativeHistory already handles this via existing tool_call logic**

Look at `buildNativeHistory` in `brain-llm.js` lines 246-293. The existing code already handles `role: 'tool_call'` entries with `h.meta`:

```js
} else if (h.role === 'tool_call' && h.meta) {
  const params = Object.entries(h.meta.params || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ');
  raw.push({ role: 'assistant', content: `[${h.meta.name}(${params})]` });
}
```

This already produces `[clarify(reason: "context_shift", question: "What kind of date?", ...)]` — verify the test passes as-is. If the test assertions need adjusting to match the actual format, adjust them:

```js
check('clarify call appears in assistant turn', nativeHistory[1].content.includes('[clarify('));
```

- [ ] **Step 4: Add pendingClarification to session persistence**

In `src/session.js`, add `pendingClarification` to `setResponseState` (line 77-99). Add after `pendingMessage`:

```js
    pendingClarification: frame.pendingClarification ?? null,
```

Add `pendingClarification` to the disk persistence in `scheduleDiskWrite` (around line 151):

```js
          pendingClarification: session.pendingClarification || null,
```

And in `flushSessions` (around line 215):

```js
        pendingClarification: session.pendingClarification || null,
```

- [ ] **Step 5: Add pendingClarification pre-routing in handleAgentRequest**

In `src/agent-loop.js`, in `handleAgentRequest`, after the session/history setup (after line 712 `addToHistory(phone, 'user', message);`) and before the URL resend check, add:

```js
  // --- Pending clarification bridging ---
  const pending = session?.pendingClarification;
  if (pending) {
    // Detect if user ignored clarification and sent a new query
    const { extractNeighborhood } = require('./neighborhoods');
    const hasNeighborhood = !!extractNeighborhood(message);
    const hasCategory = /\b(comedy|jazz|live music|dj|trivia|film|theater|art|dance|nightlife|bars?|restaurant|dinner|brunch)\b/i.test(message);
    const isNewQuery = hasNeighborhood && hasCategory;

    if (!isNewQuery && pending.implicit_filters) {
      // Merge implicit_filters into session as lastFilters
      const merged = { ...(session.lastFilters || {}) };
      if (pending.implicit_filters.neighborhood && !session.lastNeighborhood) {
        setSession(phone, { lastNeighborhood: pending.implicit_filters.neighborhood });
        session.lastNeighborhood = pending.implicit_filters.neighborhood;
      }
      if (pending.implicit_filters.category) {
        merged.categories = [pending.implicit_filters.category];
      }
      if (pending.implicit_filters.time) {
        merged.date_range = pending.implicit_filters.time;
      }
      if (Object.keys(merged).length > 0) {
        setSession(phone, { lastFilters: merged });
        session.lastFilters = merged;
      }
    }

    // Clear pendingClarification — must not persist to a third turn
    setSession(phone, { pendingClarification: null });
    session.pendingClarification = null;
  }
```

- [ ] **Step 6: Remove clarify from tool list when pendingClarification exists (enforceability guard)**

In `src/agent-loop.js`, in `handleAgentRequest`, where `BRAIN_TOOLS` is passed to `runAgentLoop` (around line 737), make the tool list conditional:

```js
    // Remove clarify tool after a clarification turn — enforce one-question max
    const tools = pending
      ? BRAIN_TOOLS.filter(t => t.name !== 'clarify')
      : BRAIN_TOOLS;

    const loopResult = await runAgentLoop(
      MODELS.brain, systemPrompt, message, tools,
      executeAndTrack,
      { maxIterations: 3, timeout: 12000, priorMessages, stopTools: ['clarify'] }
    );
```

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/agent-loop.js src/brain-llm.js src/session.js test/unit/agent-loop.test.js
git commit -m "feat: session bridging for clarify — pendingClarification, filter merge, enforceability guard"
```

---

### Task 5: Update system prompt — replace prose with contrastive examples

**Files:**
- Modify: `src/brain-llm.js:167-231` (system prompt conversation section + examples)
- Test: `test/unit/agent-loop.test.js:89-106` (prompt structure checks)

- [ ] **Step 1: Write failing tests for new prompt structure**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- clarify prompt structure ----
console.log('\nclarify prompt structure:');

const clarifyPrompt = buildBrainSystemPrompt({});
check('prompt has clarification section', clarifyPrompt.includes('## Clarification'));
check('prompt mentions clarify tool', clarifyPrompt.includes('clarify') && clarifyPrompt.includes('tool'));
check('prompt has SEARCH vs CLARIFY contrastive pairs', clarifyPrompt.includes('SEARCH') && clarifyPrompt.includes('CLARIFY'));
check('prompt has broad_area reason', clarifyPrompt.includes('broad_area'));
check('prompt has missing_neighborhood reason', clarifyPrompt.includes('missing_neighborhood'));
check('prompt has context_shift reason', clarifyPrompt.includes('context_shift'));
check('prompt has vague_intent reason', clarifyPrompt.includes('vague_intent'));
check('prompt has bias-to-action line', clarifyPrompt.includes('don\'t ask to be safe'));
check('prompt mentions implicit_filters', clarifyPrompt.includes('implicit_filters'));
check('prompt does NOT have old "When to ask vs when to pick" prose', !clarifyPrompt.includes('When to ask vs when to pick'));
check('prompt does NOT have old "GENUINELY AMBIGUOUS" prose', !clarifyPrompt.includes('GENUINELY AMBIGUOUS'));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep 'clarify prompt'`
Expected: FAIL — old prompt doesn't have `## Clarification`

- [ ] **Step 3: Replace the prompt's clarification section**

In `src/brain-llm.js`, replace lines 167-181 (the `CRITICAL — when to use search vs just reply:` block through the `When to ask vs when to pick:` block) with:

```js
CRITICAL — when to use search vs just reply:
- ANY message with enough specificity to search (neighborhood + intent, category, time, "more", "what about X", "anything free", bars, restaurants) → MUST call search first. Always. No exceptions.
- Reply WITHOUT searching for: greetings, "thanks", "bye", off-topic chat, questions about how Pulse works.
- When in doubt, search. It's better to search unnecessarily than to fabricate recommendations.
- NEVER recommend specific venues or events without search results backing them up.

## Clarification
You have a \`clarify\` tool. Use it ONLY when the request is genuinely ambiguous.

SEARCH — enough specificity exists:
- "comedy in bushwick" → search
- "free jazz tonight" → search
- "something fun in williamsburg" → search (neighborhood + vibe = enough)
- "live music east village tonight" → search

CLARIFY — genuinely ambiguous:
- "brooklyn" → clarify (reason: broad_area — borough with no intent)
- "what's good tonight" → clarify (reason: missing_neighborhood)
- "date tomorrow" → clarify (reason: context_shift — social frame, no activity)
- "I'm bored" → clarify (reason: vague_intent — no specificity at all)

When you call clarify, extract implicit_filters for anything you already understood (neighborhood, time, category). These persist to the next turn.

Never write a clarifying question as plain text. If you need to ask, use the tool.
If you have enough to search, search — don't ask to be safe.
```

- [ ] **Step 4: Update examples section**

In `src/brain-llm.js`, replace the examples section (lines 206-231) — remove the old "Clarifying question" examples that show plain-text questions and replace with tool-aware examples:

```js
<examples>
Contrasting picks (specific enough — search, not clarify):
User: "what's happening in williamsburg tonight"
SMS: Comedy show at Union Pool tonight (9 PM, free) — don't know the lineup but that room always delivers. Or if you want to be out later, there's a DJ set at Good Room (11 PM). There's also film and live music nearby if you want something different.

Contrasting picks with editorial:
User: "what's happening in brooklyn tonight"
SMS: Two things jumped out — there's a world premiere screening at Syndicated in Bushwick (8 PM, free) where the director's doing a Q&A after, only NYC date. Totally different energy: live jazz jam at Danger Danger in Williamsburg (10 PM), tiny room, rotating musicians, more of a late-night hang. I've also got comedy and late-night dance stuff if neither of those hit.

User reacts:
User: "the comedy sounds fun, tell me more"
SMS: Union Pool is a Williamsburg dive — indoor stage, big outdoor patio, cheap drinks, open til 4 AM. Show starts at 9, no cover. Get there a little early for a spot near the stage, it's a small room. You going?

Context shift (drop prior filters):
User: [was searching blues music, now pivots]
User: "what about for a date tomorrow"
SMS: [calls clarify tool — this is a context shift with no activity specified. Does NOT carry jazz/blues filters.]

After clarification resolved:
User: [was asked "What kind of date?" and replied "something active"]
SMS: [searches with date-appropriate categories, uses implicit_filters from clarify turn. Gives picks immediately — no follow-up question.]
</examples>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | grep 'clarify prompt'`
Expected: All PASS

- [ ] **Step 6: Run full test suite to check nothing else broke**

Run: `npm test`
Expected: All pass. Some old checks like `'prompt has mood mapping'` should still pass because the "When they react" section still has those words.

- [ ] **Step 7: Commit**

```bash
git add src/brain-llm.js test/unit/agent-loop.test.js
git commit -m "feat: replace ask-vs-pick prose with clarify tool contrastive examples in prompt"
```

---

### Task 6: Eval hook — question leak detection (Check 1)

**Files:**
- Modify: `test/unit/agent-loop.test.js`

This is the highest-priority eval: any response ending in `?` without a `clarify` call is a flag.

- [ ] **Step 1: Write the question leak detection utility**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- question leak detection ----
console.log('\nquestion leak detection:');

// Utility: detect if SMS ends with a question but no clarify tool was called
function detectQuestionLeak(smsText, toolCalls) {
  if (!smsText) return false;
  const trimmed = smsText.trim();
  // Ends with ? but no clarify call
  if (trimmed.endsWith('?') && !toolCalls?.some(tc => tc.name === 'clarify')) {
    // Exclude known OK patterns: details follow-ups ("You going?", "Want me to...?")
    const okPatterns = [/you going\??$/i, /want (me to|more|details)/i, /sound good\??$/i, /interest(ed|ing)\??$/i];
    if (okPatterns.some(p => p.test(trimmed))) return false;
    return true;
  }
  return false;
}

check('leak: question without clarify call', detectQuestionLeak('What neighborhood?', []));
check('no leak: question WITH clarify call', !detectQuestionLeak('What neighborhood?', [{ name: 'clarify' }]));
check('no leak: recommendation (no question)', !detectQuestionLeak('Check out this jazz show at Blue Note.', []));
check('no leak: "You going?" is OK', !detectQuestionLeak('Show starts at 9. You going?', []));
check('no leak: "sound good?" is OK', !detectQuestionLeak('I got comedy and jazz. Sound good?', []));
check('leak: bare question after recommendation', detectQuestionLeak('There are options. What vibe are you going for?', []));
```

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1 | grep 'leak'`
Expected: All PASS (this is a pure function test, no external deps)

- [ ] **Step 3: Export detectQuestionLeak for use in eval runners**

Add `detectQuestionLeak` to the exports in `src/agent-loop.js` so eval scripts can import it:

In `src/agent-loop.js`, add the function before `module.exports` and add it to exports:

```js
/**
 * Eval check: detect if SMS ends with a question but no clarify tool was called.
 * Returns true if this is a "question leak" — model bypassed the clarify tool.
 */
function detectQuestionLeak(smsText, toolCalls) {
  if (!smsText) return false;
  const trimmed = smsText.trim();
  if (trimmed.endsWith('?') && !toolCalls?.some(tc => tc.name === 'clarify')) {
    const okPatterns = [/you going\??$/i, /want (me to|more|details)/i, /sound good\??$/i, /interest(ed|ing)\??$/i];
    if (okPatterns.some(p => p.test(trimmed))) return false;
    return true;
  }
  return false;
}
```

Add to `module.exports`:
```js
  detectQuestionLeak,
```

Then update the test to import from agent-loop instead of defining inline:

```js
const { detectQuestionLeak } = require('../../src/agent-loop');
```

- [ ] **Step 4: Commit**

```bash
git add src/agent-loop.js test/unit/agent-loop.test.js
git commit -m "feat: add detectQuestionLeak eval check for clarify tool bypass"
```

---

### Task 7: Integration smoke test — full clarify flow

**Files:**
- Test: `test/unit/agent-loop.test.js`

This task verifies the full flow works end-to-end with mocked dependencies: clarify call → session save → next turn with pendingClarification → filter merge → clarify removed from tools.

- [ ] **Step 1: Write the integration test**

```js
// ---- clarify integration flow ----
console.log('\nclarify integration flow:');

// Simulate: model calls clarify → session gets pendingClarification
const flowPhone = '+10000009999';
setSession(flowPhone, { conversationHistory: [], lastNeighborhood: null, lastFilters: null });

// Step 1: clarify call saved
const clarifyTCs = [{
  name: 'clarify',
  params: {
    reason: 'context_shift',
    question: 'What kind of date — dinner, active, or chill?',
    options: ['dinner and a show', 'something active', 'low-key'],
    confidence: 0.35,
    implicit_filters: { time: 'tomorrow', neighborhood: 'williamsburg' },
  },
  result: {
    reason: 'context_shift',
    question: 'What kind of date — dinner, active, or chill?',
    options: ['dinner and a show', 'something active', 'low-key'],
    confidence: 0.35,
    implicit_filters: { time: 'tomorrow', neighborhood: 'williamsburg' },
  },
}];

saveSessionFromToolCalls(flowPhone, getSession(flowPhone), clarifyTCs, 'What kind of date?');
const s1 = getSession(flowPhone);
check('flow: pendingClarification saved', !!s1.pendingClarification);
check('flow: reason is context_shift', s1.pendingClarification.reason === 'context_shift');

// Step 2: simulate what handleAgentRequest would do on next turn
// (We can't call handleAgentRequest directly without Twilio, but we can test the pre-routing logic)
const { extractNeighborhood } = require('../../src/neighborhoods');

// Case A: user replies to clarification ("something active")
const replyMessage = 'something active';
const hasHood = !!extractNeighborhood(replyMessage);
const hasCat = /\b(comedy|jazz|live music|dj|trivia|film|theater|art|dance|nightlife|bars?|restaurant|dinner|brunch)\b/i.test(replyMessage);
const isNewQuery = hasHood && hasCat;
check('flow: "something active" is NOT detected as new query', !isNewQuery);

// Case B: user ignores clarification ("jazz in the east village")
const newQueryMessage = 'jazz in the east village';
const hasHood2 = !!extractNeighborhood(newQueryMessage);
const hasCat2 = /\b(comedy|jazz|live music|dj|trivia|film|theater|art|dance|nightlife|bars?|restaurant|dinner|brunch)\b/i.test(newQueryMessage);
const isNewQuery2 = hasHood2 && hasCat2;
check('flow: "jazz in the east village" IS detected as new query', isNewQuery2);

// Step 3: verify tools list filtering
check('flow: BRAIN_TOOLS includes clarify normally', BRAIN_TOOLS.some(t => t.name === 'clarify'));
const filteredTools = BRAIN_TOOLS.filter(t => t.name !== 'clarify');
check('flow: filtered tools exclude clarify', !filteredTools.some(t => t.name === 'clarify'));
check('flow: filtered tools still have search + lookup_venue', filteredTools.length === 2);

clearSession(flowPhone);
```

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1 | grep 'flow:'`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add test/unit/agent-loop.test.js
git commit -m "test: integration smoke test for full clarify flow"
```

---

## Self-Review Checklist

**Spec coverage:**
1. Tool schema with 4 reasons, confidence, implicit_filters, 320-char cap → Task 1 ✓
2. Session bridging via synthetic history + pendingClarification → Task 4 ✓
3. No option matching in pre-router → explicitly skipped per spec ✓
4. Eval hook: question leak detection → Task 6 ✓ (checks 2-6 are observability metrics, not code changes — they'll come from analyzing traces post-deploy)
5. Prompt changes with contrastive examples → Task 5 ✓
6. Edge case: clarify + search parallel → Task 3 step 6 ✓
7. Edge case: double clarify → handled by stop-tool (first one stops the loop) ✓
8. Edge case: ambiguous reply to clarification → enforceability guard removes clarify from tools, implicit_filters carry forward → Task 4 step 6 ✓
9. Edge case: user ignores clarification with new query → new-query detection in Task 4 step 5 ✓

**Placeholder scan:** No TBDs, TODOs, or "implement later" found.

**Type consistency:** `pendingClarification` shape is `{ reason, options, implicit_filters, confidence, question }` in both save (Task 3) and read (Task 4). Tool params match BRAIN_TOOLS schema (Task 1). `deriveIntent` returns `'clarify'` string used consistently.
