/**
 * Per-scrape-run invariants. Five checks that catch the failure modes surfaced
 * in the June 2026 data-layer audit:
 *
 *   1. output_variance     — count of events varies across last 7 runs
 *                            (catches stale on-disk-snapshot scrapers)
 *   2. date_freshness      — max event date_local is at least today+2
 *                            (catches "we scraped but events are old")
 *   3. completeness        — median completeness >= 0.5
 *                            (catches LLM extraction degradation)
 *   4. editorial_share     — source contributes at least N events to final cache
 *                            (catches "scrape ran but produced almost nothing")
 *   5. survival_rate       — events_in_cache / events_extracted >= 0.3
 *                            (catches "scrape works but merge is killing everything")
 *
 * Each check writes a row to scrape_invariants. On any failure, a single
 * runtime alert is sent via sendRuntimeAlert (Resend). The alert names the
 * failing invariants so the on-call doesn't have to dig.
 */

const { getDb } = require('./db');

const VARIANCE_LOOKBACK = 7;
const DATE_FRESHNESS_MIN_DAYS = 2;
const COMPLETENESS_FLOOR = 0.5;
const EDITORIAL_SHARE_FLOOR = 1;       // events surviving to cache
const SURVIVAL_RATE_FLOOR = 0.3;        // events_in_cache / events_extracted

function getNycDateString(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function readStageMetrics(db, runId, stageName) {
  const row = db.prepare(`
    SELECT metrics_json FROM scrape_stages
    WHERE run_id = ? AND stage_name = ?
    ORDER BY id DESC LIMIT 1
  `).get(runId, stageName);
  if (!row?.metrics_json) return null;
  try { return JSON.parse(row.metrics_json); } catch { return null; }
}

function checkOutputVariance(db, runId, source) {
  // Pull last N runs' events_returned values. If they're all identical, the
  // source is almost certainly serving from a disk snapshot (NonsenseNYC and
  // BKMag pattern). Variance of 0 = fail.
  const rows = db.prepare(`
    SELECT events_returned FROM scrape_runs
    WHERE source = ? AND events_returned IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(source, VARIANCE_LOOKBACK);
  if (rows.length < 3) {
    return { name: 'output_variance', passed: true, value: null, threshold: null,
      message: `only ${rows.length} prior runs — variance check skipped` };
  }
  const counts = rows.map(r => r.events_returned);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  const passed = variance > 0;
  return {
    name: 'output_variance',
    passed,
    value: variance,
    threshold: 0,
    message: passed
      ? `variance ${variance.toFixed(1)} over last ${rows.length} runs`
      : `events_returned identical (${counts[0]}) across last ${rows.length} runs — likely stale snapshot`,
  };
}

function checkDateFreshness(db, runId, source) {
  // Max date_local across events from this run should be >= today + 2 days.
  // A run that scrapes successfully but produces only past-dated events is
  // useless for the serving cache (those events get filtered before serving).
  const row = db.prepare(`
    SELECT MAX(date_local) AS max_date FROM scraped_events
    WHERE scrape_run_id = ?
  `).get(runId);
  const maxDate = row?.max_date;
  const today = getNycDateString(0);
  const minRequired = getNycDateString(DATE_FRESHNESS_MIN_DAYS);
  if (!maxDate) {
    return { name: 'date_freshness', passed: true, value: null, threshold: null,
      message: 'no events from this run — freshness check skipped' };
  }
  const passed = maxDate >= minRequired;
  return {
    name: 'date_freshness',
    passed,
    value: null,
    threshold: null,
    message: passed
      ? `max event date ${maxDate} >= required ${minRequired}`
      : `max event date ${maxDate} is older than required ${minRequired} (today is ${today})`,
  };
}

function checkCompleteness(db, runId, source) {
  // Median completeness across events from this run should be at least 0.5.
  // Pull all completeness values, sort, take median. better-sqlite3 has no
  // built-in median.
  const rows = db.prepare(`
    SELECT completeness FROM scraped_events
    WHERE scrape_run_id = ? AND completeness IS NOT NULL
    ORDER BY completeness
  `).all(runId);
  if (rows.length === 0) {
    return { name: 'completeness', passed: true, value: null, threshold: COMPLETENESS_FLOOR,
      message: 'no completeness values — check skipped' };
  }
  const mid = Math.floor(rows.length / 2);
  const median = rows.length % 2 === 0
    ? (rows[mid - 1].completeness + rows[mid].completeness) / 2
    : rows[mid].completeness;
  const passed = median >= COMPLETENESS_FLOOR;
  return {
    name: 'completeness',
    passed,
    value: median,
    threshold: COMPLETENESS_FLOOR,
    message: `median completeness ${median.toFixed(2)} ${passed ? '>=' : '<'} ${COMPLETENESS_FLOOR}`,
  };
}

function checkEditorialShare(db, runId, source) {
  // Source contributed at least N events to the serving cache. Catches the
  // "scrape technically ran but nothing made it through the gauntlet" mode.
  const metrics = readStageMetrics(db, runId, 'cache');
  if (!metrics) {
    return { name: 'editorial_share', passed: true, value: null, threshold: EDITORIAL_SHARE_FLOOR,
      message: 'no cache stage recorded — check skipped' };
  }
  const inCache = metrics.source_events_in_cache ?? 0;
  const passed = inCache >= EDITORIAL_SHARE_FLOOR;
  return {
    name: 'editorial_share',
    passed,
    value: inCache,
    threshold: EDITORIAL_SHARE_FLOOR,
    message: `${inCache} ${source} events in serving cache (floor ${EDITORIAL_SHARE_FLOOR})`,
  };
}

function checkSurvivalRate(db, runId, source) {
  // Of the events the source extracted, what fraction made it to the cache?
  // Low survival = merge gates (date filter, geocode, NYC bounds) eating most
  // of the output. Different failure than "we didn't extract anything."
  const llm = readStageMetrics(db, runId, 'llm_extract');
  const cache = readStageMetrics(db, runId, 'cache');
  const extracted = llm?.events_post_filter ?? 0;
  const inCache = cache?.source_events_in_cache ?? 0;
  if (extracted === 0) {
    return { name: 'survival_rate', passed: true, value: null, threshold: SURVIVAL_RATE_FLOOR,
      message: 'no events extracted — survival check skipped' };
  }
  const rate = inCache / extracted;
  const passed = rate >= SURVIVAL_RATE_FLOOR;
  return {
    name: 'survival_rate',
    passed,
    value: rate,
    threshold: SURVIVAL_RATE_FLOOR,
    message: `${inCache}/${extracted} survived (${(rate * 100).toFixed(0)}%) ${passed ? '>=' : '<'} ${SURVIVAL_RATE_FLOOR * 100}%`,
  };
}

const CHECKS = [
  checkOutputVariance,
  checkDateFreshness,
  checkCompleteness,
  checkEditorialShare,
  checkSurvivalRate,
];

/**
 * Run all invariants for a scrape run. Writes one row per check to
 * scrape_invariants. If any check fails, sends a single runtime alert
 * naming the failures. Returns the array of result objects.
 */
async function checkInvariants(runId, source) {
  const db = getDb();
  const checkedAt = new Date().toISOString();
  const results = [];

  for (const check of CHECKS) {
    let r;
    try {
      r = check(db, runId, source);
    } catch (err) {
      r = { name: check.name, passed: false, value: null, threshold: null, message: `check threw: ${err.message}` };
    }
    results.push(r);
    try {
      db.prepare(`
        INSERT INTO scrape_invariants (run_id, source, name, passed, value, threshold, message, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, source, r.name, r.passed ? 1 : 0, r.value, r.threshold, r.message, checkedAt);
    } catch (err) {
      console.warn(`[invariants] write failed for ${r.name}:`, err.message);
    }
  }

  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    try {
      const { sendRuntimeAlert } = require('./alerts');
      const lines = failures.map(f => `  - ${f.name}: ${f.message}`).join('\n');
      await sendRuntimeAlert('scrape-invariant-failure', {
        source,
        run_id: runId,
        failed_count: failures.length,
        failures: failures.map(f => f.name),
        impact: `${failures.length} invariant(s) failed for ${source} scrape:\n${lines}`,
      }).catch(() => {});
    } catch { /* alerts module unavailable in some test envs */ }
  }

  return results;
}

module.exports = { checkInvariants };
