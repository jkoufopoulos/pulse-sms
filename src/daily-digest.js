const { SOURCE_LABELS, SOURCE_EXPECTATIONS, SOURCE_CACHE_NAMES } = require('./source-registry');
const { sourceHealth, isSourceDisabled } = require('./source-health');
const { getNycDateString } = require('./geo');
const { getRecentAlerts } = require('./alerts');

/**
 * Determine digest status from metrics.
 * Green: all ok. Yellow: 1-2 issues. Red: >5 issues or user-facing errors.
 * With 22 sources, 1-2 having a rough day is normal variation.
 */
function computeDigestStatus({ sourcesBelow, cacheDrop, userFacingErrors, latencyP95 }) {
  if (userFacingErrors > 0) return 'red';
  if (cacheDrop > 40) return 'red';
  if (sourcesBelow.length > 5) return 'red';
  if (sourcesBelow.length > 0) return 'yellow';
  if (cacheDrop > 20) return 'yellow';
  if (latencyP95 > 5000) return 'yellow';
  return 'green';
}

/**
 * Build needs-attention list from source data.
 * Distinguishes expected zeros (off-schedule) from unexpected drops.
 */
function buildNeedsAttention(sourceData, dayName) {
  const items = [];
  const day = dayName.toLowerCase();

  for (const s of sourceData) {
    const isOnSchedule = !s.schedule || s.schedule.days.some(d => day.startsWith(d.toLowerCase()) || d.toLowerCase().startsWith(day));
    const belowThreshold = s.count < s.minExpected * 0.4;
    const belowAvg = s.avg7d > 5 && s.count < s.avg7d * 0.4;

    if (s.isDisabled) {
      items.push({
        source: s.name,
        issue: `auto-disabled (${s.consecutiveZeros} consecutive failures)`,
        severity: 'warn',
      });
      continue;
    }

    if (belowThreshold || belowAvg) {
      if (s.isQuarantined) {
        // Quarantine is the safety mechanism working — informational, not a warn
        items.push({
          source: s.name,
          issue: `quarantined: ${s.quarantineReason || 'unknown'}`,
          severity: 'info',
        });
      } else if (!isOnSchedule) {
        items.push({
          source: s.name,
          issue: `0 events (off-schedule, expected ${s.schedule.days.join('/')})`,
          severity: 'info',
        });
      } else {
        const ref = s.avg7d > 5 ? `avg ${Math.round(s.avg7d)}` : `min ${s.minExpected}`;
        items.push({
          source: s.name,
          issue: `${s.count} events (${ref})`,
          severity: 'warn',
        });
      }
    }
  }

  return items;
}

/**
 * Generate a daily digest report from current state.
 * Called after each scrape completes.
 */
function generateDigest(eventCache, scrapeStats) {
  const today = getNycDateString(0);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[new Date().getDay()];

  // Source counts from cache (lowercase keys for case-insensitive match with SOURCE_LABELS)
  const sourceCounts = {};
  const categoryCounts = {};
  let freeCount = 0;
  for (const e of eventCache) {
    if (e.source_name) {
      const key = e.source_name.toLowerCase();
      sourceCounts[key] = (sourceCounts[key] || 0) + 1;
    }
    const cat = e.category || 'other';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    if (e.is_free) freeCount++;
  }

  // Build source data with 7-day averages from health history
  const sourceData = SOURCE_LABELS.map(label => {
    const health = sourceHealth[label];
    const okHistory = (health?.history || []).filter(h => h.status === 'ok' && h.count > 0);
    const avg7d = okHistory.length > 0
      ? okHistory.reduce((sum, h) => sum + h.count, 0) / okHistory.length
      : 0;
    const expectations = SOURCE_EXPECTATIONS[label] || { minExpected: 0, schedule: null };
    const isQuarantined = health?.lastStatus === 'quarantined';
    // Use scrape count from health data (accurate per-source), fall back to cache count
    const cacheName = SOURCE_CACHE_NAMES[label] || label.toLowerCase();
    const count = health?.lastStatus === 'ok' ? (health.lastCount || 0) : (sourceCounts[cacheName] || 0);
    return {
      name: label,
      count,
      avg7d,
      status: count >= expectations.minExpected * 0.4 ? 'ok' : 'warn',
      isQuarantined,
      quarantineReason: isQuarantined ? health?.lastQuarantineReason : null,
      isDisabled: isSourceDisabled(label),
      consecutiveZeros: health?.consecutiveZeros || 0,
      ...expectations,
    };
  });

  const needsAttention = buildNeedsAttention(sourceData, dayName);
  const sourcesBelow = needsAttention.filter(i => i.severity === 'warn').map(i => i.source);

  // Yesterday's cache total (from digest if available, else estimate)
  let yesterdayTotal = eventCache.length; // fallback: no change
  try {
    const { getYesterdayDigest } = require('./db');
    const yesterday = getYesterdayDigest();
    if (yesterday?.report?.cache?.total) {
      yesterdayTotal = yesterday.report.cache.total;
    }
  } catch {}

  const cacheDrop = yesterdayTotal > 0
    ? Math.max(0, ((yesterdayTotal - eventCache.length) / yesterdayTotal) * 100)
    : 0;

  // Count user-facing errors from alerts in last 24h
  const recentAlerts = getRecentAlerts(50);
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const userFacingErrors = recentAlerts.filter(a =>
    (a.alertType === 'agent_brain_error' || a.alertType === 'double_failure') &&
    new Date(a.timestamp).getTime() > oneDayAgo
  ).length;

  const { computeLatencyStats, getRecentTraces } = require('./traces');
  const latencyStats = computeLatencyStats(getRecentTraces(500));
  const latencyP95 = latencyStats.p95;

  const status = computeDigestStatus({ sourcesBelow, cacheDrop, userFacingErrors, latencyP95 });
  const activeSourceCount = sourceData.filter(s => s.count > 0).length;

  const report = {
    id: today,
    generated_at: new Date().toISOString(),
    status,
    summary: `${eventCache.length.toLocaleString()} events from ${activeSourceCount} sources. ${freeCount} free. ${needsAttention.length > 0 ? `${needsAttention.length} need attention.` : 'All sources healthy.'}`,
    cache: {
      total: eventCache.length,
      yesterday: yesterdayTotal,
      change_pct: yesterdayTotal > 0 ? Math.round(((eventCache.length - yesterdayTotal) / yesterdayTotal) * 100 * 10) / 10 : 0,
      free: freeCount,
      paid: eventCache.length - freeCount,
    },
    needs_attention: needsAttention,
    sources: sourceData.map(s => ({ name: s.name, count: s.count, avg_7d: Math.round(s.avg7d), status: s.status })),
    categories: categoryCounts,
    user_facing_errors: userFacingErrors,
    scrape: {
      duration_ms: scrapeStats?.totalDurationMs || null,
      sources_ok: scrapeStats?.sourcesOk || 0,
      sources_failed: scrapeStats?.sourcesFailed || 0,
    },
    latency: {
      p50: latencyStats.p50,
      p95: latencyStats.p95,
      max: latencyStats.max,
      outlier_count: latencyStats.outliers.length,
    },
  };

  return report;
}

/**
 * Format a digest report as plain-text email body.
 */
function formatDigestEmail(report) {
  const lines = [];
  lines.push(`Pulse Daily Digest: ${report.status.toUpperCase()}`);
  lines.push(`Date: ${report.id}`);
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  if (report.needs_attention.length > 0) {
    lines.push('NEEDS ATTENTION:');
    for (const item of report.needs_attention) {
      const marker = item.severity === 'warn' ? '!' : 'i';
      lines.push(`  [${marker}] ${item.source}: ${item.issue}`);
    }
    lines.push('');
  }

  lines.push(`Cache: ${report.cache.total} events (${report.cache.change_pct > 0 ? '+' : ''}${report.cache.change_pct}% vs yesterday)`);
  lines.push(`Free: ${report.cache.free} | Paid: ${report.cache.paid}`);
  lines.push('');

  if (report.scrape.duration_ms) {
    lines.push(`Scrape: ${(report.scrape.duration_ms / 1000).toFixed(1)}s | ${report.scrape.sources_ok} ok, ${report.scrape.sources_failed} failed`);
    lines.push('');
  }

  if (report.latency) {
    lines.push(`Latency: p50 ${(report.latency.p50 / 1000).toFixed(1)}s | p95 ${(report.latency.p95 / 1000).toFixed(1)}s | max ${(report.latency.max / 1000).toFixed(1)}s${report.latency.outlier_count > 0 ? ` | ${report.latency.outlier_count} outliers` : ''}`);
    lines.push('');
  }

  lines.push('SOURCES:');
  const sorted = [...report.sources].sort((a, b) => b.count - a.count);
  for (const s of sorted) {
    const flag = s.status === 'warn' ? ' !' : '';
    lines.push(`  ${s.name}: ${s.count} (avg ${s.avg_7d})${flag}`);
  }

  return lines.join('\n');
}

module.exports = { computeDigestStatus, buildNeedsAttention, generateDigest, formatDigestEmail };
