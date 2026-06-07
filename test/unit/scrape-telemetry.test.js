const { check } = require('../helpers');

// Smoke tests for the v1 data-health observability slice. We exercise the
// telemetry write path + invariant detection logic against the live SQLite db.
// All probe rows are cleaned up after the test runs so the suite is idempotent.

console.log('\nScrape telemetry round-trip:');

const { startRun, recordStage, endRun, latestRunIdForSource } = require('../../src/scrape-telemetry');
const { getDb } = require('../../src/db');
const db = getDb();

const probeSource = 'TestProbeSrc__telemetry';
const runId = startRun(probeSource);
check('startRun returns an id', typeof runId === 'number' && runId > 0);

recordStage(runId, 'fetch', { status_code: 200, bytes: 12345 }, 100);
recordStage(runId, 'parse', { sections: 3 }, 5);
endRun(runId, 'ok', 7);

const run = db.prepare('SELECT * FROM scrape_runs WHERE id = ?').get(runId);
check('endRun sets status', run.status === 'ok');
check('endRun sets events_returned', run.events_returned === 7);
check('endRun sets completed_at', !!run.completed_at);

const stages = db.prepare('SELECT stage_name, metrics_json FROM scrape_stages WHERE run_id = ? ORDER BY id').all(runId);
check('two stages recorded', stages.length === 2);
const fetchMetrics = JSON.parse(stages[0].metrics_json);
check('fetch stage carries metrics', fetchMetrics.status_code === 200 && fetchMetrics.bytes === 12345);

check('latestRunIdForSource returns this run', latestRunIdForSource(probeSource) === runId);

// Clean up
db.prepare('DELETE FROM scrape_stages WHERE run_id = ?').run(runId);
db.prepare('DELETE FROM scrape_runs WHERE id = ?').run(runId);

console.log('\nScrape invariant detection:');

const { checkInvariants } = require('../../src/scrape-invariants');

// Stale-snapshot pattern: 5 runs returning exactly the same count must trigger
// the output_variance check.
const staleIds = [];
for (let i = 0; i < 5; i++) {
  const id = startRun(probeSource);
  recordStage(id, 'llm_extract', { events_post_filter: 64 });
  recordStage(id, 'cache', { source_events_in_cache: 0 });
  endRun(id, 'ok', 64);
  staleIds.push(id);
}

// checkInvariants is async (sendRuntimeAlert may await), but we don't need to
// wait for the alert side-effect — the DB writes happen synchronously inline.
checkInvariants(staleIds[4], probeSource).then(results => {
  const variance = results.find(r => r.name === 'output_variance');
  check('output_variance fails on identical counts', variance && !variance.passed);
  check('output_variance message names the count', variance && /identical \(64\)/.test(variance.message));

  const editorial = results.find(r => r.name === 'editorial_share');
  check('editorial_share fails when source absent from cache', editorial && !editorial.passed);

  const survival = results.find(r => r.name === 'survival_rate');
  check('survival_rate fails on zero survival', survival && !survival.passed);

  // Clean up probe rows
  for (const id of staleIds) {
    db.prepare('DELETE FROM scrape_invariants WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM scrape_stages WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM scrape_runs WHERE id = ?').run(id);
  }
});
