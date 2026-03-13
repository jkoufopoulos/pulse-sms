const fs = require('fs');
const path = require('path');
const { SOURCE_LABELS } = require('./source-registry');
const { getNycDateString } = require('./geo');

const HEALTH_WARN_THRESHOLD = 3;
const HISTORY_MAX = 7;
const AUTO_DISABLE_THRESHOLD = 7;
const PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Source health tracking (expanded) ---
function makeHealthEntry() {
  return {
    consecutiveZeros: 0,
    lastCount: 0,
    lastStatus: null,       // 'ok' | 'error' | 'timeout' | 'empty'
    lastError: null,        // error message string (null on success)
    lastDurationMs: null,   // how long this source took to scrape
    lastScrapeAt: null,     // ISO timestamp of last scrape attempt
    totalScrapes: 0,        // lifetime scrape count
    totalSuccesses: 0,      // lifetime success count (events > 0)
    history: [],            // last 7 entries: { timestamp, count, durationMs, status }
    lastQuarantineReason: null,
    disabled: false,        // auto-disabled after AUTO_DISABLE_THRESHOLD consecutive zeros
    disabledAt: null,       // ISO timestamp when disabled
    lastProbeAt: null,      // ISO timestamp of last probe attempt while disabled
  };
}

const sourceHealth = {};
for (const label of SOURCE_LABELS) {
  sourceHealth[label] = makeHealthEntry();
}

// --- Scrape-level metrics ---
let lastScrapeStats = {
  startedAt: null,
  completedAt: null,
  totalDurationMs: null,
  totalEvents: 0,
  dedupedEvents: 0,
  sourcesOk: 0,
  sourcesFailed: 0,
  sourcesEmpty: 0,
};

// --- Persist health data across deploys ---
const HEALTH_FILE = path.join(__dirname, '../data/health-cache.json');

function saveHealthData() {
  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({ sourceHealth, lastScrapeStats }));
  } catch (err) { console.error('Failed to persist health data:', err.message); }
}

// Load persisted health data on boot
try {
  const cached = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  if (cached.sourceHealth) {
    for (const [label, data] of Object.entries(cached.sourceHealth)) {
      if (sourceHealth[label]) Object.assign(sourceHealth[label], data);
    }
  }
  if (cached.lastScrapeStats) Object.assign(lastScrapeStats, cached.lastScrapeStats);
  console.log(`Loaded persisted health data (last scrape: ${lastScrapeStats.completedAt || 'none'})`);
} catch { /* file doesn't exist yet */ }

// ============================================================
// Health update helpers — called by events.js during refresh
// ============================================================

function computeFieldCoverage(events) {
  if (!events.length) return { name: 0, venue_name: 0, date_local: 0, start_time_local: 0, neighborhood: 0 };
  const fields = ['name', 'venue_name', 'date_local', 'start_time_local', 'neighborhood'];
  const coverage = {};
  for (const field of fields) {
    const filled = events.filter(e => e[field] != null).length;
    coverage[field] = filled / events.length;
  }
  return coverage;
}

function updateSourceHealth(label, { events, durationMs, status, error }) {
  const health = sourceHealth[label];
  if (!health) return;

  const now = new Date().toISOString();
  health.lastCount = events.length;
  health.lastStatus = status;
  health.lastError = error;
  health.lastDurationMs = durationMs;
  health.lastScrapeAt = now;
  health.totalScrapes++;
  if (events.length > 0) {
    health.totalSuccesses++;
    health.consecutiveZeros = 0;
    if (health.disabled) {
      console.log(`[HEALTH] ${label} auto-recovered — ${events.length} events returned`);
      health.disabled = false;
      health.disabledAt = null;
    }
  } else {
    health.consecutiveZeros++;
    if (health.consecutiveZeros >= HEALTH_WARN_THRESHOLD) {
      console.warn(`[HEALTH] ${label} has returned 0 events for ${health.consecutiveZeros} consecutive refreshes`);
    }
    if (health.consecutiveZeros >= AUTO_DISABLE_THRESHOLD && !health.disabled) {
      health.disabled = true;
      health.disabledAt = new Date().toISOString();
      console.warn(`[HEALTH] ${label} auto-disabled after ${health.consecutiveZeros} consecutive failures`);
    }
  }

  // Push to history (capped at HISTORY_MAX)
  const fieldCoverage = computeFieldCoverage(events);
  health.history.push({ timestamp: now, count: events.length, durationMs, status, fieldCoverage });
  if (health.history.length > HISTORY_MAX) {
    health.history.shift();
  }
}

function updateScrapeStats(stats) {
  lastScrapeStats = stats;
}

// ============================================================
// Disable / probe helpers
// ============================================================

function isSourceDisabled(label) {
  return sourceHealth[label]?.disabled === true;
}

function shouldProbeDisabled(label) {
  const health = sourceHealth[label];
  if (!health || !health.disabled) return false;
  if (!health.lastProbeAt) return true;
  return Date.now() - new Date(health.lastProbeAt).getTime() > PROBE_INTERVAL_MS;
}

// ============================================================
// Event mix computation — takes cache as parameter
// ============================================================

function computeEventMix(eventCache) {
  if (!eventCache.length) return null;

  const dateCounts = {};
  for (let i = 0; i < 7; i++) {
    dateCounts[getNycDateString(i)] = 0;
  }
  const categoryCounts = {};
  const hoodCounts = {};
  let freeCount = 0;
  const sourceCounts = {};

  for (const e of eventCache) {
    if (e.date_local && dateCounts.hasOwnProperty(e.date_local)) dateCounts[e.date_local]++;
    const cat = e.category || 'other';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    if (e.neighborhood) hoodCounts[e.neighborhood] = (hoodCounts[e.neighborhood] || 0) + 1;
    if (e.is_free) freeCount++;
    if (e.source_name) sourceCounts[e.source_name] = (sourceCounts[e.source_name] || 0) + 1;
  }

  return {
    total: eventCache.length,
    dateDistribution: dateCounts,
    categoryDistribution: categoryCounts,
    neighborhoodDistribution: hoodCounts,
    freePaid: { free: freeCount, paid: eventCache.length - freeCount },
    sourceDistribution: sourceCounts,
  };
}

// ============================================================
// Health status — takes cache info as parameter
// ============================================================

function getHealthStatus(cacheInfo) {
  const { size, timestamp } = cacheInfo;
  const sources = {};
  for (const [label, h] of Object.entries(sourceHealth)) {
    sources[label] = {
      status: h.lastStatus,
      last_count: h.lastCount,
      consecutive_zeros: h.consecutiveZeros,
      duration_ms: h.lastDurationMs,
      last_error: h.lastError,
      last_scrape: h.lastScrapeAt,
      quarantine_reason: h.lastQuarantineReason,
      disabled: h.disabled || false,
      disabled_at: h.disabledAt || null,
      last_probe: h.lastProbeAt || null,
      success_rate: h.totalScrapes > 0
        ? Math.round((h.totalSuccesses / h.totalScrapes) * 100) + '%'
        : null,
      history: h.history,
    };
  }

  const anyFailed = Object.values(sourceHealth).some(h => h.lastStatus === 'error' || h.lastStatus === 'timeout' || h.lastStatus === 'quarantined');
  const allFailed = Object.values(sourceHealth).every(h => h.lastStatus === 'error' || h.lastStatus === 'timeout' || h.lastStatus === 'quarantined');

  return {
    status: allFailed && lastScrapeStats.startedAt ? 'critical' : anyFailed ? 'degraded' : 'ok',
    cache: {
      size,
      age_minutes: timestamp ? Math.round((Date.now() - timestamp) / 60000) : null,
      fresh: size > 0,
      last_refresh: timestamp ? new Date(timestamp).toISOString() : null,
    },
    scrape: { ...lastScrapeStats },
    sources,
    eventMix: computeEventMix._eventCache || null, // set by wrapper in events.js
  };
}

module.exports = {
  sourceHealth,
  makeHealthEntry,
  saveHealthData,
  updateSourceHealth,
  updateScrapeStats,
  computeEventMix,
  getHealthStatus,
  computeFieldCoverage,
  isSourceDisabled,
  shouldProbeDisabled,
  HEALTH_WARN_THRESHOLD,
  AUTO_DISABLE_THRESHOLD,
};
