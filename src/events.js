const { fetchSkintEvents, fetchEventbriteEvents, fetchSongkickEvents } = require('./sources');
const { rankEventsByProximity, filterUpcomingEvents } = require('./geo');

// --- Daily event cache ---
let eventCache = [];
let cacheTimestamp = 0;
let refreshPromise = null; // mutex to prevent concurrent refreshes

// --- Source health tracking ---
const sourceHealth = {
  Skint: { consecutiveZeros: 0, lastCount: 0 },
  Songkick: { consecutiveZeros: 0, lastCount: 0 },
  Eventbrite: { consecutiveZeros: 0, lastCount: 0 },
};
const HEALTH_WARN_THRESHOLD = 3;

// ============================================================
// Cache refresh — fetches all sources in parallel
// ============================================================

async function refreshCache() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    console.log('Refreshing event cache (all sources)...');

    const [skintEvents, eventbriteEvents, songkickEvents] = await Promise.allSettled([
      fetchSkintEvents(),
      fetchEventbriteEvents(),
      fetchSongkickEvents(),
    ]);

    const allEvents = [];
    const seen = new Set();

    // Merge in priority order: Skint first (highest trust), then Songkick, then Eventbrite
    const sources = [
      { result: skintEvents, label: 'Skint' },
      { result: songkickEvents, label: 'Songkick' },
      { result: eventbriteEvents, label: 'Eventbrite' },
    ];

    for (const { result, label } of sources) {
      const events = result.status === 'fulfilled' ? result.value : [];
      for (const e of events) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }
      if (result.status === 'rejected') {
        console.error(`${label} failed:`, result.reason?.message);
      }

      // Track source health
      const health = sourceHealth[label];
      if (health) {
        health.lastCount = events.length;
        if (events.length === 0) {
          health.consecutiveZeros++;
          if (health.consecutiveZeros >= HEALTH_WARN_THRESHOLD) {
            console.warn(`[HEALTH] ${label} has returned 0 events for ${health.consecutiveZeros} consecutive refreshes`);
          }
        } else {
          health.consecutiveZeros = 0;
        }
      }
    }

    eventCache = allEvents;
    cacheTimestamp = Date.now();

    console.log(`Cache refreshed: ${allEvents.length} total events`);
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

  console.log(`${ranked.length} upcoming events near ${neighborhood} (cache: ${eventCache.length} total)`);
  return ranked.slice(0, 20);
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

module.exports = { refreshCache, getEvents, getCacheStatus, scheduleDailyScrape, clearSchedule };
