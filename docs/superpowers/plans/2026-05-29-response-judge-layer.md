# Response-Level Judge Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a response-level judge that scores every outgoing SMS against a structured rubric, runs continuously against captured traces, and gets calibrated weekly against human labels — turning eval from a launch-time check into a continuous quality signal that catches the failure modes the existing extraction/scenario/unit layers structurally can't see.

**Architecture:** Tiered judging — programmatic checks for deterministic axes (URL format, entity naming against `venues`/`events` tables), heuristic checks for semi-structured axes (constraint coverage, promise/delivery consistency) that leverage data already captured in `composition.active_filters` and `composition.picks` on each trace, and an LLM-as-judge call for soft axes (intent carry, grounding, tone). Scores land in three new SQLite tables alongside the existing schema. A trace-replay harness backfills against historical JSONL traces. A `/label` route captures human ground truth; a calibration computation tracks per-axis judge-rater agreement as an SLI. Graduated alerts wire into the existing `alerts.jsonl` plumbing.

**Tech Stack:** Existing — `better-sqlite3`, `@anthropic-ai/sdk`, Express, the custom `check()` test helper at `test/helpers.js`, OTel/Phoenix tracing already in `src/tracing.js`. No new dependencies.

**Motivating failures (catalogued from production conversations 2026-05-29):**

| Failure | Axis that would catch it | Tier |
|---|---|---|
| User asked Greenpoint OR Williamsburg; both picks Williamsburg | `constraint_coverage` | heuristic |
| "Three picks that actually fit" header → 2 items delivered | `promise_delivery_consistency` | heuristic |
| Bar rendered as "Bedford Ave" (its address) instead of "Maison Premiere" | `entity_naming_fidelity` | programmatic |
| Raw Google Maps URL with cid + tracking params in SMS body | `output_format_compliance` | programmatic |
| "what about greenpoint" → generic numbered menu, wine-bar intent lost | `intent_carry` | LLM judge |

---

## File Structure

**New files:**

```
src/eval/
  rubric.js              # Single source of truth: axis names, types, tiers
  orchestrator.js        # Runs all axes against a (user_msg, response, trace) triple
  calibration.js         # Computes judge-rater agreement
  slis.js                # SLI thresholds + breach detection
  axes/
    format-compliance.js # Programmatic: URL patterns, length, banned strings
    entity-naming.js     # Programmatic: venue/event names vs DB canonical
    constraint-coverage.js # Heuristic: input filters vs output content
    promise-delivery.js  # Heuristic: stated count vs delivered count
    llm-judge.js         # LLM-as-judge: intent_carry, grounding, tone_brand
  label-ui.html          # Human labeling interface (served via server.js route)

scripts/
  replay-traces.js       # Backfill scoring against data/traces/*.jsonl
  compute-calibration.js # Weekly judge-rater agreement snapshot

test/unit/
  eval-rubric.test.js
  eval-format-compliance.test.js
  eval-entity-naming.test.js
  eval-constraint-coverage.test.js
  eval-promise-delivery.test.js
  eval-llm-judge.test.js
  eval-orchestrator.test.js
  eval-calibration.test.js
  eval-slis.test.js
```

**Modified files:**

```
src/db.js                # Add 3 tables to runMigrations()
src/formatters.js        # Extend cleanUrl() to handle Google Maps
src/server.js            # Add /label, /api/labels, /api/calibration, /api/response-scores routes
src/alerts.js            # Wire SLI breach to sendRuntimeAlert
public/eval.html (or wherever /eval lives) # Response-quality panel
```

---

## Task 1: Database schema for scores, labels, calibration

**Files:**
- Modify: `src/db.js` (extend `runMigrations`)
- Create: `test/unit/eval-schema.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-schema.test.js
const { check } = require('../helpers');
const { getDb } = require('../../src/db');

const db = getDb();

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
check('response_scores table exists', tables.includes('response_scores'));
check('response_labels table exists', tables.includes('response_labels'));
check('calibration_runs table exists', tables.includes('calibration_runs'));

const scoreCols = db.prepare(`PRAGMA table_info(response_scores)`).all().map(c => c.name);
check('response_scores has trace_id', scoreCols.includes('trace_id'));
check('response_scores has axis', scoreCols.includes('axis'));
check('response_scores has score', scoreCols.includes('score'));
check('response_scores has tier', scoreCols.includes('tier'));
check('response_scores has details_json', scoreCols.includes('details_json'));
check('response_scores has scored_at', scoreCols.includes('scored_at'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-schema.test.js
```
Expected: `FAIL` lines for each missing table/column.

- [ ] **Step 3: Add migrations**

Append to the `runMigrations(db)` function in `src/db.js`, after the existing `CREATE TABLE` statements:

```javascript
  db.exec(`
    CREATE TABLE IF NOT EXISTS response_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      axis TEXT NOT NULL,
      score REAL NOT NULL,            -- 0..1 for scalar axes, 0/1 for binary
      tier TEXT NOT NULL,             -- 'programmatic' | 'heuristic' | 'llm'
      details_json TEXT,              -- per-axis structured breakdown
      scored_at TEXT NOT NULL,
      UNIQUE(trace_id, axis)
    );
    CREATE INDEX IF NOT EXISTS idx_response_scores_trace ON response_scores(trace_id);
    CREATE INDEX IF NOT EXISTS idx_response_scores_axis ON response_scores(axis);
    CREATE INDEX IF NOT EXISTS idx_response_scores_scored_at ON response_scores(scored_at);

    CREATE TABLE IF NOT EXISTS response_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      axis TEXT NOT NULL,
      label REAL NOT NULL,            -- human ground truth, same scale as score
      labeler_id TEXT,                -- optional, e.g. 'jk' for now
      notes TEXT,
      labeled_at TEXT NOT NULL,
      UNIQUE(trace_id, axis, labeler_id)
    );
    CREATE INDEX IF NOT EXISTS idx_response_labels_trace ON response_labels(trace_id);

    CREATE TABLE IF NOT EXISTS calibration_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      axis TEXT NOT NULL,
      n_labeled INTEGER NOT NULL,
      agreement REAL NOT NULL,        -- percent agreement, 0..1
      kappa REAL,                     -- Cohen's kappa where applicable
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calibration_runs_axis ON calibration_runs(axis);
  `);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/unit/eval-schema.test.js
```
Expected: All `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/unit/eval-schema.test.js
git commit -m "feat(eval): schema for response_scores, response_labels, calibration_runs"
```

---

## Task 2: Rubric — single source of truth

**Files:**
- Create: `src/eval/rubric.js`
- Create: `test/unit/eval-rubric.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-rubric.test.js
const { check } = require('../helpers');
const { RUBRIC, AXES, getAxis } = require('../../src/eval/rubric');

check('RUBRIC has 7 axes', Object.keys(RUBRIC).length === 7);

const expectedAxes = [
  'output_format_compliance',
  'entity_naming_fidelity',
  'constraint_coverage',
  'promise_delivery_consistency',
  'intent_carry',
  'grounding',
  'tone_brand',
];
for (const a of expectedAxes) {
  check(`axis ${a} defined`, RUBRIC[a] !== undefined);
  check(`axis ${a} has tier`, ['programmatic', 'heuristic', 'llm'].includes(RUBRIC[a].tier));
  check(`axis ${a} has scale`, ['binary', 'scalar'].includes(RUBRIC[a].scale));
  check(`axis ${a} has description`, typeof RUBRIC[a].description === 'string' && RUBRIC[a].description.length > 0);
}

check('AXES exports array of axis names', Array.isArray(AXES) && AXES.length === 7);
check('getAxis returns axis', getAxis('intent_carry').tier === 'llm');
check('getAxis returns null for unknown', getAxis('nonsense') === null);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-rubric.test.js
```
Expected: `Cannot find module '../../src/eval/rubric'`.

- [ ] **Step 3: Implement the rubric**

```javascript
// src/eval/rubric.js
/**
 * Pulse response-level eval rubric.
 *
 * Each axis scores one dimension of a single outgoing SMS response
 * against the user's immediately-preceding turn and session context.
 *
 * Tiers:
 *   programmatic  — deterministic, no model call, runs on every turn
 *   heuristic     — rule-based on structured trace fields (filters, picks)
 *   llm           — LLM-as-judge, batched, calibrated against human labels
 *
 * Scales:
 *   binary  — 0 or 1
 *   scalar  — 0.0 to 1.0
 *
 * SLI thresholds live in src/eval/slis.js, not here. This file is purely
 * the rubric definition.
 */

const RUBRIC = {
  output_format_compliance: {
    tier: 'programmatic',
    scale: 'binary',
    description: 'Response contains no raw tracking URLs, no banned strings, and respects SMS length conventions.',
  },
  entity_naming_fidelity: {
    tier: 'programmatic',
    scale: 'scalar',
    description: 'Every venue/event name mentioned in the response matches a canonical name or known alias in the venues/events tables.',
  },
  constraint_coverage: {
    tier: 'heuristic',
    scale: 'scalar',
    description: 'Every constraint the user explicitly stated (neighborhoods, categories, price, time) is reflected in the response or explicitly acknowledged as not met.',
  },
  promise_delivery_consistency: {
    tier: 'heuristic',
    scale: 'binary',
    description: 'Counts and quantifiers in the response framing ("three picks", "a few options") match what the response actually delivered.',
  },
  intent_carry: {
    tier: 'llm',
    scale: 'binary',
    description: 'When the user shifts topic, the response preserves the active intent unless the user has clearly abandoned it.',
  },
  grounding: {
    tier: 'llm',
    scale: 'scalar',
    description: 'Every factual claim about a venue, event, time, or price ties back to data the model was given. No invented details.',
  },
  tone_brand: {
    tier: 'llm',
    scale: 'scalar',
    description: 'Voice is direct, opinionated, concise, NYC-savvy. Not robotic, not over-apologetic, not generic LLM assistant.',
  },
};

const AXES = Object.keys(RUBRIC);

function getAxis(name) {
  return RUBRIC[name] || null;
}

module.exports = { RUBRIC, AXES, getAxis };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/unit/eval-rubric.test.js
```
Expected: All `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/eval/rubric.js test/unit/eval-rubric.test.js
git commit -m "feat(eval): rubric definition with 7 axes across 3 tiers"
```

---

## Task 3: Programmatic axis — output_format_compliance

**Files:**
- Modify: `src/formatters.js` — extend `cleanUrl` to handle Google Maps
- Create: `src/eval/axes/format-compliance.js`
- Create: `test/unit/eval-format-compliance.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-format-compliance.test.js
const { check } = require('../helpers');
const { scoreFormatCompliance } = require('../../src/eval/axes/format-compliance');

// Clean response → pass
const clean = scoreFormatCompliance({
  output_sms: 'Maison Premiere — oysters, absinthe cocktails, gorgeous garden. $$$, Williamsburg.',
});
check('clean response scores 1', clean.score === 1);
check('clean response has no violations', clean.details.violations.length === 0);

// Raw Google Maps URL with tracking → fail
const dirty = scoreFormatCompliance({
  output_sms: 'Bedford Ave — try it tonight. https://www.google.com/maps?cid=14651869085400931126&_ms=Clnb29nbGUubWFwcy5wbGFjZXM',
});
check('raw maps URL scores 0', dirty.score === 0);
check('raw maps URL flagged', dirty.details.violations.some(v => v.type === 'raw_tracking_url'));

// Banned phrase → fail
const banned = scoreFormatCompliance({
  output_sms: 'As an AI assistant, I cannot recommend specific bars.',
});
check('banned phrase scores 0', banned.score === 0);
check('banned phrase flagged', banned.details.violations.some(v => v.type === 'banned_phrase'));

// Excessive length → fail
const long = scoreFormatCompliance({
  output_sms: 'x'.repeat(1700),
});
check('over-length scores 0', long.score === 0);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-format-compliance.test.js
```
Expected: module not found.

- [ ] **Step 3: Extend cleanUrl to detect Maps tracking params**

In `src/formatters.js`, modify `cleanUrl`:

```javascript
function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Strip UTM, tracking, and Google Maps cid/_ms params
    for (const key of [...u.searchParams.keys()]) {
      if (
        key.startsWith('utm_') ||
        key === 'ref' || key === 'fbclid' || key === 'aff' ||
        key === 'cid' || key === '_ms' || key === 'entry'
      ) {
        u.searchParams.delete(key);
      }
    }
    let clean = u.toString().replace(/\?$/, '');

    // ... existing Eventbrite/Dice/Songkick shortening ...

    return clean;
  } catch { return url; }
}
```

- [ ] **Step 4: Implement the axis**

```javascript
// src/eval/axes/format-compliance.js
/**
 * Programmatic axis: output_format_compliance.
 *
 * Binary. Fails on:
 *   - Raw tracking URLs (Google Maps cid/_ms, UTM params surviving in body)
 *   - Banned LLM-tell phrases ("as an AI", "I cannot", "I'm just an assistant")
 *   - Excessive length (>1600 chars; SMS allows up to 1600 but we cap at 480 per spec)
 *   - Bare URLs without context lines
 */

const TRACKING_PARAM_PATTERN = /[?&](utm_|cid=|_ms=|fbclid=|aff=)/i;
const BANNED_PHRASES = [
  /\bas an ai\b/i,
  /\bi cannot\b/i,
  /\bi'?m just an? (ai|assistant|language model)\b/i,
  /\bi don'?t have access to real-?time\b/i,
];
const MAX_SMS_LENGTH = 1600;

function scoreFormatCompliance(trace) {
  const violations = [];
  const sms = trace.output_sms || '';

  // Find URLs with tracking params still attached
  const urlMatches = sms.match(/https?:\/\/\S+/g) || [];
  for (const url of urlMatches) {
    if (TRACKING_PARAM_PATTERN.test(url)) {
      violations.push({ type: 'raw_tracking_url', url });
    }
  }

  // Banned phrases
  for (const re of BANNED_PHRASES) {
    const m = sms.match(re);
    if (m) violations.push({ type: 'banned_phrase', phrase: m[0] });
  }

  // Length
  if (sms.length > MAX_SMS_LENGTH) {
    violations.push({ type: 'over_length', length: sms.length, max: MAX_SMS_LENGTH });
  }

  return {
    axis: 'output_format_compliance',
    tier: 'programmatic',
    score: violations.length === 0 ? 1 : 0,
    details: { violations },
  };
}

module.exports = { scoreFormatCompliance };
```

- [ ] **Step 5: Run test to verify it passes**

```bash
node test/unit/eval-format-compliance.test.js
```
Expected: All `PASS`.

- [ ] **Step 6: Commit**

```bash
git add src/formatters.js src/eval/axes/format-compliance.js test/unit/eval-format-compliance.test.js
git commit -m "feat(eval): output_format_compliance axis; cleanUrl handles maps cid/_ms"
```

---

## Task 4: Programmatic axis — entity_naming_fidelity

**Files:**
- Create: `src/eval/axes/entity-naming.js`
- Create: `test/unit/eval-entity-naming.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-entity-naming.test.js
const { check } = require('../helpers');
const { scoreEntityNaming, extractMentionedEntities } = require('../../src/eval/axes/entity-naming');

// Extraction — numbered-list pattern
const extracted = extractMentionedEntities(
  '1) Maison Premiere — oysters, $$$, Williamsburg.\n2) Sunday in Brooklyn — alum spot, $$.\n'
);
check('extracts two numbered entities', extracted.length === 2);
check('first entity name is Maison Premiere', extracted[0] === 'Maison Premiere');

// Scoring — all entities resolve in pool
const allMatch = scoreEntityNaming({
  output_sms: '1) Maison Premiere — oysters\n2) Sunday in Brooklyn — alum spot',
  composition: {
    picks: [
      { name: 'Maison Premiere' },
      { name: 'Sunday in Brooklyn' },
    ],
  },
});
check('all-match scores 1', allMatch.score === 1);

// Mismatch — "Bedford Ave" (address rendered as name) against pick "Maison Premiere"
const mismatch = scoreEntityNaming({
  output_sms: 'Bedford Ave — dark, intimate, candlelit. They do oysters.',
  composition: {
    picks: [{ name: 'Maison Premiere', venue_address: '298 Bedford Ave' }],
  },
});
check('address-as-name scores < 1', mismatch.score < 1);
check('address-as-name flagged as unresolved', mismatch.details.unresolved.includes('Bedford Ave'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-entity-naming.test.js
```
Expected: module not found.

- [ ] **Step 3: Implement the axis**

```javascript
// src/eval/axes/entity-naming.js
/**
 * Programmatic axis: entity_naming_fidelity.
 *
 * Scalar. For every venue/event surface form mentioned in the response,
 * does it match a canonical name (or known alias) of one of the picks
 * the model was given?
 *
 * Extraction strategy: numbered-list entries ("1) Name — ...") and
 * leading-line patterns. Conservative — we'd rather under-extract than
 * false-positive on prose.
 */

const NUMBERED_PATTERN = /^\s*\d+\)\s+([^\n—–-]+?)\s+[—–-]/gm;

function extractMentionedEntities(sms) {
  const out = [];
  let m;
  const re = new RegExp(NUMBERED_PATTERN);
  while ((m = re.exec(sms)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function resolvesAgainstPicks(mention, picks) {
  const norm = normalizeName(mention);
  if (!norm) return false;
  for (const p of picks || []) {
    const pn = normalizeName(p.name);
    if (!pn) continue;
    if (pn === norm) return true;
    // Allow the pick name to contain the mention (e.g. "Smalls" vs "Smalls Jazz Club")
    if (pn.includes(norm) || norm.includes(pn)) return true;
  }
  return false;
}

function scoreEntityNaming(trace) {
  const sms = trace.output_sms || '';
  const picks = (trace.composition && trace.composition.picks) || [];
  const mentions = extractMentionedEntities(sms);

  if (mentions.length === 0) {
    return {
      axis: 'entity_naming_fidelity',
      tier: 'programmatic',
      score: 1,            // nothing mentioned, nothing to corrupt
      details: { mentions: [], unresolved: [], n_mentions: 0 },
    };
  }

  const unresolved = mentions.filter(m => !resolvesAgainstPicks(m, picks));
  const score = (mentions.length - unresolved.length) / mentions.length;

  return {
    axis: 'entity_naming_fidelity',
    tier: 'programmatic',
    score,
    details: {
      mentions,
      unresolved,
      n_mentions: mentions.length,
      n_unresolved: unresolved.length,
    },
  };
}

module.exports = { scoreEntityNaming, extractMentionedEntities, normalizeName, resolvesAgainstPicks };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/unit/eval-entity-naming.test.js
```
Expected: All `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/eval/axes/entity-naming.js test/unit/eval-entity-naming.test.js
git commit -m "feat(eval): entity_naming_fidelity axis with numbered-list extraction"
```

---

## Task 5: Heuristic axis — constraint_coverage

**Files:**
- Create: `src/eval/axes/constraint-coverage.js`
- Create: `test/unit/eval-constraint-coverage.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-constraint-coverage.test.js
const { check } = require('../helpers');
const { scoreConstraintCoverage, extractInputConstraints } = require('../../src/eval/axes/constraint-coverage');

// Single neighborhood, met
const single = scoreConstraintCoverage({
  input_message: 'wine bar in greenpoint with food',
  output_sms: '1) Achilles Heel — wine bar, food. Greenpoint.\n',
  composition: { active_filters: { neighborhoods: ['Greenpoint'], category: 'wine' } },
});
check('single-neighborhood-met scores 1', single.score === 1);

// Two neighborhoods, one silently dropped — THE GREENPOINT FAILURE
const dropped = scoreConstraintCoverage({
  input_message: 'classy wine bar in greenpoint or williamsburg with food',
  output_sms: '1) Maison Premiere — Williamsburg.\n2) Sunday in Brooklyn — Williamsburg.\n',
  composition: { active_filters: { neighborhoods: ['Williamsburg'], category: 'wine' } },
});
check('silent-greenpoint-drop scores < 1', dropped.score < 1);
check('drop flagged in details', dropped.details.unmet.some(c => c.value === 'Greenpoint'));

// Explicit acknowledgement of a missed constraint should not penalize
const acknowledged = scoreConstraintCoverage({
  input_message: 'classy wine bar in greenpoint or williamsburg with food',
  output_sms: 'Nothing wine-bar shaped in Greenpoint tonight. Williamsburg picks:\n1) Maison Premiere',
  composition: { active_filters: { neighborhoods: ['Williamsburg'], category: 'wine' } },
});
check('acknowledged-miss scores 1', acknowledged.score === 1);

// Extraction smoke
const cs = extractInputConstraints('wine bar in greenpoint or williamsburg with food');
check('extracts both neighborhoods', cs.neighborhoods.includes('Greenpoint') && cs.neighborhoods.includes('Williamsburg'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-constraint-coverage.test.js
```
Expected: module not found.

- [ ] **Step 3: Implement the axis**

```javascript
// src/eval/axes/constraint-coverage.js
/**
 * Heuristic axis: constraint_coverage.
 *
 * Scalar. For every explicit constraint the user named, was it reflected
 * in the response or explicitly acknowledged as not met? Silent drops
 * (user asks A or B, response covers only A and doesn't say why) are the
 * canonical failure.
 *
 * Constraint sources used here:
 *   - Neighborhood matches against the existing neighborhoods registry
 *   - Category keywords mentioned in the input
 *   - Price-tier and time-window hints
 *
 * For neighborhoods, we use the existing matcher in src/neighborhoods.js
 * so this stays in sync with whatever the agent uses upstream.
 */

const { matchNeighborhoods } = require('../../neighborhoods');

const CATEGORY_KEYWORDS = {
  wine: ['wine', 'wine bar'],
  cocktail: ['cocktail', 'cocktails', 'speakeasy'],
  beer: ['beer', 'brewery', 'dive'],
  food: ['food', 'dinner', 'restaurant', 'eat'],
  music: ['music', 'concert', 'show', 'gig', 'dj'],
  comedy: ['comedy', 'standup', 'stand-up'],
};

function extractInputConstraints(input) {
  const text = (input || '').toLowerCase();
  const neighborhoods = (matchNeighborhoods(input) || []).map(n => n.canonical || n);
  const categories = [];
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(k => text.includes(k))) categories.push(cat);
  }
  return { neighborhoods, categories };
}

function neighborhoodMet(name, sms, activeFilters) {
  const lc = sms.toLowerCase();
  if (lc.includes(name.toLowerCase())) return true;
  // Also met if the active_filters at compose-time included it
  return (activeFilters?.neighborhoods || []).map(n => n.toLowerCase()).includes(name.toLowerCase());
}

function neighborhoodAcknowledged(name, sms) {
  const lc = sms.toLowerCase();
  const n = name.toLowerCase();
  // Patterns like "nothing in greenpoint", "no x in greenpoint tonight"
  const patterns = [
    new RegExp(`nothing.{0,40}\\bin ${n}\\b`),
    new RegExp(`no .{0,30}\\bin ${n}\\b`),
    new RegExp(`\\b${n}\\b.{0,30}\\bquiet\\b`),
    new RegExp(`\\b${n}\\b.{0,30}\\bnothing\\b`),
  ];
  return patterns.some(p => p.test(lc));
}

function categoryMet(cat, sms) {
  const lc = sms.toLowerCase();
  return (CATEGORY_KEYWORDS[cat] || []).some(k => lc.includes(k));
}

function scoreConstraintCoverage(trace) {
  const constraints = extractInputConstraints(trace.input_message);
  const sms = trace.output_sms || '';
  const filters = trace.composition?.active_filters || {};

  const checked = [];
  const unmet = [];

  for (const n of constraints.neighborhoods) {
    const met = neighborhoodMet(n, sms, filters);
    const acked = !met && neighborhoodAcknowledged(n, sms);
    checked.push({ kind: 'neighborhood', value: n, met, acknowledged: acked });
    if (!met && !acked) unmet.push({ kind: 'neighborhood', value: n });
  }

  for (const c of constraints.categories) {
    const met = categoryMet(c, sms);
    checked.push({ kind: 'category', value: c, met, acknowledged: false });
    if (!met) unmet.push({ kind: 'category', value: c });
  }

  const total = checked.length;
  const score = total === 0 ? 1 : (total - unmet.length) / total;

  return {
    axis: 'constraint_coverage',
    tier: 'heuristic',
    score,
    details: { checked, unmet, n_constraints: total, n_unmet: unmet.length },
  };
}

module.exports = { scoreConstraintCoverage, extractInputConstraints };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/unit/eval-constraint-coverage.test.js
```
Expected: All `PASS`. If `matchNeighborhoods` returns a different shape, adapt the `.canonical || n` line in `extractInputConstraints` to match what `src/neighborhoods.js` actually returns and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/eval/axes/constraint-coverage.js test/unit/eval-constraint-coverage.test.js
git commit -m "feat(eval): constraint_coverage axis catches silently-dropped neighborhoods"
```

---

## Task 6: Heuristic axis — promise_delivery_consistency

**Files:**
- Create: `src/eval/axes/promise-delivery.js`
- Create: `test/unit/eval-promise-delivery.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-promise-delivery.test.js
const { check } = require('../helpers');
const { scorePromiseDelivery, parsePromisedCount, countDeliveredItems } = require('../../src/eval/axes/promise-delivery');

check('parses "three picks" as 3', parsePromisedCount('Three picks that actually fit:\n1) ...') === 3);
check('parses "2 options" as 2', parsePromisedCount('I have 2 options for you:\n1) ...') === 2);
check('parses no promise as null', parsePromisedCount('Here you go:\n1) ...') === null);

check('counts numbered items', countDeliveredItems('1) A\n2) B\n3) C') === 3);
check('counts only top-level numbered lines', countDeliveredItems('1) A\nlong sub-line\n2) B') === 2);

// The screenshot failure: "Three picks" / 2 items
const mismatch = scorePromiseDelivery({
  output_sms: 'Three picks that actually fit "classy wine bar with food":\n1) Maison Premiere — ...\n2) Sunday in Brooklyn — ...',
});
check('three-promised-two-delivered scores 0', mismatch.score === 0);
check('mismatch detail has promised=3, delivered=2', mismatch.details.promised === 3 && mismatch.details.delivered === 2);

// Honest match
const ok = scorePromiseDelivery({
  output_sms: 'Three picks:\n1) A — ...\n2) B — ...\n3) C — ...',
});
check('three-promised-three-delivered scores 1', ok.score === 1);

// No promise → pass
const noPromise = scorePromiseDelivery({
  output_sms: 'Here you go:\n1) A — ...',
});
check('no-promise scores 1', noPromise.score === 1);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-promise-delivery.test.js
```
Expected: module not found.

- [ ] **Step 3: Implement the axis**

```javascript
// src/eval/axes/promise-delivery.js
/**
 * Heuristic axis: promise_delivery_consistency.
 *
 * Binary. Compares the count promised in the response framing
 * ("three picks", "2 options", "a few") with the count actually delivered
 * as numbered list items. Silent under-delivery (Maison Premiere case)
 * is the canonical failure.
 */

const WORD_TO_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

const PROMISE_PATTERNS = [
  // "Three picks ...", "two options ...", "five spots ..."
  /\b(one|two|three|four|five|six)\s+(picks|options|spots|places|bars|shows|events|recs|recommendations)\b/i,
  // "3 picks", "2 options"
  /\b(\d+)\s+(picks|options|spots|places|bars|shows|events|recs|recommendations)\b/i,
];

function parsePromisedCount(sms) {
  for (const re of PROMISE_PATTERNS) {
    const m = (sms || '').match(re);
    if (m) {
      const n = isNaN(Number(m[1])) ? WORD_TO_NUM[m[1].toLowerCase()] : Number(m[1]);
      if (n) return n;
    }
  }
  return null;
}

function countDeliveredItems(sms) {
  const lines = (sms || '').split('\n');
  return lines.filter(l => /^\s*\d+\)\s+\S/.test(l)).length;
}

function scorePromiseDelivery(trace) {
  const sms = trace.output_sms || '';
  const promised = parsePromisedCount(sms);
  const delivered = countDeliveredItems(sms);

  if (promised === null) {
    return {
      axis: 'promise_delivery_consistency',
      tier: 'heuristic',
      score: 1,
      details: { promised: null, delivered, note: 'no count promised' },
    };
  }

  return {
    axis: 'promise_delivery_consistency',
    tier: 'heuristic',
    score: promised === delivered ? 1 : 0,
    details: { promised, delivered },
  };
}

module.exports = { scorePromiseDelivery, parsePromisedCount, countDeliveredItems };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/unit/eval-promise-delivery.test.js
```
Expected: All `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/eval/axes/promise-delivery.js test/unit/eval-promise-delivery.test.js
git commit -m "feat(eval): promise_delivery_consistency catches three-promised/two-delivered"
```

---

## Task 7: LLM-as-judge for soft axes

**Files:**
- Create: `src/eval/axes/llm-judge.js`
- Create: `test/unit/eval-llm-judge.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-llm-judge.test.js
const { check } = require('../helpers');
const { buildJudgePrompt, parseJudgeResponse } = require('../../src/eval/axes/llm-judge');

const prompt = buildJudgePrompt({
  input_message: 'what about greenpoint',
  output_sms: 'What are you after in Greenpoint?\n1) Bars / drinks\n2) Dinner\n3) Events',
  session_before: { lastNeighborhood: 'Williamsburg', lastPicks: [{ name: 'Maison Premiere' }] },
  composition: { picks: [] },
});
check('prompt includes user message', prompt.includes('what about greenpoint'));
check('prompt includes session context', prompt.includes('Williamsburg'));
check('prompt asks for JSON output', prompt.toLowerCase().includes('json'));
check('prompt names the three axes', /intent_carry/.test(prompt) && /grounding/.test(prompt) && /tone_brand/.test(prompt));

// Parsing a well-formed judge response
const parsed = parseJudgeResponse(JSON.stringify({
  intent_carry: { score: 0, reason: 'Previous wine-bar intent dropped, generic menu instead.' },
  grounding: { score: 1, reason: 'No specific factual claims to check.' },
  tone_brand: { score: 0.5, reason: 'Generic menu language; not Pulse-voice.' },
}));
check('parses three axes', parsed.length === 3);
check('intent_carry score 0', parsed.find(p => p.axis === 'intent_carry').score === 0);
check('grounding score 1', parsed.find(p => p.axis === 'grounding').score === 1);

// Malformed → throws or returns empty
const bad = parseJudgeResponse('not json at all');
check('malformed returns empty', bad.length === 0);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-llm-judge.test.js
```
Expected: module not found.

- [ ] **Step 3: Implement the judge**

```javascript
// src/eval/axes/llm-judge.js
/**
 * LLM-as-judge for soft axes: intent_carry, grounding, tone_brand.
 *
 * Single Anthropic call per turn. Structured JSON output. Model is Haiku
 * (same as production), so judge and judged are on equal footing until
 * we calibrate against humans and decide whether to upgrade the judge.
 *
 * Costs land in trace.ai_costs.call_type === 'judge' so they're visible
 * in the existing cost reporting without schema changes.
 */

const Anthropic = require('@anthropic-ai/sdk');

const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const SOFT_AXES = ['intent_carry', 'grounding', 'tone_brand'];

const SYSTEM_PROMPT = `You are evaluating a single SMS response from Pulse, an NYC nightlife assistant. You are not the assistant. You score the response on three axes against a strict rubric and return JSON only.

Voice rubric for tone_brand: direct, opinionated, concise, NYC-savvy. Penalize robotic phrasing, over-apology, generic-LLM cadence, hedging.

Intent rubric for intent_carry: when the user pivots topic (e.g. asks about a new neighborhood after a wine-bar query), the response should carry the prior intent forward unless the user clearly abandoned it. Generic menu fallbacks fail this axis.

Grounding rubric: every concrete factual claim (venue name, time, price, address, "they do X") must be supported by data the model was given (visible in 'picks' or 'session_before'). Invented details fail.

Score scale: 0 means clear failure on the axis. 1 means clean pass. For grounding and tone_brand only, partial scores in {0.25, 0.5, 0.75} are allowed when the response is mixed.`;

function buildJudgePrompt({ input_message, output_sms, session_before, composition }) {
  const picks = (composition?.picks || []).map(p => ({
    name: p.name, venue: p.venue_name, neighborhood: p.neighborhood, when: p.start_time_local,
  }));
  return `Conversation context:

USER said: ${JSON.stringify(input_message)}

Session before this turn:
${JSON.stringify(session_before || {}, null, 2)}

Data the model was given as candidate picks:
${JSON.stringify(picks, null, 2)}

PULSE responded: ${JSON.stringify(output_sms)}

Return JSON of exactly this shape, no other text:

{
  "intent_carry":  {"score": 0 | 1,                    "reason": "..."},
  "grounding":     {"score": 0 | 0.25 | 0.5 | 0.75 | 1, "reason": "..."},
  "tone_brand":    {"score": 0 | 0.25 | 0.5 | 0.75 | 1, "reason": "..."}
}`;
}

function parseJudgeResponse(text) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return [];
    const obj = JSON.parse(text.slice(start, end + 1));
    const out = [];
    for (const axis of SOFT_AXES) {
      if (obj[axis] && typeof obj[axis].score === 'number') {
        out.push({
          axis,
          tier: 'llm',
          score: obj[axis].score,
          details: { reason: obj[axis].reason || '' },
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function scoreSoftAxes(trace, { apiKey } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return SOFT_AXES.map(axis => ({
      axis, tier: 'llm', score: null,
      details: { reason: 'ANTHROPIC_API_KEY not set; skipped' },
    }));
  }
  const client = new Anthropic({ apiKey: key });
  const prompt = buildJudgePrompt(trace);
  const msg = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (msg.content || []).map(b => b.text || '').join('');
  const scored = parseJudgeResponse(text);
  // Fill missing axes with nulls so callers see a row per axis
  const present = new Set(scored.map(s => s.axis));
  for (const axis of SOFT_AXES) {
    if (!present.has(axis)) {
      scored.push({ axis, tier: 'llm', score: null, details: { reason: 'judge did not return this axis' } });
    }
  }
  return scored;
}

module.exports = { scoreSoftAxes, buildJudgePrompt, parseJudgeResponse, SOFT_AXES, JUDGE_MODEL };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/unit/eval-llm-judge.test.js
```
Expected: All `PASS`. (Test does not hit the API; only `buildJudgePrompt` and `parseJudgeResponse`.)

- [ ] **Step 5: Commit**

```bash
git add src/eval/axes/llm-judge.js test/unit/eval-llm-judge.test.js
git commit -m "feat(eval): LLM-as-judge for intent_carry, grounding, tone_brand"
```

---

## Task 8: Orchestrator + trace-replay harness

**Files:**
- Create: `src/eval/orchestrator.js`
- Create: `scripts/replay-traces.js`
- Create: `test/unit/eval-orchestrator.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-orchestrator.test.js
const { check } = require('../helpers');
const { scoreTrace } = require('../../src/eval/orchestrator');

(async () => {
  const trace = {
    id: 'test-trace-1',
    input_message: 'wine bar in greenpoint with food',
    output_sms: '1) Achilles Heel — wine bar, Greenpoint.',
    session_before: { lastNeighborhood: null, lastPicks: null },
    composition: {
      picks: [{ name: 'Achilles Heel', neighborhood: 'Greenpoint' }],
      active_filters: { neighborhoods: ['Greenpoint'], category: 'wine' },
    },
  };
  const scores = await scoreTrace(trace, { skipLLM: true });
  check('scores 4 programmatic+heuristic axes when LLM skipped', scores.length === 4);
  const byAxis = Object.fromEntries(scores.map(s => [s.axis, s.score]));
  check('format compliance passes', byAxis.output_format_compliance === 1);
  check('entity naming passes', byAxis.entity_naming_fidelity === 1);
  check('constraint coverage passes', byAxis.constraint_coverage === 1);
  check('promise delivery passes', byAxis.promise_delivery_consistency === 1);
})();
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-orchestrator.test.js
```
Expected: module not found.

- [ ] **Step 3: Implement the orchestrator**

```javascript
// src/eval/orchestrator.js
/**
 * Runs the full rubric against a single trace and writes scores to DB.
 *
 * Idempotent — UNIQUE(trace_id, axis) means re-runs upsert.
 *
 * skipLLM=true is useful for fast local runs and unit tests; the LLM
 * judge incurs API cost and latency, so backfills are tiered.
 */

const { scoreFormatCompliance } = require('./axes/format-compliance');
const { scoreEntityNaming } = require('./axes/entity-naming');
const { scoreConstraintCoverage } = require('./axes/constraint-coverage');
const { scorePromiseDelivery } = require('./axes/promise-delivery');
const { scoreSoftAxes } = require('./axes/llm-judge');
const { getDb } = require('../db');

async function scoreTrace(trace, { skipLLM = false } = {}) {
  const scores = [
    scoreFormatCompliance(trace),
    scoreEntityNaming(trace),
    scoreConstraintCoverage(trace),
    scorePromiseDelivery(trace),
  ];
  if (!skipLLM) {
    const soft = await scoreSoftAxes(trace);
    scores.push(...soft);
  }
  return scores;
}

function persistScores(traceId, scores) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO response_scores (trace_id, axis, score, tier, details_json, scored_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(trace_id, axis) DO UPDATE SET
      score = excluded.score,
      tier = excluded.tier,
      details_json = excluded.details_json,
      scored_at = excluded.scored_at
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      if (r.score === null || r.score === undefined) continue;
      stmt.run(traceId, r.axis, r.score, r.tier, JSON.stringify(r.details || {}), now);
    }
  });
  tx(scores);
}

async function scoreAndPersist(trace, opts) {
  const scores = await scoreTrace(trace, opts);
  persistScores(trace.id, scores);
  return scores;
}

module.exports = { scoreTrace, persistScores, scoreAndPersist };
```

- [ ] **Step 4: Implement the replay harness**

```javascript
// scripts/replay-traces.js
/**
 * Iterate every JSONL line in data/traces/, score it, write to response_scores.
 *
 * Usage:
 *   node scripts/replay-traces.js                  # programmatic + heuristic only
 *   node scripts/replay-traces.js --llm            # include LLM judge ($)
 *   node scripts/replay-traces.js --since=2026-05-25
 *   node scripts/replay-traces.js --limit=100
 */

const fs = require('fs');
const path = require('path');
const { scoreAndPersist } = require('../src/eval/orchestrator');

const TRACES_DIR = path.join(__dirname, '..', 'data', 'traces');

function parseArgs() {
  const args = { llm: false, since: null, limit: Infinity };
  for (const a of process.argv.slice(2)) {
    if (a === '--llm') args.llm = true;
    else if (a.startsWith('--since=')) args.since = a.slice('--since='.length);
    else if (a.startsWith('--limit=')) args.limit = Number(a.slice('--limit='.length));
  }
  return args;
}

async function main() {
  const { llm, since, limit } = parseArgs();
  const files = fs.readdirSync(TRACES_DIR)
    .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
    .sort();

  let scored = 0;
  for (const file of files) {
    const date = file.replace('traces-', '').replace('.jsonl', '');
    if (since && date < since) continue;
    const full = path.join(TRACES_DIR, file);
    const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);

    for (const line of lines) {
      if (scored >= limit) break;
      let trace;
      try { trace = JSON.parse(line); } catch { continue; }
      if (!trace.id || !trace.output_sms) continue;
      try {
        await scoreAndPersist(trace, { skipLLM: !llm });
        scored += 1;
        if (scored % 25 === 0) console.log(`  scored ${scored}`);
      } catch (err) {
        console.error(`  trace ${trace.id} failed:`, err.message);
      }
    }
    if (scored >= limit) break;
  }
  console.log(`Done. Scored ${scored} traces.`);
}

main();
```

- [ ] **Step 5: Run unit test, then a small replay**

```bash
node test/unit/eval-orchestrator.test.js
```
Expected: All `PASS`.

```bash
node scripts/replay-traces.js --limit=10
```
Expected: log lines, no crash. Then verify:

```bash
sqlite3 data/pulse.db 'SELECT axis, COUNT(*), AVG(score) FROM response_scores GROUP BY axis;'
```
Expected: 4 rows (one per programmatic+heuristic axis), counts ≤ 10.

- [ ] **Step 6: Commit**

```bash
git add src/eval/orchestrator.js scripts/replay-traces.js test/unit/eval-orchestrator.test.js
git commit -m "feat(eval): orchestrator + trace-replay harness with idempotent persist"
```

---

## Task 9: Labeling UI + calibration computation

**Files:**
- Create: `src/eval/calibration.js`
- Create: `src/label-ui.html`
- Modify: `src/server.js` — add `/label`, `/api/labels`, `/api/calibration` routes
- Create: `test/unit/eval-calibration.test.js`

- [ ] **Step 1: Write the failing test for calibration math**

```javascript
// test/unit/eval-calibration.test.js
const { check } = require('../helpers');
const { agreement, cohensKappa } = require('../../src/eval/calibration');

check('perfect agreement is 1', agreement([1, 0, 1, 0], [1, 0, 1, 0]) === 1);
check('zero agreement is 0', agreement([1, 1, 1, 1], [0, 0, 0, 0]) === 0);
check('half agreement is 0.5', agreement([1, 0, 1, 0], [1, 1, 0, 0]) === 0.5);

// Cohen's kappa with all-agree → 1
check('kappa all-agree is 1', Math.abs(cohensKappa([1, 0, 1, 0], [1, 0, 1, 0]) - 1) < 1e-9);
// Random independent → near 0
const r1 = [1, 1, 0, 0, 1, 0, 1, 0];
const r2 = [1, 0, 1, 0, 0, 1, 0, 1];
check('kappa near 0 for independent', Math.abs(cohensKappa(r1, r2)) < 0.5);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-calibration.test.js
```
Expected: module not found.

- [ ] **Step 3: Implement calibration math + persistence**

```javascript
// src/eval/calibration.js
/**
 * Judge-rater agreement computation.
 *
 * For binary axes we use Cohen's kappa as the headline number and raw
 * percent agreement as the secondary. For scalar axes we bucket into
 * {0, 0.25, 0.5, 0.75, 1} and treat them as ordinal.
 *
 * A calibration_runs row records the agreement for one axis, one
 * window, one snapshot.
 */

const { getDb } = require('../db');

function agreement(judge, human) {
  if (judge.length !== human.length || judge.length === 0) return 0;
  let agree = 0;
  for (let i = 0; i < judge.length; i++) if (judge[i] === human[i]) agree += 1;
  return agree / judge.length;
}

function cohensKappa(judge, human) {
  if (judge.length !== human.length || judge.length === 0) return 0;
  const po = agreement(judge, human);
  // Expected agreement assuming independence
  const labels = new Set([...judge, ...human]);
  let pe = 0;
  for (const l of labels) {
    const pj = judge.filter(v => v === l).length / judge.length;
    const ph = human.filter(v => v === l).length / human.length;
    pe += pj * ph;
  }
  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}

function bucketize(score) {
  // Round to nearest 0.25 for ordinal comparison on scalar axes
  return Math.round(score * 4) / 4;
}

function computeForAxis(axis, windowStart, windowEnd) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.score AS judge, l.label AS human
    FROM response_scores s
    JOIN response_labels l ON l.trace_id = s.trace_id AND l.axis = s.axis
    WHERE s.axis = ?
      AND l.labeled_at BETWEEN ? AND ?
  `).all(axis, windowStart, windowEnd);

  if (rows.length === 0) return null;
  const j = rows.map(r => bucketize(r.judge));
  const h = rows.map(r => bucketize(r.human));
  return {
    axis,
    n_labeled: rows.length,
    agreement: agreement(j, h),
    kappa: cohensKappa(j, h),
    window_start: windowStart,
    window_end: windowEnd,
  };
}

function persistCalibration(snap) {
  if (!snap) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO calibration_runs (axis, n_labeled, agreement, kappa, window_start, window_end, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(snap.axis, snap.n_labeled, snap.agreement, snap.kappa, snap.window_start, snap.window_end, new Date().toISOString());
}

module.exports = { agreement, cohensKappa, bucketize, computeForAxis, persistCalibration };
```

- [ ] **Step 4: Implement the labeling UI**

```html
<!-- src/label-ui.html -->
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Pulse — Label</title>
  <style>
    body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; }
    .turn { background: #f4f4f4; padding: 12px; border-radius: 6px; margin: 8px 0; white-space: pre-wrap; }
    .axis { display: grid; grid-template-columns: 1fr auto auto auto auto auto; gap: 8px; align-items: center; margin: 6px 0; padding: 6px; border-bottom: 1px solid #eee; }
    .axis-name { font-weight: 600; }
    .judge { color: #888; font-size: 12px; }
    button { cursor: pointer; padding: 6px 10px; border: 1px solid #ccc; background: white; border-radius: 4px; }
    button.selected { background: #222; color: white; border-color: #222; }
    .save { background: #2a8; color: white; border-color: #2a8; }
  </style>
</head>
<body>
  <h2>Pulse label</h2>
  <div id="status">loading...</div>
  <div id="trace"></div>
  <h3>Score each axis</h3>
  <div id="axes"></div>
  <button class="save" id="save" disabled>Save labels and load next</button>
  <button id="skip">Skip this trace</button>

<script>
const AXES = [
  { name: 'output_format_compliance', scale: [0, 1] },
  { name: 'entity_naming_fidelity',   scale: [0, 0.25, 0.5, 0.75, 1] },
  { name: 'constraint_coverage',      scale: [0, 0.25, 0.5, 0.75, 1] },
  { name: 'promise_delivery_consistency', scale: [0, 1] },
  { name: 'intent_carry',             scale: [0, 1] },
  { name: 'grounding',                scale: [0, 0.25, 0.5, 0.75, 1] },
  { name: 'tone_brand',               scale: [0, 0.25, 0.5, 0.75, 1] },
];

const state = { trace: null, judge: {}, labels: {} };

// Build a "User: ..." or "Pulse: ..." turn block using DOM methods only.
// Never use innerHTML with the trace content — input_message and output_sms
// are real user-generated SMS bodies and could contain anything.
function makeTurn(label, body) {
  const div = document.createElement('div');
  div.className = 'turn';
  const b = document.createElement('b');
  b.textContent = label + ': ';
  div.appendChild(b);
  div.appendChild(document.createTextNode(body || ''));
  return div;
}

async function load() {
  state.labels = {};
  const r = await fetch('/api/labels/next');
  const data = await r.json();
  if (!data.trace) { document.getElementById('status').textContent = 'No unlabeled traces.'; return; }
  state.trace = data.trace;
  state.judge = data.judge_scores || {};
  document.getElementById('status').textContent = 'trace ' + data.trace.id;
  const traceEl = document.getElementById('trace');
  traceEl.textContent = '';
  traceEl.appendChild(makeTurn('User', data.trace.input_message));
  traceEl.appendChild(makeTurn('Pulse', data.trace.output_sms));
  renderAxes();
}

function renderAxes() {
  const el = document.getElementById('axes');
  el.textContent = '';
  for (const axis of AXES) {
    const row = document.createElement('div');
    row.className = 'axis';

    const name = document.createElement('span');
    name.className = 'axis-name';
    name.textContent = axis.name;
    row.appendChild(name);

    const judge = document.createElement('span');
    judge.className = 'judge';
    const j = state.judge[axis.name];
    judge.textContent = 'judge: ' + (j === undefined ? '—' : j);
    row.appendChild(judge);

    for (const v of axis.scale) {
      const btn = document.createElement('button');
      btn.dataset.axis = axis.name;
      btn.dataset.v = String(v);
      btn.textContent = String(v);
      btn.addEventListener('click', () => {
        state.labels[axis.name] = v;
        row.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
        btn.classList.add('selected');
        document.getElementById('save').disabled = Object.keys(state.labels).length < AXES.length;
      });
      row.appendChild(btn);
    }
    el.appendChild(row);
  }
}

document.getElementById('save').addEventListener('click', async () => {
  await fetch('/api/labels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trace_id: state.trace.id, labels: state.labels, labeler_id: 'jk' }),
  });
  await load();
});
document.getElementById('skip').addEventListener('click', load);

load();
</script>
</body>
</html>
```

- [ ] **Step 5: Wire routes in `src/server.js`**

Add these routes (locate them next to the existing eval-related routes, after the health-auth block):

```javascript
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { computeForAxis, persistCalibration } = require('./eval/calibration');
const { AXES } = require('./eval/rubric');

app.get('/label', (req, res) => {
  res.sendFile(path.join(__dirname, 'label-ui.html'));
});

app.get('/api/labels/next', (req, res) => {
  const db = getDb();
  // Find a trace with judge scores but no human labels yet
  const row = db.prepare(`
    SELECT DISTINCT trace_id
    FROM response_scores
    WHERE trace_id NOT IN (SELECT DISTINCT trace_id FROM response_labels)
    LIMIT 1
  `).get();
  if (!row) return res.json({ trace: null });

  // Load the trace from JSONL (latest day searched first)
  const dir = path.join(__dirname, '..', 'data', 'traces');
  const files = fs.readdirSync(dir).filter(f => f.startsWith('traces-') && f.endsWith('.jsonl')).sort().reverse();
  let trace = null;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const t = JSON.parse(line);
        if (t.id === row.trace_id) { trace = t; break; }
      } catch {}
    }
    if (trace) break;
  }
  if (!trace) return res.json({ trace: null });

  const scoreRows = db.prepare(`SELECT axis, score FROM response_scores WHERE trace_id = ?`).all(row.trace_id);
  const judge_scores = Object.fromEntries(scoreRows.map(r => [r.axis, r.score]));
  res.json({ trace: { id: trace.id, input_message: trace.input_message, output_sms: trace.output_sms }, judge_scores });
});

app.post('/api/labels', express.json(), (req, res) => {
  const { trace_id, labels, labeler_id } = req.body || {};
  if (!trace_id || !labels) return res.status(400).json({ error: 'missing trace_id or labels' });
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO response_labels (trace_id, axis, label, labeler_id, labeled_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(trace_id, axis, labeler_id) DO UPDATE SET label = excluded.label, labeled_at = excluded.labeled_at
  `);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const [axis, label] of Object.entries(labels)) stmt.run(trace_id, axis, label, labeler_id || 'anon', now);
  });
  tx();
  res.json({ ok: true });
});

app.get('/api/calibration', (req, res) => {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const out = [];
  for (const axis of AXES) {
    const snap = computeForAxis(axis, start, end);
    if (snap) out.push(snap);
  }
  res.json({ window_start: start, window_end: end, axes: out });
});
```

- [ ] **Step 6: Run unit test and smoke-test the routes**

```bash
node test/unit/eval-calibration.test.js
```
Expected: All `PASS`.

```bash
# In one terminal:
PULSE_TEST_MODE=true node src/server.js
# In another:
curl http://localhost:3000/api/calibration
```
Expected: JSON with `axes: []` (no labels yet) or per-axis snapshots if you've labeled some traces.

- [ ] **Step 7: Commit**

```bash
git add src/eval/calibration.js src/label-ui.html src/server.js test/unit/eval-calibration.test.js
git commit -m "feat(eval): labeling UI + calibration (agreement + Cohen's kappa)"
```

---

## Task 10: SLIs and graduated alerts

**Files:**
- Create: `src/eval/slis.js`
- Create: `scripts/check-slis.js`
- Create: `test/unit/eval-slis.test.js`
- Modify: `src/alerts.js` — extend exports for eval breach alerts

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-slis.test.js
const { check } = require('../helpers');
const { SLI_TARGETS, evaluateWindow } = require('../../src/eval/slis');

check('format_compliance target is 1.0', SLI_TARGETS.output_format_compliance.target === 1.0);
check('entity_naming target ≥ 0.95', SLI_TARGETS.entity_naming_fidelity.target >= 0.95);

const result = evaluateWindow({
  output_format_compliance: { mean: 0.92, n: 200 },
  entity_naming_fidelity:   { mean: 0.97, n: 200 },
  constraint_coverage:      { mean: 0.88, n: 200 },
});
check('format breach detected', result.breaches.some(b => b.axis === 'output_format_compliance'));
check('entity_naming not breached', !result.breaches.some(b => b.axis === 'entity_naming_fidelity'));
check('coverage breach detected', result.breaches.some(b => b.axis === 'constraint_coverage'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/unit/eval-slis.test.js
```
Expected: module not found.

- [ ] **Step 3: Define SLIs and breach evaluation**

```javascript
// src/eval/slis.js
/**
 * SLI targets per axis. Targets are mean score over a rolling window.
 * `min_n` is the minimum sample count below which we don't report
 * (avoids alerting on noise).
 */

const SLI_TARGETS = {
  output_format_compliance:    { target: 1.00, min_n: 50,  hard_floor: true },
  entity_naming_fidelity:      { target: 0.95, min_n: 50,  hard_floor: false },
  constraint_coverage:         { target: 0.90, min_n: 50,  hard_floor: false },
  promise_delivery_consistency:{ target: 0.95, min_n: 50,  hard_floor: false },
  intent_carry:                { target: 0.85, min_n: 30,  hard_floor: false },
  grounding:                   { target: 0.90, min_n: 30,  hard_floor: false },
  tone_brand:                  { target: 0.80, min_n: 30,  hard_floor: false },
};

function evaluateWindow(stats) {
  const breaches = [];
  for (const [axis, agg] of Object.entries(stats)) {
    const t = SLI_TARGETS[axis];
    if (!t) continue;
    if (agg.n < t.min_n) continue;
    if (agg.mean < t.target) {
      breaches.push({
        axis,
        mean: agg.mean,
        target: t.target,
        n: agg.n,
        severity: t.hard_floor ? 'red' : (agg.mean < t.target * 0.9 ? 'red' : 'yellow'),
      });
    }
  }
  return { breaches };
}

module.exports = { SLI_TARGETS, evaluateWindow };
```

- [ ] **Step 4: Implement the daily checker**

```javascript
// scripts/check-slis.js
/**
 * Compute window stats over the last 24h of response_scores, evaluate
 * against SLI targets, and fire an alert if any axis breaches.
 *
 * Run on a cron or daily timer (or manually for now).
 */

const { getDb } = require('../src/db');
const { evaluateWindow } = require('../src/eval/slis');
const { AXES } = require('../src/eval/rubric');
const { sendRuntimeAlert } = require('../src/alerts');

function windowStats(hours = 24) {
  const db = getDb();
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT axis, AVG(score) AS mean, COUNT(*) AS n
    FROM response_scores
    WHERE scored_at >= ?
    GROUP BY axis
  `).all(cutoff);
  const out = {};
  for (const a of AXES) out[a] = { mean: 1, n: 0 };
  for (const r of rows) out[r.axis] = { mean: r.mean, n: r.n };
  return out;
}

async function main() {
  const stats = windowStats(24);
  const { breaches } = evaluateWindow(stats);
  console.log(JSON.stringify({ stats, breaches }, null, 2));
  if (breaches.length > 0) {
    await sendRuntimeAlert('eval_sli_breach', {
      axes: breaches.map(b => `${b.axis} ${b.mean.toFixed(2)} < ${b.target} (n=${b.n}, ${b.severity})`).join('; '),
    });
  }
}

main();
```

- [ ] **Step 5: Run tests and smoke-check**

```bash
node test/unit/eval-slis.test.js
```
Expected: All `PASS`.

```bash
node scripts/check-slis.js
```
Expected: prints stats per axis; if you've replayed traces and have at least one axis under target, an alert fires (no-op if `RESEND_API_KEY` unset, which is fine — the log line is the signal).

- [ ] **Step 6: Commit**

```bash
git add src/eval/slis.js scripts/check-slis.js test/unit/eval-slis.test.js
git commit -m "feat(eval): SLI targets + daily breach checker with graduated alerts"
```

---

## Task 11: Dashboard panel

**Files:**
- Modify: the existing `/eval` HTML/JS (location depends on current implementation; check `src/server.js` for where `/eval` is served from)
- Add: `/api/response-scores/summary` endpoint in `src/server.js`

- [ ] **Step 1: Add the summary endpoint**

In `src/server.js`:

```javascript
app.get('/api/response-scores/summary', (req, res) => {
  const db = getDb();
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT axis, AVG(score) AS mean, COUNT(*) AS n,
           SUM(CASE WHEN score < 1 THEN 1 ELSE 0 END) AS n_below_one
    FROM response_scores
    WHERE scored_at >= ?
    GROUP BY axis
  `).all(cutoff);

  const recent = db.prepare(`
    SELECT trace_id, axis, score, details_json, scored_at
    FROM response_scores
    WHERE score < 1 AND scored_at >= ?
    ORDER BY scored_at DESC
    LIMIT 50
  `).all(cutoff);

  res.json({ window_days: 7, by_axis: rows, recent_failures: recent });
});
```

- [ ] **Step 2: Add a Response Quality panel to the `/eval` page**

Append to whichever HTML file serves `/eval` (likely `src/public/eval.html` or similar — confirm by reading `src/server.js`). Insert near other panels:

```html
<section id="response-quality">
  <h2>Response Quality (7-day)</h2>
  <table id="rq-summary">
    <thead><tr><th>Axis</th><th>Mean</th><th>n</th><th>Failures</th></tr></thead>
    <tbody></tbody>
  </table>
  <h3>Recent failures</h3>
  <ul id="rq-recent"></ul>
</section>
<script>
fetch('/api/response-scores/summary').then(r => r.json()).then(d => {
  const tbody = document.querySelector('#rq-summary tbody');
  for (const row of d.by_axis) {
    const tr = document.createElement('tr');
    for (const cell of [row.axis, row.mean.toFixed(3), String(row.n), String(row.n_below_one)]) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  const ul = document.getElementById('rq-recent');
  for (const f of d.recent_failures) {
    const li = document.createElement('li');
    let details = '';
    try { details = JSON.stringify(JSON.parse(f.details_json)); } catch {}
    // details_json originates from our own axis code, but trace_id and axis
    // are joined via SQL — keep textContent to stay safe by default.
    li.textContent = `${f.scored_at}  ${f.axis}=${f.score}  trace=${f.trace_id}  ${details.slice(0, 200)}`;
    ul.appendChild(li);
  }
});
</script>
```

- [ ] **Step 3: Smoke-test**

```bash
PULSE_TEST_MODE=true node src/server.js
# In another terminal:
curl http://localhost:3000/api/response-scores/summary | jq .
# Then visit http://localhost:3000/eval in a browser.
```

Expected: JSON with `by_axis` and `recent_failures`. UI shows the new panel populated.

- [ ] **Step 4: Commit**

```bash
git add src/server.js src/public/eval.html   # adjust path to wherever /eval lives
git commit -m "feat(eval): /api/response-scores/summary + UI panel for 7-day axis health"
```

---

## Operating the system after build

1. **Initial backfill:** `node scripts/replay-traces.js --since=2026-05-01` to score every captured trace against the four cheap axes. Then a smaller pass with `--llm --limit=200` to seed the LLM-judged axes without burning budget.
2. **Label 50–100 traces** at `/label` covering at least 20 per axis to establish a calibration baseline.
3. **Run `node scripts/check-slis.js`** daily (cron or Railway scheduled job). Each run logs window stats and fires `eval_sli_breach` alerts on threshold breach.
4. **Inspect calibration weekly** via `/api/calibration`. If any axis has judge-rater agreement below 0.80, that axis's SLI is fiction until the rubric or the judge prompt is fixed. Treat this as a hard precondition: an axis under 0.80 agreement gets paused as a gating SLI and demoted to dashboard-only until rubric work brings it back.
5. **Refresh the labeled set quarterly.** Adversarial / hard-case examples have a half-life — once a class of failure is patched, those examples stop providing signal. Pull a fresh 50 traces stratified by axis-failure to keep the calibration honest.

## Self-review

**Spec coverage:** Every failure in the motivating table maps to an axis (Tasks 3, 4, 5, 6, 7) → orchestrator (Task 8) → calibration (Task 9) → SLI alerts (Task 10) → dashboard (Task 11). The schema in Task 1 and the rubric in Task 2 underpin all of it.

**Placeholders:** Every code step has full code. The only "depends on existing file location" placeholder is the path to the `/eval` page's HTML in Task 11; that requires a `grep` in the repo to confirm before editing.

**Type consistency:** All axes return `{ axis, tier, score, details }`. Orchestrator persists from that shape. SLI evaluator reads `{ mean, n }` aggregated by axis. Calibration reads `score` and `label` columns on tables defined in Task 1. Names match across tasks.

**Open hooks that could harden later (not in scope here):**
- Per-labeler agreement when more than one human labels (currently `labeler_id` defaults to `anon`).
- Active sampling — prioritize labeling traces where judge confidence is borderline rather than uniform.
- Cost tracking for the LLM judge as a first-class SLI (it ties to existing `ai_costs` flow).
- A `regression-on-commit` flow: snapshot mean scores per axis on `main`, diff against PR branches, gate merges on no-regression.
