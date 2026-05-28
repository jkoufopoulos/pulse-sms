# Phase A — Hybrid Retrieval Implementation Plan (L1 + L2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hybrid retrieval stack as a standalone clone `pulse-rag-hybrid` on port 3002. L1 = BM25-only retrieve → single LLM compose. L2 = + Gemini dense vectors + RRF hybrid fusion + light calibration. Mandatory dedup at every layer. After each layer, run the 25-query rotated-phone comparison against the production agent-Pulse on port 3000 and write a per-layer atlas + summary.

**Architecture:** New clone `~/Projects/pulse-rag-hybrid`. Reuses Phase 0's tested retrieval primitives (`bm25.js`, `event-cards.js`, `cosine.js`, `rrf.js`, `hybrid-retrieve.js`) by copying them into `src/retrieval/`. The clone's `handleAgentRequest` becomes a linear `retrieve → compose → SMS` flow with no session state reads and no tool loop. `embeddings-cache.json` from Phase 0 transfers over so L2 doesn't re-embed.

**Tech Stack:** Same as pulse-sms (Node 20+, Express, Claude via Anthropic SDK, better-sqlite3) + Gemini for query embeddings. No new runtime deps.

**Reference spec:** `docs/superpowers/specs/2026-05-27-hybrid-pulse-design.md`
**Reference Phase 0 plan:** `docs/superpowers/plans/2026-05-27-phase-0-empirical-anchor.md`
**Reference Phase 0/0.5 findings:** `docs/superpowers/plans/phase-0-output-summary.md`, `phase-0.5-output-summary.md`

**Time budget:** ~3-4 hours total. L1 sub-phase ~90 min. L2 sub-phase ~90 min. Per-layer eval ~30 min.

---

## Pre-flight: locked design decisions (do not re-litigate during execution)

1. **Clone location:** `~/Projects/pulse-rag-hybrid/`. Cloned from `~/Projects/pulse-sms/` via `cp -r`.
2. **Port:** 3002 (env-overridable, but default in `src/server.js` is 3002 not 3000).
3. **Agent baseline model:** Claude Sonnet 4.6 (matches `pulse-sms`'s current production model per `CLAUDE.md`). Phase 0/0.5 used Haiku; the comparison numbers may shift slightly but the qualitative patterns should hold.
4. **Source of retrieval primitives:** copy Phase 0's tested files from `pulse-sms/scripts/phase-0/` into `pulse-rag-hybrid/src/retrieval/`. Do NOT modify them — they have unit tests on the pulse-sms side.
5. **Dedup is P0:** every retrieval layer ends with `dedup by lower(name)+lower(venue)`. The dedup pass is its own tested module.
6. **Compose prompt:** identical across L1 and L2 (see Task A.4 for exact text). The retrieval is the only changing variable.
7. **Hard filters retained:** `date_range = today` is applied as a pre-filter (we filter the indexable corpus, not the retrieved top-K, since stale events shouldn't compete for ranking). `free_only` is NOT a hard filter at L1/L2 because the queries don't request it — the suite handles free-event queries with retrieval. Phase 0 amendment was about RAG making free explicit; we revisit at L4 if needed.
8. **Comparison harness uses rotated phones by default:** the `PULSE_ROTATE_PHONE=true` env var that was opt-in for Phase 0.5 is the default for Phase A. No methodology contamination.
9. **No session-state reads in the clone:** `handler.js` passes `session=null`. `handleAgentRequest` writes to history but never reads. Per Phase 0/0.5 — this is the whole point of the RAG comparison.
10. **The Phase 0 `pulse-sms/data/embeddings-cache.json` (~103MB) is reused** by being copied to `pulse-rag-hybrid/data/embeddings-cache.json`. Gitignored on both sides.

---

## File structure (additions in pulse-rag-hybrid only)

```
src/
├── retrieval/                              # new module dir
│   ├── bm25.js                             # copied from pulse-sms/scripts/phase-0/
│   ├── event-cards.js                      # copied
│   ├── cosine.js                           # copied (L2)
│   ├── rrf.js                              # copied (L2)
│   ├── hybrid-retrieve.js                  # copied (L2)
│   ├── embed-query.js                      # copied (L2)
│   ├── dedup.js                            # NEW: dedup by name+venue
│   ├── compose.js                          # NEW: the single-LLM-call composer
│   ├── retrieve-l1.js                      # NEW: L1 entry point (BM25 + dedup)
│   └── retrieve-l2.js                      # NEW: L2 entry point (hybrid + dedup)
├── agent-loop.js                           # REWRITTEN: linear flow
├── handler.js                              # MODIFIED: null session pattern
└── server.js                               # MODIFIED: PORT default 3002

scripts/
├── comparison-queries.txt                  # copied from pulse-sms/scripts/phase-0/
└── compare-hybrid.js                       # NEW: hits both 3000 (agent) and 3002 (hybrid)

test/unit/retrieval/
├── dedup.test.js                           # NEW
├── compose.test.js                         # NEW (small — prompt fixture)
└── retrieve-l1.test.js                     # NEW (integration-light)

data/
└── embeddings-cache.json                   # copied from pulse-sms/data/, gitignored

docs/superpowers/plans/
├── phase-A-L1-output-atlas.md              # written at A.7
├── phase-A-L1-output-summary.md            # written at A.8
├── phase-A-L2-output-atlas.md              # written at A.13
├── phase-A-L2-output-summary.md            # written at A.14
└── phase-A-L2-calibration.md               # written at A.12
```

---

## Sub-phase L1 — BM25-only retrieval

### Task A.1: Clone pulse-sms → pulse-rag-hybrid

**Files:**
- Create: directory `~/Projects/pulse-rag-hybrid/`
- Modify in clone: `.gitignore`, `src/server.js`

- [ ] **A.1.1: Pre-flight check — confirm pulse-sms is on main and clean**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git branch --show-current
```
Expected: `main`. Run `git status --short` and confirm any uncommitted changes are unrelated to Phase A (e.g., the user's other in-progress work). If anything looks like Phase A work, STOP and report BLOCKED.

- [ ] **A.1.2: Clone**

```bash
cp -r ~/Projects/pulse-sms ~/Projects/pulse-rag-hybrid
ls -d ~/Projects/pulse-rag-hybrid
```

- [ ] **A.1.3: Rebuild native modules (better-sqlite3 binding)**

```bash
cd ~/Projects/pulse-rag-hybrid
npm rebuild better-sqlite3 2>&1 | tail -5
```

- [ ] **A.1.4: Run baseline smoke tests in the clone (should pass before any modification)**

```bash
cd ~/Projects/pulse-rag-hybrid
npm test 2>&1 | tail -5
```
Expected: all tests pass. If they don't, the clone is broken — STOP and report BLOCKED.

- [ ] **A.1.5: Change default PORT to 3002**

In `~/Projects/pulse-rag-hybrid/src/server.js`, find the line:
```javascript
const PORT = process.env.PORT || 3000;
```
Replace with:
```javascript
const PORT = process.env.PORT || 3002;
```

- [ ] **A.1.6: Copy the embeddings cache (already gitignored in pulse-sms)**

```bash
cp ~/Projects/pulse-sms/data/embeddings-cache.json ~/Projects/pulse-rag-hybrid/data/embeddings-cache.json
ls -lh ~/Projects/pulse-rag-hybrid/data/embeddings-cache.json
```
Expected: ~103MB file.

The pulse-sms `.gitignore` already has `data/embeddings-cache.json`. No edit needed in the clone.

- [ ] **A.1.7: Initial commit on the clone's main branch**

This commit ONLY changes the port. Everything else is identical to pulse-sms's state at clone time.

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/server.js
git commit -m "$(cat <<'EOF'
phase-A: clone of pulse-sms; default PORT 3002

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.2: Copy retrieval primitives into src/retrieval/

**Files:**
- Create: `src/retrieval/bm25.js`, `event-cards.js`, `cosine.js`, `rrf.js`, `hybrid-retrieve.js`, `embed-query.js`
- Create: `test/unit/retrieval/` directory

- [ ] **A.2.1: Make the directory**

```bash
cd ~/Projects/pulse-rag-hybrid
mkdir -p src/retrieval test/unit/retrieval
```

- [ ] **A.2.2: Copy the six retrieval modules from pulse-sms's tested phase-0 source**

```bash
for f in bm25 event-cards cosine rrf hybrid-retrieve embed-query; do
  cp ~/Projects/pulse-sms/scripts/phase-0/${f}.js ~/Projects/pulse-rag-hybrid/src/retrieval/${f}.js
done
ls ~/Projects/pulse-rag-hybrid/src/retrieval/
```
Expected: six files listed.

- [ ] **A.2.3: Fix relative-require paths**

The original `hybrid-retrieve.js` requires `./bm25`, `./event-cards`, `./cosine`, `./rrf` — all relative to its own directory, so no changes needed when all six files sit in `src/retrieval/`. Verify with:

```bash
cd ~/Projects/pulse-rag-hybrid
node -e "const {hybridRetrieve, buildIndex} = require('./src/retrieval/hybrid-retrieve.js'); console.log('OK', typeof hybridRetrieve, typeof buildIndex);"
```
Expected: `OK function function`. If it errors, the relative requires need adjustment — check the cp output and verify all files copied.

- [ ] **A.2.4: Copy the matching tests**

```bash
for f in bm25 event-cards cosine rrf hybrid-retrieve; do
  cp ~/Projects/pulse-sms/test/unit/phase-0/${f}.test.js ~/Projects/pulse-rag-hybrid/test/unit/retrieval/${f}.test.js
done
```

- [ ] **A.2.5: Fix test require paths**

The tests use `require('../../../scripts/phase-0/X.js')` but in the clone the modules live at `../../../src/retrieval/X.js`. Replace in each test:

```bash
cd ~/Projects/pulse-rag-hybrid
for f in bm25 event-cards cosine rrf hybrid-retrieve; do
  sed -i.bak "s|scripts/phase-0|src/retrieval|g" test/unit/retrieval/${f}.test.js
done
rm test/unit/retrieval/*.bak
grep -l "scripts/phase-0" test/unit/retrieval/ 2>/dev/null
```
The last `grep -l` should produce no output (all references updated).

- [ ] **A.2.6: Run retrieval tests in the clone**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/ 2>&1 | tail -10
```
Expected: 25 tests pass (5 per module × 5 modules; some have 6 from BM25).

- [ ] **A.2.7: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/retrieval/ test/unit/retrieval/
git commit -m "$(cat <<'EOF'
phase-A: import phase-0 retrieval primitives into src/retrieval/

Copies bm25.js, event-cards.js, cosine.js, rrf.js, hybrid-retrieve.js,
embed-query.js plus their unit tests from pulse-sms/scripts/phase-0/.
No behavioral changes; only path adjustments.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.3: TDD the dedup pass

**Files:**
- Create: `src/retrieval/dedup.js`
- Test: `test/unit/retrieval/dedup.test.js`

This is the mandatory post-retrieval dedup elevated to P0 per Phase 0 findings (corpus has exact duplicates that pollute top-K).

- [ ] **A.3.1: Write failing test**

Create `test/unit/retrieval/dedup.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { dedupEvents } = require('../../../src/retrieval/dedup.js');

test('dedupEvents: removes exact name+venue duplicates, keeps first', () => {
  const events = [
    { id: 'a', name: 'Trivia Night at Bell', venue_name: 'Northern Bell' },
    { id: 'b', name: 'Trivia Night at Bell', venue_name: 'Northern Bell' },
    { id: 'c', name: 'Different Event', venue_name: 'Northern Bell' },
  ];
  const out = dedupEvents(events);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'a');
  assert.strictEqual(out[1].id, 'c');
});

test('dedupEvents: case-insensitive on name and venue', () => {
  const events = [
    { id: 'a', name: 'Comedy Show', venue_name: 'The Club' },
    { id: 'b', name: 'COMEDY SHOW', venue_name: 'the club' },
  ];
  const out = dedupEvents(events);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'a');
});

test('dedupEvents: trims whitespace before comparing', () => {
  const events = [
    { id: 'a', name: 'Show ', venue_name: ' Venue' },
    { id: 'b', name: 'show', venue_name: 'venue' },
  ];
  const out = dedupEvents(events);
  assert.strictEqual(out.length, 1);
});

test('dedupEvents: missing name or venue → keep separately', () => {
  const events = [
    { id: 'a', name: 'Event', venue_name: null },
    { id: 'b', name: 'Event', venue_name: undefined },
    { id: 'c', name: 'Event', venue_name: 'Place' },
  ];
  const out = dedupEvents(events);
  // a and b both have null/undefined venue — they dedupe against each other
  // (both produce the same dedup key "event|"). c is distinct.
  assert.strictEqual(out.length, 2);
});

test('dedupEvents: empty input → empty output', () => {
  assert.deepStrictEqual(dedupEvents([]), []);
});

test('dedupEvents: preserves order', () => {
  const events = [
    { id: '1', name: 'A', venue_name: 'X' },
    { id: '2', name: 'B', venue_name: 'X' },
    { id: '3', name: 'A', venue_name: 'X' },  // dupe of #1
    { id: '4', name: 'C', venue_name: 'X' },
  ];
  const out = dedupEvents(events);
  assert.deepStrictEqual(out.map(e => e.id), ['1', '2', '4']);
});
```

- [ ] **A.3.2: Run, verify failure**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/dedup.test.js 2>&1 | tail -5
```
Expected: failure (module missing).

- [ ] **A.3.3: Implement**

Create `src/retrieval/dedup.js`:

```javascript
/**
 * Dedup events by lower(name)+lower(venue_name), trimming whitespace.
 * Keeps the first occurrence; preserves overall order.
 *
 * Mandatory at every retrieval layer — the events cache has exact-duplicate
 * rows from some sources (e.g., donyc lists the same event multiple times),
 * and the BM25/vector indexes inherit this. Without dedup, top-K can be the
 * same event repeated.
 */

function dedupKey(event) {
  const name = (event.name || '').trim().toLowerCase();
  const venue = (event.venue_name || '').trim().toLowerCase();
  return `${name}|${venue}`;
}

function dedupEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = dedupKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

module.exports = { dedupEvents, dedupKey };
```

- [ ] **A.3.4: Run tests, verify pass**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/dedup.test.js 2>&1 | tail -10
```
Expected: 6/6 pass.

- [ ] **A.3.5: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/retrieval/dedup.js test/unit/retrieval/dedup.test.js
git commit -m "$(cat <<'EOF'
phase-A: dedup-by-name+venue pass (P0 per Phase 0 findings)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.4: Composer module — the single-LLM-call SMS writer

**Files:**
- Create: `src/retrieval/compose.js`
- Test: `test/unit/retrieval/compose.test.js`

The composer takes (user message, retrieved events) and returns SMS text. Same prompt across L1 and L2.

- [ ] **A.4.1: Write failing test (just prompt-shape, not LLM behavior)**

Create `test/unit/retrieval/compose.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { buildComposePrompt, RAG_SYSTEM_PROMPT } = require('../../../src/retrieval/compose.js');

test('buildComposePrompt: includes user message verbatim', () => {
  const { systemPrompt, userPrompt } = buildComposePrompt('cozy date night in bk', []);
  assert.ok(userPrompt.includes('cozy date night in bk'));
});

test('buildComposePrompt: serializes events as JSON', () => {
  const events = [
    { name: 'Trivia Night', venue_name: 'Bell', neighborhood: 'Williamsburg',
      category: 'trivia', is_free: true, short_detail: 'pub trivia' },
  ];
  const { userPrompt } = buildComposePrompt('trivia', events);
  assert.ok(userPrompt.includes('"name": "Trivia Night"'));
  assert.ok(userPrompt.includes('"venue": "Bell"'));
  assert.ok(userPrompt.includes('"neighborhood": "Williamsburg"'));
});

test('buildComposePrompt: empty events list includes empty array', () => {
  const { userPrompt } = buildComposePrompt('whatever', []);
  assert.ok(userPrompt.includes('[]'));
});

test('RAG_SYSTEM_PROMPT: contains Pulse identity and SMS length rule', () => {
  assert.ok(RAG_SYSTEM_PROMPT.includes('Pulse'));
  assert.ok(/480/.test(RAG_SYSTEM_PROMPT));
});

test('buildComposePrompt: caps events serialized to top 8', () => {
  const events = Array.from({ length: 20 }, (_, i) => ({
    name: `Event ${i}`, venue_name: `Venue ${i}`,
  }));
  const { userPrompt } = buildComposePrompt('test', events);
  assert.ok(userPrompt.includes('Event 0'));
  assert.ok(userPrompt.includes('Event 7'));
  assert.ok(!userPrompt.includes('Event 10'));
});
```

- [ ] **A.4.2: Run, verify failure**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/compose.test.js 2>&1 | tail -5
```

- [ ] **A.4.3: Implement**

Create `src/retrieval/compose.js`:

```javascript
/**
 * compose.js — the single LLM call that turns retrieved events into an SMS.
 *
 * The system prompt is identical across L1 and L2 retrieval layers. The
 * only thing that changes between layers is which events get passed in.
 * This keeps the retrieval-quality comparison clean.
 */

const RAG_SYSTEM_PROMPT = `You are Pulse, an SMS-based assistant that recommends NYC nightlife and events.

You will be given a user's text message and a list of available events. Pick 1-3 events that best match what the user is asking for and write a single SMS response under 480 characters.

Rules:
- Lead with the picks, not an introduction.
- Format each pick: name -- venue (neighborhood), time, price.
- Plain text only. No markdown, no asterisks, no bullet symbols.
- If no events match, say so briefly in one sentence.
- Do not ask follow-up questions. Do not reference any prior conversation.
- Do not invent events that aren't in the list.`;

const MAX_EVENTS_IN_PROMPT = 8;

function serializeEvent(e) {
  return {
    name: (e.name || '').slice(0, 80),
    venue: e.venue_name || null,
    neighborhood: e.neighborhood || null,
    time: e.start_time_local || null,
    category: e.category || null,
    is_free: !!e.is_free,
    price: e.price_display || null,
    short_detail: (e.short_detail || e.description_short || '').slice(0, 100),
  };
}

function buildComposePrompt(userMessage, events) {
  const top = (events || []).slice(0, MAX_EVENTS_IN_PROMPT).map(serializeEvent);
  const userPrompt =
    `User text: "${userMessage}"\n\n` +
    `Available events:\n${JSON.stringify(top, null, 2)}\n\n` +
    `Write an SMS response under 480 characters.`;
  return { systemPrompt: RAG_SYSTEM_PROMPT, userPrompt };
}

module.exports = { buildComposePrompt, RAG_SYSTEM_PROMPT, MAX_EVENTS_IN_PROMPT };
```

- [ ] **A.4.4: Run tests, verify pass**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/compose.test.js 2>&1 | tail -10
```
Expected: 5/5 pass.

- [ ] **A.4.5: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/retrieval/compose.js test/unit/retrieval/compose.test.js
git commit -m "$(cat <<'EOF'
phase-A: compose module — single-LLM-call SMS prompt builder

Prompt template is identical across L1 and L2 layers; retrieval is the
only changing variable in the comparison.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.5: L1 retrieve entry point

**Files:**
- Create: `src/retrieval/retrieve-l1.js`
- Test: `test/unit/retrieval/retrieve-l1.test.js`

This is the public-facing function the rewritten agent-loop will call.

- [ ] **A.5.1: Write failing test**

Create `test/unit/retrieval/retrieve-l1.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { retrieveL1 } = require('../../../src/retrieval/retrieve-l1.js');

const EVENTS = [
  { id: '1', name: 'Trivia Night', venue_name: 'Bell',
    neighborhood: 'Williamsburg', category: 'trivia',
    is_free: true, short_detail: 'pub trivia' },
  { id: '2', name: 'Trivia Night', venue_name: 'Bell',  // dupe of 1
    neighborhood: 'Williamsburg', category: 'trivia',
    is_free: true, short_detail: 'pub trivia' },
  { id: '3', name: 'Comedy Show', venue_name: 'Club',
    neighborhood: 'LES', category: 'comedy',
    is_free: false, short_detail: 'standup' },
  { id: '4', name: 'Jazz Night', venue_name: 'Cellar',
    neighborhood: 'West Village', category: 'live_music',
    is_free: false, short_detail: 'quartet' },
];

test('retrieveL1: returns top-K events sorted by BM25 score', () => {
  const out = retrieveL1('trivia williamsburg', EVENTS, { k: 3 });
  assert.ok(out.length > 0);
  assert.strictEqual(out[0].id, '1');  // trivia + williamsburg both match
});

test('retrieveL1: dedupes by name+venue before returning', () => {
  const out = retrieveL1('trivia', EVENTS, { k: 5 });
  // event 1 and 2 are name+venue duplicates; only one should appear
  const ids = out.map(e => e.id);
  assert.ok(ids.includes('1') || ids.includes('2'));
  assert.ok(!(ids.includes('1') && ids.includes('2')));
});

test('retrieveL1: respects k limit', () => {
  const out = retrieveL1('jazz', EVENTS, { k: 1 });
  assert.strictEqual(out.length, 1);
});

test('retrieveL1: returns [] for query with no matches', () => {
  const out = retrieveL1('xyzzy plugh', EVENTS, { k: 5 });
  assert.strictEqual(out.length, 0);
});

test('retrieveL1: empty events → empty output', () => {
  const out = retrieveL1('trivia', [], { k: 5 });
  assert.strictEqual(out.length, 0);
});
```

- [ ] **A.5.2: Run, verify failure**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/retrieve-l1.test.js 2>&1 | tail -5
```

- [ ] **A.5.3: Implement**

Create `src/retrieval/retrieve-l1.js`:

```javascript
/**
 * retrieve-l1.js — BM25-only retrieval entry point.
 *
 * Pipeline:
 *   events → build cards → BM25 index → score by query →
 *   sort desc → dedup by name+venue → top-K
 */

const { buildBm25 } = require('./bm25');
const { buildCard } = require('./event-cards');
const { dedupEvents } = require('./dedup');

const DEFAULT_K = 8;

function retrieveL1(queryText, events, { k = DEFAULT_K } = {}) {
  if (!events || events.length === 0) return [];
  const cards = events.map(buildCard);
  const bm25 = buildBm25(cards);
  const qTokens = bm25.tokenize(queryText);

  if (qTokens.length === 0) return [];

  const scored = events
    .map((e, i) => ({ event: e, score: bm25.score(qTokens, i) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedup BEFORE truncating to K, otherwise duplicates eat top slots
  const deduped = dedupEvents(scored.map(r => r.event));
  return deduped.slice(0, k);
}

module.exports = { retrieveL1, DEFAULT_K };
```

- [ ] **A.5.4: Run tests, verify pass**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/retrieve-l1.test.js 2>&1 | tail -10
```
Expected: 5/5 pass.

- [ ] **A.5.5: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/retrieval/retrieve-l1.js test/unit/retrieval/retrieve-l1.test.js
git commit -m "$(cat <<'EOF'
phase-A L1: retrieve-l1 entry — BM25 + dedup, top-K

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.6: Rewrite the agent loop to a linear L1 flow

**Files:**
- Modify: `src/agent-loop.js`
- Modify: `src/handler.js`

Replaces the agent's tool-routing LLM call with `retrieveL1 → compose → SMS`. Keeps the same `handleAgentRequest` signature so handler doesn't need other changes.

- [ ] **A.6.1: Read the current `src/agent-loop.js` to know what you're replacing**

```bash
cd ~/Projects/pulse-rag-hybrid
wc -l src/agent-loop.js
```
Expected: ~1000 lines (it's the full agent-loop from pulse-sms). You're going to keep all helper functions but replace ONLY the body of `handleAgentRequest`.

- [ ] **A.6.2: Locate the function signature**

The function in pulse-sms `src/agent-loop.js` is declared as:
```javascript
async function handleAgentRequest(phone, message, session, trace, finalizeTrace) {
```
Followed by a multi-hundred-line body. The function ends with `return trace.id;` followed by `}` (end of function).

- [ ] **A.6.3: Replace the function body with the linear L1 flow**

The new body is straightforward. Open the file and find the `handleAgentRequest` function. Replace its body (everything between the opening `{` and the closing `}` of the function) with this:

```javascript
async function handleAgentRequest(phone, message, session, trace, finalizeTrace) {
  const masked = maskPhone(phone);

  // Always write user message to history (write preserved; never read back)
  if (!getSession(phone)) setSession(phone, {});
  addToHistory(phone, 'user', message);

  trace.routing.pre_routed = false;
  trace.routing.latency_ms = 0;
  trace.brain_provider = null;
  trace.brain_tool_calls = [];
  trace.brain_iterations = [];

  let smsSent = false;
  try {
    // L1 retrieval — deterministic, no LLM
    const { retrieveL1 } = require('./retrieval/retrieve-l1');
    const { buildComposePrompt } = require('./retrieval/compose');
    const { getEvents } = require('./events');
    const { filterUpcomingEvents } = require('./geo');

    // Date pre-filter: keep events from today; drop events that already
    // started 2+ hours ago. Same as agent-Pulse's behavior.
    const allEvents = await getEvents();
    const upcoming = filterUpcomingEvents(allEvents);

    const events = retrieveL1(message, upcoming, { k: 8 });

    // Compose
    const { systemPrompt, userPrompt } = buildComposePrompt(message, events);
    const composeStart = Date.now();
    const composeResult = await generate(
      MODELS.brain,
      systemPrompt,
      userPrompt,
      { maxTokens: 512, temperature: 0.5, timeout: 12000 }
    );
    trace.brain_latency_ms = Date.now() - composeStart;
    trace.brain_provider = composeResult.provider || null;
    recordAICost(trace, 'brain', composeResult.usage, composeResult.provider);
    trackAICost(phone, composeResult.usage, composeResult.provider);

    let smsText = (composeResult.text || '').trim();
    smsText = smsText || "I couldn't find anything matching that. Try a NYC neighborhood like Williamsburg or Bushwick.";
    smsText = await rewriteIfTooLong(smsText, trace);
    smsText = stripMarkdown(smsText);
    smsText = smartTruncate(smsText);

    await sendSMS(phone, smsText);
    smsSent = true;
    finalizeTrace(smsText, 'rag-l1');
  } catch (err) {
    if (smsSent) {
      console.error('Post-send error (SMS already delivered):', err.message);
      trace.brain_error = `post_send: ${err.message}`;
      return trace.id;
    }
    console.error('RAG-L1 flow error:', err.message);
    trace.brain_error = err.message;
    const sms = "Pulse hit a snag -- try again in a sec!";
    try { await sendSMS(phone, sms); } catch (e) { console.error('SMS send failed too:', e.message); }
    finalizeTrace(sms, 'error');
    sendRuntimeAlert('rag_l1_flow_error', {
      error: err.message,
      phone_masked: masked,
      message: message.slice(0, 80),
    });
  }

  return trace.id;
}
```

**Important:** the file already imports `generate`, `MODELS`, `maskPhone`, `getSession`, `setSession`, `addToHistory`, `recordAICost`, `trackAICost`, `sendSMS`, `smartTruncate`, `rewriteIfTooLong`, `stripMarkdown`, `sendRuntimeAlert` at the top. You should NOT need to add imports. Verify the top of the file already has those.

Keep all other functions in `agent-loop.js` (`executeTool`, `extractPicksFromSms`, `saveSessionFromToolCalls`, `deriveIntent`, etc.) — they're now dead code but deleting them risks breaking tests in pulse-sms (and we just cloned from there). Per the spec: "leave dead code rather than risk breakage."

- [ ] **A.6.4: Strip session reads in handler.js**

In `~/Projects/pulse-rag-hybrid/src/handler.js`, find the function `handleMessageAI`. It starts with:

```javascript
async function handleMessageAI(phone, message) {
  const traceStart = Date.now();
  const masked = maskPhone(phone);
  let session = getSession(phone);
  const trace = startTrace(masked, message);

  if (session) {
    trace.session_before = {
      lastNeighborhood: session.lastNeighborhood || null,
      lastPicks: (session.lastPicks || []).map(p => ({ event_id: p.event_id })),
    };

  }
```

Replace the body of that block with:

```javascript
async function handleMessageAI(phone, message) {
  const traceStart = Date.now();
  const masked = maskPhone(phone);
  // RAG mode: do NOT read prior session state. Treat each SMS as fresh.
  // (Session writes still happen downstream; we just don't read them back.)
  let session = null;
  const trace = startTrace(masked, message);
```

Leave the rest of `handleMessageAI` untouched (the `checkMechanical`, `isCacheFresh()` guard, and final `handleAgentRequest` call).

- [ ] **A.6.5: Run smoke tests in the clone**

```bash
cd ~/Projects/pulse-rag-hybrid
npm test 2>&1 | tail -5
```
Expected: all tests pass (or fail in ways unrelated to our changes — e.g., LLM-dependent integration tests that need API keys will fail and that's pre-existing).

If a test fails due to our changes, STOP and report BLOCKED with the failing test name.

- [ ] **A.6.6: Manual sanity check (start the server briefly)**

```bash
cd ~/Projects/pulse-rag-hybrid
# Refresh the events cache timestamp first
node -e "const fs=require('fs');const p='data/events-cache.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.timestamp=Date.now();fs.writeFileSync(p,JSON.stringify(j));console.log('refreshed')"

# Start in background
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001 \
  npm start > /tmp/pulse-hybrid-l1.log 2>&1 &
echo $! > /tmp/pulse-hybrid-l1.pid
```

Wait for ready:
```bash
until grep -q "Pulse listening on port 3002" /tmp/pulse-hybrid-l1.log 2>/dev/null \
   && grep -q "Persisted cache is fresh" /tmp/pulse-hybrid-l1.log 2>/dev/null; do
  sleep 1
done
echo "hybrid-L1 ready"
```

Smoke test:
```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"Body":"jazz tonight","From":"+15550009998"}' \
  http://localhost:3002/api/sms/test \
  | python3 -c "import sys, json; d=json.load(sys.stdin); print('msg count:', len(d.get('messages',[]))); print('intent:', d.get('trace_summary',{}).get('intent')); print('body:', (d.get('messages',[{}])[0] or {}).get('body','?')[:200])"
```
Expected: `intent: rag-l1`, body contains at least one event name. If it errors, STOP and report.

Kill the server:
```bash
kill $(cat /tmp/pulse-hybrid-l1.pid) && rm /tmp/pulse-hybrid-l1.pid
```

- [ ] **A.6.7: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/agent-loop.js src/handler.js
git commit -m "$(cat <<'EOF'
phase-A L1: rewrite handleAgentRequest body to linear retrieve→compose→SMS

handler.js: strip session reads (writes preserved per spec).
agent-loop.js: handleAgentRequest body replaced; helpers left as
dead code per spec ("leave dead code rather than risk breakage").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.7: Comparison harness — agent vs hybrid-L1

**Files:**
- Create: `scripts/comparison-queries.txt` (copy from Phase 0)
- Create: `scripts/compare-hybrid.js`

- [ ] **A.7.1: Copy the queries file**

```bash
cp ~/Projects/pulse-sms/scripts/phase-0/comparison-queries.txt ~/Projects/pulse-rag-hybrid/scripts/comparison-queries.txt
```

- [ ] **A.7.2: Implement the comparison harness**

Create `~/Projects/pulse-rag-hybrid/scripts/compare-hybrid.js`:

```javascript
#!/usr/bin/env node
/**
 * compare-hybrid.js — runs the 25-query suite against both:
 *   - http://localhost:3000  (agent-Pulse, the production agent loop)
 *   - http://localhost:3002  (this clone, hybrid retrieval)
 *
 * Uses rotated phones (one fresh phone per query) by default — the Phase
 * 0.5 methodology fix.
 *
 * Writes the comparison to a path passed via --out, defaulting to
 * docs/superpowers/plans/phase-A-output-atlas.md.
 *
 * Usage:
 *   node scripts/compare-hybrid.js --out docs/superpowers/plans/phase-A-L1-output-atlas.md
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(args[outArg + 1]) : path.resolve('docs/superpowers/plans/phase-A-output-atlas.md');
const QUERIES = path.resolve('scripts/comparison-queries.txt');

const AGENT_URL = 'http://localhost:3000/api/sms/test';
const HYBRID_URL = 'http://localhost:3002/api/sms/test';
const PAUSE_MS = 4000;
const TIMEOUT_MS = 30000;

function readQueries(text) {
  const out = [];
  let bucket = '?';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/BUCKET (\w)/);
      if (m) bucket = m[1];
      continue;
    }
    out.push({ bucket, query: line });
  }
  return out;
}

async function post(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const json = await res.json().catch(() => ({ error: 'non-JSON', status: res.status }));
    if (!res.ok) return { error: json.error || `HTTP ${res.status}`, messages: json.messages || [] };
    return json;
  } catch (err) { return { error: err.message }; }
  finally { clearTimeout(timer); }
}

function fmt(r) {
  if (r.error) return `_(error: ${r.error})_`;
  const bodies = (r.messages || []).map(m => m.body || JSON.stringify(m));
  if (bodies.length === 0) return '_(no SMS captured)_';
  return bodies.map(b => `> ${b.replace(/\n/g, '\n> ')}`).join('\n>\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const queries = readQueries(fs.readFileSync(QUERIES, 'utf8'));
  console.log(`Loaded ${queries.length} queries from ${QUERIES}`);

  let md = `# Phase A — Hybrid Retrieval vs Agent Comparison\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Agent URL: ${AGENT_URL}\n`;
  md += `Hybrid URL: ${HYBRID_URL}\n`;
  md += `Phones: rotated per query (+15550003XXXX)\n\n---\n\n`;

  for (let i = 0; i < queries.length; i++) {
    const { query, bucket } = queries[i];
    const phone = `+1555000${String(3000 + i).padStart(4, '0')}`;
    console.log(`\n[${i + 1}/${queries.length}] (${bucket}) "${query}" phone=${phone}`);

    const [agentRes, hybridRes] = await Promise.all([
      post(AGENT_URL, { Body: query, From: phone }),
      post(HYBRID_URL, { Body: query, From: phone }),
    ]);
    console.log(`  agent: ${(agentRes.messages || []).length} msg, intent=${agentRes.trace_summary?.intent || '?'}`);
    console.log(`  hybrid: ${(hybridRes.messages || []).length} msg, intent=${hybridRes.trace_summary?.intent || '?'}`);

    md += `## ${bucket}-${i + 1}: "${query}"\n\n`;
    md += `**Agent (port 3000):**\n${fmt(agentRes)}\n\n`;
    md += `**Hybrid (port 3002):**\n${fmt(hybridRes)}\n\n`;
    md += `| Agent right? | Hybrid right? | Notes |\n|---|---|---|\n| _(annotate)_ | _(annotate)_ | _(annotate)_ |\n\n---\n\n`;

    if (i < queries.length - 1) await sleep(PAUSE_MS);
  }

  fs.writeFileSync(OUT, md);
  console.log(`\nWrote ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **A.7.3: Commit the harness (we'll run it in A.8)**

```bash
cd ~/Projects/pulse-rag-hybrid
git add scripts/comparison-queries.txt scripts/compare-hybrid.js
git commit -m "$(cat <<'EOF'
phase-A: comparison harness — 25-query suite vs agent (3000) and hybrid (3002)

Uses rotated phones (one per query) — the Phase 0.5 methodology fix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.8: Run L1 comparison and write annotated atlas + summary

**Files:**
- Create: `docs/superpowers/plans/phase-A-L1-output-atlas.md`
- Create: `docs/superpowers/plans/phase-A-L1-output-summary.md`

- [ ] **A.8.1: Start agent-Pulse on port 3000 (in pulse-sms)**

```bash
cd ~/Projects/pulse-sms
node -e "const fs=require('fs');const p='data/events-cache.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.timestamp=Date.now();fs.writeFileSync(p,JSON.stringify(j));console.log('refreshed')"

PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_MODEL_BRAIN=claude-sonnet-4-6-20250514 \
  npm start > /tmp/pulse-sms.log 2>&1 &
echo $! > /tmp/pulse-sms.pid

until grep -q "Pulse listening on port 3000" /tmp/pulse-sms.log 2>/dev/null \
   && grep -q "Persisted cache is fresh" /tmp/pulse-sms.log 2>/dev/null; do sleep 1; done
echo "agent ready on 3000"
```

Note: `PULSE_MODEL_BRAIN=claude-sonnet-4-6-20250514` matches the current production CLAUDE.md default. If sonnet model name has changed by the time you run this, check `pulse-sms/src/model-config.js` for the actual current default.

- [ ] **A.8.2: Start hybrid-L1 on port 3002 (in pulse-rag-hybrid)**

```bash
cd ~/Projects/pulse-rag-hybrid
node -e "const fs=require('fs');const p='data/events-cache.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.timestamp=Date.now();fs.writeFileSync(p,JSON.stringify(j));console.log('refreshed')"

PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001 \
  npm start > /tmp/pulse-hybrid-l1.log 2>&1 &
echo $! > /tmp/pulse-hybrid-l1.pid

until grep -q "Pulse listening on port 3002" /tmp/pulse-hybrid-l1.log 2>/dev/null \
   && grep -q "Persisted cache is fresh" /tmp/pulse-hybrid-l1.log 2>/dev/null; do sleep 1; done
echo "hybrid-L1 ready on 3002"
```

Note: hybrid uses Haiku (smaller/cheaper) since composition is a 1-shot task and Haiku handles it fine. Document this in the summary.

- [ ] **A.8.3: Run the comparison**

```bash
cd ~/Projects/pulse-rag-hybrid
node scripts/compare-hybrid.js --out docs/superpowers/plans/phase-A-L1-output-atlas.md 2>&1 | tail -30
```
Expected: 25 queries processed, atlas written. ~3 minutes runtime.

- [ ] **A.8.4: Verify the atlas has 25 entries**

```bash
grep -c '^## ' ~/Projects/pulse-rag-hybrid/docs/superpowers/plans/phase-A-L1-output-atlas.md
```
Expected: `25`

- [ ] **A.8.5: Stop both servers**

```bash
kill $(cat /tmp/pulse-sms.pid) && rm /tmp/pulse-sms.pid
kill $(cat /tmp/pulse-hybrid-l1.pid) && rm /tmp/pulse-hybrid-l1.pid
sleep 1
lsof -ti :3000 -ti :3002 2>/dev/null && echo "still up" || echo "ports clear"
```

- [ ] **A.8.6: Hand-annotate the atlas**

Open `~/Projects/pulse-rag-hybrid/docs/superpowers/plans/phase-A-L1-output-atlas.md` and fill in each row's three annotation columns. Use the failure-mode labels from the Phase 0 plan (Task 13.2 in `2026-05-27-phase-0-empirical-anchor.md`).

If you prefer to script the annotation as we did for Phase 0/0.5, write a small `/tmp/annotate-L1.js` mirroring `/tmp/annotate-atlas.js` style.

- [ ] **A.8.7: Write the L1 decision summary**

Create `~/Projects/pulse-rag-hybrid/docs/superpowers/plans/phase-A-L1-output-summary.md` covering:

1. **Bucket-level results table** (same shape as Phase 0/0.5 summaries — agent right / hybrid right per bucket).
2. **Comparison to Phase 0.5** (where hybrid was *hypothetical* — now hybrid is *running*). Does the actual run match what Phase 0.5 predicted?
3. **L1's specific blind spots** (vibe queries, synonyms, geographic implications) — these are what L2 should fix. Score how many B-bucket queries fall here.
4. **Decision:** does L1 demonstrably underperform agent on Bucket B? If yes, proceed to L2. If no (surprising), pause and investigate.

- [ ] **A.8.8: Commit the L1 atlas + summary**

```bash
cd ~/Projects/pulse-rag-hybrid
git add docs/superpowers/plans/phase-A-L1-output-atlas.md docs/superpowers/plans/phase-A-L1-output-summary.md
git commit -m "$(cat <<'EOF'
phase-A L1: comparison atlas + decision summary

L1 = BM25-only retrieval + single LLM compose, no agent loop.
Compared to production agent-Pulse on Sonnet 4.6 via the 25-query
rotated-phone suite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Sub-phase L2 — Add dense vectors + RRF fusion

### Task A.9: Embedding-cache loader module

**Files:**
- Create: `src/retrieval/embeddings-cache.js`
- Test: `test/unit/retrieval/embeddings-cache.test.js`

This module wraps the on-disk `embeddings-cache.json` and exposes a `getVectors()` function for the L2 retriever.

- [ ] **A.9.1: Write failing test**

Create `test/unit/retrieval/embeddings-cache.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEmbeddingsCache } = require('../../../src/retrieval/embeddings-cache.js');

test('loadEmbeddingsCache: returns { ids, vectors, vectorsById }', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-test-'));
  const cachePath = path.join(tmp, 'cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    count: 3,
    dims: 4,
    ids: ['a', 'b', 'c'],
    vectors: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
  }));
  const cache = loadEmbeddingsCache(cachePath);
  assert.deepStrictEqual(cache.ids, ['a', 'b', 'c']);
  assert.strictEqual(cache.vectors.length, 3);
  assert.deepStrictEqual(cache.vectorsById.a, [1, 0, 0, 0]);
});

test('loadEmbeddingsCache: missing file → throws helpful error', () => {
  assert.throws(
    () => loadEmbeddingsCache('/no/such/file.json'),
    /embeddings cache not found/i
  );
});

test('loadEmbeddingsCache: malformed JSON → throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-test-'));
  const cachePath = path.join(tmp, 'cache.json');
  fs.writeFileSync(cachePath, '{not json');
  assert.throws(() => loadEmbeddingsCache(cachePath));
});
```

- [ ] **A.9.2: Run, verify failure**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/embeddings-cache.test.js 2>&1 | tail -5
```

- [ ] **A.9.3: Implement**

Create `src/retrieval/embeddings-cache.js`:

```javascript
/**
 * embeddings-cache.js — loads pre-computed event embeddings from disk.
 *
 * On-disk format (produced by /tmp/explore-clusters.js originally):
 *   { count, timestamp, dims, ids: [...], vectors: [[...], ...] }
 *
 * Lazy load — first call reads from disk; subsequent calls reuse the parsed
 * structure. Re-embedding events is out of scope for L2; if events-cache
 * grows beyond what embeddings-cache covers, those events are simply absent
 * from dense retrieval (they'll still appear in BM25).
 */

const fs = require('fs');
const path = require('path');

let _cache = null;
let _loadedPath = null;

function loadEmbeddingsCache(cachePath) {
  if (_cache && _loadedPath === cachePath) return _cache;
  if (!fs.existsSync(cachePath)) {
    throw new Error(`embeddings cache not found at ${cachePath}`);
  }
  const raw = fs.readFileSync(cachePath, 'utf8');
  const parsed = JSON.parse(raw);
  const vectorsById = {};
  for (let i = 0; i < parsed.ids.length; i++) {
    vectorsById[parsed.ids[i]] = parsed.vectors[i];
  }
  _cache = { ids: parsed.ids, vectors: parsed.vectors, vectorsById,
             count: parsed.count, dims: parsed.dims };
  _loadedPath = cachePath;
  return _cache;
}

function defaultCachePath() {
  return path.resolve(__dirname, '../../data/embeddings-cache.json');
}

module.exports = { loadEmbeddingsCache, defaultCachePath };
```

- [ ] **A.9.4: Run tests, verify pass**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/embeddings-cache.test.js 2>&1 | tail -10
```
Expected: 3/3 pass.

- [ ] **A.9.5: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/retrieval/embeddings-cache.js test/unit/retrieval/embeddings-cache.test.js
git commit -m "$(cat <<'EOF'
phase-A L2: embeddings-cache loader (lazy load from data/embeddings-cache.json)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.10: L2 retrieve entry point (hybrid BM25 + dense + dedup)

**Files:**
- Create: `src/retrieval/retrieve-l2.js`
- Test: `test/unit/retrieval/retrieve-l2.test.js`

- [ ] **A.10.1: Write failing test**

Create `test/unit/retrieval/retrieve-l2.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { retrieveL2 } = require('../../../src/retrieval/retrieve-l2.js');

const EVENTS = [
  { id: '1', name: 'Trivia Night', venue_name: 'Bell',
    neighborhood: 'Williamsburg', category: 'trivia',
    is_free: true, short_detail: 'pub trivia' },
  { id: '2', name: 'Trivia Night', venue_name: 'Bell',  // dupe of 1
    neighborhood: 'Williamsburg', category: 'trivia',
    is_free: true, short_detail: 'pub trivia' },
  { id: '3', name: 'Comedy Show', venue_name: 'Club',
    neighborhood: 'LES', category: 'comedy',
    is_free: false, short_detail: 'standup' },
  { id: '4', name: 'Jazz Night', venue_name: 'Cellar',
    neighborhood: 'West Village', category: 'live_music',
    is_free: false, short_detail: 'quartet' },
];

const QUERY_VEC = [0, 0, 0, 1];   // misleading
const VECTORS = {
  '1': [0.1, 0.1, 0.1, 0.9],
  '2': [0.1, 0.1, 0.1, 0.9],
  '3': [0.1, 0.9, 0.1, 0.1],
  '4': [0.9, 0.1, 0.1, 0.1],
};

test('retrieveL2: returns top-K with dedup applied', () => {
  const out = retrieveL2({
    queryText: 'trivia',
    queryVector: QUERY_VEC,
    events: EVENTS,
    vectors: VECTORS,
    k: 5,
    rrfK: 60,
  });
  // events 1 and 2 are dupes — at most one should appear
  const ids = out.map(e => e.id);
  assert.ok(!(ids.includes('1') && ids.includes('2')));
});

test('retrieveL2: respects K limit', () => {
  const out = retrieveL2({
    queryText: 'event',
    queryVector: QUERY_VEC,
    events: EVENTS,
    vectors: VECTORS,
    k: 2,
    rrfK: 60,
  });
  assert.ok(out.length <= 2);
});

test('retrieveL2: combines BM25 + vector signals (event 1 wins for "trivia")', () => {
  const out = retrieveL2({
    queryText: 'trivia',
    queryVector: QUERY_VEC,
    events: EVENTS,
    vectors: VECTORS,
    k: 4,
    rrfK: 60,
  });
  assert.strictEqual(out[0].id, '1');
});

test('retrieveL2: empty events → empty output', () => {
  const out = retrieveL2({
    queryText: 'anything',
    queryVector: QUERY_VEC,
    events: [],
    vectors: {},
    k: 5,
    rrfK: 60,
  });
  assert.strictEqual(out.length, 0);
});
```

- [ ] **A.10.2: Run, verify failure**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/retrieve-l2.test.js 2>&1 | tail -5
```

- [ ] **A.10.3: Implement**

Create `src/retrieval/retrieve-l2.js`:

```javascript
/**
 * retrieve-l2.js — hybrid retrieval entry point (BM25 + dense via RRF).
 *
 * Pipeline:
 *   events → build cards → BM25 index → rank by query (lexical)
 *           → cosine sim against query vector (semantic)
 *   → RRF-fuse the two rankings → dedup by name+venue → top-K
 *
 * Note: events present in `events` but missing from `vectors` still get
 * BM25 ranking; they're just absent from the dense side. This degrades
 * gracefully if the embeddings cache is stale relative to events cache.
 */

const { buildIndex, hybridRetrieve } = require('./hybrid-retrieve');
const { dedupEvents } = require('./dedup');

const DEFAULT_K = 8;
const DEFAULT_RRF_K = 60;
const CANDIDATE_POOL = 50;

function retrieveL2({ queryText, queryVector, events, vectors,
                     k = DEFAULT_K, rrfK = DEFAULT_RRF_K } = {}) {
  if (!events || events.length === 0) return [];
  if (!queryVector || queryVector.length === 0) return [];

  const idx = buildIndex(events);
  // hybridRetrieve returns [{ id, rrfScore, bm25Rank, vecRank }] — we need
  // the events themselves, in fused order.
  const fused = hybridRetrieve({
    queryText, queryVector, index: idx, vectors,
    topK: CANDIDATE_POOL, rrfK,
  });

  const eventsById = Object.fromEntries(events.map(e => [e.id, e]));
  const ordered = fused.map(r => eventsById[r.id]).filter(Boolean);
  const deduped = dedupEvents(ordered);
  return deduped.slice(0, k);
}

module.exports = { retrieveL2, DEFAULT_K, DEFAULT_RRF_K };
```

- [ ] **A.10.4: Run tests, verify pass**

```bash
cd ~/Projects/pulse-rag-hybrid
node --test test/unit/retrieval/retrieve-l2.test.js 2>&1 | tail -10
```
Expected: 4/4 pass.

- [ ] **A.10.5: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/retrieval/retrieve-l2.js test/unit/retrieval/retrieve-l2.test.js
git commit -m "$(cat <<'EOF'
phase-A L2: retrieve-l2 entry — BM25 + dense via RRF + dedup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.11: Wire L2 into the linear handler

**Files:**
- Modify: `src/agent-loop.js`

Replaces L1's `retrieveL1` call with L2's `retrieveL2`. Also embeds the query at handler-call time.

- [ ] **A.11.1: Replace the L1-specific block inside `handleAgentRequest`**

Open `~/Projects/pulse-rag-hybrid/src/agent-loop.js`. Find this block (inside `handleAgentRequest`, currently L1's body):

```javascript
    const { retrieveL1 } = require('./retrieval/retrieve-l1');
    const { buildComposePrompt } = require('./retrieval/compose');
    const { getEvents } = require('./events');
    const { filterUpcomingEvents } = require('./geo');

    const allEvents = await getEvents();
    const upcoming = filterUpcomingEvents(allEvents);

    const events = retrieveL1(message, upcoming, { k: 8 });
```

Replace with:

```javascript
    const { retrieveL2 } = require('./retrieval/retrieve-l2');
    const { embedQuery } = require('./retrieval/embed-query');
    const { loadEmbeddingsCache, defaultCachePath } = require('./retrieval/embeddings-cache');
    const { buildComposePrompt } = require('./retrieval/compose');
    const { getEvents } = require('./events');
    const { filterUpcomingEvents } = require('./geo');

    const allEvents = await getEvents();
    const upcoming = filterUpcomingEvents(allEvents);

    // Embed the query (1 Gemini API call, ~50ms)
    const queryVector = await embedQuery(message);

    // Lazy-load the embeddings cache
    const { vectorsById } = loadEmbeddingsCache(defaultCachePath());

    const events = retrieveL2({
      queryText: message,
      queryVector,
      events: upcoming,
      vectors: vectorsById,
      k: 8,
    });
```

Also change the `finalizeTrace(smsText, 'rag-l1')` line to `finalizeTrace(smsText, 'rag-l2')` for trace clarity.

- [ ] **A.11.2: Verify environment has GEMINI_API_KEY available**

The L2 path requires `GEMINI_API_KEY` to be set in the runtime env. The existing `.env` has it. Verify with:

```bash
grep '^GEMINI_API_KEY=' ~/Projects/pulse-rag-hybrid/.env | head -1 | cut -c1-30
```
Expected: a partial key line. If empty, STOP and report — L2 won't work without it.

- [ ] **A.11.3: Smoke-test the L2 handler**

```bash
cd ~/Projects/pulse-rag-hybrid
node -e "const fs=require('fs');const p='data/events-cache.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.timestamp=Date.now();fs.writeFileSync(p,JSON.stringify(j));"

PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001 \
  npm start > /tmp/pulse-hybrid-l2.log 2>&1 &
echo $! > /tmp/pulse-hybrid-l2.pid

until grep -q "Pulse listening on port 3002" /tmp/pulse-hybrid-l2.log 2>/dev/null \
   && grep -q "Persisted cache is fresh" /tmp/pulse-hybrid-l2.log 2>/dev/null; do sleep 1; done

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"Body":"cozy date night in brooklyn","From":"+15550009999"}' \
  http://localhost:3002/api/sms/test \
  | python3 -c "import sys, json; d=json.load(sys.stdin); print('msg count:', len(d.get('messages',[]))); print('intent:', d.get('trace_summary',{}).get('intent')); print('body:', (d.get('messages',[{}])[0] or {}).get('body','?')[:200])"

kill $(cat /tmp/pulse-hybrid-l2.pid) && rm /tmp/pulse-hybrid-l2.pid
```
Expected: `intent: rag-l2`, body contains a Brooklyn-adjacent event (Williamsburg / Greenpoint / Crown Heights are common). If body is empty or errors, STOP and report.

- [ ] **A.11.4: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add src/agent-loop.js
git commit -m "$(cat <<'EOF'
phase-A L2: wire retrieve-l2 into the linear handler

L1 → L2 swap. Same compose step, same prompt, same SMS path.
The only changed variable is which events the retriever selects.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.12: L2 calibration sub-eval — sweep RRF k on Bucket B

**Files:**
- Create: `scripts/calibrate-rrf-k.js`
- Create: `docs/superpowers/plans/phase-A-L2-calibration.md`

The sub-eval sweeps the RRF k parameter on the 8 Bucket B (vibe/semantic) queries and documents the choice.

- [ ] **A.12.1: Implement the sweep script**

Create `~/Projects/pulse-rag-hybrid/scripts/calibrate-rrf-k.js`:

```javascript
#!/usr/bin/env node
/**
 * calibrate-rrf-k.js — sweeps the RRF k parameter on the 8 Bucket B (vibe)
 * queries and prints top-3 results for each k value, so we can eyeball
 * which value surfaces the most reasonable events per query.
 *
 * No agent involvement. Pure offline retrieval comparison.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/calibrate-rrf-k.js
 */

const fs = require('fs');
const path = require('path');
const { retrieveL2 } = require('../src/retrieval/retrieve-l2');
const { embedQuery } = require('../src/retrieval/embed-query');
const { loadEmbeddingsCache, defaultCachePath } = require('../src/retrieval/embeddings-cache');

const BUCKET_B_QUERIES = [
  'something romantic and intimate in BK',
  'cozy date night spot',
  'weird underground vibes tonight',
  'low-key bar that isnt another wine bar',
  'where do creatives hang out in brooklyn',
  'something different tonight',
  'after-work drinks but not basic',
  'actually fun trivia somewhere',
];

const K_VALUES = [10, 30, 60, 100];

(async () => {
  const eventsCache = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../data/events-cache.json'), 'utf8'));
  const events = eventsCache.events;
  const { vectorsById } = loadEmbeddingsCache(defaultCachePath());

  let md = `# Phase A — L2 RRF-k Calibration Sweep\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Bucket B queries: ${BUCKET_B_QUERIES.length}\n`;
  md += `k values swept: ${K_VALUES.join(', ')}\n\n`;
  md += `For each query × k, top 3 events from retrieveL2 (with dedup).\n\n---\n\n`;

  for (const q of BUCKET_B_QUERIES) {
    console.log(`\n"${q}"`);
    const qv = await embedQuery(q);
    md += `## "${q}"\n\n`;

    for (const k of K_VALUES) {
      const out = retrieveL2({
        queryText: q, queryVector: qv,
        events, vectors: vectorsById,
        k: 3, rrfK: k,
      });
      md += `**rrfK=${k}:**\n`;
      out.forEach((e, i) => {
        md += `${i + 1}. ${e.name?.slice(0, 50)} — ${e.venue_name || '?'} (${e.neighborhood || '?'}) [${e.category || '?'}]\n`;
      });
      md += `\n`;
      console.log(`  k=${k}: ${out[0]?.name?.slice(0, 40) || '?'}`);
    }
    md += `\n_(annotate: which k surfaced the most reasonable picks?)_\n\n---\n\n`;
  }

  const OUT = path.resolve(__dirname, '../docs/superpowers/plans/phase-A-L2-calibration.md');
  fs.writeFileSync(OUT, md);
  console.log(`\nWrote ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **A.12.2: Run the sweep**

```bash
cd ~/Projects/pulse-rag-hybrid
GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2- | tr -d '"') \
  node scripts/calibrate-rrf-k.js 2>&1 | tail -30
```
Expected: 8 queries × 4 k values = 32 embed calls (or 8 if we cache, but here we embed once per query). Output file written.

- [ ] **A.12.3: Eyeball the results and pick a k**

Open `~/Projects/pulse-rag-hybrid/docs/superpowers/plans/phase-A-L2-calibration.md`. For each of the 8 queries, check which k value surfaces the most reasonable top-3. If k=60 (the default) wins consistently, document that. If a different k is materially better on most queries, switch.

Add a final section to the calibration doc:

```markdown
## Choice

Selected: rrfK = <chosen value>

Rationale: <one paragraph — e.g., "k=60 was best on 5/8 queries; k=30 won 2; k=100 won 1. The default holds.">

If different from 60, also update `src/retrieval/retrieve-l2.js`'s DEFAULT_RRF_K constant
```

- [ ] **A.12.4: Apply the calibration choice (if k != 60) and commit**

If k changed, edit `src/retrieval/retrieve-l2.js`:
```javascript
const DEFAULT_RRF_K = <chosen value>;
```
Re-run unit tests to confirm nothing breaks.

```bash
cd ~/Projects/pulse-rag-hybrid
git add scripts/calibrate-rrf-k.js docs/superpowers/plans/phase-A-L2-calibration.md src/retrieval/retrieve-l2.js
git commit -m "$(cat <<'EOF'
phase-A L2: calibration sweep on Bucket B (RRF k parameter)

Sweep k ∈ {10, 30, 60, 100} on the 8 vibe queries.
Chosen: rrfK = <CHOSEN VALUE> (see phase-A-L2-calibration.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.13: Run L2 comparison and write annotated atlas

**Files:**
- Create: `docs/superpowers/plans/phase-A-L2-output-atlas.md`

- [ ] **A.13.1: Start both servers**

Same as Task A.8.1 and A.8.2 — agent-Pulse on 3000, hybrid (now L2) on 3002.

- [ ] **A.13.2: Run the comparison**

```bash
cd ~/Projects/pulse-rag-hybrid
node scripts/compare-hybrid.js --out docs/superpowers/plans/phase-A-L2-output-atlas.md 2>&1 | tail -30
```

- [ ] **A.13.3: Verify 25 entries**

```bash
grep -c '^## ' ~/Projects/pulse-rag-hybrid/docs/superpowers/plans/phase-A-L2-output-atlas.md
```

- [ ] **A.13.4: Stop both servers**

```bash
kill $(cat /tmp/pulse-sms.pid) 2>/dev/null && rm /tmp/pulse-sms.pid
kill $(cat /tmp/pulse-hybrid-l2.pid) 2>/dev/null && rm /tmp/pulse-hybrid-l2.pid
```

- [ ] **A.13.5: Hand-annotate the atlas** (same procedure as A.8.6)

- [ ] **A.13.6: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add docs/superpowers/plans/phase-A-L2-output-atlas.md
git commit -m "$(cat <<'EOF'
phase-A L2: comparison atlas — hybrid (BM25 + dense + RRF + dedup) vs agent

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.14: Write the L2 decision summary

**Files:**
- Create: `docs/superpowers/plans/phase-A-L2-output-summary.md`

The Phase A capstone. Documents what L1 + L2 demonstrated, where the hybrid stack earned its keep, where the agent still dominates, and what Phase B's design should focus on.

- [ ] **A.14.1: Write the summary**

Create `~/Projects/pulse-rag-hybrid/docs/superpowers/plans/phase-A-L2-output-summary.md`:

```markdown
# Phase A — Capstone Summary (L1 + L2 hybrid retrieval)

**Date:** <today>
**Atlases:** `phase-A-L1-output-atlas.md`, `phase-A-L2-output-atlas.md`
**Calibration:** `phase-A-L2-calibration.md`

## Bucket-level results

|  | Agent (3000) | Hybrid L1 | Hybrid L2 | L1 → L2 delta |
|---|---|---|---|---|
| A — State/reference | __ / 5 | __ / 5 | __ / 5 | __ |
| B — Vibe/semantic | __ / 8 | __ / 8 | __ / 8 | __ |
| C — Classic retrieve | __ / 7 | __ / 7 | __ / 7 | __ |
| D — Edges | __ / 5 | __ / 5 | __ / 5 | __ |
| **Total** | __ / 25 | __ / 25 | __ / 25 | __ |

(Fill in from the annotated atlases.)

## Where L2 demonstrably beat L1

(List 2-4 specific queries where L2 surfaced events L1 couldn't. Quote the events. This is where the dense-vector layer earned its keep.)

## Where L2 did NOT beat L1

(List the cases where L1 == L2 or L1 > L2. Usually classic retrieve queries where BM25 alone is sufficient. Quote 1-2.)

## Where L2 still lost to the agent

(Bucket A almost certainly remains agent-only territory. Bucket D edges depend on the case. Document which.)

## Phase A's design hypothesis vs reality

The Phase 0/0.5 summaries predicted:
- L1 BM25 handles classic retrieve cleanly (Bucket C)
- L2 hybrid lifts vibe queries (Bucket B) over L1
- Neither L1 nor L2 can touch state/reference (Bucket A)
- Agent's clarify-bias was the dominant Phase 0.5 finding

Did the actual Phase A data confirm or refute each? Be explicit.

## Phase B design implications (final, locked)

Based on the full Phase A data, the D1 taxonomy should encode:

1. **Session-state policy:** when to carry filter state forward across turns (Phase 0 motivation).
2. **Clarify-vs-retrieve policy:** when a strong hybrid top-1 should short-circuit the clarify (Phase 0.5 motivation).
3. **NEW (if Phase A surfaces it):** ___________ (e.g., "when to fall back from hybrid to agent for state/reference queries")

The audit signature for each turn should capture which policy fired and why, so the D2 dashboard can show overrides per policy.

## Decision

- [ ] Proceed to Phase B implementation plan
- [ ] L2 underperformed expectations → debug or amend before Phase B
- [ ] Both layers met expectations → write Phase B plan immediately
- [ ] Something else: __________

Selected: __________

## What's next

The Phase B implementation plan, informed by:
- This summary's Phase B design implications
- The empirical evidence from `phase-A-L1-output-atlas.md` and `phase-A-L2-output-atlas.md`
- The original spec's §3 D1/D2 designs (with the LLM-proposes / taxonomy-authorizes pattern)
```

Fill in the bracketed sections from the annotated atlases.

- [ ] **A.14.2: Commit**

```bash
cd ~/Projects/pulse-rag-hybrid
git add docs/superpowers/plans/phase-A-L2-output-summary.md
git commit -m "$(cat <<'EOF'
phase-A L2: capstone summary — L1 + L2 hybrid retrieval comparison vs agent

Documents L2's lift over L1, where hybrid earned its keep vs where the
agent's tool-routing still dominates. Locks in Phase B's design direction
based on the full Phase A data.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final task: hand-off

- [ ] **A.15: Update the spec's "Open questions" section with Phase A resolutions**

In `~/Projects/pulse-sms/docs/superpowers/specs/2026-05-27-hybrid-pulse-design.md` §8, add resolutions for any questions the Phase A work answered. Commit on `pulse-sms` main.

- [ ] **A.16: Write the Phase B implementation plan**

Invoke `superpowers:writing-plans` again with:
- Spec ref: `docs/superpowers/specs/2026-05-27-hybrid-pulse-design.md` §3 (Phase B)
- Phase 0/0.5/A summaries as input
- Phase A's "Phase B design implications" section as the primary driver

---

## Self-review (controller checks before declaring Phase A done)

After Task A.14:

- [ ] All 14 task commits land on `~/Projects/pulse-rag-hybrid`'s main branch
- [ ] Three docs in `pulse-rag-hybrid/docs/superpowers/plans/`: L1 atlas, L1 summary, L2 calibration, L2 atlas, L2 summary
- [ ] `pulse-rag-hybrid` runs on port 3002 with `npm start` (smoke-test it one last time)
- [ ] `pulse-sms` on port 3000 was not modified during Phase A (it stays the baseline)
- [ ] Phase B plan's writing-plans invocation is triggered

---

## Risks & abort criteria

| Risk | Signal | Response |
|---|---|---|
| L1 outperforms agent on Bucket A | Hybrid L1 wins state/reference queries (shouldn't be possible architecturally) | Suspect a bug in the agent baseline or the comparison harness. Investigate before continuing. |
| L2 doesn't improve over L1 | Bucket B scores ≤ L1's; calibration sweep shows no clear winner | Drop L2 from scope, ship L1 only. Update §3 of the spec. Phase B can still proceed. |
| Embedding cache stale relative to events cache | `vectorsById[event.id]` returns undefined for >10% of events | Re-run `/tmp/explore-clusters.js` (or its modern equivalent) to refresh embeddings. Document in the L2 summary. |
| Smoke tests fail post-clone | A.1.4 fails | Hard blocker. Don't continue until root-caused. |
| Time exhausted | Phase A pushes past 5 hours | Ship L1 only (Tasks A.1–A.8), note L2 as deferred next step, write Phase B plan referencing L1 results only. |
