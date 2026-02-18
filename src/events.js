const fs = require('fs');
const path = require('path');
const { fetchSkintEvents, fetchEventbriteEvents, fetchSongkickEvents, fetchDiceEvents, fetchRAEvents, fetchTavilyFreeEvents, fetchNonsenseNYC, fetchOhMyRockness, fetchDoNYCEvents, fetchBAMEvents, fetchSmallsLiveEvents, fetchNYPLEvents, fetchEventbriteComedy, fetchEventbriteArts, fetchNYCParksEvents, fetchBrooklynVeganEvents } = require('./sources');
const { rankEventsByProximity, filterUpcomingEvents, getNycDateString, getEventDate } = require('./geo');
const { batchGeocodeEvents, exportLearnedVenues, importLearnedVenues } = require('./venues');

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

const SOURCE_LABELS = [
  'Skint', 'Songkick', 'Eventbrite', 'RA', 'Dice', 'Tavily',
  'NonsenseNYC', 'OhMyRockness', 'EventbriteComedy', 'EventbriteArts',
  'NYCParks', 'BrooklynVegan', 'DoNYC', 'BAM', 'SmallsLIVE', 'NYPL',
];

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

// --- Endpoint URLs for proactive checks ---
const ENDPOINT_URLS = {
  Skint: 'https://theskint.com',
  Eventbrite: 'https://www.eventbrite.com/d/ny--new-york/events--today/',
  Songkick: 'https://www.songkick.com/metro-areas/7644-us-new-york/today',
  RA: 'https://ra.co',
  Dice: 'https://dice.fm/browse/new-york',
  NonsenseNYC: 'https://nonsensenyc.com',
  OhMyRockness: 'https://www.ohmyrockness.com/shows',
  DoNYC: 'https://donyc.com/events/today',
  BAM: 'https://www.bam.org/api/BAMApi/GetCalendarEventsByDayWithOnGoing',
  SmallsLIVE: 'https://www.smallslive.com/events/today',
  NYPL: 'https://www.eventbrite.com/o/new-york-public-library-for-the-performing-arts-5993389089',
  NYCParks: 'https://www.nycgovparks.org/events',
  BrooklynVegan: 'https://www.brooklynvegan.com',
};

// ============================================================
// Timed fetch wrapper — captures duration + status per source
// ============================================================

async function timedFetch(fetchFn, label) {
  const start = Date.now();
  try {
    const events = await fetchFn();
    const durationMs = Date.now() - start;
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
    const [endpointResults, ...fetchResults] = await Promise.allSettled([
      checkEndpoints(),
      timedFetch(fetchSkintEvents, 'Skint'),
      timedFetch(fetchEventbriteEvents, 'Eventbrite'),
      timedFetch(fetchSongkickEvents, 'Songkick'),
      timedFetch(fetchRAEvents, 'RA'),
      timedFetch(fetchDiceEvents, 'Dice'),
      timedFetch(fetchTavilyFreeEvents, 'Tavily'),
      timedFetch(fetchNonsenseNYC, 'NonsenseNYC'),
      timedFetch(fetchOhMyRockness, 'OhMyRockness'),
      timedFetch(fetchDoNYCEvents, 'DoNYC'),
      timedFetch(fetchBAMEvents, 'BAM'),
      timedFetch(fetchSmallsLiveEvents, 'SmallsLIVE'),
      timedFetch(fetchNYPLEvents, 'NYPL'),
      timedFetch(fetchEventbriteComedy, 'EventbriteComedy'),
      timedFetch(fetchEventbriteArts, 'EventbriteArts'),
      timedFetch(fetchNYCParksEvents, 'NYCParks'),
      timedFetch(fetchBrooklynVeganEvents, 'BrooklynVegan'),
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

    // Map fetch results back to labels (same order as Promise.allSettled above)
    const sourceOrder = [
      'Skint', 'Eventbrite', 'Songkick', 'RA', 'Dice', 'Tavily',
      'NonsenseNYC', 'OhMyRockness', 'DoNYC', 'BAM', 'SmallsLIVE',
      'NYPL', 'EventbriteComedy', 'EventbriteArts', 'NYCParks', 'BrooklynVegan',
    ];

    const fetchMap = {};
    for (let i = 0; i < sourceOrder.length; i++) {
      const settled = fetchResults[i];
      // timedFetch never throws (catches internally), but Promise.allSettled wraps it
      fetchMap[sourceOrder[i]] = settled.status === 'fulfilled' ? settled.value : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message || 'unknown' };
    }

    // Merge in priority order (highest source_weight first)
    const mergeOrder = [
      'Skint', 'NonsenseNYC', 'RA', 'OhMyRockness', 'Dice', 'BrooklynVegan',
      'BAM', 'SmallsLIVE', 'NYCParks', 'DoNYC', 'Songkick', 'NYPL',
      'Eventbrite', 'EventbriteComedy', 'EventbriteArts', 'Tavily',
    ];

    let sourcesOk = 0, sourcesFailed = 0, sourcesEmpty = 0;
    let totalRaw = 0;
    const now = new Date().toISOString();

    for (const label of mergeOrder) {
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
  if (hoursUntil <= 0) hoursUntil += 24; // already past today, schedule for tomorrow

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

module.exports = { refreshCache, getEvents, getCacheStatus, getHealthStatus, getRawCache, scheduleDailyScrape, clearSchedule };
