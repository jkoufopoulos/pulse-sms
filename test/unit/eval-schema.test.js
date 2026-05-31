// test/unit/eval-schema.test.js
const Database = require('better-sqlite3');
const { check } = require('../helpers');
const { runMigrations } = require('../../src/db');

console.log('\n--- eval-schema.test.js ---');

const db = new Database(':memory:');
runMigrations(db);

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

// Also verify columns on the other two new tables (review finding)
const labelCols = db.prepare(`PRAGMA table_info(response_labels)`).all().map(c => c.name);
check('response_labels has trace_id', labelCols.includes('trace_id'));
check('response_labels has axis', labelCols.includes('axis'));
check('response_labels has label', labelCols.includes('label'));
check('response_labels has labeler_id', labelCols.includes('labeler_id'));
check('response_labels has labeled_at', labelCols.includes('labeled_at'));

const calCols = db.prepare(`PRAGMA table_info(calibration_runs)`).all().map(c => c.name);
check('calibration_runs has axis', calCols.includes('axis'));
check('calibration_runs has n_labeled', calCols.includes('n_labeled'));
check('calibration_runs has agreement', calCols.includes('agreement'));
check('calibration_runs has kappa', calCols.includes('kappa'));
check('calibration_runs has window_start', calCols.includes('window_start'));
check('calibration_runs has window_end', calCols.includes('window_end'));
check('calibration_runs has computed_at', calCols.includes('computed_at'));

// Verify the UNIQUE constraint on response_labels works correctly even with default labeler_id
const insert = db.prepare(`INSERT INTO response_labels (trace_id, axis, label, labeled_at) VALUES (?, ?, ?, ?)`);
insert.run('t1', 'intent_carry', 1, '2026-05-31T00:00:00Z');
let threw = false;
try { insert.run('t1', 'intent_carry', 0, '2026-05-31T00:01:00Z'); } catch { threw = true; }
check('duplicate (trace_id, axis) with default labeler_id is rejected', threw);

db.close();
