#!/usr/bin/env node
// scripts/ingest-production-traces.js
//
// Loads every JSONL trace from data/traces/, groups by phone_masked, and
// upserts each phone's conversation into the singleton production
// eval_runs row + one eval_turn_captures row per trace.
//
// Per-turn source label: 'sms' if the trace id starts with 'twilio-backfill-'
// (real SMS pulled from Twilio API), 'simulator' if the masked phone tail
// matches a known test-pool pattern (+1555*), else 'sms' (real-user SMS
// that arrived live via the Twilio webhook).
//
// Default behavior is NON-DESTRUCTIVE: existing labels and prior turns
// stay put. New traces (by trace_id) are appended into the existing
// production run. Use --scrub to nuke everything and start fresh.
//
// Filters: drops phones with <MIN_TURNS_PER_PHONE turns (fragments aren't
// conversations) — but only when DECIDING what to insert; existing turns
// in the run are never deleted.
//
// Usage:
//   node scripts/ingest-production-traces.js          # upsert (safe)
//   node scripts/ingest-production-traces.js --dry    # preview only
//   node scripts/ingest-production-traces.js --scrub  # nuke + reingest

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getDb } = require('../src/db');

const TRACES_DIR = path.join(__dirname, '..', 'data', 'traces');
const MIN_TURNS_PER_PHONE = 3;  // <3 turns can't exercise carryover

function parseArgs(argv) {
  return {
    dry: argv.includes('--dry'),
    scrub: argv.includes('--scrub'),
  };
}

const SIMULATOR_TAILS = new Set(['0000', '0003', '0099', '1234', '2233', '9990', '9999']);
function isSimulatorTail(tail) {
  if (SIMULATOR_TAILS.has(tail)) return true;
  const n = parseInt(tail, 10);
  if (n >= 2000 && n <= 2024) return true;
  if (n >= 3000 && n <= 3024) return true;
  return false;
}

function detectSource(trace) {
  if (typeof trace.id === 'string' && trace.id.startsWith('twilio-backfill-')) return 'sms';
  if (trace.source === 'twilio-backfill') return 'sms';
  const m = String(trace.phone_masked || '').match(/(\d{4})$/);
  if (m && isSimulatorTail(m[1])) return 'simulator';
  return 'sms';
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

function ensureSchema(db) {
  const runCols = db.prepare(`PRAGMA table_info(eval_runs)`).all().map(c => c.name);
  if (!runCols.includes('source')) {
    db.exec(`ALTER TABLE eval_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'synthetic'`);
    console.log('[migration] added eval_runs.source column');
  }
  const capCols = db.prepare(`PRAGMA table_info(eval_turn_captures)`).all().map(c => c.name);
  if (!capCols.includes('source')) {
    db.exec(`ALTER TABLE eval_turn_captures ADD COLUMN source TEXT`);
    console.log('[migration] added eval_turn_captures.source column');
  }
}

function scrubAll(db) {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM eval_runs`).get().n;
  db.exec(`DELETE FROM eval_turn_captures`);
  db.exec(`DELETE FROM eval_runs`);
  console.log(`[scrub] removed ${before} runs and all their turn captures (labels in response_labels survive but are orphaned until re-ingest)`);
}

function findOrCreateProductionRun(db, getGitSha) {
  const existing = db.prepare(`SELECT id FROM eval_runs WHERE source = 'production' ORDER BY id ASC LIMIT 1`).get();
  if (existing) return existing.id;
  return db.prepare(`
    INSERT INTO eval_runs (started_at, git_sha, model, env_flags, notes, source)
    VALUES (?, ?, ?, ?, ?, 'production')
  `).run(
    new Date().toISOString(),
    getGitSha(),
    'mixed (production)',
    JSON.stringify({}),
    'Production: live SMS + simulator traces.'
  ).lastInsertRowid;
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

  ensureSchema(db);
  if (args.scrub) scrubAll(db);

  const traces = loadAllTraces();
  const byPhone = groupByPhone(traces);

  console.log(`[ingest] loaded ${traces.length} traces across ${byPhone.size} phones`);

  // Filter to phones with >= MIN_TURNS_PER_PHONE for INSERT decisions; existing
  // turns in the run are never deleted.
  const conversationalPhones = [...byPhone.entries()].filter(([_, ts]) => ts.length >= MIN_TURNS_PER_PHONE);
  console.log(`[ingest] ${conversationalPhones.length} phones have >= ${MIN_TURNS_PER_PHONE} turns (eligible for insert)`);

  if (args.dry) {
    console.log('[dry-run] skipping inserts. Top phones by turn count (with detected source):');
    for (const [p, ts] of conversationalPhones.slice(0, 10)) {
      const src = detectSource(ts[0]);
      console.log(`  ${p} [${src}]: ${ts.length} turns (${ts[0].timestamp?.slice(0, 10)} → ${ts[ts.length-1].timestamp?.slice(0, 10)})`);
    }
    return;
  }

  const runId = findOrCreateProductionRun(db, getGitSha);
  console.log(`[ingest] upserting into production run #${runId}`);

  // Pre-load existing trace_ids in this run so we skip duplicates
  const existingIds = new Set(
    db.prepare(`SELECT trace_id FROM eval_turn_captures WHERE run_id = ?`).all(runId).map(r => r.trace_id)
  );
  console.log(`[ingest] run #${runId} already has ${existingIds.size} turns; skipping any with matching trace_id`);

  const insert = db.prepare(`INSERT INTO eval_turn_captures (
    run_id, scenario_id, turn_index, trace_id, user_msg,
    brain_prompt, brain_messages, tool_call, agent_sms,
    session_before, session_after, matcher_result, events_meta, captured_at, source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // For each phone, figure out where to resume turn_index numbering
  const maxIdxByPhone = new Map();
  for (const row of db.prepare(`SELECT scenario_id, MAX(turn_index) AS maxIdx FROM eval_turn_captures WHERE run_id = ? GROUP BY scenario_id`).all(runId)) {
    maxIdxByPhone.set(row.scenario_id, row.maxIdx);
  }

  const tx = db.transaction(() => {
    let inserted = 0, skipped = 0;
    const counts = { sms: 0, simulator: 0 };
    for (const [phone, phoneTraces] of conversationalPhones) {
      let nextIdx = (maxIdxByPhone.get(phone) ?? -1) + 1;
      for (const t of phoneTraces) {
        const traceId = t.id || `legacy-${phone}-${nextIdx}`;
        if (existingIds.has(traceId)) { skipped++; continue; }
        const toolCall = extractToolCall(t);
        const eventsMeta = t.events ? JSON.stringify({
          cache_size: t.events.cache_size ?? null,
          candidates_count: t.events.candidates_count ?? null,
          funnel: t.events.funnel ?? null,
        }) : null;
        const source = detectSource(t);
        counts[source] = (counts[source] || 0) + 1;
        insert.run(
          runId, phone, nextIdx++, traceId,
          t.input_message || '',
          t.brain_prompt || null,
          t.brain_messages || null,
          toolCall ? JSON.stringify(toolCall) : null,
          t.output_sms || null,
          t.session_before ? JSON.stringify(t.session_before) : null,
          null, null, eventsMeta,
          t.timestamp || new Date().toISOString(),
          source,
        );
        inserted++;
      }
    }
    console.log(`[ingest] inserted ${inserted} new turns (skipped ${skipped} already present); source breakdown: ${JSON.stringify(counts)}`);
  });
  tx();

  const summary = db.prepare(`
    SELECT COUNT(DISTINCT scenario_id) AS convos, COUNT(*) AS turns FROM eval_turn_captures WHERE run_id = ?
  `).get(runId);
  db.prepare(`UPDATE eval_runs SET notes = ? WHERE id = ?`).run(
    `Production: ${summary.convos} conversations, ${summary.turns} turns (sms + simulator).`,
    runId,
  );
  console.log(`[ingest] run #${runId} now has ${summary.convos} conversations, ${summary.turns} turns total`);
}

main().catch(err => { console.error(err); process.exit(1); });
