# Agent Brain Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split `agent-brain.js` (1683 lines) into 3 focused modules under 500 lines each.

**Architecture:** Three files with clear data flow: orchestrator → LLM → execution. No circular dependencies. All exports preserved for backward compatibility — `agent-brain.js` re-exports everything so existing `require('./agent-brain')` calls (handler.js, tests) work unchanged.

**Tech Stack:** Node.js, no new dependencies. Pure file reorganization.

---

## File Layout

| New File | Responsibility | Functions | ~Lines |
|----------|---------------|-----------|--------|
| `agent-brain.js` | Orchestrator + mechanical + constants | `handleAgentBrainRequest`, `checkMechanical`, `isFirstMessage`, `BRAIN_TOOLS`, re-exports | ~450 |
| `brain-llm.js` | LLM calling, continuation, compose fallbacks | `getGeminiClient`, `GEMINI_SAFETY`, `buildBrainSystemPrompt`, `callAgentBrain`, `callAgentBrainAnthropic`, `extractGeminiUsage`, `continueWithResults`, `serializePoolForContinuation`, `brainCompose`, `welcomeCompose`, `withTimeout`, `BRAIN_COMPOSE_SYSTEM`, `BRAIN_COMPOSE_SCHEMA`, `WELCOME_COMPOSE_SYSTEM` | ~550 |
| `brain-execute.js` | Tool execution + pool building | `buildSearchPool`, `executeSearchEvents`, `executeRespond`, `handleWelcome`, `executeMore`, `executeDetails`, `resolveDateRange`, `validatePicks`, `stripCodeFences`, `reconcilePicks` | ~530 |

**Dependency graph (no cycles):**
```
agent-brain.js → brain-llm.js (callAgentBrain, continueWithResults, brainCompose, welcomeCompose)
agent-brain.js → brain-execute.js (executeSearchEvents, executeRespond, handleWelcome, executeMore, executeDetails)
brain-execute.js → brain-llm.js (brainCompose, welcomeCompose, continueWithResults, serializePoolForContinuation, validatePicks helper)
```

---

### Task 1: Create `brain-llm.js`

**Files:**
- Create: `src/brain-llm.js`

**Step 1: Create the file**

Extract these functions from `agent-brain.js` lines 36-52, 119-241, 325-330, 332-421, 425-500, 502-577, 708-770, 776-778, 841-986 into `src/brain-llm.js`:

- `getGeminiClient` (lines 37-45) + `GEMINI_SAFETY` (lines 47-52)
- `buildBrainSystemPrompt` (lines 119-241)
- `withTimeout` (lines 325-330)
- `callAgentBrain` (lines 332-413)
- `extractGeminiUsage` (lines 415-421)
- `callAgentBrainAnthropic` (lines 425-499)
- `continueWithResults` (lines 502-536)
- `serializePoolForContinuation` (lines 541-577)
- `BRAIN_COMPOSE_SYSTEM` (lines 708-725)
- `BRAIN_COMPOSE_SCHEMA` (lines 726-742)
- `WELCOME_COMPOSE_SYSTEM` (lines 743-770)
- `stripCodeFences` (lines 776-778)
- `reconcilePicks` (lines 784-792)
- `brainCompose` (lines 841-919)
- `welcomeCompose` (lines 925-986)

Imports needed at the top of `brain-llm.js`:
```js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { NEIGHBORHOODS } = require('./neighborhoods');
const { getNycDateString } = require('./geo');
const { describeFilters } = require('./pipeline');
const { smartTruncate } = require('./formatters');
const { recordAICost } = require('./traces');
```

Exports:
```js
module.exports = {
  getGeminiClient, GEMINI_SAFETY,
  buildBrainSystemPrompt,
  withTimeout,
  callAgentBrain, callAgentBrainAnthropic, extractGeminiUsage,
  continueWithResults, serializePoolForContinuation,
  brainCompose, welcomeCompose,
  stripCodeFences, reconcilePicks,
  BRAIN_COMPOSE_SYSTEM, BRAIN_COMPOSE_SCHEMA, WELCOME_COMPOSE_SYSTEM,
};
```

**Step 2: Run tests**

Run: `npm test 2>&1 | grep -E '^\d+ passed'`
Expected: Tests still pass (brain-llm.js is created but not yet imported)

**Step 3: Commit**

```bash
git add src/brain-llm.js
git commit -m "refactor: extract brain-llm.js from agent-brain.js (LLM calling + compose)"
```

---

### Task 2: Create `brain-execute.js`

**Files:**
- Create: `src/brain-execute.js`

**Step 1: Create the file**

Extract these functions from `agent-brain.js`:

- `resolveDateRange` (lines 267-321)
- `executeMore` (lines 583-650)
- `executeDetails` (lines 651-706)
- `validatePicks` (lines 799-835)
- `buildSearchPool` (lines 995-1139)
- `executeSearchEvents` (lines 1143-1215)
- `executeRespond` (lines 1219-1236)
- `handleWelcome` (lines 1242-1300)

Imports needed at the top of `brain-execute.js`:
```js
const { extractNeighborhood, BOROUGHS, detectBorough } = require('./neighborhoods');
const { getAdjacentNeighborhoods, getNycDateString } = require('./geo');
const { getEvents, getEventsForBorough, getEventsCitywide, getCacheStatus } = require('./events');
const { filterKidsEvents } = require('./curation');
const { buildTaggedPool, buildEventMap, saveResponseFrame, mergeFilters, buildZeroMatchResponse, describeFilters } = require('./pipeline');
const { recordAICost } = require('./traces');
const { setSession } = require('./session');
const { trackAICost } = require('./request-guard');
const { updateProfile } = require('./preference-profile');
const { smartTruncate } = require('./formatters');
const { brainCompose, welcomeCompose, validatePicks: _unusedImportCheck, continueWithResults, serializePoolForContinuation, stripCodeFences, reconcilePicks } = require('./brain-llm');
```

Note: `validatePicks` stays in this file (it's an execution concern — validating picks against the event pool). `brainCompose`, `welcomeCompose`, `continueWithResults`, `serializePoolForContinuation` are imported from `brain-llm.js`.

Actually, `stripCodeFences` and `reconcilePicks` are only used by brain-llm.js compose functions internally — they should stay there. And `validatePicks` is used in both `executeSearchEvents` and `handleWelcome` (in brain-execute.js) and also in `handleAgentBrainRequest` (in agent-brain.js). It should live in brain-execute.js and be imported by agent-brain.js.

Corrected imports for `brain-execute.js`:
```js
const { extractNeighborhood, BOROUGHS, detectBorough } = require('./neighborhoods');
const { getAdjacentNeighborhoods, getNycDateString } = require('./geo');
const { getEvents, getEventsForBorough, getEventsCitywide, getCacheStatus } = require('./events');
const { filterKidsEvents } = require('./curation');
const { buildTaggedPool, buildEventMap, saveResponseFrame, mergeFilters, buildZeroMatchResponse, describeFilters } = require('./pipeline');
const { recordAICost } = require('./traces');
const { setSession } = require('./session');
const { trackAICost } = require('./request-guard');
const { updateProfile } = require('./preference-profile');
const { smartTruncate } = require('./formatters');
const { brainCompose, welcomeCompose, continueWithResults, serializePoolForContinuation } = require('./brain-llm');
```

Exports:
```js
module.exports = {
  resolveDateRange, executeMore, executeDetails, validatePicks,
  buildSearchPool, executeSearchEvents, executeRespond, handleWelcome,
};
```

**Step 2: Run tests**

Run: `npm test 2>&1 | grep -E '^\d+ passed'`
Expected: Tests still pass (brain-execute.js created but not yet imported)

**Step 3: Commit**

```bash
git add src/brain-execute.js
git commit -m "refactor: extract brain-execute.js from agent-brain.js (tool execution + pool building)"
```

---

### Task 3: Slim down `agent-brain.js` to orchestrator

**Files:**
- Modify: `src/agent-brain.js`

**Step 1: Replace the file contents**

`agent-brain.js` should now contain only:

1. **Imports** — from brain-llm.js, brain-execute.js, and remaining direct deps
2. **Constants** — `BRAIN_TOOLS` (lines 56-115), `NEIGHBORHOOD_NAMES` (line 34)
3. **Functions that stay:**
   - `checkMechanical` (lines 245-256)
   - `isFirstMessage` (lines 261-263)
   - `handleAgentBrainRequest` (lines 1304-1681) — the orchestrator
4. **Re-exports** — everything from brain-llm.js and brain-execute.js so `require('./agent-brain')` still works

New imports at top:
```js
const { extractNeighborhood, NEIGHBORHOODS } = require('./neighborhoods');
const { sendSMS, maskPhone } = require('./twilio');
const { startTrace, saveTrace, recordAICost } = require('./traces');
const { getSession, setSession, addToHistory } = require('./session');
const { trackAICost, OPT_OUT_KEYWORDS } = require('./request-guard');
const { handleHelp } = require('./intent-handlers');
const { saveResponseFrame, buildEventMap, buildExhaustionMessage, describeFilters, sendPickUrls } = require('./pipeline');
const { smartTruncate } = require('./formatters');
const { sendRuntimeAlert } = require('./alerts');
const { updateProfile } = require('./preference-profile');
const { getNycDateString } = require('./geo');

// Split modules
const { callAgentBrain, continueWithResults, serializePoolForContinuation, brainCompose, buildBrainSystemPrompt, GEMINI_SAFETY, getGeminiClient, BRAIN_COMPOSE_SYSTEM, BRAIN_COMPOSE_SCHEMA, WELCOME_COMPOSE_SYSTEM, extractGeminiUsage, callAgentBrainAnthropic, withTimeout, welcomeCompose, stripCodeFences, reconcilePicks } = require('./brain-llm');
const { executeSearchEvents, executeRespond, handleWelcome, executeMore, executeDetails, buildSearchPool, resolveDateRange, validatePicks } = require('./brain-execute');
```

The `BRAIN_TOOLS` constant stays in this file (it defines the agent's tool schema and is only used by `callAgentBrain` in brain-llm.js — BUT it's also referenced in `callAgentBrain`. So `BRAIN_TOOLS` should move to brain-llm.js since that's where it's used.)

**Correction:** Move `BRAIN_TOOLS` to `brain-llm.js` as well. It's only used in `callAgentBrain` line 345.

Re-exports at bottom:
```js
module.exports = {
  // Orchestrator
  checkMechanical, handleAgentBrainRequest,
  // Re-exports from brain-llm.js
  callAgentBrain, brainCompose, welcomeCompose, buildBrainSystemPrompt,
  // Re-exports from brain-execute.js
  resolveDateRange, validatePicks, buildSearchPool, executeMore, executeDetails, handleWelcome,
};
```

**Step 2: Run tests**

Run: `npm test 2>&1 | grep -E '^\d+ passed'`
Expected: `881 passed, 0 failed` and eval tests pass

**Step 3: Verify line counts**

Run: `wc -l src/agent-brain.js src/brain-llm.js src/brain-execute.js`
Expected: Each file under ~550 lines. Total should be ~1683 + small overhead for duplicate imports.

**Step 4: Commit**

```bash
git add src/agent-brain.js
git commit -m "refactor: slim agent-brain.js to orchestrator, re-exports from brain-llm + brain-execute"
```

---

### Task 4: Update module header comment

**Files:**
- Modify: `src/agent-brain.js` (lines 1-14)

**Step 1: Update the file header**

Replace the header comment with:
```js
/**
 * Agent Brain — Orchestrator for Pulse's LLM-powered SMS agent.
 *
 * Routes incoming messages: checkMechanical (help + TCPA, $0) → callAgentBrain (Gemini tool calling).
 * Tool execution and LLM calling are split into brain-execute.js and brain-llm.js.
 *
 * This file re-exports from both modules so existing require('./agent-brain') calls work unchanged.
 */
```

**Step 2: Run tests**

Run: `npm test 2>&1 | grep -E '^\d+ passed'`
Expected: All pass

**Step 3: Commit**

```bash
git add src/agent-brain.js
git commit -m "docs: update agent-brain.js header for split architecture"
```

---

### Task 5: Update ROADMAP.md tech debt

**Files:**
- Modify: `ROADMAP.md`

**Step 1: Mark the tech debt item as done**

Change:
```
| **agent-brain.js is 1683 lines** | Medium | Largest file. Consider splitting...
```
To:
```
| ~~agent-brain.js is 1683 lines~~ | ~~Medium~~ | ~~Split into agent-brain.js (~450), brain-llm.js (~550), brain-execute.js (~530).~~ **Done (2026-03-05)** |
```

**Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark agent-brain split as done in roadmap"
```
