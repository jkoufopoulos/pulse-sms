#!/usr/bin/env node
// scripts/split-by-session-gap.js
//
// One-shot retroactive split: walks each (run_id, scenario_id) in
// eval_turn_captures sorted by captured_at; whenever a gap > GAP_HOURS
// appears between consecutive turns, starts a new sub-conversation by
// appending ":s2", ":s3", etc. to scenario_id. Sub-3-turn segments are
// soft-discarded via eval_scenario_meta.
//
// Labels survive: response_labels is keyed by trace_id, which doesn't
// change. conversation_labels referencing the un-split scenario_id are
// deleted (the labeling unit changed; user needs to re-label).
//
// Run: node scripts/split-by-session-gap.js [--dry]

const { getDb } = require('../src/db');

const GAP_HOURS = 6;          // gap longer than this → new conversation
const MIN_TURNS = 3;

// NYC calendar date for an ISO timestamp ('en-CA' returns YYYY-MM-DD).
function nycCalendarDay(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function segmentTurns(turns) {
  // turns: sorted ascending by captured_at. Returns array of arrays.
  // New segment when: gap > GAP_HOURS OR crosses NYC calendar day.
  const segments = [];
  let current = [];
  for (const t of turns) {
    if (current.length === 0) { current.push(t); continue; }
    const prev = current[current.length - 1];
    const gapMs = new Date(t.captured_at) - new Date(prev.captured_at);
    const sameDayNyc = nycCalendarDay(t.captured_at) === nycCalendarDay(prev.captured_at);
    const isNewSession = gapMs > GAP_HOURS * 3600 * 1000 || !sameDayNyc;
    if (isNewSession) {
      segments.push(current);
      current = [t];
    } else {
      current.push(t);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();

  const all = db.prepare(`
    SELECT id, run_id, scenario_id, turn_index, captured_at
    FROM eval_turn_captures
    ORDER BY run_id, scenario_id, captured_at
  `).all();

  // Group by (run_id, scenario_id)
  const groups = new Map();
  for (const r of all) {
    const k = `${r.run_id}::${r.scenario_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  let totalRenamed = 0;
  let totalDiscarded = 0;
  let scenariosSplit = 0;
  let scenariosUntouched = 0;
  const renames = [];  // [{capture_id, new_scenario_id, new_turn_index}]
  const discards = [];  // [{run_id, scenario_id, reason}]
  const conv_label_drops = [];  // scenario_ids to drop conv labels for

  for (const [key, turns] of groups) {
    const [runIdStr, baseScenarioId] = key.split('::');
    const runId = parseInt(runIdStr, 10);
    const segments = segmentTurns(turns);
    if (segments.length === 1) { scenariosUntouched++; continue; }

    scenariosSplit++;
    conv_label_drops.push({ run_id: runId, scenario_id: baseScenarioId });

    // Rename each segment with :s{N} suffix. First segment keeps the base id
    // for continuity; subsequent get :s2, :s3 etc.
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const newId = segIdx === 0 ? baseScenarioId : `${baseScenarioId}:s${segIdx + 1}`;
      for (let i = 0; i < segments[segIdx].length; i++) {
        const cap = segments[segIdx][i];
        renames.push({ capture_id: cap.id, new_scenario_id: newId, new_turn_index: i });
        totalRenamed++;
      }
      if (segments[segIdx].length < MIN_TURNS) {
        discards.push({ run_id: runId, scenario_id: newId, count: segments[segIdx].length });
        totalDiscarded++;
      }
    }
  }

  console.log(`Scenarios with >24h gaps to split: ${scenariosSplit}`);
  console.log(`Scenarios untouched (single session): ${scenariosUntouched}`);
  console.log(`Turn captures to rename: ${totalRenamed}`);
  console.log(`New segments below ${MIN_TURNS}-turn floor (to discard): ${totalDiscarded}`);
  console.log('');

  if (dry) {
    console.log('=== DRY RUN — sample renames ===');
    const byNewId = {};
    for (const r of renames) {
      byNewId[r.new_scenario_id] = (byNewId[r.new_scenario_id] || 0) + 1;
    }
    const sorted = Object.entries(byNewId).sort((a, b) => b[1] - a[1]);
    for (const [id, n] of sorted.slice(0, 30)) console.log(` ${id}: ${n} turns`);
    if (sorted.length > 30) console.log(` ... and ${sorted.length - 30} more`);
    console.log('');
    console.log('=== Segments to discard ===');
    for (const d of discards) console.log(` ${d.scenario_id} (${d.count} turn${d.count===1?'':'s'})`);
    return;
  }

  // Apply renames in a transaction
  const upd = db.prepare(`UPDATE eval_turn_captures SET scenario_id = ?, turn_index = ? WHERE id = ?`);
  const dropConvLabel = db.prepare(`DELETE FROM conversation_labels WHERE run_id = ? AND scenario_id = ?`);
  const upsertMeta = db.prepare(`
    INSERT INTO eval_scenario_meta (run_id, scenario_id, status, notes, updated_at)
    VALUES (?, ?, 'discarded', ?, ?)
    ON CONFLICT(run_id, scenario_id) DO UPDATE SET
      status = 'discarded', notes = excluded.notes, updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const r of renames) upd.run(r.new_scenario_id, r.new_turn_index, r.capture_id);
    for (const c of conv_label_drops) dropConvLabel.run(c.run_id, c.scenario_id);
    for (const d of discards) {
      upsertMeta.run(d.run_id, d.scenario_id, `auto-discarded: ${d.count}-turn segment below ${MIN_TURNS}-turn floor (post-split)`, now);
    }
  })();

  console.log(`Applied ${totalRenamed} renames, dropped ${conv_label_drops.length} stale conv-labels, discarded ${totalDiscarded} sub-${MIN_TURNS}-turn segments.`);
}

main();
