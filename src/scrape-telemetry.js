/**
 * Per-source scrape telemetry. Three-call surface:
 *   startRun(source)                  -> run_id
 *   recordStage(run_id, name, metrics, duration_ms?)
 *   endRun(run_id, status, events_returned?, error?)
 *
 * The pipeline calls these around each source's fetchFn so we can see per-stage
 * detail (fetch / parse / llm_extract / normalize / merge / cache) and per-run
 * outcomes. Failure to record telemetry MUST NEVER break the scrape — every
 * write is wrapped in try/catch and logs to console on failure.
 *
 * See `scrape_runs`, `scrape_stages`, `scrape_invariants` in src/db.js.
 */

const { getDb } = require('./db');

function startRun(source) {
  try {
    const db = getDb();
    const startedAt = new Date().toISOString();
    const r = db.prepare(`
      INSERT INTO scrape_runs (source, started_at, status)
      VALUES (?, ?, 'running')
    `).run(source, startedAt);
    return r.lastInsertRowid;
  } catch (err) {
    console.warn(`[telemetry] startRun(${source}) failed:`, err.message);
    return null;
  }
}

function recordStage(runId, stageName, metrics, durationMs = null) {
  if (!runId) return;
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO scrape_stages (run_id, stage_name, started_at, duration_ms, metrics_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      runId,
      stageName,
      new Date().toISOString(),
      durationMs,
      JSON.stringify(metrics || {}),
    );
  } catch (err) {
    console.warn(`[telemetry] recordStage(${runId}, ${stageName}) failed:`, err.message);
  }
}

function endRun(runId, status, eventsReturned = null, errorMessage = null) {
  if (!runId) return;
  try {
    const db = getDb();
    db.prepare(`
      UPDATE scrape_runs
      SET completed_at = ?, status = ?, events_returned = ?, error_message = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      status,
      eventsReturned,
      errorMessage,
      runId,
    );
  } catch (err) {
    console.warn(`[telemetry] endRun(${runId}) failed:`, err.message);
  }
}

/** Convenience: time an async fn and record its stage in one call. */
async function timedStage(runId, stageName, fn, deriveMetrics = () => ({})) {
  const t0 = Date.now();
  try {
    const result = await fn();
    recordStage(runId, stageName, deriveMetrics(result), Date.now() - t0);
    return result;
  } catch (err) {
    recordStage(runId, stageName, { error: err.message }, Date.now() - t0);
    throw err;
  }
}

/**
 * Find the most recent run id for a source. Used by refreshCache to attach
 * merge/cache stages to whichever scrape pass just produced the events.
 * Returns null if no run exists for the source.
 */
function latestRunIdForSource(source) {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT id FROM scrape_runs
      WHERE source = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(source);
    return row?.id ?? null;
  } catch (err) {
    console.warn(`[telemetry] latestRunIdForSource(${source}) failed:`, err.message);
    return null;
  }
}

module.exports = { startRun, recordStage, endRun, timedStage, latestRunIdForSource };
