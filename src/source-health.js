/**
 * source-health.js — Per-source scrape health tracking.
 * Tracks status, event counts, timing, errors, and history for each source.
 * Persists to data/source-health.json so state survives restarts.
 */

const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, '../data/source-health.json');
const MAX_HISTORY = 14; // ~2 weeks of daily scrapes

// Per-source health state: { [label]: { status, last_count, duration_ms, ... } }
const sourceHealth = new Proxy({}, {
  get(target, prop) {
    if (typeof prop !== 'string') return target[prop];
    if (!(prop in target)) {
      target[prop] = {
        status: null,
        last_count: null,
        duration_ms: null,
        last_scrape: null,
        last_error: null,
        quarantine_reason: null,
        consecutive_zeros: 0,
        history: [],
      };
    }
    return target[prop];
  }
});

// Aggregate scrape stats from most recent run
let scrapeStats = {};

// Load persisted state on startup
try {
  const saved = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  if (saved.sources) {
    for (const [label, data] of Object.entries(saved.sources)) {
      Object.assign(sourceHealth[label], data);
    }
  }
  if (saved.scrapeStats) {
    scrapeStats = saved.scrapeStats;
  }
  console.log(`Loaded source health for ${Object.keys(saved.sources || {}).length} sources`);
} catch {
  // No saved data yet — starts fresh
}

function updateSourceHealth(label, result) {
  const h = sourceHealth[label];
  h.status = result.status || 'ok';
  h.last_count = result.events ? result.events.length : 0;
  h.duration_ms = result.durationMs ?? null;
  h.last_scrape = new Date().toISOString();

  if (result.status === 'error' || result.status === 'timeout') {
    h.last_error = result.error || 'unknown error';
    h.consecutive_zeros++;
  } else if (h.last_count === 0) {
    h.status = 'empty';
    h.last_error = null;
    h.consecutive_zeros++;
  } else {
    h.last_error = null;
    h.consecutive_zeros = 0;
  }

  // Append to history (capped)
  h.history.push({
    count: h.last_count,
    status: h.status,
    durationMs: h.duration_ms,
    timestamp: h.last_scrape,
  });
  if (h.history.length > MAX_HISTORY) {
    h.history = h.history.slice(-MAX_HISTORY);
  }

  // Compute success rate from history
  const total = h.history.length;
  const successes = h.history.filter(entry => entry.status === 'ok').length;
  h.success_rate = total > 0 ? Math.round((successes / total) * 100) + '%' : '--';
}

function updateScrapeStats(stats) {
  scrapeStats = stats;
}

function saveHealthData() {
  const sources = {};
  for (const [label, h] of Object.entries(Object.assign({}, sourceHealth))) {
    sources[label] = { ...h };
  }
  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({ sources, scrapeStats }, null, 2));
  } catch (err) {
    console.warn('Failed to persist source health:', err.message);
  }
}

function computeEventMix(events) {
  const categoryDistribution = {};
  const neighborhoodDistribution = {};
  const dateDistribution = {};
  let free = 0, paid = 0;

  // Build 7-day date range starting today
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dateDistribution[d.toISOString().slice(0, 10)] = 0;
  }

  for (const e of events) {
    const cat = e.category || 'other';
    categoryDistribution[cat] = (categoryDistribution[cat] || 0) + 1;
    if (e.neighborhood) {
      neighborhoodDistribution[e.neighborhood] = (neighborhoodDistribution[e.neighborhood] || 0) + 1;
    }
    if (e.date_local && dateDistribution[e.date_local] !== undefined) {
      dateDistribution[e.date_local]++;
    }
    if (e.is_free) free++; else paid++;
  }

  // Event composition
  const recurring = events.filter(e => e.is_recurring).length;
  const triviaRe = /trivia/i;
  const trivia = events.filter(e => triviaRe.test(e.category || '') || triviaRe.test(e.name || '') || triviaRe.test(e.subcategory || '')).length;
  const recurringOrTrivia = events.filter(e => e.is_recurring || triviaRe.test(e.category || '') || triviaRe.test(e.name || '') || triviaRe.test(e.subcategory || '')).length;
  const unique = events.length - recurringOrTrivia;

  // Data gaps by source — seed with all registered sources so they always appear
  const gapTypes = [
    { key: 'tbaVenue', test: e => e.venue_name === 'TBA' || e.venue_name === 'tba' },
    { key: 'noVenue', test: e => !e.venue_name },
    { key: 'noNeighborhood', test: e => !e.neighborhood },
    { key: 'noDescription', test: e => !e.description_short && !e.description },
    { key: 'noTime', test: e => !e.start_time_local },
    { key: 'noUrl', test: e => !e.ticket_url && !e.source_url },
  ];
  const dataGaps = {};
  try {
    const { SOURCES } = require('./source-registry');
    for (const s of SOURCES) {
      dataGaps[s.label] = { count: 0, gaps: {} };
    }
  } catch {}
  for (const e of events) {
    const src = e.source_name || 'unknown';
    if (!dataGaps[src]) dataGaps[src] = { count: 0, gaps: {} };
    dataGaps[src].count++;
    for (const g of gapTypes) {
      if (!dataGaps[src].gaps[g.key]) dataGaps[src].gaps[g.key] = 0;
      if (g.test(e)) dataGaps[src].gaps[g.key]++;
    }
  }

  return {
    total: events.length,
    categoryDistribution,
    neighborhoodDistribution,
    dateDistribution,
    freePaid: { free, paid },
    composition: { recurring, trivia, unique, recurringOrTrivia },
    dataGaps,
  };
}

function getHealthStatus({ size, timestamp } = {}) {
  const ageMins = timestamp ? Math.round((Date.now() - timestamp) / 60000) : null;
  const fresh = size > 0 && ageMins != null && ageMins < 20 * 60;

  // Build sources snapshot (plain objects, not Proxy)
  const sources = {};
  for (const [label, h] of Object.entries(Object.assign({}, sourceHealth))) {
    sources[label] = { ...h };
  }

  return {
    status: !fresh ? 'critical' : scrapeStats.sourcesFailed > 0 ? 'degraded' : 'ok',
    cache: {
      size: size || 0,
      fresh,
      age_minutes: ageMins,
    },
    scrape: {
      totalDurationMs: scrapeStats.totalDurationMs ?? null,
      completedAt: scrapeStats.completedAt ?? null,
      sourcesOk: scrapeStats.sourcesOk ?? 0,
      sourcesFailed: scrapeStats.sourcesFailed ?? 0,
      sourcesEmpty: scrapeStats.sourcesEmpty ?? 0,
      sourcesQuarantined: scrapeStats.sourcesQuarantined ?? 0,
      totalEvents: scrapeStats.totalEvents ?? 0,
      dedupedEvents: scrapeStats.dedupedEvents ?? 0,
    },
    sources,
  };
}

/**
 * Compute a coverage matrix: neighborhood x category with completeness stats.
 * An event is "complete" if it has time + neighborhood + (URL or description).
 */
function computeCoverageMatrix(events) {
  const isComplete = e => !!e.start_time_local && !!e.neighborhood && (!!e.source_url || !!e.ticket_url || !!e.description_short);

  const byNeighborhood = {};
  const byCategory = {};
  const byDate = {};
  let totalComplete = 0;

  for (const e of events) {
    const hood = e.neighborhood || 'Unknown';
    const cat = e.category || 'other';
    const date = e.date_local || 'undated';
    const complete = isComplete(e);
    if (complete) totalComplete++;

    if (!byNeighborhood[hood]) byNeighborhood[hood] = { total: 0, complete: 0, categories: {} };
    byNeighborhood[hood].total++;
    if (complete) byNeighborhood[hood].complete++;
    byNeighborhood[hood].categories[cat] = (byNeighborhood[hood].categories[cat] || 0) + 1;

    if (!byCategory[cat]) byCategory[cat] = { total: 0, complete: 0 };
    byCategory[cat].total++;
    if (complete) byCategory[cat].complete++;

    if (!byDate[date]) byDate[date] = { total: 0, complete: 0 };
    byDate[date].total++;
    if (complete) byDate[date].complete++;
  }

  return {
    byNeighborhood,
    byCategory,
    byDate,
    summary: {
      total: events.length,
      complete: totalComplete,
      completeRate: events.length > 0 ? Math.round(totalComplete / events.length * 100) : 0,
      neighborhoods: Object.keys(byNeighborhood).length,
      categories: Object.keys(byCategory).length,
    },
  };
}

// Auto-quarantine disabled — all sources enabled
function isSourceDisabled() { return false; }
function shouldProbeDisabled() { return false; }

module.exports = {
  sourceHealth,
  saveHealthData,
  updateSourceHealth,
  updateScrapeStats,
  computeEventMix,
  computeCoverageMatrix,
  getHealthStatus,
  isSourceDisabled,
  shouldProbeDisabled,
};
