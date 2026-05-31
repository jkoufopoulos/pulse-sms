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
  // Seed an eval_runs row so the FK on eval_turn_captures.run_id is satisfied
  db.prepare(`INSERT INTO eval_runs (id, started_at, model) VALUES (1, ?, ?)`)
    .run(new Date().toISOString(), 'test-model');

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

  const rows = db.prepare('SELECT * FROM eval_turn_captures WHERE run_id = 1 ORDER BY turn_index').all();
  check('2 capture rows persisted', rows.length === 2);
  check('row 0 has the user_msg', rows[0].user_msg === 'williamsburg');
  check('row 0 has non-null brain_prompt', rows[0].brain_prompt && rows[0].brain_prompt.length > 0);

  db.close();
};
