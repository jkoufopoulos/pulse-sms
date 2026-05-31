# Context Carryover Eval — v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manual scoring loop for context carryover quality — 10 scripted scenarios replay against a fixture pool, capturing per-turn artifacts; a `/eval` workspace UI lets you label each turn on a single 1-5 axis with notes; labels persist to `response_labels` and surface across runs by `(scenario_id, turn_index)`.

**Architecture:** Two new tables (`eval_runs`, `eval_turn_captures`) hold reproducible per-turn snapshots; the existing `response_labels` table holds human grades and is joined back via `trace_id`. Replay wires `enableTestCapture` (twilio.js) + `setEventCache` (a new export on events.js) to suppress real SMS and inject a fixed event pool, then calls `handleAgentRequestGraph` per turn and persists everything it needed to look at to decide. The workspace is a single HTML page with vanilla JS hitting four `/api/eval/*` routes.

**Tech Stack:** Existing — Node, `better-sqlite3`, `express`, the project's custom `check()` test helper at `test/helpers.js`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-31-context-carryover-eval-design.md`. This plan supersedes the prior draft `docs/superpowers/plans/2026-05-31-continuity-eval.md` (which targeted a mechanical-matcher-only flow without a workspace UI); Task 11 deletes that draft.

---

## File Structure

**New files:**
```
src/eval/carryover/
  matcher.js                # deep partial-match with $present, $absent, $regex, $in, $contains, $absent_or_empty
  scenario-loader.js        # read + validate scenarios from disk
  replay.js                 # run one scenario through handleAgentRequestGraph, capture per-turn, persist
  fixtures/events.json      # 15 stable events spanning scenario hoods + categories
  scenarios/
    01-filter-add-time.json
    02-filter-carries-across-hood-swap.json
    03-filter-drop-explicit.json
    04-more-keeps-frame.json
    05-numeric-pick-is-details.json
    06-intent-survives-hood-swap.json
    07-disjunction-honored.json
    08-date-swap.json
    09-greeting-then-hood.json
    10-comedy-keyword-refinement.json

scripts/
  eval-carryover.js         # CLI entry: load scenarios, run replay, create eval_runs row

src/eval-ui.html            # workspace UI (3 nested views, vanilla JS)

test/unit/
  eval-runs-schema.test.js
  eval-matcher.test.js
  eval-scenario-loader.test.js
  eval-replay.test.js
```

**Modified files:**
```
src/db.js                   # add eval_runs + eval_turn_captures migrations
src/events.js               # add setEventCache export
src/server.js               # add /api/eval/* routes + GET /eval
package.json                # add eval:carryover script
test/run-all.js             # register 4 new test files
CLAUDE.md                   # update eval section
```

---

## Task 1: Schema migrations for eval_runs + eval_turn_captures

The two new tables let the workspace render per-turn captures and find prior labels on the same logical turn across runs.

**Files:**
- Create: `test/unit/eval-runs-schema.test.js`
- Modify: `src/db.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-runs-schema.test.js
const Database = require('better-sqlite3');
const { check } = require('../helpers');
const { runMigrations } = require('../../src/db');

console.log('\n--- eval-runs-schema.test.js ---');

const db = new Database(':memory:');
runMigrations(db);

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
check('eval_runs table exists', tables.includes('eval_runs'));
check('eval_turn_captures table exists', tables.includes('eval_turn_captures'));

// eval_runs columns
const runCols = db.prepare(`PRAGMA table_info(eval_runs)`).all().map(c => c.name);
check('eval_runs has id', runCols.includes('id'));
check('eval_runs has started_at', runCols.includes('started_at'));
check('eval_runs has git_sha', runCols.includes('git_sha'));
check('eval_runs has model', runCols.includes('model'));
check('eval_runs has env_flags', runCols.includes('env_flags'));
check('eval_runs has notes', runCols.includes('notes'));

// eval_turn_captures columns
const capCols = db.prepare(`PRAGMA table_info(eval_turn_captures)`).all().map(c => c.name);
const requiredCapCols = [
  'id', 'run_id', 'scenario_id', 'turn_index', 'trace_id',
  'user_msg', 'brain_prompt', 'brain_messages', 'tool_call', 'agent_sms',
  'session_before', 'session_after', 'matcher_result', 'captured_at',
];
for (const col of requiredCapCols) {
  check(`eval_turn_captures has ${col}`, capCols.includes(col));
}

// UNIQUE constraint on (run_id, scenario_id, turn_index)
const insertRun = db.prepare(`INSERT INTO eval_runs (started_at, model) VALUES (?, ?)`);
const runId = insertRun.run('2026-05-31T00:00:00Z', 'test-model').lastInsertRowid;
const insertCap = db.prepare(`INSERT INTO eval_turn_captures
  (run_id, scenario_id, turn_index, trace_id, user_msg, captured_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
insertCap.run(runId, 'sc1', 0, 'trace-a', 'hi', '2026-05-31T00:00:00Z');
let threw = false;
try { insertCap.run(runId, 'sc1', 0, 'trace-b', 'hi again', '2026-05-31T00:00:01Z'); } catch { threw = true; }
check('UNIQUE(run_id, scenario_id, turn_index) rejects duplicates', threw);

// Index for prior-label lookups across runs
const indices = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='eval_turn_captures'`).all().map(r => r.name);
check('idx_captures_scenario_turn index exists', indices.includes('idx_captures_scenario_turn'));

db.close();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/unit/eval-runs-schema.test.js`
Expected: All checks FAIL — tables don't exist yet.

- [ ] **Step 3: Add migrations to src/db.js**

In `src/db.js`, find the existing `runMigrations(db)` function (line 30) and look for the most recent `CREATE TABLE IF NOT EXISTS calibration_runs` block (already there from commit `b12d5df`). Immediately after that block, inside the same `db.exec(...)` template literal, add:

```sql
    CREATE TABLE IF NOT EXISTS eval_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      git_sha TEXT,
      model TEXT NOT NULL,
      env_flags TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS eval_turn_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES eval_runs(id),
      scenario_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      user_msg TEXT NOT NULL,
      brain_prompt TEXT,
      brain_messages TEXT,
      tool_call TEXT,
      agent_sms TEXT,
      session_before TEXT,
      session_after TEXT,
      matcher_result TEXT,
      captured_at TEXT NOT NULL,
      UNIQUE(run_id, scenario_id, turn_index)
    );
    CREATE INDEX IF NOT EXISTS idx_captures_scenario_turn ON eval_turn_captures(scenario_id, turn_index);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/unit/eval-runs-schema.test.js`
Expected: All checks PASS.

- [ ] **Step 5: Register test in test/run-all.js**

In `test/run-all.js`, add `require('./unit/eval-runs-schema.test');` next to the other unit test requires (alphabetical-ish ordering — near `eval-schema.test`).

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/unit/eval-runs-schema.test.js test/run-all.js
git commit -m "feat(eval): eval_runs + eval_turn_captures schema for carryover eval"
```

---

## Task 2: setEventCache export on events.js

The replay needs to overwrite `events.js`'s private `eventCache` with the fixture pool so the brain sees stable events instead of whatever scraped today. Production code never calls this.

**Files:**
- Modify: `src/events.js`

- [ ] **Step 1: Find the `module.exports` block in src/events.js**

Open `src/events.js`. Search for `module.exports = {` (it's near the bottom).

- [ ] **Step 2: Add setEventCache function above the exports**

Immediately above the `module.exports = {` line, add:

```javascript
/**
 * Test-only: overwrite the in-memory event cache with a fixture array.
 * Used by the carryover eval harness to isolate brain behavior from
 * scrape variance. Should never be called from production code paths.
 */
function setEventCache(events) {
  if (!Array.isArray(events)) throw new Error('setEventCache: events must be an array');
  eventCache = events;
}
```

- [ ] **Step 3: Add to exports**

Add `setEventCache` to the existing `module.exports = { ... }` block.

- [ ] **Step 4: Smoke-test the injection**

Run from project root:
```bash
node -e "const e = require('./src/events'); e.setEventCache([{ id: 'x', name: 'fake', neighborhood: 'williamsburg', extraction_confidence: 0.9, completeness: 0.9 }]); e.getEvents('williamsburg').then(r => console.log('returned', r.length, 'events'));"
```
Expected: prints `returned 1 events` (or similar — at least 1).

- [ ] **Step 5: Commit**

```bash
git add src/events.js
git commit -m "feat(events): setEventCache export for fixture injection in evals"
```

---

## Task 3: Fixture event pool

15 events covering Williamsburg, Bushwick, Greenpoint, LES, across comedy/music/food/art, with `2026-06-01` start times and `0.8-0.9` quality scores so they survive `applyQualityGates`.

**Files:**
- Create: `src/eval/carryover/fixtures/events.json`

- [ ] **Step 1: Create the fixtures directory and file**

```bash
mkdir -p src/eval/carryover/fixtures
```

Write `src/eval/carryover/fixtures/events.json`:

```json
[
  {
    "id": "fx-wb-comedy-1",
    "name": "Hot Soup Comedy",
    "venue_name": "Pete's Candy Store",
    "neighborhood": "williamsburg",
    "borough": "brooklyn",
    "category": "comedy",
    "is_free": true,
    "start_time_local": "2026-06-01T22:30:00",
    "url": "https://example.com/hotsoup",
    "extraction_confidence": 0.9,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "discovery"
  },
  {
    "id": "fx-wb-music-1",
    "name": "Subterranean DJ Set",
    "venue_name": "Baby's All Right",
    "neighborhood": "williamsburg",
    "borough": "brooklyn",
    "category": "music",
    "is_free": false,
    "start_time_local": "2026-06-01T21:00:00",
    "url": "https://example.com/babys",
    "extraction_confidence": 0.85,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "niche"
  },
  {
    "id": "fx-wb-wine-1",
    "name": "Natural Wine Tasting",
    "venue_name": "Maison Premiere",
    "neighborhood": "williamsburg",
    "borough": "brooklyn",
    "category": "food",
    "is_free": false,
    "start_time_local": "2026-06-01T19:30:00",
    "url": "https://example.com/maison",
    "extraction_confidence": 0.9,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "platform"
  },
  {
    "id": "fx-wb-art-1",
    "name": "Open Studios Friday",
    "venue_name": "Trestle Gallery",
    "neighborhood": "williamsburg",
    "borough": "brooklyn",
    "category": "art",
    "is_free": true,
    "start_time_local": "2026-06-01T19:00:00",
    "url": "https://example.com/trestle",
    "extraction_confidence": 0.8,
    "completeness": 0.85,
    "source_tier": "primary",
    "source_vibe": "niche"
  },
  {
    "id": "fx-wb-music-2",
    "name": "Indie Showcase",
    "venue_name": "Union Pool",
    "neighborhood": "williamsburg",
    "borough": "brooklyn",
    "category": "music",
    "is_free": false,
    "start_time_local": "2026-06-01T20:00:00",
    "url": "https://example.com/unionpool",
    "extraction_confidence": 0.85,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "niche"
  },
  {
    "id": "fx-bw-comedy-1",
    "name": "Stand-Up Showcase",
    "venue_name": "Two Boots Bushwick",
    "neighborhood": "bushwick",
    "borough": "brooklyn",
    "category": "comedy",
    "is_free": true,
    "start_time_local": "2026-06-01T22:00:00",
    "url": "https://example.com/twoboots",
    "extraction_confidence": 0.9,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "discovery"
  },
  {
    "id": "fx-bw-music-1",
    "name": "Warehouse Show",
    "venue_name": "Elsewhere",
    "neighborhood": "bushwick",
    "borough": "brooklyn",
    "category": "music",
    "is_free": false,
    "start_time_local": "2026-06-01T23:00:00",
    "url": "https://example.com/elsewhere",
    "extraction_confidence": 0.9,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "platform"
  },
  {
    "id": "fx-bw-music-2",
    "name": "Late Night DJ",
    "venue_name": "Mood Ring",
    "neighborhood": "bushwick",
    "borough": "brooklyn",
    "category": "music",
    "is_free": true,
    "start_time_local": "2026-06-01T23:30:00",
    "url": "https://example.com/moodring",
    "extraction_confidence": 0.85,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "discovery"
  },
  {
    "id": "fx-bw-art-1",
    "name": "Bushwick Open Studios",
    "venue_name": "56 Bogart",
    "neighborhood": "bushwick",
    "borough": "brooklyn",
    "category": "art",
    "is_free": true,
    "start_time_local": "2026-06-01T18:00:00",
    "url": "https://example.com/56bogart",
    "extraction_confidence": 0.85,
    "completeness": 0.85,
    "source_tier": "primary",
    "source_vibe": "niche"
  },
  {
    "id": "fx-gp-wine-1",
    "name": "Orange Wine Pop-Up",
    "venue_name": "The Four Horsemen",
    "neighborhood": "greenpoint",
    "borough": "brooklyn",
    "category": "food",
    "is_free": false,
    "start_time_local": "2026-06-01T19:00:00",
    "url": "https://example.com/fourhorsemen",
    "extraction_confidence": 0.9,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "platform"
  },
  {
    "id": "fx-gp-music-1",
    "name": "Greenpoint Open Mic",
    "venue_name": "Pencil Factory",
    "neighborhood": "greenpoint",
    "borough": "brooklyn",
    "category": "music",
    "is_free": true,
    "start_time_local": "2026-06-01T20:30:00",
    "url": "https://example.com/pencilfactory",
    "extraction_confidence": 0.85,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "niche"
  },
  {
    "id": "fx-gp-comedy-1",
    "name": "Comedy at the Diamond",
    "venue_name": "The Diamond",
    "neighborhood": "greenpoint",
    "borough": "brooklyn",
    "category": "comedy",
    "is_free": false,
    "start_time_local": "2026-06-01T21:00:00",
    "url": "https://example.com/diamond",
    "extraction_confidence": 0.85,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "discovery"
  },
  {
    "id": "fx-gp-art-1",
    "name": "Print Studio Sale",
    "venue_name": "Greenpoint Print",
    "neighborhood": "greenpoint",
    "borough": "brooklyn",
    "category": "art",
    "is_free": true,
    "start_time_local": "2026-06-01T18:30:00",
    "url": "https://example.com/gpprint",
    "extraction_confidence": 0.8,
    "completeness": 0.85,
    "source_tier": "primary",
    "source_vibe": "niche"
  },
  {
    "id": "fx-lel-music-1",
    "name": "LES Punk Show",
    "venue_name": "Bowery Electric",
    "neighborhood": "les",
    "borough": "manhattan",
    "category": "music",
    "is_free": false,
    "start_time_local": "2026-06-01T22:00:00",
    "url": "https://example.com/bowery",
    "extraction_confidence": 0.9,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "platform"
  },
  {
    "id": "fx-lel-comedy-1",
    "name": "Stand-Up Late",
    "venue_name": "The Stand",
    "neighborhood": "les",
    "borough": "manhattan",
    "category": "comedy",
    "is_free": false,
    "start_time_local": "2026-06-01T23:00:00",
    "url": "https://example.com/thestand",
    "extraction_confidence": 0.9,
    "completeness": 0.9,
    "source_tier": "primary",
    "source_vibe": "platform"
  }
]
```

- [ ] **Step 2: Verify all fixtures clear quality gates**

```bash
node -e "
const fx = require('./src/eval/carryover/fixtures/events.json');
const e = require('./src/events');
e.setEventCache(fx);
e.getEvents('williamsburg').then(r => {
  const ids = new Set(r.map(x => x.id));
  const dropped = fx.filter(f => !ids.has(f.id) && f.neighborhood === 'williamsburg');
  console.log('total fixtures:', fx.length);
  console.log('williamsburg fixtures dropped:', dropped.map(d => d.id));
});
"
```
Expected: `total fixtures: 15`, `williamsburg fixtures dropped: []`. If any williamsburg fixture is dropped, bump its `extraction_confidence` or `completeness` to 0.9 in the JSON.

- [ ] **Step 3: Commit**

```bash
git add src/eval/carryover/fixtures/events.json
git commit -m "feat(eval): fixture event pool for carryover scenarios"
```

---

## Task 4: Matcher library

The matcher does deep partial-match between an expected shape and actual tool-call params, supporting 6 tagged operators.

**Files:**
- Create: `test/unit/eval-matcher.test.js`
- Create: `src/eval/carryover/matcher.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-matcher.test.js
const { check } = require('../helpers');
const { match } = require('../../src/eval/carryover/matcher');

console.log('\n--- eval-matcher.test.js ---');

// --- exact primitive match ---
check('string equal passes', match('a', 'a').passed === true);
check('string mismatch fails', match('a', 'b').passed === false);
check('mismatch reports path and values', match('a', 'b').mismatches[0].path === '' && match('a', 'b').mismatches[0].expected === 'a');
check('number equal passes', match(7, 7).passed === true);

// --- $present ---
check('$present passes on truthy', match({ $present: true }, 'williamsburg').passed === true);
check('$present passes on 0 (defined-not-null)', match({ $present: true }, 0).passed === true);
check('$present fails on undefined', match({ $present: true }, undefined).passed === false);
check('$present fails on null', match({ $present: true }, null).passed === false);

// --- $absent ---
check('$absent passes on undefined', match({ $absent: true }, undefined).passed === true);
check('$absent passes on null', match({ $absent: true }, null).passed === true);
check('$absent fails on value', match({ $absent: true }, 'williamsburg').passed === false);

// --- $regex ---
check('$regex passes', match({ $regex: '^2[0-3]:' }, '22:30').passed === true);
check('$regex fails', match({ $regex: '^2[0-3]:' }, '08:00').passed === false);

// --- $in ---
check('$in passes', match({ $in: ['comedy', 'music'] }, 'comedy').passed === true);
check('$in fails', match({ $in: ['comedy', 'music'] }, 'art').passed === false);

// --- $contains ---
check('$contains passes', match({ $contains: 'comedy' }, ['comedy', 'music']).passed === true);
check('$contains fails when not in array', match({ $contains: 'art' }, ['comedy', 'music']).passed === false);
check('$contains fails when not array', match({ $contains: 'comedy' }, 'comedy').passed === false);

// --- $absent_or_empty ---
check('$absent_or_empty passes on undefined', match({ $absent_or_empty: true }, undefined).passed === true);
check('$absent_or_empty passes on []', match({ $absent_or_empty: true }, []).passed === true);
check('$absent_or_empty fails on non-empty array', match({ $absent_or_empty: true }, ['comedy']).passed === false);

// --- partial object match ---
const actual = { neighborhood: 'williamsburg', filters: { categories: ['comedy'], free_only: true }, intent: 'discover' };
check('partial object match passes when subset matches',
  match({ neighborhood: 'williamsburg', intent: 'discover' }, actual).passed === true);
check('keys not in expected are ignored',
  match({ neighborhood: 'williamsburg' }, actual).passed === true);
check('nested mismatch reports nested path',
  match({ filters: { free_only: false } }, actual).mismatches[0].path === 'filters.free_only');

// --- nested $contains in filters ---
check('nested $contains passes',
  match({ filters: { categories: { $contains: 'comedy' } } }, actual).passed === true);
check('nested $contains fails',
  match({ filters: { categories: { $contains: 'jazz' } } }, actual).passed === false);

// --- nested $absent on missing nested key ---
check('nested $absent passes when key missing',
  match({ filters: { time_after: { $absent: true } } }, actual).passed === true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/unit/eval-matcher.test.js`
Expected: All FAIL — module does not exist yet.

- [ ] **Step 3: Create the directory and implement the matcher**

```bash
mkdir -p src/eval/carryover
```

Write `src/eval/carryover/matcher.js`:

```javascript
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isTaggedMatcher(v) {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  return keys[0].startsWith('$');
}

function matchTagged(tag, expectedValue, actual, path) {
  switch (tag) {
    case '$present':
      if (actual !== undefined && actual !== null) return [];
      return [{ path, expected: '<present>', actual, reason: 'expected present' }];
    case '$absent':
      if (actual === undefined || actual === null) return [];
      return [{ path, expected: '<absent>', actual, reason: 'expected absent' }];
    case '$regex': {
      const re = new RegExp(expectedValue);
      if (typeof actual === 'string' && re.test(actual)) return [];
      return [{ path, expected: `/${expectedValue}/`, actual, reason: 'regex did not match' }];
    }
    case '$in':
      if (Array.isArray(expectedValue) && expectedValue.includes(actual)) return [];
      return [{ path, expected: `one of ${JSON.stringify(expectedValue)}`, actual, reason: 'not in allowed set' }];
    case '$contains':
      if (Array.isArray(actual) && actual.includes(expectedValue)) return [];
      return [{ path, expected: `array containing ${JSON.stringify(expectedValue)}`, actual, reason: 'array did not contain value' }];
    case '$absent_or_empty':
      if (actual === undefined || actual === null) return [];
      if (Array.isArray(actual) && actual.length === 0) return [];
      return [{ path, expected: '<absent or empty>', actual, reason: 'expected absent or empty array' }];
    default:
      return [{ path, expected: tag, actual, reason: `unknown matcher ${tag}` }];
  }
}

function deepMatch(expected, actual, path) {
  if (isTaggedMatcher(expected)) {
    const tag = Object.keys(expected)[0];
    return matchTagged(tag, expected[tag], actual, path);
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return [{ path, expected, actual, reason: 'expected object, got non-object' }];
    }
    const mismatches = [];
    for (const key of Object.keys(expected)) {
      const childPath = path ? `${path}.${key}` : key;
      mismatches.push(...deepMatch(expected[key], actual?.[key], childPath));
    }
    return mismatches;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [{ path, expected, actual, reason: 'expected array, got non-array' }];
    }
    if (expected.length !== actual.length) {
      return [{ path, expected: `length ${expected.length}`, actual: `length ${actual.length}`, reason: 'array length differs' }];
    }
    const mismatches = [];
    for (let i = 0; i < expected.length; i++) {
      mismatches.push(...deepMatch(expected[i], actual[i], `${path}[${i}]`));
    }
    return mismatches;
  }

  if (expected === actual) return [];
  return [{ path, expected, actual, reason: 'value mismatch' }];
}

function match(expected, actual) {
  const mismatches = deepMatch(expected, actual, '');
  return { passed: mismatches.length === 0, mismatches };
}

module.exports = { match };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/unit/eval-matcher.test.js`
Expected: All PASS.

- [ ] **Step 5: Register test in test/run-all.js**

Add `require('./unit/eval-matcher.test');` to `test/run-all.js`.

- [ ] **Step 6: Commit**

```bash
git add src/eval/carryover/matcher.js test/unit/eval-matcher.test.js test/run-all.js
git commit -m "feat(eval): matcher library for carryover assertions"
```

---

## Task 5: Scenario loader

Reads + validates scenario JSON files. A scenario has `id`, optional `description`, and an ordered `turns` array; each turn has `user` (string) and optional `expect` (`{ tool, args }`).

**Files:**
- Create: `test/unit/eval-scenario-loader.test.js`
- Create: `src/eval/carryover/scenario-loader.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/eval-scenario-loader.test.js
const { check } = require('../helpers');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadScenario, loadAllScenarios } = require('../../src/eval/carryover/scenario-loader');

console.log('\n--- eval-scenario-loader.test.js ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-scenarios-'));

// --- valid scenario with expect ---
const validPath = path.join(tmpDir, 'a-valid.json');
fs.writeFileSync(validPath, JSON.stringify({
  id: 'a-valid',
  description: 'test',
  turns: [{ user: 'hi', expect: { tool: 'search', args: { neighborhood: 'williamsburg' } } }],
}));
const valid = loadScenario(validPath);
check('loads valid scenario', valid.id === 'a-valid');
check('loaded scenario has 1 turn', valid.turns.length === 1);

// --- valid scenario WITHOUT expect (matcher is optional) ---
const noExpectPath = path.join(tmpDir, 'no-expect.json');
fs.writeFileSync(noExpectPath, JSON.stringify({
  id: 'no-expect',
  turns: [{ user: 'hi' }, { user: 'more' }],
}));
const noExpect = loadScenario(noExpectPath);
check('scenarios without expect blocks are valid', noExpect.turns.length === 2);

// --- missing id ---
const noIdPath = path.join(tmpDir, 'no-id.json');
fs.writeFileSync(noIdPath, JSON.stringify({ turns: [] }));
let threw = false;
try { loadScenario(noIdPath); } catch (e) { threw = true; }
check('throws when id missing', threw === true);

// --- empty turns ---
const noTurnsPath = path.join(tmpDir, 'no-turns.json');
fs.writeFileSync(noTurnsPath, JSON.stringify({ id: 'x', turns: [] }));
threw = false;
try { loadScenario(noTurnsPath); } catch (e) { threw = true; }
check('throws when turns empty', threw === true);

// --- turn missing user ---
const badTurnPath = path.join(tmpDir, 'bad-turn.json');
fs.writeFileSync(badTurnPath, JSON.stringify({ id: 'x', turns: [{ expect: { tool: 'search', args: {} } }] }));
threw = false;
try { loadScenario(badTurnPath); } catch (e) { threw = true; }
check('throws when turn missing user', threw === true);

// --- malformed expect (has expect but missing tool) ---
const badExpectPath = path.join(tmpDir, 'bad-expect.json');
fs.writeFileSync(badExpectPath, JSON.stringify({ id: 'x', turns: [{ user: 'hi', expect: { args: {} } }] }));
threw = false;
try { loadScenario(badExpectPath); } catch (e) { threw = true; }
check('throws when expect.tool missing', threw === true);

// --- loadAllScenarios reads dir, ignores non-json, sorts by filename ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-scenarios-dir-'));
fs.writeFileSync(path.join(dir, '02-second.json'), JSON.stringify({ id: '02', turns: [{ user: 'a' }] }));
fs.writeFileSync(path.join(dir, '01-first.json'), JSON.stringify({ id: '01', turns: [{ user: 'a' }] }));
fs.writeFileSync(path.join(dir, 'README.md'), 'ignore me');
const all = loadAllScenarios(dir);
check('loadAllScenarios skips non-json', all.length === 2);
check('loadAllScenarios sorts by filename', all[0].id === '01' && all[1].id === '02');

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/unit/eval-scenario-loader.test.js`
Expected: All FAIL.

- [ ] **Step 3: Implement the loader**

Write `src/eval/carryover/scenario-loader.js`:

```javascript
const fs = require('fs');
const path = require('path');

function validateScenario(s, sourcePath) {
  const where = sourcePath ? ` (${sourcePath})` : '';
  if (typeof s !== 'object' || s === null) throw new Error(`scenario must be object${where}`);
  if (typeof s.id !== 'string' || s.id.length === 0) throw new Error(`scenario missing id${where}`);
  if (!Array.isArray(s.turns) || s.turns.length === 0) throw new Error(`scenario ${s.id} has no turns${where}`);
  for (let i = 0; i < s.turns.length; i++) {
    const t = s.turns[i];
    if (typeof t.user !== 'string') throw new Error(`scenario ${s.id} turn ${i} missing user${where}`);
    if (t.expect !== undefined) {
      if (typeof t.expect.tool !== 'string') {
        throw new Error(`scenario ${s.id} turn ${i} missing expect.tool${where}`);
      }
      if (!t.expect.args || typeof t.expect.args !== 'object') {
        throw new Error(`scenario ${s.id} turn ${i} missing expect.args${where}`);
      }
    }
  }
  return s;
}

function loadScenario(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`scenario ${filePath} not valid JSON: ${e.message}`); }
  return validateScenario(parsed, filePath);
}

function loadAllScenarios(dirPath) {
  const files = fs.readdirSync(dirPath)
    .filter(f => f.endsWith('.json'))
    .sort();
  return files.map(f => loadScenario(path.join(dirPath, f)));
}

module.exports = { loadScenario, loadAllScenarios, validateScenario };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/unit/eval-scenario-loader.test.js`
Expected: All PASS.

- [ ] **Step 5: Register test in test/run-all.js**

Add `require('./unit/eval-scenario-loader.test');` to `test/run-all.js`.

- [ ] **Step 6: Commit**

```bash
git add src/eval/carryover/scenario-loader.js test/unit/eval-scenario-loader.test.js test/run-all.js
git commit -m "feat(eval): scenario JSON loader + validation"
```

---

## Task 6: 10 scenario JSON files

Each tests one specific continuity invariant drawn from production failure patterns.

**Files:**
- Create: `src/eval/carryover/scenarios/01-filter-add-time.json` through `10-comedy-keyword-refinement.json`

- [ ] **Step 1: Create the scenarios directory**

```bash
mkdir -p src/eval/carryover/scenarios
```

- [ ] **Step 2: Write all 10 scenario files**

`src/eval/carryover/scenarios/01-filter-add-time.json`:
```json
{
  "id": "01-filter-add-time",
  "description": "Adding 'later tonight' keeps the neighborhood and adds a time filter",
  "turns": [
    { "user": "williamsburg",
      "expect": { "tool": "search", "args": { "neighborhood": "williamsburg", "intent": "discover" } } },
    { "user": "later tonight",
      "expect": { "tool": "search", "args": {
        "neighborhood": "williamsburg",
        "filters": { "time_after": { "$regex": "^2[0-3]:" } },
        "intent": "discover"
      } } }
  ]
}
```

`src/eval/carryover/scenarios/02-filter-carries-across-hood-swap.json`:
```json
{
  "id": "02-filter-carries-across-hood-swap",
  "description": "After a category filter is set, switching neighborhoods keeps the filter",
  "turns": [
    { "user": "williamsburg",
      "expect": { "tool": "search", "args": { "neighborhood": "williamsburg" } } },
    { "user": "how about comedy",
      "expect": { "tool": "search", "args": {
        "neighborhood": "williamsburg",
        "filters": { "categories": { "$contains": "comedy" } }
      } } },
    { "user": "try bushwick",
      "expect": { "tool": "search", "args": {
        "neighborhood": "bushwick",
        "filters": { "categories": { "$contains": "comedy" } }
      } } }
  ]
}
```

`src/eval/carryover/scenarios/03-filter-drop-explicit.json`:
```json
{
  "id": "03-filter-drop-explicit",
  "description": "An explicit 'forget the X' drops that filter but keeps neighborhood",
  "turns": [
    { "user": "bushwick",
      "expect": { "tool": "search", "args": { "neighborhood": "bushwick" } } },
    { "user": "comedy",
      "expect": { "tool": "search", "args": {
        "neighborhood": "bushwick",
        "filters": { "categories": { "$contains": "comedy" } }
      } } },
    { "user": "forget the comedy",
      "expect": { "tool": "search", "args": {
        "neighborhood": "bushwick",
        "filters": { "categories": { "$absent_or_empty": true } }
      } } }
  ]
}
```

`src/eval/carryover/scenarios/04-more-keeps-frame.json`:
```json
{
  "id": "04-more-keeps-frame",
  "description": "'more' should be intent=more without restating neighborhood",
  "turns": [
    { "user": "williamsburg",
      "expect": { "tool": "search", "args": { "neighborhood": "williamsburg" } } },
    { "user": "more",
      "expect": { "tool": "search", "args": { "intent": "more" } } }
  ]
}
```

`src/eval/carryover/scenarios/05-numeric-pick-is-details.json`:
```json
{
  "id": "05-numeric-pick-is-details",
  "description": "A bare number after picks is a details lookup, not a new search",
  "turns": [
    { "user": "williamsburg",
      "expect": { "tool": "search", "args": { "neighborhood": "williamsburg" } } },
    { "user": "2",
      "expect": { "tool": "search", "args": { "intent": "details", "reference": { "$present": true } } } }
  ]
}
```

`src/eval/carryover/scenarios/06-intent-survives-hood-swap.json`:
```json
{
  "id": "06-intent-survives-hood-swap",
  "description": "'what about greenpoint' after a wine-bar query should keep the wine-bar intent",
  "turns": [
    { "user": "wine bar in williamsburg",
      "expect": { "tool": "search", "args": {
        "neighborhood": "williamsburg",
        "filters": { "categories": { "$contains": "food" } }
      } } },
    { "user": "what about greenpoint",
      "expect": { "tool": "search", "args": {
        "neighborhood": "greenpoint",
        "filters": { "categories": { "$contains": "food" } }
      } } }
  ]
}
```

`src/eval/carryover/scenarios/07-disjunction-honored.json`:
```json
{
  "id": "07-disjunction-honored",
  "description": "'greenpoint or williamsburg' should not silently collapse to one hood",
  "turns": [
    { "user": "greenpoint or williamsburg",
      "expect": { "tool": "search", "args": {
        "neighborhood": { "$in": ["greenpoint", "williamsburg"] }
      } } }
  ]
}
```

`src/eval/carryover/scenarios/08-date-swap.json`:
```json
{
  "id": "08-date-swap",
  "description": "Saying 'actually tomorrow' after a 'tonight' search swaps the date range",
  "turns": [
    { "user": "tonight in williamsburg",
      "expect": { "tool": "search", "args": {
        "neighborhood": "williamsburg",
        "filters": { "date_range": { "$present": true } }
      } } },
    { "user": "actually tomorrow",
      "expect": { "tool": "search", "args": {
        "neighborhood": "williamsburg",
        "filters": { "date_range": { "$regex": "tomorrow|2026-" } }
      } } }
  ]
}
```

`src/eval/carryover/scenarios/09-greeting-then-hood.json`:
```json
{
  "id": "09-greeting-then-hood",
  "description": "Greeting followed by a neighborhood should land in a normal discover search",
  "turns": [
    { "user": "hi",
      "expect": { "tool": "respond", "args": {} } },
    { "user": "williamsburg",
      "expect": { "tool": "search", "args": { "neighborhood": "williamsburg", "intent": "discover" } } }
  ]
}
```

`src/eval/carryover/scenarios/10-comedy-keyword-refinement.json`:
```json
{
  "id": "10-comedy-keyword-refinement",
  "description": "A category keyword after a hood should refine, not restart",
  "turns": [
    { "user": "bushwick",
      "expect": { "tool": "search", "args": { "neighborhood": "bushwick" } } },
    { "user": "comedy",
      "expect": { "tool": "search", "args": {
        "neighborhood": "bushwick",
        "filters": { "categories": { "$contains": "comedy" } }
      } } }
  ]
}
```

- [ ] **Step 3: Validate they all load**

```bash
node -e "
const path = require('path');
const { loadAllScenarios } = require('./src/eval/carryover/scenario-loader');
const ss = loadAllScenarios(path.join('src/eval/carryover/scenarios'));
console.log('loaded', ss.length, 'scenarios:');
for (const s of ss) console.log(' ', s.id, '(' + s.turns.length + ' turns)');
"
```
Expected: `loaded 10 scenarios:` followed by all 10 ids and turn counts.

- [ ] **Step 4: Commit**

```bash
git add src/eval/carryover/scenarios/
git commit -m "feat(eval): 10 carryover scenarios from production failure patterns"
```

---

## Task 7: Replay harness

Runs one scenario through `handleAgentRequestGraph`, captures per-turn artifacts, persists to `eval_turn_captures`. The replay is the most complex piece — it has to thread a brain-prompt capture hook through the agent graph without modifying production code paths.

**Approach:** rather than modifying agent-graph.js, the replay monkey-patches the `runAgentLoop` import temporarily and intercepts the call to capture `systemPrompt` + `messages`. This is contained to the replay process — production handlers never see the patch.

**Files:**
- Create: `test/unit/eval-replay.test.js`
- Create: `src/eval/carryover/replay.js`

- [ ] **Step 1: Write the failing test (smoke level — full replay against fixture)**

```javascript
// test/unit/eval-replay.test.js
// Smoke test for replayScenario — runs a 2-turn scenario through the actual
// agent graph against the fixture pool and verifies captures land in DB.
// Requires an API key (ANTHROPIC_API_KEY or GEMINI_API_KEY) — skips if absent.

const { check } = require('../helpers');

if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
  console.log('\n--- eval-replay.test.js (skipped: no API key) ---');
  module.exports.runAsync = async () => {};
  return;
}

console.log('\n--- eval-replay.test.js ---');

process.env.PULSE_TEST_MODE = 'true';

const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/db');
const { replayScenario } = require('../../src/eval/carryover/replay');

module.exports.runAsync = async function () {
  const db = new Database(':memory:');
  runMigrations(db);

  const scenario = {
    id: 'smoke-01',
    description: 'replay smoke',
    turns: [
      { user: 'williamsburg', expect: { tool: 'search', args: { neighborhood: 'williamsburg' } } },
      { user: 'how about comedy' },
    ],
  };

  const result = await replayScenario(scenario, { runId: 1, db });

  check('replay returns scenarioId', result.scenarioId === 'smoke-01');
  check('replay returns 2 turns', result.turns.length === 2);
  check('turn 0 has user_msg', result.turns[0].user_msg === 'williamsburg');
  check('turn 0 has trace_id', typeof result.turns[0].trace_id === 'string' && result.turns[0].trace_id.length > 0);
  check('turn 0 has brain_prompt captured', typeof result.turns[0].brain_prompt === 'string' && result.turns[0].brain_prompt.length > 0);
  check('turn 0 has session_before snapshot', result.turns[0].session_before !== null);
  check('turn 0 has session_after snapshot', result.turns[0].session_after !== null);
  check('turn 0 has matcher result (had expect)', result.turns[0].matcher_result !== null);
  check('turn 1 has no matcher result (no expect)', result.turns[1].matcher_result === null);

  // Rows must be persisted to DB
  const rows = db.prepare('SELECT * FROM eval_turn_captures WHERE run_id = 1 ORDER BY turn_index').all();
  check('2 capture rows persisted', rows.length === 2);
  check('row 0 has the user_msg', rows[0].user_msg === 'williamsburg');
  check('row 0 has non-null brain_prompt', rows[0].brain_prompt && rows[0].brain_prompt.length > 0);

  db.close();
};
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/unit/eval-replay.test.js`
Expected: FAIL — module does not exist (or "Cannot find module ...replay").

- [ ] **Step 3: Implement the replay**

Write `src/eval/carryover/replay.js`:

```javascript
// src/eval/carryover/replay.js
//
// replayScenario(scenario, { runId, db }) → { scenarioId, description, turns: [...] }
//
// Drives one scenario through handleAgentRequestGraph against the fixture pool.
// For each turn, captures the brain's system prompt + messages, tool call,
// agent SMS, session frame before/after, and (if scenario has expect) matcher
// result — then writes a row to eval_turn_captures.

const path = require('path');
const Module = require('module');

const FIXTURE_PATH = path.join(__dirname, 'fixtures/events.json');
const FIXTURE_EVENTS = require(FIXTURE_PATH);

// Fields from session to snapshot before/after each turn (per spec).
const SNAPSHOT_FIELDS = [
  'lastNeighborhood',
  'lastBorough',
  'lastFilters',
  'lastResultType',
  'pendingNearby',
  'visitedHoods',
];

function snapshotSession(session) {
  if (!session) return null;
  const out = {};
  for (const f of SNAPSHOT_FIELDS) out[f] = session[f] === undefined ? null : session[f];
  // lastPicks shrunk to ids only (full event blobs are noise)
  if (session.lastPicks) out.lastPicks = session.lastPicks.map(p => p.event_id || p);
  else out.lastPicks = null;
  return out;
}

function makeTestPhone(scenarioId) {
  const slug = scenarioId.replace(/[^0-9]/g, '').padStart(7, '0').slice(-7);
  return `+1555${slug}`;
}

// Wraps llm.runAgentLoop to capture the systemPrompt + messages it's called with.
// Returns { restore } that the caller invokes after the turn to undo the patch.
function patchRunAgentLoop(captureRef) {
  const llm = require('../../llm');
  const original = llm.runAgentLoop;
  llm.runAgentLoop = async function (opts) {
    captureRef.brain_prompt = opts.systemPrompt || null;
    captureRef.brain_messages = JSON.stringify(opts.messages || []);
    return original.call(this, opts);
  };
  return { restore: () => { llm.runAgentLoop = original; } };
}

async function replayScenario(scenario, { runId, db }) {
  // Lazy-require so test files can stub if needed
  const { setEventCache } = require('../../events');
  const { setSession, getSession, clearSession, addToHistory } = require('../../session');
  const { enableTestCapture, disableTestCapture } = require('../../twilio');
  const { startTrace } = require('../../traces');
  const { handleAgentRequestGraph } = require('../../agent-graph');
  const { match } = require('./matcher');

  setEventCache(FIXTURE_EVENTS);

  const phone = makeTestPhone(scenario.id);
  clearSession(phone);
  setSession(phone, {});

  enableTestCapture(phone);

  const insert = db.prepare(`INSERT INTO eval_turn_captures (
    run_id, scenario_id, turn_index, trace_id, user_msg,
    brain_prompt, brain_messages, tool_call, agent_sms,
    session_before, session_after, matcher_result, captured_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const turnsOut = [];
  try {
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const sessionBefore = snapshotSession(getSession(phone));

      addToHistory(phone, 'user', turn.user);

      const capture = { brain_prompt: null, brain_messages: null };
      const patch = patchRunAgentLoop(capture);

      const trace = startTrace('eval', turn.user);
      let agentSms = null;
      const finalizeTrace = (smsText, intent) => {
        trace.output_sms = smsText || null;
        trace.output_intent = intent || trace.output_intent || null;
        agentSms = smsText || null;
      };

      try {
        await handleAgentRequestGraph(phone, turn.user, getSession(phone), trace, finalizeTrace);
      } finally {
        patch.restore();
      }

      const sessionAfter = snapshotSession(getSession(phone));

      const toolCall = trace.brain_tool
        ? { name: trace.brain_tool, params: trace.brain_params || {} }
        : null;

      // Matcher result (only if scenario provided expect)
      let matcherResult = null;
      if (turn.expect) {
        if (!toolCall) {
          matcherResult = {
            passed: false,
            mismatches: [{ path: 'tool', expected: turn.expect.tool, actual: null, reason: 'no tool call' }],
          };
        } else {
          const mismatches = [];
          if (toolCall.name !== turn.expect.tool) {
            mismatches.push({ path: 'tool', expected: turn.expect.tool, actual: toolCall.name, reason: 'wrong tool' });
          }
          const argMatch = match(turn.expect.args, toolCall.params || {});
          for (const m of argMatch.mismatches) {
            mismatches.push({ ...m, path: m.path ? `args.${m.path}` : 'args' });
          }
          matcherResult = { passed: mismatches.length === 0, mismatches };
        }
      }

      const capturedAt = new Date().toISOString();
      insert.run(
        runId, scenario.id, i, trace.id, turn.user,
        capture.brain_prompt, capture.brain_messages,
        toolCall ? JSON.stringify(toolCall) : null,
        agentSms,
        JSON.stringify(sessionBefore),
        JSON.stringify(sessionAfter),
        matcherResult ? JSON.stringify(matcherResult) : null,
        capturedAt
      );

      turnsOut.push({
        turn_index: i,
        user_msg: turn.user,
        trace_id: trace.id,
        brain_prompt: capture.brain_prompt,
        brain_messages: capture.brain_messages,
        tool_call: toolCall,
        agent_sms: agentSms,
        session_before: sessionBefore,
        session_after: sessionAfter,
        matcher_result: matcherResult,
      });
    }
  } finally {
    disableTestCapture(phone);
    clearSession(phone);
  }

  return {
    scenarioId: scenario.id,
    description: scenario.description || '',
    turns: turnsOut,
  };
}

module.exports = { replayScenario, snapshotSession, makeTestPhone };
```

- [ ] **Step 4: Register the test as async in run-all.js**

In `test/run-all.js`, near where `misc.runAsync()` is awaited, add:

```javascript
const evalReplay = require('./unit/eval-replay.test');
// ...
await evalReplay.runAsync();
```

Place the `require` next to the other test requires; place the `await` inside the same `(async () => { ... })()` block as the other `runAsync` calls.

- [ ] **Step 5: Run test to verify it passes**

```bash
node test/unit/eval-replay.test.js
```
Expected: All PASS. If it skips because no API key is set, that's also OK — set `ANTHROPIC_API_KEY` and re-run to actually exercise.

- [ ] **Step 6: Commit**

```bash
git add src/eval/carryover/replay.js test/unit/eval-replay.test.js test/run-all.js
git commit -m "feat(eval): replay harness with per-turn brain-context capture"
```

---

## Task 8: CLI runner — scripts/eval-carryover.js

Loads scenarios, creates an `eval_runs` row, runs each scenario through `replayScenario`, prints a summary table.

**Files:**
- Create: `scripts/eval-carryover.js`

- [ ] **Step 1: Implement the CLI**

Write `scripts/eval-carryover.js`:

```javascript
#!/usr/bin/env node
// scripts/eval-carryover.js
//
// Usage: node scripts/eval-carryover.js [--scenario <id>]
//
// Loads all carryover scenarios, creates an eval_runs row, runs each scenario
// through the replay harness, prints a summary.

const path = require('path');
const { execSync } = require('child_process');

process.env.PULSE_TEST_MODE = 'true';

const { getDb } = require('../src/db');
const { MODELS } = require('../src/model-config');
const { loadAllScenarios } = require('../src/eval/carryover/scenario-loader');
const { replayScenario } = require('../src/eval/carryover/replay');

const SCENARIO_DIR = path.join(__dirname, '..', 'src', 'eval', 'carryover', 'scenarios');

function parseArgs(argv) {
  const args = { scenarioId: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--scenario') args.scenarioId = argv[++i];
  }
  return args;
}

function getGitSha() {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function collectEnvFlags() {
  const keys = ['PULSE_BRAIN_PROJECT', 'PULSE_TEST_MODE'];
  const out = {};
  for (const k of keys) if (process.env[k]) out[k] = process.env[k];
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  let scenarios = loadAllScenarios(SCENARIO_DIR);
  if (args.scenarioId) {
    scenarios = scenarios.filter(s => s.id === args.scenarioId);
    if (scenarios.length === 0) {
      console.error(`No scenario with id "${args.scenarioId}" found in ${SCENARIO_DIR}`);
      process.exit(2);
    }
  }

  const db = getDb();
  const runInsert = db.prepare(`INSERT INTO eval_runs (started_at, git_sha, model, env_flags, notes)
    VALUES (?, ?, ?, ?, ?)`);
  const runId = runInsert.run(
    new Date().toISOString(),
    getGitSha(),
    MODELS.brain,
    JSON.stringify(collectEnvFlags()),
    null
  ).lastInsertRowid;

  console.log(`Run #${runId} started — model=${MODELS.brain}`);

  let totalTurns = 0;
  let matchedTurns = 0;
  let evaluatedTurns = 0;

  for (const s of scenarios) {
    process.stdout.write(`  ${s.id}... `);
    let result;
    try {
      result = await replayScenario(s, { runId, db });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      continue;
    }
    const turnsWithMatcher = result.turns.filter(t => t.matcher_result !== null);
    const passed = turnsWithMatcher.filter(t => t.matcher_result.passed).length;
    totalTurns += result.turns.length;
    matchedTurns += passed;
    evaluatedTurns += turnsWithMatcher.length;
    console.log(`${result.turns.length} turns, ${passed}/${turnsWithMatcher.length} matched`);
  }

  console.log('');
  console.log(`Total turns: ${totalTurns}`);
  console.log(`Matcher pass rate: ${matchedTurns}/${evaluatedTurns} (turns with expect blocks)`);
  console.log(`Run #${runId} done. Open /eval to label.`);
}

main().catch(err => { console.error(err); process.exit(2); });
```

- [ ] **Step 2: Smoke-test the CLI (one scenario)**

Set `ANTHROPIC_API_KEY` (or `GEMINI_API_KEY`) in your environment, then:

```bash
node scripts/eval-carryover.js --scenario 04-more-keeps-frame
```
Expected: prints `Run #N started — model=...`, then `04-more-keeps-frame... 2 turns, 1/2 matched` (or similar; exact pass count depends on brain), then summary lines.

If the script crashes with "Cannot find module" — re-verify Tasks 4, 5, 7 created the right files.

- [ ] **Step 3: Commit**

```bash
git add scripts/eval-carryover.js
git commit -m "feat(eval): carryover CLI runner — creates run row, persists captures"
```

---

## Task 9: API routes in server.js

Five new routes, all under `/api/eval/*` plus the HTML serve at `/eval`. They power the workspace UI.

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Open src/server.js and locate the existing eval/test routes**

Search for `app.get('/api/traces'` (around line 401). The new routes will be added immediately after that block, before any `if (process.env.PULSE_TEST_MODE === 'true')` block.

- [ ] **Step 2: Add the 5 new routes**

Paste the following block just after the existing `/api/traces/:id` route and before any `PULSE_TEST_MODE` block:

```javascript
// --- Carryover eval workspace ---
const { getDb: _getEvalDb } = require('./db');

app.get('/eval', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'eval-ui.html'));
});

app.get('/api/eval/runs', (req, res) => {
  const db = _getEvalDb();
  const rows = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM eval_turn_captures WHERE run_id = r.id) AS turn_count,
      (SELECT COUNT(*) FROM eval_turn_captures c
        WHERE c.run_id = r.id
          AND EXISTS (SELECT 1 FROM response_labels l WHERE l.trace_id = c.trace_id)) AS labeled_count,
      (SELECT COUNT(*) FROM eval_turn_captures c
        WHERE c.run_id = r.id
          AND c.matcher_result IS NOT NULL
          AND json_extract(c.matcher_result, '$.passed') = 1) AS matcher_passed,
      (SELECT COUNT(*) FROM eval_turn_captures c
        WHERE c.run_id = r.id AND c.matcher_result IS NOT NULL) AS matcher_evaluated
    FROM eval_runs r
    ORDER BY r.id DESC
    LIMIT 50
  `).all();
  res.json({ runs: rows });
});

app.get('/api/eval/runs/:id', (req, res) => {
  const db = _getEvalDb();
  const run = db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const scenarios = db.prepare(`
    SELECT
      scenario_id,
      COUNT(*) AS turn_count,
      SUM(CASE WHEN matcher_result IS NOT NULL AND json_extract(matcher_result, '$.passed') = 1 THEN 1 ELSE 0 END) AS matcher_passed,
      SUM(CASE WHEN matcher_result IS NOT NULL THEN 1 ELSE 0 END) AS matcher_evaluated
    FROM eval_turn_captures
    WHERE run_id = ?
    GROUP BY scenario_id
    ORDER BY scenario_id
  `).all(req.params.id);

  for (const s of scenarios) {
    s.labeled_count = db.prepare(`
      SELECT COUNT(*) AS n FROM eval_turn_captures c
      WHERE c.run_id = ? AND c.scenario_id = ?
      AND EXISTS (SELECT 1 FROM response_labels l WHERE l.trace_id = c.trace_id)
    `).get(req.params.id, s.scenario_id).n;
  }

  const turns = db.prepare(`
    SELECT id AS capture_id, scenario_id, turn_index, trace_id, user_msg,
           tool_call, agent_sms, matcher_result, captured_at
    FROM eval_turn_captures WHERE run_id = ? ORDER BY scenario_id, turn_index
  `).all(req.params.id);

  res.json({ run, scenarios, turns });
});

app.get('/api/eval/turns/:capture_id', (req, res) => {
  const db = _getEvalDb();
  const turn = db.prepare(`SELECT * FROM eval_turn_captures WHERE id = ?`).get(req.params.capture_id);
  if (!turn) return res.status(404).json({ error: 'turn not found' });

  // Prior labels on the same logical turn (scenario_id, turn_index) across all runs
  const priorLabels = db.prepare(`
    SELECT l.*, c.run_id, c.captured_at AS turn_captured_at
    FROM response_labels l
    JOIN eval_turn_captures c ON c.trace_id = l.trace_id
    WHERE c.scenario_id = ? AND c.turn_index = ?
    ORDER BY l.labeled_at DESC
  `).all(turn.scenario_id, turn.turn_index);

  res.json({ turn, prior_labels: priorLabels });
});

app.post('/api/eval/labels', express.json(), (req, res) => {
  const { trace_id, axis, label, notes } = req.body || {};
  if (!trace_id || !axis || label === undefined) {
    return res.status(400).json({ error: 'trace_id, axis, and label are required' });
  }
  const labeler_id = process.env.PULSE_LABELER_ID || 'jk';
  const db = _getEvalDb();
  try {
    db.prepare(`
      INSERT INTO response_labels (trace_id, axis, label, labeler_id, notes, labeled_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_id, axis, labeler_id) DO UPDATE SET
        label = excluded.label,
        notes = excluded.notes,
        labeled_at = excluded.labeled_at
    `).run(trace_id, axis, label, labeler_id, notes || null, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Verify Express is configured for JSON body parsing**

Search for `app.use(express.json())` near the top of `src/server.js`. If it's not there, add it immediately after the `const app = express();` line. (The `POST /api/eval/labels` route uses `express.json()` inline as defense-in-depth, but the global setting matters for any other JSON endpoints.)

- [ ] **Step 4: Smoke-test the routes**

Start the server in one terminal:
```bash
node src/server.js
```

In a second terminal:
```bash
curl -s http://localhost:3000/api/eval/runs | head -100
```
Expected: JSON `{"runs":[ ... ]}` — at least one run (from Task 8's smoke test) if you ran the CLI earlier. Empty array is also fine if you haven't run the CLI yet.

```bash
curl -s -X POST http://localhost:3000/api/eval/labels \
  -H 'Content-Type: application/json' \
  -d '{"trace_id":"fake-trace","axis":"context_carryover_quality","label":4,"notes":"smoke"}'
```
Expected: `{"ok":true}` (or `{"error":"..."}` if `response_labels` requires a trace_id with a real FK — verify in your DB browser that the row landed).

Kill the server (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat(server): /eval workspace + /api/eval/* routes"
```

---

## Task 10: Workspace UI — src/eval-ui.html

3-view single-page workspace. We first try restoring the old `src/eval-ui.html` from `1f9066b^` as a starting skeleton, then evaluate fit. If the old shape doesn't match v1 (likely — it was built for scenario+regression evals, not turn labeling), we write fresh.

**Files:**
- Create or restore: `src/eval-ui.html`

- [ ] **Step 1: Pull the deleted eval-ui.html for inspection**

```bash
git show 1f9066b^:src/eval-ui.html > /tmp/old-eval-ui.html
wc -l /tmp/old-eval-ui.html
head -50 /tmp/old-eval-ui.html
```
Expected: `1684 /tmp/old-eval-ui.html` and a glimpse of the old structure.

- [ ] **Step 2: Decide restore vs. rewrite**

Open `/tmp/old-eval-ui.html` in an editor. Spend 5 minutes reviewing. Decide:
- If the old shape has a recognizable "scenarios → turns" hierarchy with editable per-turn fields, copy it to `src/eval-ui.html` and skip to Step 4 to trim it.
- Otherwise, write fresh per Step 3.

The default for this plan is **write fresh** — the old UI predates the schema we're using by 2.5 months and is unlikely to fit cleanly.

- [ ] **Step 3: Write src/eval-ui.html from scratch**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Carryover Eval Workspace</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; max-width: 1100px; color: #222; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    h2 { font-size: 16px; margin: 24px 0 8px; }
    .crumbs { color: #666; font-size: 13px; margin-bottom: 12px; }
    .crumbs a { color: #2563eb; text-decoration: none; cursor: pointer; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border-bottom: 1px solid #eee; padding: 8px 10px; text-align: left; }
    tr.runrow:hover, tr.screnrow:hover { background: #f9fafb; cursor: pointer; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge.pass { background: #d1fae5; color: #065f46; }
    .badge.fail { background: #fee2e2; color: #991b1b; }
    .badge.none { background: #f3f4f6; color: #6b7280; }
    .turn { border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px; margin-bottom: 14px; background: #fff; }
    .turn h3 { font-size: 14px; margin: 0 0 10px; display: flex; align-items: center; gap: 10px; }
    .turn .row { margin: 6px 0; font-size: 13px; }
    .turn .label-key { color: #6b7280; font-weight: 500; margin-right: 6px; }
    .turn pre { background: #f9fafb; padding: 8px 10px; border-radius: 4px; font-size: 12px; overflow-x: auto; margin: 6px 0; }
    .score-widget { margin-top: 12px; padding-top: 10px; border-top: 1px solid #f3f4f6; }
    .score-btns { display: inline-flex; gap: 4px; margin-right: 10px; }
    .score-btns button { padding: 4px 10px; border: 1px solid #d1d5db; background: #fff; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .score-btns button.active { background: #2563eb; color: white; border-color: #2563eb; }
    .score-widget textarea { width: 100%; min-height: 50px; padding: 6px 8px; font-family: inherit; font-size: 13px; box-sizing: border-box; margin-top: 8px; border: 1px solid #d1d5db; border-radius: 4px; }
    .score-widget button.save { padding: 6px 14px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 6px; }
    .saved { color: #065f46; font-size: 12px; margin-left: 8px; }
    .prior { font-size: 12px; color: #6b7280; margin-top: 8px; }
    details summary { cursor: pointer; color: #2563eb; font-size: 12px; margin: 4px 0; }
  </style>
</head>
<body>
  <h1>Carryover Eval Workspace</h1>
  <div id="crumbs" class="crumbs"></div>
  <div id="view"></div>

  <script>
    const AXIS = 'context_carryover_quality';
    const state = { view: 'runs', runId: null, scenarioId: null, run: null };

    function el(html) {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      return t.content.firstChild;
    }

    function fmtFlags(jsonStr) {
      if (!jsonStr) return '';
      try {
        const o = JSON.parse(jsonStr);
        return Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
      } catch { return jsonStr; }
    }

    function fmtShortSha(sha) { return sha ? sha.slice(0, 7) : '—'; }

    // All DOM construction goes through helpers — no innerHTML with interpolated
    // strings. Even though every data source here is internal (DB rows produced
    // by the eval harness running our own brain), the schema accepts free-text
    // notes from any caller of POST /api/eval/labels, and the agent SMS / brain
    // prompt fields are LLM output. Treat all of it as untrusted.

    function _el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, v);
      }
      for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) for (const cc of c) node.append(cc);
        else if (typeof c === 'string') node.append(document.createTextNode(c));
        else node.append(c);
      }
      return node;
    }
    function _replaceChildren(host, ...nodes) {
      while (host.firstChild) host.removeChild(host.firstChild);
      for (const n of nodes) if (n) host.append(n);
    }

    async function showRuns() {
      state.view = 'runs';
      _replaceChildren(document.getElementById('crumbs'), document.createTextNode('Runs'));
      const r = await fetch('/api/eval/runs').then(x => x.json());
      const tbody = _el('tbody');
      if (!r.runs.length) {
        tbody.append(_el('tr', {}, _el('td', { colspan: 8, style: 'color:#6b7280' },
          'No runs yet. Run ', _el('code', {}, 'npm run eval:carryover'), '.')));
      } else {
        for (const run of r.runs) {
          tbody.append(_el('tr', { class: 'runrow', onclick: () => showRun(run.id) },
            _el('td', {}, `#${run.id}`),
            _el('td', {}, run.started_at.slice(0, 16).replace('T', ' ')),
            _el('td', {}, fmtShortSha(run.git_sha)),
            _el('td', {}, run.model || ''),
            _el('td', {}, fmtFlags(run.env_flags)),
            _el('td', {}, `${run.turn_count} turns`),
            _el('td', {}, `${run.labeled_count} labeled`),
            _el('td', {}, `${run.matcher_passed}/${run.matcher_evaluated} matched`),
          ));
        }
      }
      const table = _el('table', {},
        _el('thead', {}, _el('tr', {},
          ...['Run', 'Started', 'SHA', 'Model', 'Flags', 'Turns', 'Labels', 'Matcher'].map(h => _el('th', {}, h))
        )),
        tbody,
      );
      _replaceChildren(document.getElementById('view'), table);
    }

    async function showRun(runId) {
      state.view = 'run';
      state.runId = runId;
      const r = await fetch(`/api/eval/runs/${runId}`).then(x => x.json());
      state.run = r;
      _replaceChildren(document.getElementById('crumbs'),
        _el('a', { onclick: showRuns }, 'Runs'),
        document.createTextNode(` · Run #${runId}`),
      );
      const tbody = _el('tbody');
      for (const s of r.scenarios) {
        tbody.append(_el('tr', { class: 'screnrow', onclick: () => showScenario(s.scenario_id) },
          _el('td', {}, s.scenario_id),
          _el('td', {}, `${s.turn_count} turns`),
          _el('td', {}, `${s.labeled_count} labeled`),
          _el('td', {}, `${s.matcher_passed}/${s.matcher_evaluated} matched`),
        ));
      }
      const meta = _el('div', { style: 'margin-bottom:12px; color:#6b7280; font-size:13px' },
        `${r.run.model || ''} · ${fmtFlags(r.run.env_flags)} · ${fmtShortSha(r.run.git_sha)}`);
      const table = _el('table', {},
        _el('thead', {}, _el('tr', {},
          ...['Scenario', 'Turns', 'Labels', 'Matcher'].map(h => _el('th', {}, h))
        )),
        tbody,
      );
      _replaceChildren(document.getElementById('view'), meta, table);
    }

    async function showScenario(scenarioId) {
      state.view = 'scenario';
      state.scenarioId = scenarioId;
      const r = state.run;
      const scenarioTurns = r.turns.filter(t => t.scenario_id === scenarioId);
      const details = await Promise.all(
        scenarioTurns.map(t => fetch(`/api/eval/turns/${t.capture_id}`).then(x => x.json()))
      );
      _replaceChildren(document.getElementById('crumbs'),
        _el('a', { onclick: showRuns }, 'Runs'),
        document.createTextNode(' · '),
        _el('a', { onclick: () => showRun(state.runId) }, `Run #${state.runId}`),
        document.createTextNode(` · ${scenarioId}`),
      );
      _replaceChildren(document.getElementById('view'), ...details.map(renderTurn));
    }

    function renderTurn(d) {
      const t = d.turn;
      const mr = t.matcher_result ? JSON.parse(t.matcher_result) : null;
      const tc = t.tool_call ? JSON.parse(t.tool_call) : null;
      const sb = t.session_before ? JSON.parse(t.session_before) : null;
      const sa = t.session_after ? JSON.parse(t.session_after) : null;
      const myPrior = d.prior_labels.find(l => l.trace_id === t.trace_id);
      const otherPrior = d.prior_labels.filter(l => l.trace_id !== t.trace_id);
      const currentScore = myPrior ? myPrior.label : null;
      const currentNotes = myPrior ? (myPrior.notes || '') : '';

      const badge = mr === null
        ? _el('span', { class: 'badge none' }, 'no expect')
        : _el('span', { class: 'badge ' + (mr.passed ? 'pass' : 'fail') },
          'matcher: ' + (mr.passed ? 'pass' : 'fail'));

      const rows = [
        _el('div', { class: 'row' },
          _el('span', { class: 'label-key' }, 'user:'),
          _el('code', {}, t.user_msg || '')),
        _el('div', { class: 'row' },
          _el('span', { class: 'label-key' }, 'tool:'),
          _el('code', {}, tc ? `${tc.name}(${JSON.stringify(tc.params)})` : 'none')),
        _el('div', { class: 'row' },
          _el('span', { class: 'label-key' }, 'sms:'),
          document.createTextNode(t.agent_sms || '')),
      ];

      if (mr && !mr.passed) {
        rows.push(_el('div', { class: 'row', style: 'color:#991b1b' },
          mr.mismatches.map(m => `at ${m.path || '<root>'}: ${m.reason}`).join('; ')));
      }

      const dPrompt = _el('details', {},
        _el('summary', {}, 'brain prompt'),
        _el('pre', {}, t.brain_prompt || ''));
      const dMsgs = _el('details', {},
        _el('summary', {}, 'brain messages'),
        _el('pre', {}, t.brain_messages || ''));
      const dFrame = _el('details', {},
        _el('summary', {}, 'session before / after'),
        _el('pre', {}, `before: ${JSON.stringify(sb, null, 2)}\nafter:  ${JSON.stringify(sa, null, 2)}`));

      const scoreBtns = _el('div', { class: 'score-btns' },
        ...[1, 2, 3, 4, 5].map(n => _el('button', {
          class: currentScore === n ? 'active' : '',
          dataset: { score: String(n) },
        }, String(n)))
      );
      const savedAffordance = _el('span', {
        class: 'saved',
        style: 'display:' + (currentScore ? 'inline' : 'none'),
      }, 'saved ✓');
      const notesArea = _el('textarea', { placeholder: 'notes (why this grade?)' });
      notesArea.value = currentNotes;
      const saveBtn = _el('button', { class: 'save' }, 'Save label');

      const scoreWidget = _el('div', { class: 'score-widget' },
        scoreBtns, savedAffordance, notesArea, saveBtn);

      const priorBlock = otherPrior.length
        ? _el('div', { class: 'prior' },
          'Previous labels: ' + otherPrior.map(p =>
            `run #${p.run_id} → ${p.label}` + (p.notes ? ` ("${p.notes.slice(0, 40)}")` : '')
          ).join(', '))
        : null;

      const turn = _el('div', {
        class: 'turn',
        dataset: { traceId: t.trace_id },
      },
        _el('h3', {}, `Turn ${t.turn_index} `, badge),
        ...rows,
        dPrompt, dMsgs, dFrame,
        scoreWidget,
        priorBlock,
      );
      return turn;
    }

    // Click delegation for score buttons + save
    document.addEventListener('click', async (e) => {
      if (e.target.matches('.score-btns button')) {
        const turnEl = e.target.closest('.turn');
        turnEl.querySelectorAll('.score-btns button').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
      }
      if (e.target.matches('.score-widget button.save')) {
        const turnEl = e.target.closest('.turn');
        const trace_id = turnEl.dataset.traceId;
        const active = turnEl.querySelector('.score-btns button.active');
        if (!active) { alert('pick a score first'); return; }
        const label = parseInt(active.dataset.score, 10);
        const notes = turnEl.querySelector('textarea').value;
        const r = await fetch('/api/eval/labels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trace_id, axis: AXIS, label, notes }),
        }).then(x => x.json());
        if (r.ok) {
          const saved = turnEl.querySelector('.saved');
          saved.style.display = 'inline';
          saved.textContent = 'saved ✓';
        } else {
          alert('save failed: ' + (r.error || 'unknown'));
        }
      }
    });

    showRuns();
  </script>
</body>
</html>
```

- [ ] **Step 4: Manually verify the workspace renders**

Start the server (`node src/server.js`) and open `http://localhost:3000/eval` in a browser.
Expected: Runs page renders. If there are no runs yet, the table shows a placeholder. If you've already done Task 8's smoke test, you should see a run row — click it, click into a scenario, see the turn cards.

Kill the server.

- [ ] **Step 5: Commit**

```bash
git add src/eval-ui.html
git commit -m "feat(eval): /eval workspace UI — 3 nested views, label widget"
```

---

## Task 11: Wire up npm, verify end-to-end, update CLAUDE.md, drop superseded plan

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`
- Delete: `docs/superpowers/plans/2026-05-31-continuity-eval.md`

- [ ] **Step 1: Add npm script**

In `package.json`, in the `scripts` block, add:

```json
"eval:carryover": "node scripts/eval-carryover.js"
```

Final block:

```json
"scripts": {
  "start": "node src/server.js",
  "dev": "node --watch src/server.js",
  "test": "node test/run-all.js",
  "eval:carryover": "node scripts/eval-carryover.js"
}
```

- [ ] **Step 2: End-to-end manual verification**

```bash
npm test
```
Expected: all unit tests pass (including the 4 new ones).

```bash
npm run eval:carryover
```
Expected: runs all 10 scenarios, prints turn counts + matcher pass rates, finishes with `Run #N done. Open /eval to label.`

```bash
node src/server.js
```
Open `http://localhost:3000/eval`, navigate Runs → Run #N → click a scenario → label one turn → save. Refresh the page; the label should persist (the "saved ✓" affordance should reappear). Kill the server.

- [ ] **Step 3: Update CLAUDE.md**

Open `CLAUDE.md`. In the **Running** section, replace any line like `npm run eval:quality` (which doesn't exist) with:

```
npm run eval:carryover  # 10-scenario carryover replay + labeling workspace at /eval (~$0.03, ~60s)
```

In the **Architecture** description, find the line about evals (currently claims "Evals: 6 modules in src/evals/" — stale). Replace with:

```
Evals: carryover harness in `src/eval/carryover/` (10 multi-turn scenarios + matcher + replay against fixture pool, writes to eval_runs + eval_turn_captures); workspace at `/eval` for human labeling on `context_carryover_quality` (1-5) into response_labels. Spec: `docs/superpowers/specs/2026-05-31-context-carryover-eval-design.md`.
```

- [ ] **Step 4: Delete the superseded prior-draft plan**

```bash
rm docs/superpowers/plans/2026-05-31-continuity-eval.md
```

(The prior draft targeted a different shape — mechanical-only, no workspace UI. This plan supersedes it and incorporates the parts that are still useful.)

- [ ] **Step 5: Commit**

```bash
git add package.json CLAUDE.md
git rm docs/superpowers/plans/2026-05-31-continuity-eval.md
git commit -m "chore(eval): wire npm script, update CLAUDE.md, drop superseded plan"
```

---

## Self-Review

**Spec coverage:**
- [x] Schema: eval_runs + eval_turn_captures (Task 1)
- [x] setEventCache on events.js (Task 2)
- [x] Fixture pool (Task 3)
- [x] Matcher library (Task 4)
- [x] Scenario loader (Task 5)
- [x] 10 scenarios (Task 6)
- [x] Replay harness with brain-prompt capture (Task 7)
- [x] CLI runner (Task 8)
- [x] API routes (Task 9)
- [x] Workspace UI with 3 nested views + label widget (Task 10)
- [x] Wire-up + CLAUDE.md fix (Task 11)
- [x] Defer judge, calibration, diff-view, authoring (called out in spec; absent from plan deliberately)
- [x] Single axis context_carryover_quality 1-5 + notes (Task 9 POST + Task 10 UI)
- [x] Matcher badge is informational only, doesn't pre-fill score (Task 10 renderTurn — badge rendered, score buttons unrelated)

**Type consistency:**
- `match(expected, actual) → { passed, mismatches }` — defined in Task 4, used by Task 7.
- `loadAllScenarios(dirPath) → [scenario]` — defined in Task 5, used by Task 8.
- `replayScenario(scenario, { runId, db }) → { scenarioId, description, turns: [...] }` — defined in Task 7, used by Task 8.
- `snapshotSession(session)` — defined in Task 7, used internally only.
- `setEventCache(events)` — defined in Task 2, used by Task 7 (via require inside replayScenario).
- `eval_turn_captures` columns — defined in Task 1, written by Task 7, read by Task 9, rendered by Task 10. All column names match across tasks.
- `response_labels` schema — already exists from `b12d5df`; written by Task 9 with `axis='context_carryover_quality'`, `label IN 1..5`, `labeler_id` from env or `'jk'`.

**Operating cost:**
- Per run: 10 scenarios × ~3 turns avg × ~$0.001/brain call ≈ **$0.03**, ~60s.
- Labels: human time only.

**Risks documented in spec, not re-documented here:**
- Brain non-determinism may cause matcher flakes at regex boundaries.
- Small fixture pool may cause brain to respond conversationally on `09-greeting-then-hood` if quality gates drop too many — Task 3 step 2 verifies this.
- The `patchRunAgentLoop` monkey-patch in Task 7 is contained to replay only; if it breaks (e.g., llm.js stops exposing `runAgentLoop` as a named export), replays will return null `brain_prompt` — Task 7's smoke test catches that.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-31-context-carryover-eval-impl.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
