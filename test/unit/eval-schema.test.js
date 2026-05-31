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
