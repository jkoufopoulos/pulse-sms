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
    eventMap = {}, neighborhood, filters, offeredIds = [], visitedHoods, pending } = {}) {
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
    vibe: next.vibe || base.vibe || null,
    time_after: next.time_after || base.time_after || null,
  };
}

/**
 * Check if an event matches ALL active filter dimensions.
 * Events without parseable times pass the time filter (soft behavior).
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
  return true;
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
      isSparse: false,
    };
  }

  const matched = [];
  const unmatched = [];

  for (const e of events) {
    if (eventMatchesFilters(e, activeFilters)) {
      matched.push({ ...e, filter_match: true });
    } else {
      unmatched.push({ ...e, filter_match: false });
    }
  }

  const pool = [
    ...matched.slice(0, 10),
    ...unmatched.slice(0, Math.max(0, 15 - Math.min(matched.length, 10))),
  ];

  return {
    pool,
    matchCount: matched.length,
    isSparse: matched.length > 0 && matched.length < 3,
  };
}

module.exports = { applyFilters, resolveActiveFilters, buildEventMap, saveResponseFrame, buildExhaustionMessage, mergeFilters, eventMatchesFilters, buildTaggedPool };
