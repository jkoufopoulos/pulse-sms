# Phase 1: Unified Agent Loop — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delete unified-flow path, make agent brain the only code path with model-agnostic Gemini-then-Claude fallback.

**Architecture:** Refactor `callAgentBrain` to accept a provider param. Extract `checkMechanical` and `getAdjacentNeighborhoods` from pre-router into their own module. Remove handler.js branching on `PULSE_AGENT_BRAIN`. Delete unified-flow.js, most of pre-router.js, model-router.js, and compose skills.

**Tech Stack:** Gemini SDK, Anthropic SDK, existing tool definitions.

---

## Dependency Map

```
handler.js
  ├── agent-brain.js (checkMechanical, handleAgentBrainRequest)
  │     ├── callAgentBrain (Gemini) → callAgentBrainAnthropic (fallback)
  │     ├── brainCompose (Gemini/Anthropic)
  │     ├── getAdjacentNeighborhoods (from pre-router.js)
  │     └── intent-handlers.js (handleHelp, handleDetails, handleMore)
  │           ├── composeViaBrain (lazy require agent-brain.brainCompose)
  │           ├── composeViaExecuteQuery (uses ai.js → unifiedRespond)
  │           └── composeDetails (from ai.js — KEEP)
  ├── unified-flow.js (DELETE)
  ├── pre-router.js (MOSTLY DELETE — keep getAdjacentNeighborhoods)
  ├── model-router.js (DELETE)
  └── src/skills/ (DELETE)

ai.js — KEEP: composeDetails (used by handleDetails), extractEvents (used by scrapers)
         KEEP FOR NOW: unifiedRespond (used by handleMore via executeQuery — will be replaced by brainCompose)
pipeline.js — KEEP: executeQuery calls unifiedRespond for handleMore. After this phase, handleMore uses brainCompose only.
```

## Files to Delete

- `src/unified-flow.js` (~450 lines)
- `src/model-router.js` (~100 lines)
- `src/skills/compose-skills.js` (~100 lines)
- `src/skills/build-compose-prompt.js` (~80 lines)

## Files to Modify

- `src/handler.js` — Remove unified-flow branching, PULSE_AGENT_BRAIN gate, model-router import
- `src/agent-brain.js` — Extract getAdjacentNeighborhoods import, make it the sole path
- `src/intent-handlers.js` — Remove composeViaExecuteQuery, always use composeViaBrain
- `src/pipeline.js` — Remove executeQuery (calls unifiedRespond), remove late require of ai.js
- `src/pre-router.js` — Reduce to just getAdjacentNeighborhoods export (or move to geo.js)
- `src/ai.js` — Remove unifiedRespond, buildUnifiedPrompt import; keep composeDetails + extractEvents

---

### Task 1: Extract getAdjacentNeighborhoods to geo.js

**Files:**
- Modify: `src/geo.js` — add getAdjacentNeighborhoods function
- Modify: `src/pre-router.js` — move function out, re-export from geo.js for backward compat temporarily
- Modify: `src/agent-brain.js:20` — change import to geo.js
- Modify: `src/intent-handlers.js:4` — change import to geo.js
- Test: `npm test`

**Step 1: Read geo.js exports to find insertion point**

Read `src/geo.js` to understand current exports.

**Step 2: Copy getAdjacentNeighborhoods from pre-router.js to geo.js**

Move the function (pre-router.js lines 10-37 approx) to geo.js. It needs `NEIGHBORHOODS` and `HOOD_TO_BOROUGH` which are already in neighborhoods.js (imported by geo.js).

**Step 3: Update imports in agent-brain.js, intent-handlers.js, unified-flow.js**

Change `require('./pre-router')` to `require('./geo')` for `getAdjacentNeighborhoods`.

**Step 4: Run tests**

Run: `npm test`
Expected: 124 passed, 0 failed

**Step 5: Commit**

```bash
git add src/geo.js src/pre-router.js src/agent-brain.js src/intent-handlers.js
git commit -m "refactor: extract getAdjacentNeighborhoods to geo.js"
```

---

### Task 2: Make handleMore always use brainCompose

**Files:**
- Modify: `src/intent-handlers.js` — remove composeViaExecuteQuery, remove PULSE_AGENT_BRAIN gate, always use composeViaBrain
- Test: `npm test`

**Step 1: In intent-handlers.js, remove the composeViaExecuteQuery function entirely**

It's ~60 lines (169-225) that build a unified-flow prompt for handleMore.

**Step 2: Remove the PULSE_AGENT_BRAIN conditional**

Change line ~322:
```javascript
const composeFn = process.env.PULSE_AGENT_BRAIN === 'true' ? composeViaBrain : composeViaExecuteQuery;
```
To:
```javascript
const composeFn = composeViaBrain;
```

Or just inline the call directly.

**Step 3: Remove executeQuery import from intent-handlers.js**

It was only used by composeViaExecuteQuery.

**Step 4: Run tests**

Run: `npm test`
Expected: 124 passed, 0 failed

**Step 5: Commit**

```bash
git add src/intent-handlers.js
git commit -m "refactor: handleMore always uses brainCompose"
```

---

### Task 3: Remove unified-flow path from handler.js

**Files:**
- Modify: `src/handler.js` — remove lines 305-396 (the entire `// --- Original pre-router + unified flow ---` block), remove unified-flow.js imports, remove model-router import, remove preRoute import
- Test: `npm test`

**Step 1: Remove imports**

Remove from handler.js:
```javascript
const { preRoute } = require('./pre-router');
const { routeModel } = require('./model-router');
const { resolveUnifiedContext, callUnified, handleUnifiedResponse, handleZeroMatch } = require('./unified-flow');
```

**Step 2: Remove the PULSE_AGENT_BRAIN conditional block**

The entire `if (process.env.PULSE_AGENT_BRAIN === 'true') { ... }` block (lines ~273-303) becomes the only path. Remove the `if` wrapper — the mechanical check + handleAgentBrainRequest is always called.

**Step 3: Remove the unified-flow code path**

Delete lines 305-396 (everything after the agent brain block through the end of handleMessageAI). This includes:
- Pre-router call
- Pre-detected filter handling
- Zero-match bypass
- Model routing
- callUnified + handleUnifiedResponse
- handleDegradedFallback

**Step 4: Remove the handleDegradedFallback function**

The agent brain has its own zero-match handling and degraded fallback is not needed — the agent brain falls back to Anthropic on Gemini failure, which is the new safety net.

**Step 5: Run tests**

Run: `npm test`
Expected: 124 passed, 0 failed

**Step 6: Commit**

```bash
git add src/handler.js
git commit -m "refactor: remove unified-flow path from handler, agent brain is sole path"
```

---

### Task 4: Delete unified-flow.js, model-router.js, compose skills

**Files:**
- Delete: `src/unified-flow.js`
- Delete: `src/model-router.js`
- Delete: `src/skills/compose-skills.js`
- Delete: `src/skills/build-compose-prompt.js`
- Test: `npm test`

**Step 1: Delete the files**

```bash
rm src/unified-flow.js src/model-router.js src/skills/compose-skills.js src/skills/build-compose-prompt.js
```

**Step 2: Verify no remaining imports**

Search for any remaining `require('./unified-flow')`, `require('./model-router')`, `require('./skills/`)`.

**Step 3: Run tests**

Run: `npm test`
Expected: 124 passed, 0 failed

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete unified-flow.js, model-router.js, compose skills"
```

---

### Task 5: Clean up ai.js — remove unifiedRespond

**Files:**
- Modify: `src/ai.js` — remove unifiedRespond, remove buildUnifiedPrompt import, remove unified-related code. Keep composeDetails and extractEvents.
- Modify: `src/pipeline.js` — remove executeQuery function (its only caller was composeViaExecuteQuery, now deleted). Remove late `require('./ai')`.
- Test: `npm test`

**Step 1: Read ai.js to identify what to keep vs remove**

Keep: `composeDetails`, `extractEvents`, any shared helpers they use.
Remove: `unifiedRespond`, `buildUnifiedPrompt` import, any unified-flow-specific code.

**Step 2: Remove executeQuery from pipeline.js**

Remove the function and its export. It was the bridge between intent-handlers and unifiedRespond.

**Step 3: Run tests**

Run: `npm test`
Expected: 124 passed, 0 failed

**Step 4: Commit**

```bash
git add src/ai.js src/pipeline.js
git commit -m "chore: remove unifiedRespond, executeQuery — agent brain composes directly"
```

---

### Task 6: Reduce pre-router.js to minimal exports

**Files:**
- Modify: `src/pre-router.js` — remove preRoute function and all filter detection logic. Keep only getAdjacentNeighborhoods (re-exported from geo.js for any remaining consumers) and parseDateRange (if still used).
- Test: `npm test`

**Step 1: Check if parseDateRange is used outside pre-router**

Search for `parseDateRange` imports. If only used internally, delete. If used by tests or other modules, keep.

**Step 2: Gut pre-router.js**

Remove: preRoute function, catMap, multiWordCatMap, AMBIGUOUS_CAT_WORDS, matchCategory, all filter detection logic. If getAdjacentNeighborhoods was successfully moved to geo.js in Task 1, the file can be deleted entirely (or kept as a thin re-export for safety).

**Step 3: Run tests**

Run: `npm test`
Expected: 124 passed, 0 failed

**Step 4: Commit**

```bash
git add src/pre-router.js
git commit -m "chore: gut pre-router.js — filter detection removed, agent brain handles all routing"
```

---

### Task 7: Remove PULSE_AGENT_BRAIN env var

**Files:**
- Modify: `src/handler.js` — remove any remaining references
- Modify: `src/agent-brain.js` — remove any conditional checks
- Modify: `.env.example` — remove PULSE_AGENT_BRAIN
- Modify: `CLAUDE.md` — update env vars section
- Modify: `ROADMAP.md` — mark Phase 1 as done
- Test: `npm test`

**Step 1: Search for all PULSE_AGENT_BRAIN references**

```bash
grep -r "PULSE_AGENT_BRAIN" src/ .env* CLAUDE.md ROADMAP.md
```

Remove all references. The agent brain is the only path — no gate needed.

**Step 2: Update docs**

- `.env.example`: remove `PULSE_AGENT_BRAIN=true`
- `CLAUDE.md`: remove from env vars section, update any references to "gated" or "enabled by"
- `ROADMAP.md`: mark Phase 1 as Done with date

**Step 3: Run tests**

Run: `npm test`
Expected: 124 passed, 0 failed

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: agent brain is the only path — remove PULSE_AGENT_BRAIN gate"
```

---

### Task 8: Run full eval suite against Railway

**Step 1: Deploy to Railway**

```bash
railway up
```

Wait ~3 min for build + deploy.

**Step 2: Run scenario evals**

```bash
node scripts/run-scenario-evals.js --url https://web-production-c8fdb.up.railway.app
```

Expected: pass rate >= 99% on code evals.

**Step 3: Run regression evals**

```bash
node scripts/run-regression-evals.js --url https://web-production-c8fdb.up.railway.app
```

Expected: no P1/P4 regressions.

**Step 4: Review failures**

If any failures, investigate whether they're:
- Cache-dependent (non-deterministic, expected)
- Code regressions (fix before proceeding)
- Unified-flow-specific scenarios that need updating

**Step 5: Update ROADMAP.md**

Mark Phase 1 as **Done** with date and eval results.
