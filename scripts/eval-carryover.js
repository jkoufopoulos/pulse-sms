#!/usr/bin/env node
// scripts/eval-carryover.js
//
// Usage: node scripts/eval-carryover.js [--scenario <id>]
//
// Loads all carryover scenarios, creates an eval_runs row, runs each scenario
// through the replay harness, prints a summary.

require('dotenv').config();

const path = require('path');
const { execFileSync } = require('child_process');

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
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
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
