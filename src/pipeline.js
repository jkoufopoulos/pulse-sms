const { setResponseState } = require('./session');
const { filterByTimeAfter, parseAsNycTime } = require('./geo');

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
 * Merge two filter objects. Incoming truthy values override existing.
 * Falsy incoming values fall back to existing (enables filter compounding).
 */
function mergeFilters(existing, incoming) {
  if (!existing && !incoming) return {};
  const base = existing || {};
  const next = incoming || {};
  return {
    free_only: next.free_only || base.free_only || false,
    category: next.category || base.category || null,
    subcategory: next.subcategory || base.subcategory || null,
    vibe: next.vibe || base.vibe || null,
    time_after: next.time_after || base.time_after || null,
  };
}

/**
 * Check if an event matches ALL active filter dimensions.
 * Returns 'hard' (exact match), 'soft' (broad category match with subcategory),
 * or false (no match). Events without parseable times pass the time filter.
 */
function eventMatchesFilters(event, filters) {
  if (filters.free_only && !event.is_free) return false;
  if (filters.category && event.category !== filters.category) return false;
  if (filters.time_after && /^\d{2}:\d{2}$/.test(filters.time_after)) {
    if (event.start_time_local && /T\d{2}:/.test(event.start_time_local)) {
      try {
        const ms = parseAsNycTime(event.start_time_local);
        if (!isNaN(ms)) {
          const nycDate = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false });
          const [h, m] = nycDate.split(':').map(Number);
          const eventMinutes = h * 60 + m;
          const [filterH, filterM] = filters.time_after.split(':').map(Number);
          const filterMinutes = filterH * 60 + filterM;
          // After-midnight wrapping: events before 6am treated as next-day
          const adjustedEvent = eventMinutes < 6 * 60 ? eventMinutes + 24 * 60 : eventMinutes;
          const adjustedFilter = filterMinutes < 6 * 60 ? filterMinutes + 24 * 60 : filterMinutes;
          if (adjustedEvent < adjustedFilter) return false;
        }
      } catch { /* no parseable time → pass */ }
    }
  }
  // vibe has no event field to match — LLM handles vibe selection
  // Determine hard vs soft: if subcategory is set, the category is a broad match
  // and the LLM should use judgment to find events matching the sub-genre
  if (filters.subcategory) return 'soft';
  return 'hard';
}

/**
 * Build a tagged event pool. Matched events come first (up to 10),
 * padded to 15 total with unmatched events. Returns pool + metadata.
 */
function buildTaggedPool(events, activeFilters) {
  const hasFilters = activeFilters && Object.values(activeFilters).some(Boolean);
  if (!hasFilters) {
    return {
      pool: events.slice(0, 15).map(e => ({ ...e, filter_match: false })),
      matchCount: 0,
      hardCount: 0,
      softCount: 0,
      isSparse: false,
    };
  }

  const hard = [];
  const soft = [];
  const unmatched = [];

  for (const e of events) {
    const result = eventMatchesFilters(e, activeFilters);
    if (result === 'hard') {
      hard.push({ ...e, filter_match: 'hard' });
    } else if (result === 'soft') {
      soft.push({ ...e, filter_match: 'soft' });
    } else {
      unmatched.push({ ...e, filter_match: false });
    }
  }

  const hardSlice = hard.slice(0, 10);
  const softSlice = soft.slice(0, Math.max(0, 10 - hardSlice.length));
  const unmatchedSlice = unmatched.slice(0, Math.max(0, 15 - hardSlice.length - softSlice.length));
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
  return Object.keys(result).length > 0 ? result : null;
}

module.exports = { applyFilters, resolveActiveFilters, buildEventMap, saveResponseFrame, buildExhaustionMessage, mergeFilters, eventMatchesFilters, buildTaggedPool, normalizeFilters };
