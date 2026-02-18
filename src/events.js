const fs = require('fs');
const path = require('path');
const { fetchSkintEvents, fetchEventbriteEvents, fetchSongkickEvents, fetchDiceEvents, fetchRAEvents, fetchTavilyFreeEvents, fetchNonsenseNYC, fetchOhMyRockness, fetchDoNYCEvents, fetchBAMEvents, fetchSmallsLiveEvents, fetchNYPLEvents, fetchEventbriteComedy, fetchEventbriteArts, fetchNYCParksEvents, fetchBrooklynVeganEvents } = require('./sources');
const { rankEventsByProximity, filterUpcomingEvents, getNycDateString, getEventDate } = require('./geo');
const { batchGeocodeEvents, exportLearnedVenues, importLearnedVenues } = require('./venues');
const { sendHealthAlert } = require('./alerts');

// Load persisted learned venues on boot
try {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/venues-learned.json'), 'utf8'));
  importLearnedVenues(data);
  console.log(`Loaded ${Object.keys(data).length} persisted venues`);
} catch { /* file doesn't exist yet */ }

// --- Daily event cache ---
let eventCache = [];
let cacheTimestamp = 0;
let refreshPromise = null; // mutex to prevent concurrent refreshes

// --- Source health tracking (expanded) ---
function makeHealthEntry() {
  return {
    consecutiveZeros: 0,
    lastCount: 0,
    lastStatus: null,       // 'ok' | 'error' | 'timeout' | 'empty'
    lastError: null,        // error message string (null on success)
    lastHttpStatus: null,   // HTTP status code from endpoint check
    lastDurationMs: null,   // how long this source took to scrape
    lastScrapeAt: null,     // ISO timestamp of last scrape attempt
    totalScrapes: 0,        // lifetime scrape count
    totalSuccesses: 0,      // lifetime success count (events > 0)
    history: [],            // last 7 entries: { timestamp, count, durationMs, status }
  };
}

// ============================================================
// Single source registry — everything derives from this array
// ============================================================

const SOURCES = [
  { label: 'Skint',            fetch: fetchSkintEvents,         weight: 0.9,  mergeRank: 0, endpoint: 'https://theskint.com' },
  { label: 'NonsenseNYC',      fetch: fetchNonsenseNYC,         weight: 0.9,  mergeRank: 1, endpoint: 'https://nonsensenyc.com' },
  { label: 'RA',               fetch: fetchRAEvents,            weight: 0.85, mergeRank: 0, endpoint: 'https://ra.co' },
  { label: 'OhMyRockness',     fetch: fetchOhMyRockness,        weight: 0.85, mergeRank: 1, endpoint: 'https://www.ohmyrockness.com/shows' },
  { label: 'Dice',             fetch: fetchDiceEvents,          weight: 0.8,  mergeRank: 0, endpoint: 'https://dice.fm/browse/new-york' },
  { label: 'BrooklynVegan',    fetch: fetchBrooklynVeganEvents, weight: 0.8,  mergeRank: 1, endpoint: 'https://www.brooklynvegan.com' },
  { label: 'BAM',              fetch: fetchBAMEvents,           weight: 0.8,  mergeRank: 2, endpoint: 'https://www.bam.org/api/BAMApi/GetCalendarEventsByDayWithOnGoing' },
  { label: 'SmallsLIVE',       fetch: fetchSmallsLiveEvents,    weight: 0.8,  mergeRank: 3, endpoint: 'https://www.smallslive.com/events/today' },
  { label: 'NYCParks',         fetch: fetchNYCParksEvents,      weight: 0.75, mergeRank: 0, endpoint: 'https://www.nycgovparks.org/events' },
  { label: 'DoNYC',            fetch: fetchDoNYCEvents,         weight: 0.75, mergeRank: 1, endpoint: 'https://donyc.com/events/today' },
  { label: 'Songkick',         fetch: fetchSongkickEvents,      weight: 0.75, mergeRank: 2, endpoint: 'https://www.songkick.com/metro-areas/7644-us-new-york/today' },
  { label: 'Eventbrite',       fetch: fetchEventbriteEvents,    weight: 0.7,  mergeRank: 0, endpoint: 'https://www.eventbrite.com/d/ny--new-york/events--today/' },
  { label: 'NYPL',             fetch: fetchNYPLEvents,          weight: 0.7,  mergeRank: 1, endpoint: 'https://www.eventbrite.com/o/new-york-public-library-for-the-performing-arts-5993389089' },
  { label: 'EventbriteComedy', fetch: fetchEventbriteComedy,    weight: 0.7,  mergeRank: 2, endpoint: null },
  { label: 'EventbriteArts',   fetch: fetchEventbriteArts,      weight: 0.7,  mergeRank: 3, endpoint: null },
  { label: 'Tavily',           fetch: fetchTavilyFreeEvents,    weight: 0.6,  mergeRank: 0, endpoint: null },
];

// Boot-time validation — fail fast on config errors
function validateSources(sources) {
  const labels = new Set();
  for (const s of sources) {
    if (!s.label) throw new Error('Source missing label');
    if (labels.has(s.label)) throw new Error(`Duplicate source label: ${s.label}`);
    labels.add(s.label);
    if (typeof s.fetch !== 'function') throw new Error(`${s.label}: fetch must be a function`);
    if (typeof s.weight !== 'number' || s.weight < 0 || s.weight > 1) throw new Error(`${s.label}: weight must be 0-1`);
  }
}
validateSources(SOURCES);

// Derived — no manual sync needed
const SOURCE_LABELS = SOURCES.map(s => s.label);

const ENDPOINT_URLS = Object.fromEntries(
  SOURCES.filter(s => s.endpoint).map(s => [s.label, s.endpoint])
);

const MERGE_ORDER = [...SOURCES]
  .sort((a, b) => (b.weight - a.weight) || (a.mergeRank - b.mergeRank) || a.label.localeCompare(b.label))
  .map(s => s.label);

const sourceHealth = {};
for (const label of SOURCE_LABELS) {
  sourceHealth[label] = makeHealthEntry();
}

const HEALTH_WARN_THRESHOLD = 3;
const HISTORY_MAX = 7;

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

// ============================================================
// Timed fetch wrapper — captures duration + status per source
// ============================================================

async function timedFetch(fetchFn, label, weight) {
  const start = Date.now();
  try {
    const events = await fetchFn();
    const durationMs = Date.now() - start;
    // Stamp canonical weight from registry (overrides whatever scrapers set)
    for (const e of events) { e.source_weight = weight; }
    return { events, durationMs, status: events.length > 0 ? 'ok' : 'empty', error: null };
  } catch (err) {
    const durationMs = Date.now() - start;
    const status = err.name === 'AbortError' || err.message?.includes('timeout') ? 'timeout' : 'error';
    return { events: [], durationMs, status, error: err.message };
  }
}

// ============================================================
// Proactive endpoint checks — HEAD requests during scrape
// ============================================================

async function checkEndpoints() {
  const results = {};
  const checks = Object.entries(ENDPOINT_URLS).map(async ([label, url]) => {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'PulseSMS/1.0 HealthCheck' },
        redirect: 'follow',
      });
      clearTimeout(timeout);
      results[label] = { httpStatus: res.status, durationMs: Date.now() - start };
    } catch (err) {
      results[label] = { httpStatus: null, durationMs: Date.now() - start, error: err.message };
    }
  });
  await Promise.allSettled(checks);
  return results;
}

// ============================================================
// Cache refresh — fetches all sources in parallel
// ============================================================

async function refreshCache() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const scrapeStart = new Date();
    lastScrapeStats.startedAt = scrapeStart.toISOString();
    console.log('Refreshing event cache (all sources)...');

    // Run endpoint checks and source fetches in parallel
    // SOURCES drives the fetch array — no positional coupling
    const [endpointResults, ...fetchResults] = await Promise.allSettled([
      checkEndpoints(),
      ...SOURCES.map(s => timedFetch(s.fetch, s.label, s.weight)),
    ]);

    // Store endpoint check results
    const endpoints = endpointResults.status === 'fulfilled' ? endpointResults.value : {};
    for (const [label, data] of Object.entries(endpoints)) {
      if (sourceHealth[label]) {
        sourceHealth[label].lastHttpStatus = data.httpStatus;
      }
    }

    const allEvents = [];
    const seen = new Set();

    // Map fetch results back to labels — SOURCES[i] corresponds to fetchResults[i]
    const fetchMap = {};
    for (let i = 0; i < SOURCES.length; i++) {
      const settled = fetchResults[i];
      fetchMap[SOURCES[i].label] = settled.status === 'fulfilled'
        ? settled.value
        : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message || 'unknown' };
    }

    let sourcesOk = 0, sourcesFailed = 0, sourcesEmpty = 0;
    let totalRaw = 0;
    const now = new Date().toISOString();

    // Merge in priority order (highest weight first, then mergeRank)
    for (const label of MERGE_ORDER) {
      const { events, durationMs, status, error } = fetchMap[label];
      totalRaw += events.length;

      for (const e of events) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }

      if (status === 'error' || status === 'timeout') {
        console.error(`${label} failed:`, error);
      }

      // Update health tracking
      const health = sourceHealth[label];
      if (health) {
        health.lastCount = events.length;
        health.lastStatus = status;
        health.lastError = error;
        health.lastDurationMs = durationMs;
        health.lastScrapeAt = now;
        health.totalScrapes++;
        if (events.length > 0) {
          health.totalSuccesses++;
          health.consecutiveZeros = 0;
        } else {
          health.consecutiveZeros++;
          if (health.consecutiveZeros >= HEALTH_WARN_THRESHOLD) {
            console.warn(`[HEALTH] ${label} has returned 0 events for ${health.consecutiveZeros} consecutive refreshes`);
          }
        }

        // Push to history (capped at HISTORY_MAX)
        health.history.push({ timestamp: now, count: events.length, durationMs, status });
        if (health.history.length > HISTORY_MAX) {
          health.history.shift();
        }
      }

      if (status === 'ok') sourcesOk++;
      else if (status === 'empty') sourcesEmpty++;
      else sourcesFailed++;
    }

    // Geocode events that still have no neighborhood (venue map miss)
    await batchGeocodeEvents(allEvents);

    // Persist learned venues to disk for next restart
    const learned = exportLearnedVenues();
    const learnedCount = Object.keys(learned).length;
    if (learnedCount > 0) {
      try {
        fs.writeFileSync(path.join(__dirname, '../data/venues-learned.json'), JSON.stringify(learned, null, 2));
        console.log(`Persisted ${learnedCount} learned venues`);
      } catch (err) { console.error('Failed to persist venues:', err.message); }
    }

    eventCache = allEvents;
    cacheTimestamp = Date.now();

    // Update scrape-level stats
    const scrapeEnd = new Date();
    lastScrapeStats = {
      startedAt: scrapeStart.toISOString(),
      completedAt: scrapeEnd.toISOString(),
      totalDurationMs: scrapeEnd - scrapeStart,
      totalEvents: totalRaw,
      dedupedEvents: allEvents.length,
      sourcesOk,
      sourcesFailed,
      sourcesEmpty,
    };

    // Alert on sources that have been failing for 3+ consecutive scrapes
    const alertable = Object.entries(sourceHealth)
      .filter(([_, h]) => h.consecutiveZeros >= HEALTH_WARN_THRESHOLD)
      .map(([label, h]) => ({ label, consecutiveZeros: h.consecutiveZeros, lastError: h.lastError, lastStatus: h.lastStatus }));
    if (alertable.length > 0) {
      sendHealthAlert(alertable, lastScrapeStats).catch(err =>
        console.error('[ALERT] Failed:', err.message)
      );
    }

    console.log(`Cache refreshed: ${allEvents.length} deduped events (${totalRaw} raw from ${sourcesOk} ok / ${sourcesFailed} failed / ${sourcesEmpty} empty sources)`);
    return eventCache;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

// ============================================================
// Main entry: get events for a neighborhood (reads from cache)
// ============================================================

async function getEvents(neighborhood) {
  if (eventCache.length === 0) {
    // First request before morning scrape — do a one-time load
    await refreshCache();
  }

  const upcoming = filterUpcomingEvents(eventCache);
  const ranked = rankEventsByProximity(upcoming, neighborhood);

  // Only return tonight's events — tomorrow events should only surface if the user asks
  const todayNyc = getNycDateString(0);
  const tonightOnly = ranked.filter(e => {
    const d = getEventDate(e);
    return !d || d === todayNyc;
  });

  console.log(`${tonightOnly.length} tonight events near ${neighborhood} (${ranked.length} total upcoming, cache: ${eventCache.length})`);
  return tonightOnly.slice(0, 20);
}

// ============================================================
// Daily scheduler — runs scrape at target hour in NYC timezone
// ============================================================

const SCRAPE_HOUR = 10; // 10am ET

function msUntilNextScrape() {
  const now = new Date();
  // Get current NYC time components
  const nycStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [datePart, timePart] = nycStr.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);

  // Calculate ms until next SCRAPE_HOUR
  let hoursUntil = SCRAPE_HOUR - hour;
  if (hoursUntil < 0) hoursUntil += 24; // already past today, schedule for tomorrow

  const msUntil = (hoursUntil * 3600 - minute * 60 - second) * 1000;
  return msUntil;
}

let dailyTimer = null;

function scheduleDailyScrape() {
  const ms = msUntilNextScrape();
  const hours = (ms / 3600000).toFixed(1);
  console.log(`Next scrape scheduled in ${hours} hours (${SCRAPE_HOUR}:00 ET)`);

  dailyTimer = setTimeout(async () => {
    try {
      await refreshCache();
    } catch (err) {
      console.error('Scheduled scrape failed:', err.message);
    }
    // Schedule next one (repeats daily)
    scheduleDailyScrape();
  }, ms);
}

function clearSchedule() {
  if (dailyTimer) clearTimeout(dailyTimer);
}

function getCacheStatus() {
  return {
    cache_size: eventCache.length,
    cache_age_minutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
    cache_fresh: eventCache.length > 0,
    sources: { ...sourceHealth },
  };
}

function getHealthStatus() {
  const sources = {};
  for (const [label, h] of Object.entries(sourceHealth)) {
    sources[label] = {
      status: h.lastStatus,
      last_count: h.lastCount,
      consecutive_zeros: h.consecutiveZeros,
      duration_ms: h.lastDurationMs,
      http_status: h.lastHttpStatus,
      last_error: h.lastError,
      last_scrape: h.lastScrapeAt,
      success_rate: h.totalScrapes > 0
        ? Math.round((h.totalSuccesses / h.totalScrapes) * 100) + '%'
        : null,
      history: h.history,
    };
  }

  const anyFailed = Object.values(sourceHealth).some(h => h.lastStatus === 'error' || h.lastStatus === 'timeout');
  const allFailed = Object.values(sourceHealth).every(h => h.lastStatus === 'error' || h.lastStatus === 'timeout');

  return {
    status: allFailed && lastScrapeStats.startedAt ? 'critical' : anyFailed ? 'degraded' : 'ok',
    cache: {
      size: eventCache.length,
      age_minutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
      fresh: eventCache.length > 0,
      last_refresh: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null,
    },
    scrape: { ...lastScrapeStats },
    sources,
  };
}

function getRawCache() {
  return { events: [...eventCache], timestamp: cacheTimestamp };
}

module.exports = { SOURCES, refreshCache, getEvents, getCacheStatus, getHealthStatus, getRawCache, scheduleDailyScrape, clearSchedule };
