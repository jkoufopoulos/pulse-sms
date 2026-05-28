# Phase 0 Empirical Anchor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the 25-query suite against the running agent-Pulse server and a hypothetical hybrid (BM25 + cached Gemini vectors + RRF) retrieval. Produce a failure-mode atlas (markdown table) and a 1-page summary that gates Phase A and Phase B design.

**Architecture:** Phase 0 is an analysis exercise on data we've already collected. Build minimal BM25 + RRF + event-card implementations in `scripts/phase-0/` (these are reusable in Phase A — they will be copied into the future `pulse-rag-hybrid` clone). Read cached Gemini embeddings from `data/embeddings-cache.json`. POST each query to the running `pulse-sms` agent on port 3000. Capture both outputs side-by-side into a markdown atlas; hand-annotate; produce decision summary.

**Tech Stack:** Node 20+, Node's built-in `node --test` runner, Gemini `gemini-embedding-001` (already cached), the existing `pulse-sms` server on port 3000. No new npm dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-27-hybrid-pulse-design.md`

**Total time budget:** ~3 hours.

---

## File structure

**Create (in `~/Projects/pulse-sms/`):**

```
scripts/phase-0/
├── comparison-queries.txt              # 25-query suite, bucket-labeled comments
├── bm25.js                             # ~80 LOC pure BM25 (reusable in Phase A)
├── event-cards.js                      # event row → indexable string
├── rrf.js                              # Reciprocal Rank Fusion
├── cosine.js                           # cosine similarity helper
├── hybrid-retrieve.js                  # ties BM25 + vectors + RRF together
├── embed-query.js                      # Gemini API call for query embedding
├── agent-caller.js                     # POST to localhost:3000/api/sms/test
└── atlas-runner.js                     # orchestrator: runs everything, writes atlas

test/unit/phase-0/
├── bm25.test.js
├── event-cards.test.js
├── rrf.test.js
├── cosine.test.js
└── hybrid-retrieve.test.js

data/
└── embeddings-cache.json               # copy of /tmp/pulse-embeddings.json (gitignored)

docs/superpowers/plans/
├── phase-0-output-atlas.md             # the table (auto-generated + hand-annotated)
└── phase-0-output-summary.md           # 1-page decision summary
```

**Modify:**

```
.gitignore                              # add data/embeddings-cache.json
```

---

## Task 1: Set up directories and the 25-query suite

**Files:**
- Create: `scripts/phase-0/comparison-queries.txt`
- Create: `scripts/phase-0/` and `test/unit/phase-0/` directories

- [ ] **Step 1.1: Create the directory structure**

```bash
mkdir -p /Users/justinkoufopoulos/Projects/pulse-sms/scripts/phase-0
mkdir -p /Users/justinkoufopoulos/Projects/pulse-sms/test/unit/phase-0
```

- [ ] **Step 1.2: Write the query suite to a file**

Create `scripts/phase-0/comparison-queries.txt` with this exact content (lines starting with `#` are bucket labels and will be skipped by the orchestrator):

```
# BUCKET A — State / reference (5 queries)
more
2
i meant brooklyn not bushwick
send me the link
actually skip the music, just bars

# BUCKET B — Vibe / semantic (8 queries)
something romantic and intimate in BK
cozy date night spot
weird underground vibes tonight
low-key bar that isnt another wine bar
where do creatives hang out in brooklyn
something different tonight
after-work drinks but not basic
actually fun trivia somewhere

# BUCKET C — Classic retrieve (7 queries)
williamsburg
free events
comedy in the lower east side
jazz tonight
events tomorrow night
anything happening in bushwick
dj set in brooklyn

# BUCKET D — Edges (5 queries)
help
dinner and a show
how about comedy later tonight
wburg
free or cheap things this weekend
```

- [ ] **Step 1.3: Verify the file is readable and has 25 non-comment lines**

```bash
grep -cv '^#\|^$' /Users/justinkoufopoulos/Projects/pulse-sms/scripts/phase-0/comparison-queries.txt
```
Expected output: `25`

- [ ] **Step 1.4: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/comparison-queries.txt
git commit -m "$(cat <<'EOF'
phase-0: add 25-query comparison suite (4 hypothesis buckets)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Move cached embeddings into the project

**Files:**
- Create: `data/embeddings-cache.json` (copy from `/tmp/pulse-embeddings.json`)
- Modify: `.gitignore`

- [ ] **Step 2.1: Confirm the cached embeddings file exists**

```bash
ls -lh /tmp/pulse-embeddings.json
```
Expected: file exists, ~60MB. If it does NOT exist, jump to the "Re-embed if missing" sub-task at the bottom of this document.

- [ ] **Step 2.2: Copy to project data directory**

```bash
cp /tmp/pulse-embeddings.json /Users/justinkoufopoulos/Projects/pulse-sms/data/embeddings-cache.json
ls -lh /Users/justinkoufopoulos/Projects/pulse-sms/data/embeddings-cache.json
```

- [ ] **Step 2.3: Add to .gitignore so we don't commit ~60MB of binary-ish data**

Read the current `.gitignore`:

```bash
cat /Users/justinkoufopoulos/Projects/pulse-sms/.gitignore
```

Add this line at the end of `.gitignore`:

```
# Cached Gemini embeddings for Phase 0 / Phase A retrieval experiments
data/embeddings-cache.json
```

- [ ] **Step 2.4: Verify the file is ignored by git**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git status --short
```
Expected: `data/embeddings-cache.json` should NOT appear in the status output. The `.gitignore` change WILL appear (`M .gitignore`).

- [ ] **Step 2.5: Commit the gitignore change**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add .gitignore
git commit -m "$(cat <<'EOF'
phase-0: gitignore the cached embeddings file (60MB binary data)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: TDD the BM25 implementation

**Files:**
- Create: `scripts/phase-0/bm25.js`
- Test: `test/unit/phase-0/bm25.test.js`

BM25 has two well-defined formulas: term IDF and per-doc score. We'll test on a tiny hand-built corpus where we can verify expected rankings by inspection.

- [ ] **Step 3.1: Write the failing test**

Create `test/unit/phase-0/bm25.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { buildBm25 } = require('../../../scripts/phase-0/bm25.js');

const DOCS = [
  'trivia night at northern bell williamsburg free pub',  // doc 0
  'brooklyn music kitchen open mic clinton hill live',     // doc 1
  'blind brunch date ladies in brooklyn greenpoint',       // doc 2
  'jazz late night vinyl west village live music',         // doc 3
];

test('BM25: tokenize lowercases and strips stopwords', () => {
  const bm = buildBm25(DOCS);
  const tokens = bm.tokenize('Brooklyn Date Night');
  assert.deepStrictEqual(tokens, ['brooklyn', 'date', 'night']);
});

test('BM25: tokenize drops stopwords from list', () => {
  const bm = buildBm25(DOCS);
  const tokens = bm.tokenize('the brooklyn and a date');
  assert.deepStrictEqual(tokens, ['brooklyn', 'date']);
});

test('BM25: IDF higher for rare terms', () => {
  const bm = buildBm25(DOCS);
  // "brooklyn" appears in 2 of 4 docs; "vinyl" appears in 1 of 4
  // therefore IDF(vinyl) > IDF(brooklyn)
  const idfBrooklyn = bm.idf.get('brooklyn');
  const idfVinyl = bm.idf.get('vinyl');
  assert.ok(idfVinyl > idfBrooklyn, `expected idf(vinyl)=${idfVinyl} > idf(brooklyn)=${idfBrooklyn}`);
});

test('BM25: scoring ranks doc with rare-term match higher', () => {
  const bm = buildBm25(DOCS);
  const qTokens = bm.tokenize('brooklyn date');
  const scores = DOCS.map((_, i) => bm.score(qTokens, i));
  // doc 2 has BOTH "brooklyn" AND "date"; doc 1 has only "brooklyn"
  assert.ok(scores[2] > scores[1], `doc 2 score ${scores[2]} should beat doc 1 score ${scores[1]}`);
});

test('BM25: doc with no query tokens scores 0', () => {
  const bm = buildBm25(DOCS);
  const qTokens = bm.tokenize('jazz vinyl');
  const score = bm.score(qTokens, 0);  // doc 0 has neither
  assert.strictEqual(score, 0);
});

test('BM25: top-K ordering matches scores', () => {
  const bm = buildBm25(DOCS);
  const qTokens = bm.tokenize('brooklyn');
  const ranked = DOCS
    .map((_, i) => ({ i, score: bm.score(qTokens, i) }))
    .sort((a, b) => b.score - a.score);
  // docs with "brooklyn" should come first (indices 1 and 2)
  assert.ok([1, 2].includes(ranked[0].i));
  assert.ok([1, 2].includes(ranked[1].i));
});
```

- [ ] **Step 3.2: Run tests to verify they fail (module not yet created)**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/bm25.test.js 2>&1 | tail -20
```
Expected: failure messages because `scripts/phase-0/bm25.js` doesn't exist yet.

- [ ] **Step 3.3: Implement BM25**

Create `scripts/phase-0/bm25.js`:

```javascript
/**
 * BM25 — pure-function implementation, no external dependencies.
 * Reusable in Phase A (will be copied into pulse-rag-hybrid/src/retrieval/).
 *
 * Standard formula: k1=1.2, b=0.75, smoothed-positive IDF.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'in', 'on', 'at', 'for',
  'of', 'to', 'with', 'is', 'it',
]);

function tokenize(s) {
  if (!s) return [];
  const matches = s.toLowerCase().match(/\w+/g) || [];
  return matches.filter(t => !STOPWORDS.has(t) && t.length > 1);
}

function buildBm25(docs, opts = {}) {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;

  const N = docs.length;
  const tokens = docs.map(tokenize);
  const docLens = tokens.map(t => t.length);
  const avgDl = docLens.length === 0
    ? 0
    : docLens.reduce((s, x) => s + x, 0) / N;

  // Document frequency per term (how many docs contain it).
  const df = new Map();
  for (const toks of tokens) {
    for (const t of new Set(toks)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  // IDF per term, smoothed so it stays positive.
  const idf = new Map();
  for (const [term, dfreq] of df) {
    idf.set(term, Math.log((N - dfreq + 0.5) / (dfreq + 0.5) + 1));
  }

  // Term frequency per document (precomputed for speed).
  const tfPerDoc = tokens.map(toks => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  });

  function score(queryTokens, docIdx) {
    let s = 0;
    for (const q of queryTokens) {
      const tf = tfPerDoc[docIdx].get(q) || 0;
      if (tf === 0) continue;
      const i = idf.get(q) || 0;
      const dl = docLens[docIdx];
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + b * (dl / (avgDl || 1)));
      s += i * (num / den);
    }
    return s;
  }

  return { score, tokenize, idf, df, avgDl, docLens };
}

module.exports = { buildBm25, tokenize, STOPWORDS };
```

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/bm25.test.js
```
Expected: `# pass 6` (or similar — all tests passing).

- [ ] **Step 3.5: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/bm25.js test/unit/phase-0/bm25.test.js
git commit -m "$(cat <<'EOF'
phase-0: BM25 implementation with unit tests

~80 LOC pure function, no deps. Reusable as-is in Phase A.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TDD the event-card builder

**Files:**
- Create: `scripts/phase-0/event-cards.js`
- Test: `test/unit/phase-0/event-cards.test.js`

The event card is the string we index per event. It must concatenate the same six fields in the same order across all code paths.

- [ ] **Step 4.1: Write the failing test**

Create `test/unit/phase-0/event-cards.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { buildCard } = require('../../../scripts/phase-0/event-cards.js');

test('buildCard: all six fields present and joined by ". "', () => {
  const event = {
    name: 'Trivia Night',
    venue_name: 'Northern Bell',
    neighborhood: 'Williamsburg',
    category: 'trivia',
    is_free: true,
    short_detail: 'Weekly pub trivia with prizes.',
  };
  const card = buildCard(event);
  assert.strictEqual(
    card,
    'Trivia Night. Northern Bell. Williamsburg. trivia. free. Weekly pub trivia with prizes.'
  );
});

test('buildCard: is_free=false uses price_display', () => {
  const event = {
    name: 'Show', venue_name: 'BAM', neighborhood: 'Fort Greene',
    category: 'film', is_free: false, price_display: '$15',
    short_detail: 'Film screening.',
  };
  const card = buildCard(event);
  assert.ok(card.includes('. $15. '), `expected price segment in card: ${card}`);
});

test('buildCard: missing fields are dropped (no double periods)', () => {
  const event = {
    name: 'Event', venue_name: 'Place',
    // no neighborhood, no category, no price, no detail
    is_free: false,
  };
  const card = buildCard(event);
  assert.strictEqual(card, 'Event. Place');
});

test('buildCard: prefers short_detail over description_short', () => {
  const event = {
    name: 'A', venue_name: 'B',
    short_detail: 'short_one', description_short: 'desc_one',
  };
  const card = buildCard(event);
  assert.ok(card.endsWith('short_one'));
});

test('buildCard: falls back to description_short if short_detail missing', () => {
  const event = {
    name: 'A', venue_name: 'B',
    description_short: 'desc_one',
  };
  const card = buildCard(event);
  assert.ok(card.endsWith('desc_one'));
});
```

- [ ] **Step 4.2: Run tests, verify failure**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/event-cards.test.js 2>&1 | tail -10
```
Expected: failure (module missing).

- [ ] **Step 4.3: Implement**

Create `scripts/phase-0/event-cards.js`:

```javascript
/**
 * Event card builder — concatenates the indexable fields per event.
 * Single source of truth for "what text represents an event in retrieval."
 */

function buildCard(event) {
  const priceField = event.is_free
    ? 'free'
    : (event.price_display || null);

  const detailField = event.short_detail || event.description_short || null;

  const parts = [
    event.name,
    event.venue_name,
    event.neighborhood,
    event.category,
    priceField,
    detailField,
  ].filter(Boolean);

  return parts.join('. ');
}

module.exports = { buildCard };
```

- [ ] **Step 4.4: Run tests, verify pass**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/event-cards.test.js
```
Expected: all 5 tests pass.

- [ ] **Step 4.5: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/event-cards.js test/unit/phase-0/event-cards.test.js
git commit -m "$(cat <<'EOF'
phase-0: event-card builder with unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: TDD cosine similarity

**Files:**
- Create: `scripts/phase-0/cosine.js`
- Test: `test/unit/phase-0/cosine.test.js`

- [ ] **Step 5.1: Write the failing test**

Create `test/unit/phase-0/cosine.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { cosine } = require('../../../scripts/phase-0/cosine.js');

test('cosine: identical vectors return 1.0', () => {
  const a = [1, 2, 3];
  assert.strictEqual(cosine(a, a), 1);
});

test('cosine: opposite vectors return -1', () => {
  const a = [1, 2, 3];
  const b = [-1, -2, -3];
  assert.ok(Math.abs(cosine(a, b) - -1) < 1e-9);
});

test('cosine: orthogonal vectors return 0', () => {
  const a = [1, 0];
  const b = [0, 1];
  assert.strictEqual(cosine(a, b), 0);
});

test('cosine: handles unit-length input correctly', () => {
  const a = [0.6, 0.8];   // unit vector
  const b = [0.8, 0.6];   // unit vector
  // dot product = 0.48 + 0.48 = 0.96
  assert.ok(Math.abs(cosine(a, b) - 0.96) < 1e-9);
});

test('cosine: works on 3072-dim arrays (Gemini embeddings)', () => {
  const a = new Array(3072).fill(0.01);
  const b = new Array(3072).fill(0.01);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9);
});
```

- [ ] **Step 5.2: Run tests, verify failure**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/cosine.test.js 2>&1 | tail -10
```

- [ ] **Step 5.3: Implement**

Create `scripts/phase-0/cosine.js`:

```javascript
/**
 * Cosine similarity for dense vectors.
 * Returns value in [-1, 1]; 1 = same direction, 0 = orthogonal, -1 = opposite.
 */

function cosine(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

module.exports = { cosine };
```

- [ ] **Step 5.4: Run tests, verify pass**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/cosine.test.js
```

- [ ] **Step 5.5: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/cosine.js test/unit/phase-0/cosine.test.js
git commit -m "$(cat <<'EOF'
phase-0: cosine similarity helper with unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: TDD RRF (Reciprocal Rank Fusion)

**Files:**
- Create: `scripts/phase-0/rrf.js`
- Test: `test/unit/phase-0/rrf.test.js`

- [ ] **Step 6.1: Write the failing test**

Create `test/unit/phase-0/rrf.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { rrfFuse } = require('../../../scripts/phase-0/rrf.js');

test('rrfFuse: doc at rank 1 in both rankings beats doc in only one', () => {
  // ranking is an array of doc IDs in descending score order
  const bm = ['a', 'b', 'c'];
  const vec = ['a', 'd', 'e'];
  const fused = rrfFuse([bm, vec], { k: 60 });
  // 'a' appears at rank 0 in both → highest RRF
  assert.strictEqual(fused[0].id, 'a');
});

test('rrfFuse: doc in only one ranking still ranks if other docs have weak presence', () => {
  const bm = ['a', 'b', 'c'];
  const vec = ['d', 'e', 'f'];
  const fused = rrfFuse([bm, vec], { k: 60 });
  // first 6 docs each contribute 1/(60+rank); fused has 6 unique entries
  assert.strictEqual(fused.length, 6);
  // 'a' and 'd' both appear at rank 0 → tied at top
  assert.ok(['a', 'd'].includes(fused[0].id));
});

test('rrfFuse: known RRF math — score = sum of 1/(k+rank) across methods', () => {
  const bm = ['x'];
  const vec = ['x'];
  const fused = rrfFuse([bm, vec], { k: 60 });
  // x appears at rank 0 in both methods: score = 1/60 + 1/60
  const expected = (1 / 60) + (1 / 60);
  assert.ok(Math.abs(fused[0].score - expected) < 1e-9);
});

test('rrfFuse: empty rankings return empty', () => {
  const fused = rrfFuse([[], []], { k: 60 });
  assert.strictEqual(fused.length, 0);
});

test('rrfFuse: respects top-k limit if provided', () => {
  const bm = ['a', 'b', 'c', 'd', 'e'];
  const vec = ['a', 'b', 'c', 'd', 'e'];
  const fused = rrfFuse([bm, vec], { k: 60, topK: 3 });
  assert.strictEqual(fused.length, 3);
});
```

- [ ] **Step 6.2: Run tests, verify failure**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/rrf.test.js 2>&1 | tail -10
```

- [ ] **Step 6.3: Implement**

Create `scripts/phase-0/rrf.js`:

```javascript
/**
 * Reciprocal Rank Fusion — merges multiple ranked lists into one.
 *
 * Each input ranking is an array of doc IDs in descending score order.
 * Each doc gets fused_score = sum over rankings of 1 / (k + rank_in_ranking).
 * Standard k = 60 from the original Cormack/Clarke/Buettcher paper.
 */

function rrfFuse(rankings, { k = 60, topK = null } = {}) {
  const scores = new Map();

  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const id = ranking[rank];
      const inc = 1 / (k + rank);
      scores.set(id, (scores.get(id) || 0) + inc);
    }
  }

  const fused = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);

  return topK == null ? fused : fused.slice(0, topK);
}

module.exports = { rrfFuse };
```

- [ ] **Step 6.4: Run tests, verify pass**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/rrf.test.js
```

- [ ] **Step 6.5: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/rrf.js test/unit/phase-0/rrf.test.js
git commit -m "$(cat <<'EOF'
phase-0: RRF (Reciprocal Rank Fusion) with unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: TDD the hybrid-retrieve orchestrator

**Files:**
- Create: `scripts/phase-0/hybrid-retrieve.js`
- Test: `test/unit/phase-0/hybrid-retrieve.test.js`

The hybrid retriever takes (a) the events cache, (b) the embeddings cache, (c) a query string and its embedding, and returns top-K by RRF over BM25 + dense.

- [ ] **Step 7.1: Write the failing test**

Create `test/unit/phase-0/hybrid-retrieve.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { hybridRetrieve, buildIndex } = require('../../../scripts/phase-0/hybrid-retrieve.js');

const EVENTS = [
  { id: 'a', name: 'Trivia Night', venue_name: 'Bell', neighborhood: 'Williamsburg', category: 'trivia', short_detail: 'pub trivia' },
  { id: 'b', name: 'Comedy Show',  venue_name: 'Club', neighborhood: 'LES',          category: 'comedy', short_detail: 'standup' },
  { id: 'c', name: 'Jazz Night',   venue_name: 'Cellar', neighborhood: 'West Village', category: 'live_music', short_detail: 'jazz quartet' },
];

// 3 fake vectors (dim=4 for testability)
// query vector close to event 'c' (jazz)
const VECTORS = {
  a: [0.1, 0.1, 0.1, 0.9],
  b: [0.1, 0.9, 0.1, 0.1],
  c: [0.9, 0.1, 0.1, 0.1],
};
const QUERY_VEC = [0.85, 0.15, 0.1, 0.1];  // closest to c

test('buildIndex: produces { cards, eventIds, bm25 }', () => {
  const idx = buildIndex(EVENTS);
  assert.strictEqual(idx.cards.length, 3);
  assert.strictEqual(idx.eventIds[0], 'a');
  assert.ok(typeof idx.bm25.score === 'function');
});

test('hybridRetrieve: query "jazz" routes to event c (BM25 dominates lexical match)', () => {
  const idx = buildIndex(EVENTS);
  const results = hybridRetrieve({
    queryText: 'jazz',
    queryVector: [0, 0, 0, 1],  // misleading vector; BM25 should still nail it
    index: idx,
    vectors: VECTORS,
    topK: 3,
    rrfK: 60,
  });
  assert.strictEqual(results[0].id, 'c');
});

test('hybridRetrieve: returns at most topK results', () => {
  const idx = buildIndex(EVENTS);
  const results = hybridRetrieve({
    queryText: 'a vibe',
    queryVector: QUERY_VEC,
    index: idx,
    vectors: VECTORS,
    topK: 2,
    rrfK: 60,
  });
  assert.ok(results.length <= 2);
});

test('hybridRetrieve: each result has { id, rrfScore, bm25Rank, vecRank }', () => {
  const idx = buildIndex(EVENTS);
  const results = hybridRetrieve({
    queryText: 'jazz',
    queryVector: QUERY_VEC,
    index: idx,
    vectors: VECTORS,
    topK: 3,
    rrfK: 60,
  });
  for (const r of results) {
    assert.ok('id' in r);
    assert.ok('rrfScore' in r);
    assert.ok('bm25Rank' in r);
    assert.ok('vecRank' in r);
  }
});
```

- [ ] **Step 7.2: Run tests, verify failure**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/hybrid-retrieve.test.js 2>&1 | tail -10
```

- [ ] **Step 7.3: Implement**

Create `scripts/phase-0/hybrid-retrieve.js`:

```javascript
/**
 * Hybrid retrieval — fuses BM25 (lexical) and cosine (dense) rankings via RRF.
 * Given a query (text + vector) and an index, returns top-K events with
 * provenance (which method ranked them where).
 */

const { buildBm25 } = require('./bm25');
const { buildCard } = require('./event-cards');
const { cosine } = require('./cosine');
const { rrfFuse } = require('./rrf');

function buildIndex(events) {
  const cards = events.map(buildCard);
  const eventIds = events.map(e => e.id);
  const bm25 = buildBm25(cards);
  return { cards, eventIds, bm25, events };
}

function hybridRetrieve({
  queryText, queryVector, index, vectors,
  topK = 10, rrfK = 60, candidatePool = 50,
}) {
  const { bm25, eventIds } = index;

  // BM25 ranking
  const qTokens = bm25.tokenize(queryText);
  const bm25Scored = eventIds.map((id, i) => ({
    id, score: bm25.score(qTokens, i),
  }));
  const bm25Ranked = bm25Scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, candidatePool);
  const bm25Ranking = bm25Ranked.map(r => r.id);
  const bm25Rank = new Map(bm25Ranking.map((id, i) => [id, i]));

  // Dense ranking
  const vecScored = eventIds
    .filter(id => vectors[id])
    .map(id => ({ id, score: cosine(queryVector, vectors[id]) }));
  const vecRanked = vecScored
    .sort((a, b) => b.score - a.score)
    .slice(0, candidatePool);
  const vecRanking = vecRanked.map(r => r.id);
  const vecRank = new Map(vecRanking.map((id, i) => [id, i]));

  // RRF fuse
  const fused = rrfFuse([bm25Ranking, vecRanking], { k: rrfK, topK });

  return fused.map(({ id, score }) => ({
    id,
    rrfScore: score,
    bm25Rank: bm25Rank.has(id) ? bm25Rank.get(id) + 1 : null,
    vecRank: vecRank.has(id) ? vecRank.get(id) + 1 : null,
  }));
}

module.exports = { hybridRetrieve, buildIndex };
```

- [ ] **Step 7.4: Run tests, verify pass**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node --test test/unit/phase-0/hybrid-retrieve.test.js
```

- [ ] **Step 7.5: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/hybrid-retrieve.js test/unit/phase-0/hybrid-retrieve.test.js
git commit -m "$(cat <<'EOF'
phase-0: hybrid retrieval orchestrator (BM25 + dense via RRF)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Query embedding helper (no TDD — thin API wrapper)

**Files:**
- Create: `scripts/phase-0/embed-query.js`

This is a one-function file that calls Gemini and returns a vector. Testing it would require API mocks; the value isn't worth it. Manual sanity check at the end.

- [ ] **Step 8.1: Implement**

Create `scripts/phase-0/embed-query.js`:

```javascript
/**
 * Embed a single query string via Gemini gemini-embedding-001.
 * Uses RETRIEVAL_QUERY task type (vs RETRIEVAL_DOCUMENT for the cards).
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

async function embedQuery(text, { apiKey } = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not provided');

  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
    }),
  });
  if (!res.ok) {
    throw new Error(`embed-query failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.embedding.values;
}

module.exports = { embedQuery };
```

- [ ] **Step 8.2: Sanity-check with a real call**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2- | tr -d '"') node -e "
const { embedQuery } = require('./scripts/phase-0/embed-query');
(async () => {
  const v = await embedQuery('cozy date night');
  console.log('dim:', v.length, 'first 6:', v.slice(0, 6).map(x => x.toFixed(4)));
})();
"
```
Expected: `dim: 3072 first 6: [0.???, ...]` — some 3072-dimensional vector with 6 floats shown. If it errors with `404`, the model name has changed; check `https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY` for the current embedding model and update `GEMINI_URL` in the script.

- [ ] **Step 8.3: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/embed-query.js
git commit -m "$(cat <<'EOF'
phase-0: query embedding helper (Gemini gemini-embedding-001)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Agent-Pulse caller (no TDD — HTTP wrapper)

**Files:**
- Create: `scripts/phase-0/agent-caller.js`

- [ ] **Step 9.1: Implement**

Create `scripts/phase-0/agent-caller.js`:

```javascript
/**
 * POST a single message to agent-Pulse's /api/sms/test endpoint and return
 * the captured SMS messages + trace summary.
 *
 * Requires pulse-sms to be running on port 3000 with PULSE_TEST_MODE=true.
 */

const TEST_URL = 'http://localhost:3000/api/sms/test';
const TIMEOUT_MS = 30000;

async function callAgent(message, { phone = '+15550001234', timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(TEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Body: message, From: phone }),
      signal: ctl.signal,
    });
    const json = await res.json().catch(() => ({ error: 'non-JSON response', status: res.status }));
    if (!res.ok) {
      return { error: json.error || `HTTP ${res.status}`, messages: json.messages || [] };
    }
    return json;
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callAgent };
```

- [ ] **Step 9.2: Sanity-check the call (requires agent-Pulse running, see Task 11)**

If the server isn't running yet, skip this step and come back after Task 11. Otherwise:

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node -e "
const { callAgent } = require('./scripts/phase-0/agent-caller');
(async () => {
  const r = await callAgent('williamsburg', { phone: '+15550009998' });
  console.log('messages count:', (r.messages || []).length);
  console.log('first body:', (r.messages?.[0]?.body || '?').slice(0, 100));
  console.log('intent:', r.trace_summary?.intent);
})();
"
```
Expected: a captured SMS body and an intent string.

- [ ] **Step 9.3: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/agent-caller.js
git commit -m "$(cat <<'EOF'
phase-0: agent-Pulse caller (POST to localhost:3000/api/sms/test)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: The atlas runner — orchestrator that produces the atlas

**Files:**
- Create: `scripts/phase-0/atlas-runner.js`

- [ ] **Step 10.1: Implement**

Create `scripts/phase-0/atlas-runner.js`:

```javascript
#!/usr/bin/env node
/**
 * atlas-runner.js — Phase 0 orchestrator.
 *
 * For each query in scripts/phase-0/comparison-queries.txt:
 *   1. Run hybrid retrieval (BM25 + dense) over cached events + embeddings
 *   2. POST the query to agent-Pulse on port 3000
 *   3. Capture both outputs into a markdown atlas
 *
 * Writes the atlas to docs/superpowers/plans/phase-0-output-atlas.md.
 *
 * Prerequisites:
 *   - agent-Pulse running on port 3000 with PULSE_TEST_MODE=true
 *   - data/embeddings-cache.json populated (from Task 2)
 *   - GEMINI_API_KEY in environment
 *
 * Usage:
 *   GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2- | tr -d '"') \
 *     node scripts/phase-0/atlas-runner.js
 */

const fs = require('fs');
const path = require('path');

const { buildIndex, hybridRetrieve } = require('./hybrid-retrieve');
const { embedQuery } = require('./embed-query');
const { callAgent } = require('./agent-caller');

const ROOT = path.resolve(__dirname, '../..');
const QUERIES_FILE = path.join(ROOT, 'scripts/phase-0/comparison-queries.txt');
const EVENTS_FILE = path.join(ROOT, 'data/events-cache.json');
const EMBED_FILE = path.join(ROOT, 'data/embeddings-cache.json');
const OUT_FILE = path.join(ROOT, 'docs/superpowers/plans/phase-0-output-atlas.md');

const PAUSE_MS = 4000;   // pause between queries to be kind to LLM rate limits

function readQueries(text) {
  const lines = text.split('\n');
  let bucket = '?';
  const out = [];
  for (const raw of lines) {
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmtAgentResponse(agentResp) {
  if (agentResp.error) return `_(error: ${agentResp.error})_`;
  const bodies = (agentResp.messages || []).map(m => m.body || JSON.stringify(m));
  if (bodies.length === 0) return '_(no SMS captured)_';
  return bodies.map(b => `> ${b.replace(/\n/g, '\n> ')}`).join('\n>\n');
}

function fmtHybridTop(hybridTop, eventsById) {
  if (hybridTop.length === 0) return '_(no results)_';
  return hybridTop.slice(0, 3).map((r, i) => {
    const e = eventsById[r.id];
    if (!e) return `${i + 1}. _(unknown event id ${r.id})_`;
    const hood = e.neighborhood || '?';
    const cat = e.category || '?';
    const ranks = `bm25=#${r.bm25Rank ?? '-'} vec=#${r.vecRank ?? '-'}`;
    return `${i + 1}. **${(e.name || '').slice(0, 50)}** — ${e.venue_name || '?'} (${hood}) [${cat}] _${ranks}_`;
  }).join('\n');
}

(async () => {
  // Load data
  console.log('Loading events cache...');
  const eventsCache = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  const events = eventsCache.events;
  const eventsById = Object.fromEntries(events.map(e => [e.id, e]));

  console.log(`Loading embeddings cache (this may take ~1s for 60MB)...`);
  const embedStore = JSON.parse(fs.readFileSync(EMBED_FILE, 'utf8'));
  const vectors = {};
  for (let i = 0; i < embedStore.ids.length; i++) {
    vectors[embedStore.ids[i]] = embedStore.vectors[i];
  }

  console.log('Building BM25 index over event cards...');
  const idx = buildIndex(events);

  console.log('Loading queries...');
  const queries = readQueries(fs.readFileSync(QUERIES_FILE, 'utf8'));
  console.log(`  ${queries.length} queries across ${new Set(queries.map(q => q.bucket)).size} buckets`);

  // Header
  let atlas = `# Phase 0 — Failure-Mode Atlas\n\n`;
  atlas += `Generated: ${new Date().toISOString()}\n`;
  atlas += `Events in corpus: ${events.length}\n`;
  atlas += `Queries: ${queries.length} across 4 buckets\n\n`;
  atlas += `---\n\n`;
  atlas += `**How to read the columns:**\n`;
  atlas += `- _Agent response_: full SMS captured from agent-Pulse on port 3000\n`;
  atlas += `- _Hybrid top-3_: top 3 events from BM25+vector RRF fusion over the same corpus\n`;
  atlas += `- _Agent right?_, _Hybrid right?_, _Failure mode_: leave blank during initial run; hand-annotate in Task 11\n\n`;
  atlas += `---\n\n`;

  for (let i = 0; i < queries.length; i++) {
    const { query, bucket } = queries[i];
    console.log(`\n[${i + 1}/${queries.length}] (${bucket}) "${query}"`);

    let hybridTop = [];
    let qVec = null;
    try {
      qVec = await embedQuery(query);
      hybridTop = hybridRetrieve({
        queryText: query,
        queryVector: qVec,
        index: idx,
        vectors,
        topK: 10,
        rrfK: 60,
      });
      console.log(`  hybrid: ${hybridTop.length} results, top = ${eventsById[hybridTop[0]?.id]?.name?.slice(0, 40) || '?'}`);
    } catch (err) {
      console.error(`  hybrid failed: ${err.message}`);
    }

    let agentResp;
    try {
      agentResp = await callAgent(query, { phone: '+15550001234' });
      console.log(`  agent: ${(agentResp.messages || []).length} msg, intent=${agentResp.trace_summary?.intent || '?'}`);
    } catch (err) {
      agentResp = { error: err.message };
      console.error(`  agent failed: ${err.message}`);
    }

    atlas += `## ${bucket}-${i + 1}: "${query}"\n\n`;
    atlas += `**Agent response:**\n${fmtAgentResponse(agentResp)}\n\n`;
    atlas += `**Hybrid top-3:**\n${fmtHybridTop(hybridTop, eventsById)}\n\n`;
    atlas += `| Agent right? | Hybrid right? | Failure mode |\n`;
    atlas += `|---|---|---|\n`;
    atlas += `| _(annotate)_ | _(annotate)_ | _(annotate)_ |\n\n`;
    atlas += `---\n\n`;

    if (i < queries.length - 1) await sleep(PAUSE_MS);
  }

  fs.writeFileSync(OUT_FILE, atlas);
  console.log(`\nWrote ${OUT_FILE}`);
})().catch(e => { console.error('Atlas run failed:', e); process.exit(1); });
```

- [ ] **Step 10.2: Commit**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add scripts/phase-0/atlas-runner.js
git commit -m "$(cat <<'EOF'
phase-0: atlas runner — orchestrator for the 25-query comparison

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Pre-flight — start agent-Pulse on port 3000

The events-cache `timestamp` field needs to be current; otherwise the staleness guard sends "Pulse is refreshing..." instead of a real response. The event dates themselves don't matter for the routing/retrieval comparison.

**Files:**
- Modify: `data/events-cache.json` (timestamp field only — already done in prior session, may need redoing if stale)

- [ ] **Step 11.1: Refresh the cache timestamp**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
node -e "
const fs = require('fs');
const p = 'data/events-cache.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.timestamp = Date.now();
fs.writeFileSync(p, JSON.stringify(j));
console.log('timestamp refreshed to', j.timestamp, '(events:', (j.events||[]).length + ')');
"
```

- [ ] **Step 11.2: Start agent-Pulse in the background**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001 \
  npm start > /tmp/pulse-sms.log 2>&1 &
echo "PID: $!" > /tmp/pulse-sms.pid
```

- [ ] **Step 11.3: Wait for server to be ready (binds AND cache reports fresh)**

```bash
until grep -q "Pulse listening on port 3000" /tmp/pulse-sms.log 2>/dev/null \
   && grep -q "Persisted cache is fresh" /tmp/pulse-sms.log 2>/dev/null; do
  sleep 1
done
echo "agent-Pulse ready on port 3000"
```

- [ ] **Step 11.4: Smoke-test with one query**

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"Body":"williamsburg","From":"+15550009998"}' \
  http://localhost:3000/api/sms/test \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('messages:', len(d.get('messages', [])))
print('intent:', d.get('trace_summary',{}).get('intent'))
print('first body:', (d.get('messages',[{}])[0] or {}).get('body','?')[:120])
"
```
Expected: 1 message, an intent string (likely `clarify` or `events`), a non-error body.

---

## Task 12: Run the atlas

- [ ] **Step 12.1: Run the orchestrator**

This will make 25 query embeddings (~$0.0001) and 25 agent calls (~25-50 seconds of compute spread across 4-second pauses).

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2- | tr -d '"') \
  node scripts/phase-0/atlas-runner.js
```
Expected:
- Console: `[1/25] (A) "more"`, ... `[25/25] (D) "free or cheap things this weekend"`
- Output file written: `docs/superpowers/plans/phase-0-output-atlas.md`
- Total runtime: ~2.5 minutes

- [ ] **Step 12.2: Verify the atlas has 25 entries**

```bash
grep -c '^## ' /Users/justinkoufopoulos/Projects/pulse-sms/docs/superpowers/plans/phase-0-output-atlas.md
```
Expected output: `25`

- [ ] **Step 12.3: Stop the agent server (we'll restart it if needed for re-runs)**

```bash
kill $(cat /tmp/pulse-sms.pid)
rm /tmp/pulse-sms.pid
```

- [ ] **Step 12.4: Commit the unannotated atlas**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add docs/superpowers/plans/phase-0-output-atlas.md
git commit -m "$(cat <<'EOF'
phase-0: atlas run — 25 queries against agent + hypothetical hybrid

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Hand-annotate the atlas

This is the analysis step. Open the atlas and fill in the three annotation columns for each query. Each annotation should be one short sentence.

- [ ] **Step 13.1: Open the atlas in your editor**

```bash
open /Users/justinkoufopoulos/Projects/pulse-sms/docs/superpowers/plans/phase-0-output-atlas.md
```

- [ ] **Step 13.2: For each of the 25 queries, fill in the three annotation columns**

For each query block, replace `_(annotate)_` placeholders in the table with:

- **Agent right?** — `yes` / `no` / `partial`. Brief 1-line reason if `no` or `partial`.
- **Hybrid right?** — `yes` / `no` / `partial`. Brief 1-line reason if `no` or `partial`.
- **Failure mode** — if either side failed, name the failure mode in 4-6 words. Use these labels where they fit:
  - `state required` (agent OK, hybrid needs prior turn context)
  - `reference resolution` (agent OK, hybrid can't resolve "2", "more")
  - `intent ambiguity` (both fail; needs clarify)
  - `vocabulary mismatch` (agent OK because of LLM understanding; hybrid misses)
  - `semantic vibe` (hybrid better because BM25 can't read vibes)
  - `false positive on noise floor` (hybrid surfaces irrelevant things at high score)
  - `duplicate pollution` (hybrid top-3 includes near-identical rows)
  - `agent over-clarifies` (agent asks when retrieval would have been fine)
  - `agent under-clarifies` (agent commits to wrong intent)
  - (or coin a new label and add it to the list)

- [ ] **Step 13.3: Commit the annotated atlas**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add docs/superpowers/plans/phase-0-output-atlas.md
git commit -m "$(cat <<'EOF'
phase-0: hand-annotate atlas with right/wrong + failure modes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Write the decision summary

This is Phase 0's actual deliverable — the 1-page summary that gates Phase A and Phase B design.

**Files:**
- Create: `docs/superpowers/plans/phase-0-output-summary.md`

- [ ] **Step 14.1: Write the summary**

Create `docs/superpowers/plans/phase-0-output-summary.md` with this structure (fill in from the annotated atlas):

```markdown
# Phase 0 — Decision Summary

**Date:** [today's date]
**Atlas:** `phase-0-output-atlas.md`
**Spec:** `2026-05-27-hybrid-pulse-design.md`

## Bucket-level results

| Bucket | n | Agent right | Hybrid right | Both right | Both wrong |
|---|---|---|---|---|---|
| A — State/reference | 5 | ? | ? | ? | ? |
| B — Vibe/semantic | 8 | ? | ? | ? | ? |
| C — Classic retrieve | 7 | ? | ? | ? | ? |
| D — Edges | 5 | ? | ? | ? | ? |

## Top three findings

1. **[finding]** — supporting query examples and counts.
2. **[finding]** — ...
3. **[finding]** — ...

## What the failure-mode atlas tells us

(2-3 paragraphs synthesizing the annotations. Focus on patterns, not individual queries.)

## Implications for the spec's three phases

### Phase A — Retrieval craft

[Should we build L1+L2? Why or why not? If yes, what changes from the spec design based on what Phase 0 surfaced?]

### Phase B — Decision craft

[Does the LLM-proposes / taxonomy-authorizes pattern materially change anything vs. the agent loop? Or is its value primarily policy/auditability infrastructure?]

[What specific intents should `interaction_routing` actually classify, given the queries that worked vs. those that didn't?]

### Phase A and B together — the architecture changes

[Any cross-phase implications. For example: if Bucket B shows hybrid only winning on a few queries, maybe L2 calibration is sweep-light and we lean more on D1 to gate when retrieval-only suffices vs. when we need the agent's tool-routing.]

## Decision

Selecting one of the four options from the spec's §1:

- [ ] (a) Phase A is justified → proceed with L1, L2
- [ ] (b) Phase A is partially redundant → skip ahead
- [ ] (c) Phase B needs redesign → LLM-proposes / taxonomy-authorizes needs separate validation
- [ ] (d) Something else — describe:

[1 paragraph defending the choice.]

## Next plan

[State which plan to write next: Phase A plan, refined Phase B plan, or both.]
```

- [ ] **Step 14.2: Commit the summary**

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
git add docs/superpowers/plans/phase-0-output-summary.md
git commit -m "$(cat <<'EOF'
phase-0: decision summary — gates Phase A and Phase B design

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Appendix — Re-embed if `/tmp/pulse-embeddings.json` is missing

If Task 2 finds the cached embeddings file is gone, regenerate it before continuing:

```bash
cd /Users/justinkoufopoulos/Projects/pulse-sms
GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2- | tr -d '"') \
  node /tmp/explore-clusters.js
# (will embed all 2743 events, ~2-3 minutes, ~$0.001)
```
Then copy: `cp /tmp/pulse-embeddings.json data/embeddings-cache.json`.

---

## Self-review notes (what this plan covered against the spec)

| Spec requirement | Plan task |
|---|---|
| 25-query suite in `scripts/comparison-queries.txt` | Task 1 |
| Hypothetical hybrid retrieval (BM25 + RRF over cached vectors) | Tasks 3, 5, 6, 7 |
| Event cards built per spec's field order | Task 4 |
| Embeddings persisted to `data/embeddings-cache.json` | Task 2 |
| Agent baseline (port 3000) caller | Task 9 |
| Atlas markdown output at the spec's named location | Task 10 |
| Failure-mode column scheme with explicit categories | Task 13 (Step 13.2) |
| 1-page summary that gates Phase A and Phase B | Task 14 |
| BM25 rolled in-house (~80 LOC, reusable in Phase A) | Task 3 |
| RRF k=60 default | Task 6 |
| Lazy embedding rebuild (Phase A) | Not in scope here — Phase 0 uses pre-cached embeddings |
| Decision points (a)-(d) from spec §1 | Task 14 (Step 14.1) |

**Out of scope for this plan (deferred to Phase A / Phase B plans):**
- `pulse-rag-hybrid` clone creation
- Replacing `agent-loop.js`
- LLM compose step (Phase A's single-shot compose)
- Taxonomy YAML + LLM classifier (Phase B)
- Feedback flywheel / dashboard (Phase B)
