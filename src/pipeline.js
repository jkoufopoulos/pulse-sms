const { setResponseState } = require('./session');
const { filterByTimeAfter, parseAsNycTime, getEventDate } = require('./geo');
const { searchTavilyEvents } = require('./sources/tavily');

/**
 * Apply event filters (free, category, time).
 * Soft mode (default): falls back to unfiltered if no category matches.
 * Strict mode: keeps empty result when no category matches (for explicit requests like "free comedy").
 */
function applyFilters(events, filters, { strict = false } = {}) {
  let filtered = events;
  if (filters?.free_only) {
    filtered = filtered.filter(e => e.is_free);
  }
  if (filters?.category) {
    const catFiltered = filtered.filter(e => e.category === filters.category);
    if (strict || catFiltered.length > 0) filtered = catFiltered;
  }
  if (filters?.time_after) {
    filtered = filterByTimeAfter(filtered, filters.time_after);
  }
  return filtered;
}

/**
 * Resolve active filters from route, pending session state, and last session filters.
 * Priority: route filters > pending filters > session lastFilters > fallback route.
 */
function resolveActiveFilters(route, session, { forceFree = false } = {}) {
  const routeHasFilters = route.filters && Object.values(route.filters).some(Boolean);
  let filters;
  if (routeHasFilters) {
    filters = route.filters;
  } else if (session?.pendingFilters && Object.values(session.pendingFilters).some(Boolean)) {
    filters = session.pendingFilters;
  } else if (session?.lastFilters && Object.values(session.lastFilters).some(Boolean)) {
    filters = session.lastFilters;
  } else {
    filters = route.filters || {};
  }
  if (forceFree) filters = { ...filters, free_only: true };
  return filters;
}

/**
 * Build an event lookup map from an array of events.
 */
function buildEventMap(events) {
  const map = {};
  for (const e of events) map[e.id] = e;
  return map;
}

/**
 * Save all event-related session fields atomically after a response.
 * Every field is explicitly set to prevent stale state from persisting.
 */
function saveResponseFrame(phone, { mode = 'fresh', picks = [], prevSession,
    eventMap = {}, neighborhood, filters, offeredIds = [], visitedHoods, pending, pendingMessage } = {}) {
  const isMore = mode === 'more';
  setResponseState(phone, {
    picks,
    allPicks: isMore ? [...(prevSession?.allPicks || prevSession?.lastPicks || []), ...picks] : picks,
    offeredIds: isMore ? [...(prevSession?.allOfferedIds || []), ...offeredIds] : offeredIds,
    eventMap,
    neighborhood,
    dateRange: filters?.date_range || null,
    filters: filters || null,
    visitedHoods: visitedHoods
      ? visitedHoods
      : isMore
        ? [...new Set([...(prevSession?.visitedHoods || []), neighborhood])]
        : (neighborhood ? [neighborhood] : []),
    pendingNearby: pending?.neighborhood || null,
    pendingNearbyEvents: pending?.nearbyEvents || null,
    pendingFilters: pending?.filters || null,
    pendingMessage: pendingMessage || null,
  });
}

/**
 * Build a consistent exhaustion message with nearby neighborhood suggestion.
 */
function buildExhaustionMessage(hood, { adjacentHoods = [], visitedHoods = [] } = {}) {
  const unvisited = adjacentHoods.filter(n => !visitedHoods.includes(n));
  const suggestion = unvisited[0] || null;
  const message = suggestion
    ? `That's everything I've got in ${hood}! ${suggestion} is right nearby — want picks from there?`
    : `That's everything I've got in ${hood}! Try a different neighborhood for more.`;
  return { message, suggestedHood: suggestion };
}

/**
 * Merge two filter objects with explicit-key semantics.
 * If a key EXISTS in incoming (even with value null/false), it overrides.
 * If a key is ABSENT from incoming, fall back to existing (enables compounding).
 * This lets pre-router set only the keys it detects, compounding with existing filters,
 * while also enabling partial clearing (e.g. { category: null } clears category only).
 */
function mergeFilters(existing, incoming) {
  if (!existing && !incoming) return {};
  const base = existing || {};
  const next = incoming || {};
  return {
    free_only: 'free_only' in next ? (next.free_only || false) : (base.free_only || false),
    category: 'category' in next ? (next.category || null) : (base.category || null),
    subcategory: 'subcategory' in next ? (next.subcategory || null) : (base.subcategory || null),
    vibe: 'vibe' in next ? (next.vibe || null) : (base.vibe || null),
    time_after: 'time_after' in next ? (next.time_after || null) : (base.time_after || null),
    date_range: 'date_range' in next ? (next.date_range || null) : (base.date_range || null),
  };
}

/**
 * Check if an event fails a time gate. Returns true if the event starts
 * before the given HH:MM time (NYC timezone). Events without parseable
 * start times pass through (return false = does not fail).
 * Uses after-midnight wrapping: events before 6am are treated as next-day.
 */
function failsTimeGate(event, timeAfter) {
  if (!event.start_time_local || !/T\d{2}:/.test(event.start_time_local)) return false;
  try {
    const ms = parseAsNycTime(event.start_time_local);
    if (isNaN(ms)) return false;
    const nycDate = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false });
    const [h, m] = nycDate.split(':').map(Number);
    const eventMinutes = h * 60 + m;
    const [filterH, filterM] = timeAfter.split(':').map(Number);
    const filterMinutes = filterH * 60 + filterM;
    // After-midnight wrapping: events before 6am treated as next-day
    const adjustedEvent = eventMinutes < 6 * 60 ? eventMinutes + 24 * 60 : eventMinutes;
    const adjustedFilter = filterMinutes < 6 * 60 ? filterMinutes + 24 * 60 : filterMinutes;
    return adjustedEvent < adjustedFilter;
  } catch { return false; }
}

/**
 * Check if an event matches ALL active filter dimensions.
 * Returns 'hard' (exact match), 'soft' (broad category match with subcategory),
 * or false (no match). Time is enforced upstream by failsTimeGate in buildTaggedPool.
 */
function eventMatchesFilters(event, filters) {
  if (filters.free_only && !event.is_free) return false;
  if (filters.category && event.category !== filters.category) return false;
  // Date range filter: check event's date falls within range
  if (filters.date_range) {
    const eventDate = getEventDate(event);
    if (eventDate) {
      if (eventDate < filters.date_range.start || eventDate > filters.date_range.end) return false;
    }
    // Events without dates get soft match — we don't know if they're in range
    if (!eventDate) return 'soft';
  }
  // vibe has no event field to match — LLM handles vibe selection
  // If time filter active but event has no parseable time, downgrade to soft —
  // we don't know if it matches, so [SOFT] lets the LLM deprioritize vs confirmed-late events
  if (filters.time_after && (!event.start_time_local || !/T\d{2}:/.test(event.start_time_local))) return 'soft';
  // Determine hard vs soft: if subcategory is set, the category is a broad match
  // and the LLM should use judgment to find events matching the sub-genre
  if (filters.subcategory) return 'soft';
  return 'hard';
}

/**
 * Build a tagged event pool. Matched events come first (up to 10),
 * padded to 15 total with unmatched events. Returns pool + metadata.
 */
function buildTaggedPool(events, activeFilters, { citywide = false } = {}) {
  const hasFilters = activeFilters && Object.values(activeFilters).some(Boolean);
  if (!hasFilters) {
    let pool = events.slice(0, 15);
    // For citywide pools, apply neighborhood diversity even without filters
    if (citywide) {
      const diversePool = [];
      const hoodCounts = {};
      for (const e of events) {
        const hood = e.neighborhood || 'unknown';
        hoodCounts[hood] = (hoodCounts[hood] || 0) + 1;
        if (hoodCounts[hood] <= 3) diversePool.push(e);
        if (diversePool.length >= 15) break;
      }
      pool = diversePool;
    }
    return {
      pool: pool.map(e => ({ ...e, filter_match: false })),
      matchCount: 0,
      hardCount: 0,
      softCount: 0,
      isSparse: false,
    };
  }

  // Hard time gate (P5): pre-filter events before classification.
  // Events before time_after never reach the LLM.
  let candidates = events;
  if (activeFilters.time_after && /^\d{2}:\d{2}$/.test(activeFilters.time_after)) {
    candidates = events.filter(e => !failsTimeGate(e, activeFilters.time_after));
  }

  const hard = [];
  const soft = [];
  const unmatched = [];

  for (const e of candidates) {
    const result = eventMatchesFilters(e, activeFilters);
    if (result === 'hard') {
      hard.push({ ...e, filter_match: 'hard' });
    } else if (result === 'soft') {
      soft.push({ ...e, filter_match: 'soft' });
    } else {
      unmatched.push({ ...e, filter_match: false });
    }
  }

  // For citywide pools, apply neighborhood diversity: max 3 per neighborhood
  const applyDiversity = (arr, cap) => {
    if (!citywide) return arr.slice(0, cap);
    const result = [];
    const hoodCounts = {};
    for (const e of arr) {
      const hood = e.neighborhood || 'unknown';
      hoodCounts[hood] = (hoodCounts[hood] || 0) + 1;
      if (hoodCounts[hood] <= 3) result.push(e);
      if (result.length >= cap) break;
    }
    return result;
  };

  const hardSlice = applyDiversity(hard, 10);
  const softSlice = applyDiversity(soft, Math.max(0, 10 - hardSlice.length));
  const unmatchedSlice = applyDiversity(unmatched, Math.max(0, 15 - hardSlice.length - softSlice.length));
  const pool = [...hardSlice, ...softSlice, ...unmatchedSlice];

  const totalMatched = hard.length + soft.length;
  return {
    pool,
    matchCount: totalMatched,
    hardCount: hard.length,
    softCount: soft.length,
    isSparse: totalMatched > 0 && totalMatched < 3,
  };
}

/**
 * Map LLM subcategory values to canonical categories (matches pre-router.js catMap).
 */
const CATEGORY_NORMALIZE = {
  jazz: 'live_music', rock: 'live_music', indie: 'live_music', folk: 'live_music',
  punk: 'live_music', metal: 'live_music', 'hip hop': 'live_music', 'hip-hop': 'live_music',
  'r&b': 'live_music', soul: 'live_music', funk: 'live_music', rap: 'live_music',
  music: 'live_music', 'live music': 'live_music',
  techno: 'nightlife', house: 'nightlife', electronic: 'nightlife', dj: 'nightlife',
  dance: 'nightlife', salsa: 'nightlife', bachata: 'nightlife', swing: 'nightlife',
  standup: 'comedy', 'stand-up': 'comedy', improv: 'comedy',
  theatre: 'theater',
  trivia: 'community', karaoke: 'community', drag: 'community',
  burlesque: 'community', bingo: 'community', 'open mic': 'community', poetry: 'community',
};

/**
 * Normalize LLM-returned filters to canonical form.
 * Maps subcategories to canonical categories, coerces free_only to boolean,
 * validates time_after is HH:MM format.
 */
function normalizeFilters(filters) {
  if (!filters || typeof filters !== 'object') return null;
  const result = {};
  if (filters.category) {
    const key = String(filters.category).toLowerCase().trim();
    const canonical = CATEGORY_NORMALIZE[key] || key;
    result.category = canonical;
    // If the LLM returned a sub-genre that maps to a broader category,
    // preserve the original term as subcategory so the tagged pool uses soft matching
    if (CATEGORY_NORMALIZE[key] && key !== canonical) {
      result.subcategory = key;
    }
  }
  if (filters.subcategory) {
    result.subcategory = String(filters.subcategory).toLowerCase().trim();
  }
  if (filters.free_only !== undefined && filters.free_only !== null) {
    result.free_only = Boolean(filters.free_only);
  }
  if (filters.time_after) {
    const ta = String(filters.time_after).trim();
    result.time_after = /^\d{2}:\d{2}$/.test(ta) ? ta : null;
  }
  if (filters.vibe) {
    result.vibe = filters.vibe;
  }
  if (filters.date_range && filters.date_range.start && filters.date_range.end) {
    result.date_range = filters.date_range;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Build a filter-aware Tavily search query for a neighborhood.
 */
function buildTavilyQuery(hood, filters) {
  const parts = [];
  if (filters?.free_only) parts.push('free');
  if (filters?.subcategory) parts.push(filters.subcategory);
  else if (filters?.category) parts.push(filters.category.replace('_', ' '));
  parts.push('events');
  parts.push(hood);
  parts.push('NYC');
  if (filters?.time_after) {
    const [h] = filters.time_after.split(':').map(Number);
    if (h >= 21) parts.push('late night');
    else parts.push('tonight');
  } else {
    parts.push('tonight');
  }
  return parts.join(' ');
}

/**
 * Last-resort Tavily live search when cached events are exhausted.
 * Returns { events } or null on failure/empty.
 */
async function tryTavilyFallback(hood, filters, excludeIds, trace) {
  try {
    const query = buildTavilyQuery(hood, filters);
    const start = Date.now();
    const results = await searchTavilyEvents(hood, { query });
    const latency = Date.now() - start;
    const excludeSet = new Set(excludeIds || []);
    const fresh = results.filter(e => !excludeSet.has(e.id));
    if (trace) {
      trace.tavily_fallback = { triggered: true, query, latency_ms: latency, raw_count: results.length, fresh_count: fresh.length };
    }
    if (fresh.length === 0) return null;
    // Late require to avoid circular dep (events.js → pipeline.js)
    require('./events').injectEvents(fresh);
    return { events: fresh };
  } catch (err) {
    console.error('Tavily fallback error:', err.message);
    if (trace) {
      trace.tavily_fallback = { triggered: true, error: err.message };
    }
    return null;
  }
}

module.exports = { applyFilters, resolveActiveFilters, buildEventMap, saveResponseFrame, buildExhaustionMessage, mergeFilters, eventMatchesFilters, buildTaggedPool, normalizeFilters, failsTimeGate, buildTavilyQuery, tryTavilyFallback };
