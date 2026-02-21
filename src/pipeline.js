const { setResponseState } = require('./session');
const { filterByTimeAfter } = require('./geo');

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

module.exports = { applyFilters, resolveActiveFilters, buildEventMap, saveResponseFrame, buildExhaustionMessage };
