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
