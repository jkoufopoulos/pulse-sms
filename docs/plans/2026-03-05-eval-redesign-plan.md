# Eval Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 417-scenario behavioral conformance eval system with 15 golden conversations scored on 6 quality dimensions.

**Architecture:** Upgrade the existing quality eval runner with a new 6-dimension rubric (tone, curation, intent_match, probing, inference, coherence). Write 15 golden conversations. Trim code evals from 24 to 6. Archive old eval infrastructure.

**Tech Stack:** Anthropic Claude Haiku (judge), existing `scripts/run-quality-evals.js` runner, `data/fixtures/quality-conversations.json`.

**Design doc:** `docs/plans/2026-03-05-eval-redesign-design.md`

---

### Task 1: Write 15 golden conversations

**Files:**
- Modify: `data/fixtures/quality-conversations.json`

**Step 1: Replace the file contents**

Replace `data/fixtures/quality-conversations.json` with:

```json
[
  {
    "name": "cold open: neighborhood",
    "turns": [
      { "user": "bushwick" },
      { "user": "tell me about the first one" },
      { "user": "thanks" }
    ]
  },
  {
    "name": "specific request: genre + neighborhood",
    "turns": [
      { "user": "jazz in west village" }
    ]
  },
  {
    "name": "vague vibe: weird tonight",
    "turns": [
      { "user": "anything weird tonight" }
    ]
  },
  {
    "name": "ultra vague: vibes",
    "turns": [
      { "user": "vibes" }
    ]
  },
  {
    "name": "progressive filtering",
    "turns": [
      { "user": "free stuff in greenpoint" },
      { "user": "how about comedy" },
      { "user": "more" }
    ]
  },
  {
    "name": "group context",
    "turns": [
      { "user": "4 of us looking for something fun in williamsburg" }
    ]
  },
  {
    "name": "challenge the picks",
    "turns": [
      { "user": "williamsburg" },
      { "user": "those sound basic" }
    ]
  },
  {
    "name": "pivot mid-conversation",
    "turns": [
      { "user": "les" },
      { "user": "actually bushwick" },
      { "user": "techno stuff" }
    ]
  },
  {
    "name": "natural detail request",
    "turns": [
      { "user": "east village" },
      { "user": "any comedy?" },
      { "user": "tell me about the first one" }
    ]
  },
  {
    "name": "borough-level search",
    "turns": [
      { "user": "comedy tonight somewhere in brooklyn" }
    ]
  },
  {
    "name": "vibe + location inference",
    "turns": [
      { "user": "something chill near prospect park" }
    ]
  },
  {
    "name": "new user: just says hey",
    "turns": [
      { "user": "hey" }
    ]
  },
  {
    "name": "weekend planning: refine",
    "turns": [
      { "user": "what's good this weekend" },
      { "user": "saturday night specifically" }
    ]
  },
  {
    "name": "exhaustion: trivia deep dive",
    "turns": [
      { "user": "trivia" },
      { "user": "more" },
      { "user": "more" }
    ]
  },
  {
    "name": "time-specific request",
    "turns": [
      { "user": "anything happening tomorrow afternoon" }
    ]
  }
]
```

**Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('data/fixtures/quality-conversations.json')); console.log('valid')"`
Expected: `valid`

**Step 3: Commit**

```bash
git add data/fixtures/quality-conversations.json
git commit -m "feat: replace quality conversations with 15 golden scenarios"
```

---

### Task 2: Upgrade judge rubric to 6 dimensions

**Files:**
- Modify: `scripts/run-quality-evals.js`

**Step 1: Replace `JUDGE_SYSTEM` prompt**

Find the `JUDGE_SYSTEM` const (around line 42-56). Replace the entire string with:

```js
const JUDGE_SYSTEM = `You are evaluating an SMS nightlife recommendation bot called Pulse.
Pulse is supposed to feel like texting a cool friend who always knows what's happening tonight -- not a search engine, not a customer service bot.

Score ONLY the dimensions that apply to this turn. Set inapplicable dimensions to null.

DIMENSIONS (each 1-5):

- tone (ALWAYS score): 5 = sounds like a friend who actually goes out, uses natural language, has personality, opinionated. 3 = fine but generic, could be any bot. 1 = robotic, formal, "I'd be happy to help", bullet-point listing.

- curation (score ONLY when response contains event picks): 5 = recommendations feel genuinely curated, the kind of thing a knowledgeable local would suggest -- interesting, not obvious. 3 = reasonable but stuff you'd find on the first page of Google. 1 = generic, irrelevant, clearly just database results.

- intent_match (score ONLY when user had a clear request): 5 = nailed exactly what the user wanted, picks/response perfectly aligned with their ask. 3 = partially relevant, some picks match but others don't. 1 = completely missed what the user was asking for.

- probing (score ONLY when user intent is vague/ambiguous): 5 = asked a smart, specific follow-up that would genuinely help narrow down what the user wants. 3 = asked something generic like "what are you looking for?" 1 = didn't ask at all, just guessed badly or gave generic results.

- inference (score ONLY when there's an opportunity to go beyond the literal request): 5 = connected dots brilliantly -- inferred context (group size, vibe, time constraints) and picked events that match the unstated need. 3 = reasonable interpretation but nothing creative. 1 = took request too literally, missed obvious context clues.

- coherence (score ONLY on turn 2+ of a conversation): 5 = perfectly maintained context from previous turns, built on the conversation naturally. 3 = mostly coherent but forgot or ignored something from earlier. 1 = clearly lost context, contradicted previous turns, or started over.

Respond in STRICT JSON (no markdown fencing):
{"tone": N_or_null, "curation": N_or_null, "intent_match": N_or_null, "probing": N_or_null, "inference": N_or_null, "coherence": N_or_null, "note": "one sentence on the weakest score"}`;
```

**Step 2: Update `judgeResponse` to pass turn number**

Change the `judgeResponse` function signature and prompt to include turn context:

```js
async function judgeResponse(userMessage, responseText, { turnNumber, previousTurns } = {}) {
  let context = '';
  if (previousTurns?.length > 0) {
    context = '\n\nPrevious turns in this conversation:\n' +
      previousTurns.map(t => `User: "${t.user}"\nPulse: "${t.response}"`).join('\n\n') +
      '\n\n---\nNow scoring this turn:\n';
  }
  const turnLabel = turnNumber > 1 ? ` (turn ${turnNumber} of conversation)` : ' (first message, no prior context)';
  const prompt = `The user texted${turnLabel}: "${userMessage}"${context}\n\nPulse responded: "${responseText}"\n\nScore this response. Remember: only score dimensions that apply to this turn. Set others to null.`;

  // ... rest of function unchanged
```

**Step 3: Update `runConversation` to pass turn context**

In the `runConversation` function, change the judge call to pass turn number and previous turns:

```js
// Inside the turn loop, after getting responseText:
let scores, note;
try {
  const judgment = await judgeResponse(turn.user, responseText, {
    turnNumber: turnResults.length + 1,
    previousTurns: turnResults,
  });
  scores = {
    tone: judgment.tone ?? null,
    curation: judgment.curation ?? null,
    intent_match: judgment.intent_match ?? null,
    probing: judgment.probing ?? null,
    inference: judgment.inference ?? null,
    coherence: judgment.coherence ?? null,
  };
  note = judgment.note || null;
} catch (err) {
  scores = { tone: null, curation: null, intent_match: null, probing: null, inference: null, coherence: null };
  note = `Judge error: ${err.message}`;
}
```

**Step 4: Update `dimensionAvg` and summary output**

The existing `dimensionAvg` function already works generically. Update the CLI summary (around line 275-281):

```js
console.log(`\n${'='.repeat(60)}`);
console.log(`Quality: ${overallAvg.toFixed(1)}/5.0 (${conversations.length} conversations)`);
console.log(`  Tone: ${dimensionAvg(convResults, 'tone').toFixed(1)}  Curation: ${dimensionAvg(convResults, 'curation').toFixed(1)}  Intent: ${dimensionAvg(convResults, 'intent_match').toFixed(1)}`);
console.log(`  Probing: ${dimensionAvg(convResults, 'probing').toFixed(1)}  Inference: ${dimensionAvg(convResults, 'inference').toFixed(1)}  Coherence: ${dimensionAvg(convResults, 'coherence').toFixed(1)}`);
console.log(`  Worst: ${worst}`);
console.log(`  Cost: $${judgeCostTotal.toFixed(4)}  Time: ${totalElapsed}s`);
console.log(`${'='.repeat(60)}`);
```

Update the report `summary` object to include all 6 dimensions:

```js
summary: {
  conversations: conversations.length,
  avg_score: parseFloat(overallAvg.toFixed(1)),
  tone: parseFloat(dimensionAvg(convResults, 'tone').toFixed(1)),
  curation: parseFloat(dimensionAvg(convResults, 'curation').toFixed(1)),
  intent_match: parseFloat(dimensionAvg(convResults, 'intent_match').toFixed(1)),
  probing: parseFloat(dimensionAvg(convResults, 'probing').toFixed(1)),
  inference: parseFloat(dimensionAvg(convResults, 'inference').toFixed(1)),
  coherence: parseFloat(dimensionAvg(convResults, 'coherence').toFixed(1)),
},
```

**Step 5: Run quality evals to test**

Start server: `PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js &`
Wait for cache, then: `npm run eval:quality -- --name "new user"`
Expected: runs 1 conversation, prints 6-dimension scores.

**Step 6: Commit**

```bash
git add scripts/run-quality-evals.js
git commit -m "feat: upgrade quality eval rubric to 6 dimensions"
```

---

### Task 3: Trim code evals to 6 invariants

**Files:**
- Modify: `src/evals/code-evals.js`

**Step 1: Read the current file**

Read `src/evals/code-evals.js` in full to understand all 24 checks.

**Step 2: Replace the evals object**

Keep ONLY these 6 functions from the existing `evals` object. Delete all others:
- `char_limit`
- `response_not_empty`
- `picked_events_exist`
- `latency_under_10s`
- `valid_urls`
- `price_transparency`

Keep the `CATEGORY_PARENTS` map and any imports these 6 functions need. Delete unused imports.

Also update `VALID_INTENTS` to remove `'free'` (no longer a distinct intent):
```js
const VALID_INTENTS = ['events', 'details', 'more', 'help', 'conversational'];
```

Actually, `valid_intent` is being removed, so just delete the `VALID_INTENTS` const entirely if no surviving eval uses it.

**Step 3: Update `runCodeEvals` to only run surviving checks**

The `runCodeEvals` function (find it at the bottom) iterates over the evals object, so it should just work with fewer entries. Verify this.

**Step 4: Run unit tests**

Run: `npm test`
Expected: PASS — unit tests that reference code evals may need updating if they test specific eval names.

**Step 5: Commit**

```bash
git add src/evals/code-evals.js
git commit -m "refactor: trim code evals from 24 to 6 invariant checks"
```

---

### Task 4: Archive old eval infrastructure

**Files:**
- Move: `data/fixtures/synthetic-cases.json` -> `data/fixtures/archive/synthetic-cases.json`
- Move: `data/fixtures/multi-turn-scenarios.json` -> `data/fixtures/archive/multi-turn-scenarios.json`
- Move: `data/fixtures/regression-scenarios.json` -> `data/fixtures/archive/regression-scenarios.json`
- Move: `scripts/run-evals.js` -> `scripts/archive/run-evals.js`
- Move: `scripts/run-scenario-evals.js` -> `scripts/archive/run-scenario-evals.js`
- Move: `scripts/run-regression-evals.js` -> `scripts/archive/run-regression-evals.js`
- Modify: `package.json` (remove `eval` and `eval:judges` scripts)

**Step 1: Create archive directories**

```bash
mkdir -p data/fixtures/archive scripts/archive
```

**Step 2: Move files**

```bash
mv data/fixtures/synthetic-cases.json data/fixtures/archive/
mv data/fixtures/multi-turn-scenarios.json data/fixtures/archive/
mv data/fixtures/regression-scenarios.json data/fixtures/archive/
mv scripts/run-evals.js scripts/archive/
mv scripts/run-scenario-evals.js scripts/archive/
mv scripts/run-regression-evals.js scripts/archive/
```

**Step 3: Update package.json scripts**

Remove `"eval"` and `"eval:judges"` scripts. Keep `"eval:quality"`. The scripts section should have:

```json
"scripts": {
  "start": "node src/server.js",
  "dev": "node --watch src/server.js",
  "test": "node test/run-all.js && node test/eval.test.js",
  "eval:quality": "node scripts/run-quality-evals.js"
}
```

Also remove `"eval:gen"` if it exists — that generated synthetic cases.

**Step 4: Update any unit tests that reference archived evals**

Check `test/eval.test.js` — if it imports from `scripts/run-evals.js` or references `synthetic-cases.json`, update or remove those tests.

**Step 5: Run tests**

Run: `npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: archive old eval infrastructure (synthetic, regression, scenario)"
```

---

### Task 5: Update CLAUDE.md and ROADMAP.md

**Files:**
- Modify: `CLAUDE.md` (Running section, eval references)
- Modify: `ROADMAP.md` (eval references)

**Step 1: Update CLAUDE.md**

In the Running section, replace eval commands:
```bash
npm run eval:quality   # quality evals on 15 golden conversations (~$0.20, ~2min)
```

Remove references to `npm run eval`, `npm run eval:judges`, scenario evals, regression evals.

**Step 2: Update ROADMAP.md**

If there are eval-related items in the roadmap, update to reflect the new system.

**Step 3: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: update eval references for quality-first system"
```

---

### Task 6: Run full quality eval and verify

**Step 1: Start server**

```bash
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js
```

Wait for cache to load.

**Step 2: Run quality evals**

```bash
npm run eval:quality
```

Expected output format:
```
Quality: X.X/5.0 (15 conversations)
  Tone: X.X  Curation: X.X  Intent: X.X
  Probing: X.X  Inference: X.X  Coherence: X.X
  Worst: "conversation name" (X.X)
  Cost: $0.XX  Time: XXs
```

**Step 3: Review scores**

If any conversation scores below 2.0, note it as a quality issue to investigate (not an eval bug).

**Step 4: Commit report**

No code commit needed — reports auto-save to `data/reports/`.
