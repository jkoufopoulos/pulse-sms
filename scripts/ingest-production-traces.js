#!/usr/bin/env node
// scripts/ingest-production-traces.js
//
// Loads every JSONL trace from data/traces/, groups by phone_masked, and
// persists each phone's conversation into the eval workbench as a single
// production-source eval_runs row + one eval_turn_captures row per trace.
//
// Also: scrubs all prior synthetic runs from the bench (DELETE FROM
// eval_runs + eval_turn_captures) and ALTERs eval_runs to add the 'source'
// column on existing DBs (idempotent — checks PRAGMA first).
//
// Filters: drops phones with <2 turns (fragments aren't conversations).
//
// Usage: node scripts/ingest-production-traces.js [--dry] [--keep-synthetic]

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getDb } = require('../src/db');

const TRACES_DIR = path.join(__dirname, '..', 'data', 'traces');
const MIN_TURNS_PER_PHONE = 2;

function parseArgs(argv) {
  return {
    dry: argv.includes('--dry'),
    keepSynthetic: argv.includes('--keep-synthetic'),
  };
}

function getGitSha() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function loadAllTraces() {
  const files = fs.readdirSync(TRACES_DIR).filter(f => f.endsWith('.jsonl'));
  const traces = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(TRACES_DIR, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { traces.push(JSON.parse(line)); } catch (e) { /* skip malformed */ }
    }
  }
  return traces;
}

function groupByPhone(traces) {
  const byPhone = new Map();
  for (const t of traces) {
    const p = t.phone_masked;
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(t);
  }
  for (const [p, list] of byPhone) {
    list.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }
  return byPhone;
}

function ensureSourceColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(eval_runs)`).all().map(c => c.name);
  if (!cols.includes('source')) {
    db.exec(`ALTER TABLE eval_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'synthetic'`);
    console.log('[migration] added eval_runs.source column');
  }
}

function scrubSynthetic(db) {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM eval_runs`).get().n;
  db.exec(`DELETE FROM eval_turn_captures`);
  db.exec(`DELETE FROM eval_runs`);
  console.log(`[scrub] removed ${before} synthetic runs and all their turn captures`);
}

function extractToolCall(trace) {
  const calls = trace.brain_tool_calls || [];
  if (!calls.length) return null;
  const last = calls[calls.length - 1];
  return { name: last.name, params: last.params || {} };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = getDb();

  ensureSourceColumn(db);
  if (!args.keepSynthetic) scrubSynthetic(db);

  const traces = loadAllTraces();
  const byPhone = groupByPhone(traces);

  console.log(`[ingest] loaded ${traces.length} traces across ${byPhone.size} phones`);

  // Filter to phones with >= MIN_TURNS_PER_PHONE
  const conversationalPhones = [...byPhone.entries()].filter(([_, ts]) => ts.length >= MIN_TURNS_PER_PHONE);
  console.log(`[ingest] ${conversationalPhones.length} phones have >= ${MIN_TURNS_PER_PHONE} turns (kept)`);

  if (args.dry) {
    console.log('[dry-run] skipping inserts. Top phones by turn count:');
    for (const [p, ts] of conversationalPhones.slice(0, 10)) {
      console.log(`  ${p}: ${ts.length} turns (${ts[0].timestamp?.slice(0, 10)} → ${ts[ts.length-1].timestamp?.slice(0, 10)})`);
    }
    return;
  }

  // Single production run for ALL phones — each phone is one "scenario"
  const runId = db.prepare(`
    INSERT INTO eval_runs (started_at, git_sha, model, env_flags, notes, source)
    VALUES (?, ?, ?, ?, ?, 'production')
  `).run(
    new Date().toISOString(),
    getGitSha(),
    'mixed (production)',
    JSON.stringify({}),
    `Ingested ${traces.length} traces; ${conversationalPhones.length} conversations.`,
  ).lastInsertRowid;

  console.log(`[ingest] created production run #${runId}`);

  const insert = db.prepare(`INSERT INTO eval_turn_captures (
    run_id, scenario_id, turn_index, trace_id, user_msg,
    brain_prompt, brain_messages, tool_call, agent_sms,
    session_before, session_after, matcher_result, captured_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let inserted = 0;
  for (const [phone, phoneTraces] of conversationalPhones) {
    // scenario_id = phone (masked), turn_index = position in chronological order
    for (let i = 0; i < phoneTraces.length; i++) {
      const t = phoneTraces[i];
      const toolCall = extractToolCall(t);
      insert.run(
        runId,
        phone,
        i,
        t.id || `legacy-${phone}-${i}`,  // some old traces may not have ids
        t.input_message || '',
        null,  // brain_prompt — not captured in production traces
        null,  // brain_messages — not captured in production traces
        toolCall ? JSON.stringify(toolCall) : null,
        t.output_sms || null,
        null,  // session_before — production traces don't snapshot
        null,  // session_after
        null,  // matcher_result — production has no expect block
        t.timestamp || new Date().toISOString(),
      );
      inserted++;
    }
  }

  console.log(`[ingest] inserted ${inserted} turns across ${conversationalPhones.length} conversations`);
  console.log(`[ingest] open /eval — run #${runId} is the production data`);
}

main().catch(err => { console.error(err); process.exit(1); });
