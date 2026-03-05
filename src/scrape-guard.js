const { sourceHealth } = require('./source-health');
const { getNycDateString } = require('./geo');

const MIN_HISTORY = 3;
const COUNT_DRIFT_THRESHOLD = 0.4;
const FIELD_DRIFT_THRESHOLD = 0.25;
const DATE_SANITY_THRESHOLD = 0.2;
const DATE_SANITY_BASELINE_MIN = 0.6;
const DUPLICATE_THRESHOLD = 0.5;

function getBaselineStats(label) {
  const health = sourceHealth[label];
  if (!health || health.history.length < MIN_HISTORY) return null;

  const okEntries = health.history.filter(h => h.status === 'ok' && h.count > 0);
  if (okEntries.length < MIN_HISTORY) return null;

  const avgCount = okEntries.reduce((sum, h) => sum + h.count, 0) / okEntries.length;

  const avgCoverage = { name: 0, venue_name: 0, date_local: 0 };
  let coverageEntries = 0;
  for (const h of okEntries) {
    if (h.fieldCoverage) {
      avgCoverage.name += h.fieldCoverage.name;
      avgCoverage.venue_name += h.fieldCoverage.venue_name;
      avgCoverage.date_local += h.fieldCoverage.date_local;
      coverageEntries++;
    }
  }
  if (coverageEntries > 0) {
    avgCoverage.name /= coverageEntries;
    avgCoverage.venue_name /= coverageEntries;
    avgCoverage.date_local /= coverageEntries;
  }

  return { avgCount, avgCoverage, entries: okEntries.length };
}

function checkBaseline(label, events) {
  const baseline = getBaselineStats(label);
  if (!baseline) return { quarantined: false, reason: null };

  // 1. Count drift
  if (events.length < baseline.avgCount * COUNT_DRIFT_THRESHOLD &&
      baseline.avgCount >= 10) {
    return {
      quarantined: true,
      reason: `count drift: ${events.length} events vs ${Math.round(baseline.avgCount)} avg`,
    };
  }

  if (events.length === 0) return { quarantined: false, reason: null };

  // 2. Field coverage drift
  const n = events.length;
  const fields = ['name', 'venue_name', 'date_local'];
  for (const field of fields) {
    const coverage = events.filter(e => !!e[field]).length / n;
    const avgCoverage = baseline.avgCoverage[field];
    if (avgCoverage - coverage > FIELD_DRIFT_THRESHOLD) {
      return {
        quarantined: true,
        reason: `${field} coverage drift: ${(coverage * 100).toFixed(0)}% vs ${(avgCoverage * 100).toFixed(0)}% avg`,
      };
    }
  }

  // 3. Date sanity
  const today = getNycDateString(0);
  const weekOut = getNycDateString(7);
  const datedEvents = events.filter(e => !!e.date_local);
  if (datedEvents.length > 0) {
    const nearbyPct = datedEvents.filter(e => e.date_local >= today && e.date_local <= weekOut).length / datedEvents.length;
    const avgDateCoverage = baseline.avgCoverage.date_local;
    if (nearbyPct < DATE_SANITY_THRESHOLD && avgDateCoverage >= DATE_SANITY_BASELINE_MIN) {
      return {
        quarantined: true,
        reason: `date sanity: ${(nearbyPct * 100).toFixed(0)}% events within 7 days (expected >${(DATE_SANITY_THRESHOLD * 100)}%)`,
      };
    }
  }

  // 4. Duplicate spike
  const nameCounts = {};
  for (const e of events) {
    const name = (e.name || '').toLowerCase().trim();
    if (name) nameCounts[name] = (nameCounts[name] || 0) + 1;
  }
  const maxDupes = Math.max(0, ...Object.values(nameCounts));
  if (events.length > 5 && maxDupes / events.length > DUPLICATE_THRESHOLD) {
    return {
      quarantined: true,
      reason: `duplicate spike: "${Object.entries(nameCounts).find(([_, c]) => c === maxDupes)?.[0]}" appears ${maxDupes}/${events.length} times`,
    };
  }

  return { quarantined: false, reason: null };
}

module.exports = { checkBaseline, getBaselineStats, MIN_HISTORY };
