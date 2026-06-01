#!/usr/bin/env node
// scripts/backfill-events-meta.js
//
// One-shot: adds eval_turn_captures.events_meta column if missing, then
// backfills it from data/traces/*.jsonl by joining on trace_id. Preserves
// every existing row (labels, discard status, etc.) — UPDATE only, no DELETE.
//
// Run after the trace.events schema or the ingest fields change.

const fs = require('fs');
const path = require('path');
const { getDb } = require('../src/db');

function ensureColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(eval_turn_captures)`).all().map(c => c.name);
  if (!cols.includes('events_meta')) {
    db.exec(`ALTER TABLE eval_turn_captures ADD COLUMN events_meta TEXT`);
    console.log('[migration] added eval_turn_captures.events_meta');
  } else {
    console.log('[migration] events_meta column already present');
  }
}

function loadAllTraces() {
  const TRACES_DIR = path.join(__dirname, '..', 'data', 'traces');
  const byId = new Map();
  for (const f of fs.readdirSync(TRACES_DIR).filter(f => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(TRACES_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        if (t.id) byId.set(t.id, t);
      } catch {}
    }
  }
  return byId;
}

function extractEventsMeta(trace) {
  if (!trace?.events) return null;
  const e = trace.events;
  // Subset of trace.events that matters for the workbench badge:
  //   - cache_size (was there anything at all in the cache?)
  //   - candidates_count (did anything survive filtering?)
  //   - funnel (where in the pipeline did things drop, if instrumented)
  return JSON.stringify({
    cache_size: e.cache_size ?? null,
    candidates_count: e.candidates_count ?? null,
    funnel: e.funnel ?? null,
  });
}

function main() {
  const db = getDb();
  ensureColumn(db);

  const tracesById = loadAllTraces();
  console.log(`[backfill] loaded ${tracesById.size} traces from disk`);

  const captures = db.prepare(`SELECT id, trace_id FROM eval_turn_captures WHERE events_meta IS NULL`).all();
  console.log(`[backfill] ${captures.length} captures missing events_meta`);

  const update = db.prepare(`UPDATE eval_turn_captures SET events_meta = ? WHERE id = ?`);
  let updated = 0;
  let noTrace = 0;
  for (const c of captures) {
    const trace = tracesById.get(c.trace_id);
    if (!trace) { noTrace++; continue; }
    const meta = extractEventsMeta(trace);
    if (meta) {
      update.run(meta, c.id);
      updated++;
    }
  }
  console.log(`[backfill] updated ${updated} captures; ${noTrace} had no matching trace in JSONL (legacy/synthetic)`);

  // Quick sanity: how many turns now show candidates_count = 0?
  const emptyCount = db.prepare(`
    SELECT COUNT(*) AS n FROM eval_turn_captures
    WHERE events_meta IS NOT NULL
    AND json_extract(events_meta, '$.candidates_count') = 0
  `).get().n;
  console.log(`[backfill] turns with candidates_count = 0 (will show empty-data badge):`, emptyCount);
}

main();
