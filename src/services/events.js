const { extractEvents } = require('./ai');
const { fetchSkintEvents, fetchEventbriteEvents, fetchSongkickEvents, normalizeExtractedEvent } = require('./sources');
const { rankEventsByProximity, filterUpcomingEvents } = require('../utils/geo');

// --- In-memory event cache with 2-hour TTL ---
let eventCache = [];
let cacheTimestamp = 0;
let refreshPromise = null; // mutex to prevent concurrent refreshes
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// --- Source health tracking ---
const sourceHealth = {
  Skint: { consecutiveZeros: 0, lastCount: 0 },
  Songkick: { consecutiveZeros: 0, lastCount: 0 },
  Eventbrite: { consecutiveZeros: 0, lastCount: 0 },
};
const HEALTH_WARN_THRESHOLD = 3; // warn after 3 consecutive zero refreshes

function isCacheFresh() {
  return Date.now() - cacheTimestamp < CACHE_TTL_MS;
}

// ============================================================
// Cache refresh — fetches all sources in parallel
// ============================================================

async function refreshCache() {
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
}

// ============================================================
// Tavily fallback (on-demand web search when cache is thin)
// ============================================================

async function searchTavily(neighborhood) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.error('TAVILY_API_KEY not set');
    return [];
  }

  const query = `events tonight ${neighborhood} NYC`;
  console.log(`Tavily search: "${query}"`);

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        include_answer: false,
        max_results: 8,
      }),
    });

    if (!res.ok) {
      console.error(`Tavily API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) return [];

    const rawText = results
      .map(r => `${r.title}\n${r.content}\nURL: ${r.url}`)
      .join('\n\n---\n\n');

    const extracted = await extractEvents(rawText, 'tavily_search', query);
    const events = (extracted.events || [])
      .filter(e => e.name && e.confidence >= 0.3)
      .map(e => normalizeExtractedEvent(e, 'tavily', 'web_search', 0.5));

    console.log(`Tavily: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Tavily error:', err.message);
    return [];
  }
}

// ============================================================
// Main entry: get events for a neighborhood
// ============================================================

async function getEvents(neighborhood) {
  if (!isCacheFresh()) {
    if (!refreshPromise) {
      refreshPromise = refreshCache().finally(() => { refreshPromise = null; });
    }
    await refreshPromise;
  }

  // Pre-filter: remove events that have already ended, then rank by proximity
  const upcoming = filterUpcomingEvents(eventCache);
  const ranked = rankEventsByProximity(upcoming, neighborhood);

  if (ranked.length >= 5) {
    console.log(`Cache has ${ranked.length} upcoming events near ${neighborhood}`);
    return ranked.slice(0, 20);
  }

  // Supplement with Tavily when cache is thin
  console.log(`Cache thin for ${neighborhood} (${ranked.length} upcoming), searching Tavily...`);
  const tavilyEvents = await searchTavily(neighborhood);

  const seen = new Set(ranked.map(e => e.id));
  const merged = [...ranked];
  for (const e of tavilyEvents) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      merged.push(e);
    }
  }

  return merged.slice(0, 20);
}

function getCacheStatus() {
  return {
    cache_size: eventCache.length,
    cache_age_minutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
    cache_fresh: isCacheFresh(),
    sources: { ...sourceHealth },
  };
}

module.exports = { refreshCache, searchTavily, getEvents, getCacheStatus };
