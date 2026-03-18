const { sourceHealth } = require('./source-health');
const { getNycDateString } = require('./geo');
const MIN_HISTORY = 3;
const FIELD_DRIFT_THRESHOLD = 0.60;
const DATE_SANITY_THRESHOLD = 0.2;
const DATE_SANITY_BASELINE_MIN = 0.6;
const DUPLICATE_THRESHOLD = 0.5;

function getBaselineStats(label) {
  const health = sourceHealth[label];
  if (!health || health.history.length < MIN_HISTORY) return null;

  const okEntries = health.history.filter(h => h.status === 'ok' && h.count > 0);
  if (okEntries.length < MIN_HISTORY) return null;

  const avgCount = okEntries.reduce((sum, h) => sum + h.count, 0) / okEntries.length;

  const counts = okEntries.map(h => h.count).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  const medianCount = counts.length % 2 === 1 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;

  const avgCoverage = { name: 0, venue_name: 0, date_local: 0, start_time_local: 0, neighborhood: 0 };
  let coverageEntries = 0;
  for (const h of okEntries) {
    if (h.fieldCoverage) {
      for (const field of Object.keys(avgCoverage)) {
        avgCoverage[field] += h.fieldCoverage[field] || 0;
      }
      coverageEntries++;
    }
  }
  if (coverageEntries > 0) {
    for (const field of Object.keys(avgCoverage)) {
      avgCoverage[field] /= coverageEntries;
    }
  }

  return { avgCount, medianCount, avgCoverage, entries: okEntries.length };
}

function checkBaseline(label, events) {
  const baseline = getBaselineStats(label);
  if (!baseline) return { quarantined: false, reason: null };

  // 1. Count drift — warn only, don't quarantine
  // Post-scrape LLM enrichment handles quality gaps; count alone is not a quality signal.
  const isVolatile = !!sourceHealth[label]?.volatile;
  const baselineCount = isVolatile ? baseline.medianCount : baseline.avgCount;
  const baselineLabel = isVolatile ? 'median' : 'avg';
  if (baselineCount >= 10 && events.length < baselineCount * 0.4) {
    console.warn(`[SCRAPE-GUARD] ${label} count drift: ${events.length} events vs ${Math.round(baselineCount)} ${baselineLabel} (not quarantining)`);
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

  // 3. Date sanity — warn only, don't quarantine
  // Newsletter/film sources legitimately publish events weeks/months out
  const today = getNycDateString(0);
  const monthOut = getNycDateString(30);
  const datedEvents = events.filter(e => !!e.date_local);
  if (datedEvents.length > 0) {
    const nearbyPct = datedEvents.filter(e => e.date_local >= today && e.date_local <= monthOut).length / datedEvents.length;
    const avgDateCoverage = baseline.avgCoverage.date_local;
    if (nearbyPct < DATE_SANITY_THRESHOLD && avgDateCoverage >= DATE_SANITY_BASELINE_MIN) {
      console.warn(`[SCRAPE-GUARD] ${label} date sanity warning: ${(nearbyPct * 100).toFixed(0)}% events within 30 days`);
    }
  }

  // 4. Duplicate spike — but allow legitimate multi-show venues (same name, different times)
  const nameCounts = {};
  const nameTimeCounts = {};
  for (const e of events) {
    const name = (e.name || '').toLowerCase().trim();
    if (!name) continue;
    nameCounts[name] = (nameCounts[name] || 0) + 1;
    const timeKey = `${name}|${(e.start_time_local || '').slice(0, 16)}`;
    nameTimeCounts[timeKey] = (nameTimeCounts[timeKey] || 0) + 1;
  }
  const maxDupes = Math.max(0, ...Object.values(nameCounts));
  if (events.length > 5 && maxDupes / events.length > DUPLICATE_THRESHOLD) {
    const dupeName = Object.entries(nameCounts).find(([_, c]) => c === maxDupes)?.[0];
    // Count distinct date+time slots for the duplicated name
    const distinctSlots = Object.keys(nameTimeCounts).filter(k => k.startsWith(dupeName + '|')).length;
    // If 70%+ of occurrences have unique time slots, it's a multi-show venue
    if (distinctSlots < maxDupes * 0.7) {
      return {
        quarantined: true,
        reason: `duplicate spike: "${dupeName}" appears ${maxDupes}/${events.length} times`,
      };
    }
  }

  return { quarantined: false, reason: null };
}

module.exports = { checkBaseline, getBaselineStats, MIN_HISTORY };
