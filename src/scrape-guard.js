const { sourceHealth } = require('./source-health');
const { getNycDateString } = require('./geo');
const { checkSourceCompleteness } = require('./evals/source-completeness');
const { runExtractionAudit } = require('./evals/extraction-audit');
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

  const counts = okEntries.map(h => h.count).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  const medianCount = counts.length % 2 === 1 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;

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

  return { avgCount, medianCount, avgCoverage, entries: okEntries.length };
}

function checkBaseline(label, events) {
  const baseline = getBaselineStats(label);
  if (!baseline) return { quarantined: false, reason: null };

  // 1. Count drift
  const isVolatile = !!sourceHealth[label]?.volatile;
  const baselineCount = isVolatile ? baseline.medianCount : baseline.avgCount;
  const baselineLabel = isVolatile ? 'median' : 'avg';
  if (events.length < baselineCount * COUNT_DRIFT_THRESHOLD &&
      baselineCount >= 10) {
    return {
      quarantined: true,
      reason: `count drift: ${events.length} events vs ${Math.round(baselineCount)} ${baselineLabel}`,
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

const COMPLETENESS_ALERT_THRESHOLD = 0.8;
const EXTRACTION_ALERT_THRESHOLD = 0.7;

function postScrapeAudit(fetchMap, events, extractionInputs) {
  const alerts = [];

  // 1. Source field-completeness check
  let completeness = {};
  try {
    completeness = checkSourceCompleteness(fetchMap);
    for (const [label, result] of Object.entries(completeness)) {
      if (result.total === 0) continue;
      const passRate = result.passed / result.total;
      if (passRate < COMPLETENESS_ALERT_THRESHOLD) {
        const msg = `${label}: ${(passRate * 100).toFixed(0)}% completeness (${result.failed}/${result.total} failed)`;
        alerts.push({ type: 'completeness', label, passRate, message: msg });
      }
    }
  } catch (err) {
    console.error('[SCRAPE-GUARD] Source completeness check failed:', err.message);
  }

  // 2. Extraction audit (Claude-extracted sources only)
  let extraction = {};
  try {
    const report = runExtractionAudit(events, extractionInputs);
    extraction = report;
    if (report.sourceStats) {
      for (const [label, stats] of Object.entries(report.sourceStats)) {
        if (stats.total === 0) continue;
        const passRate = stats.passed / stats.total;
        if (passRate < EXTRACTION_ALERT_THRESHOLD) {
          const msg = `${label}: ${(passRate * 100).toFixed(0)}% extraction audit pass rate (${stats.total - stats.passed}/${stats.total} issues)`;
          alerts.push({ type: 'extraction', label, passRate, message: msg });
        }
      }
    }
  } catch (err) {
    console.error('[SCRAPE-GUARD] Extraction audit failed:', err.message);
  }

  // Send alerts
  if (alerts.length > 0) {
    const summary = alerts.map(a => a.message).join('\n');
    console.warn(`[SCRAPE-GUARD] Post-scrape audit found ${alerts.length} issue(s):\n${summary}`);
  }

  return { alerts, completeness, extraction };
}

module.exports = { checkBaseline, getBaselineStats, postScrapeAudit, MIN_HISTORY };
