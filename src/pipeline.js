const { setResponseState } = require('./session');
const { filterByTimeAfter, parseAsNycTime, getEventDate } = require('./geo');
const { recordAICost } = require('./traces');
const { VALID_CATEGORIES } = require('./evals/scrape-audit');

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
    eventMap = {}, neighborhood, borough, filters, offeredIds = [], visitedHoods, pending, pendingMessage, lastResponseHadPicks } = {}) {
  const isMore = mode === 'more';
  setResponseState(phone, {
    picks,
    allPicks: isMore ? [...(prevSession?.allPicks || prevSession?.lastPicks || []), ...picks] : picks,
    offeredIds: isMore ? [...(prevSession?.allOfferedIds || []), ...offeredIds] : offeredIds,
    eventMap,
    neighborhood,
    borough: borough || null,
    dateRange: filters?.date_range || null,
    filters: filters || null,
    visitedHoods: visitedHoods
      ? visitedHoods
      : [...new Set([...(prevSession?.visitedHoods || []), neighborhood || 'citywide'])],
    pendingNearby: pending?.neighborhood || null,
    pendingNearbyEvents: pending?.nearbyEvents || null,
    pendingFilters: pending?.filters || null,
    pendingMessage: pendingMessage || null,
    lastResponseHadPicks: lastResponseHadPicks ?? (picks.length > 0),
  });
}

/**
 * Build a consistent exhaustion message with nearby neighborhood suggestion.
 */
function buildExhaustionMessage(hood, { adjacentHoods = [], visitedHoods = [], filters, borough } = {}) {
  const unvisited = adjacentHoods.filter(n => !visitedHoods.includes(n));
  const suggestion = unvisited[0] || null;
  const label = describeFilters(filters);
  const hasFilter = label !== 'events';
  const what = hasFilter ? `all the ${label}` : 'everything';
  const locationName = hood || (borough ? borough.charAt(0).toUpperCase() + borough.slice(1) : 'this area');
  const message = suggestion
    ? `That's ${what} I've got in ${locationName}! ${suggestion} is right nearby — want ${hasFilter ? label : 'picks'} from there?`
    : `That's ${what} I've got in ${locationName}! Try a different neighborhood for more.`;
  return { message, suggestedHood: suggestion };
}

/**
 * Convert a filter object to a human-readable SMS label.
 * Order: free → subcategory|category → vibe → time suffix.
 * Examples: {category:'comedy', free_only:true} → "free comedy"
 *           {time_after:'22:00'} → "events after 10pm"
 */
function describeFilters(filters) {
  if (!filters || typeof filters !== 'object') return 'events';
  const parts = [];
  if (filters.free_only) parts.push('free');
  if (filters.categories && Array.isArray(filters.categories) && filters.categories.length > 0) {
    parts.push(filters.categories.map(c => c.replace(/_/g, ' ')).join(' or '));
  } else if (filters.subcategory) {
    parts.push(filters.subcategory);
  } else if (filters.category) {
    parts.push(filters.category.replace(/_/g, ' '));
  }
  if (filters.vibe) parts.push(filters.vibe);
  // Need a noun if we only have modifiers (free, time) but no category/vibe
  const hasNoun = filters.subcategory || filters.category || filters.vibe;
  if (!hasNoun) {
    if (parts.length === 0 && !filters.time_after) return 'events';
    parts.push('events');
  }
  if (parts.length === 0) return 'events';
  // Time suffix
  if (filters.time_after && /^\d{2}:\d{2}$/.test(filters.time_after)) {
    const [h, m] = filters.time_after.split(':').map(Number);
    let label;
    if (h === 0 && m === 0) label = 'midnight';
    else if (h === 12 && m === 0) label = 'noon';
    else {
      const hr12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const ampm = h < 12 ? 'am' : 'pm';
      label = m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, '0')}${ampm}`;
    }
    parts.push(`after ${label}`);
  }
  return parts.join(' ');
}

/**
 * Build a deterministic zero-match response when filters match nothing in a neighborhood.
 * Scans adjacent hoods and citywide for matches, suggests alternatives.
 * Returns { message, suggestedHood, source }.
 */
function buildZeroMatchResponse(hood, activeFilters, adjacentHoods) {
  const label = describeFilters(activeFilters);
  // Late require to avoid circular dep (events.js → pipeline.js)
  const { scanCityWide } = require('./events');
  const cityMatches = scanCityWide(activeFilters);

  // Citywide (no neighborhood) — skip adjacent check, just find any match
  if (!hood) {
    const cityMatch = cityMatches[0];
    if (cityMatch) {
      return {
        message: `No ${label} tonight — I've got ${label} in ${cityMatch.neighborhood} though. Want picks from there?`,
        suggestedHood: cityMatch.neighborhood,
        source: 'citywide',
      };
    }
    return {
      message: `No ${label} tonight — tell me a neighborhood and I'll show you what's happening!`,
      suggestedHood: null,
      source: 'none',
    };
  }

  // Check adjacent neighborhoods first
  const adjSet = new Set(adjacentHoods || []);
  const adjacentMatch = cityMatches.find(m => adjSet.has(m.neighborhood));
  if (adjacentMatch) {
    return {
      message: `No ${label} in ${hood} tonight — but ${adjacentMatch.neighborhood} has some. Want picks from there?`,
      suggestedHood: adjacentMatch.neighborhood,
      source: 'adjacent',
    };
  }
  // Citywide match (not adjacent)
  const cityMatch = cityMatches.find(m => m.neighborhood !== hood);
  if (cityMatch) {
    return {
      message: `No ${label} in ${hood} tonight — I've got ${label} in ${cityMatch.neighborhood} though. Want picks from there?`,
      suggestedHood: cityMatch.neighborhood,
      source: 'citywide',
    };
  }
  // Nothing anywhere
  return {
    message: `No ${label} anywhere tonight — want me to just show you what's in ${hood}?`,
    suggestedHood: null,
    source: 'none',
  };
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
  const result = {
    free_only: 'free_only' in next ? (next.free_only || false) : (base.free_only || false),
    category: 'category' in next ? (next.category || null) : (base.category || null),
    subcategory: 'subcategory' in next ? (next.subcategory || null) : (base.subcategory || null),
    vibe: 'vibe' in next ? (next.vibe || null) : (base.vibe || null),
    time_after: 'time_after' in next ? (next.time_after || null) : (base.time_after || null),
    date_range: 'date_range' in next ? (next.date_range || null) : (base.date_range || null),
  };
  // Multi-category array (agent brain only): categories takes precedence over category
  if ('categories' in next) {
    result.categories = next.categories?.length > 0 ? next.categories : null;
    if (result.categories) result.category = null; // categories replaces category
  } else if ('categories' in base && !('category' in next)) {
    result.categories = base.categories?.length > 0 ? base.categories : null;
  }
  return result;
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
  // Multi-category (OR match): event matches if its category is in the array
  if (filters.categories && Array.isArray(filters.categories) && filters.categories.length > 0) {
    if (!filters.categories.includes(event.category)) return false;
  } else if (filters.category && event.category !== filters.category) {
    return false;
  }
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
  const pool = [...hardSlice, ...softSlice];

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
  films: 'film', movie: 'film', movies: 'film', cinema: 'film',
  karaoke: 'community', drag: 'community',
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
    // Reject unknown categories (P1: only valid categories reach session state)
    if (!VALID_CATEGORIES.has(result.category)) {
      console.warn(`normalizeFilters: rejected invalid category "${result.category}"`);
      delete result.category;
      delete result.subcategory;
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
 * Normalize LLM filter_intent.updates into a format suitable for mergeFilters.
 * Validates keys against known filter fields, maps subcategories → categories.
 * Returns an object with explicit-key semantics (present keys override, absent fall back).
 */
function normalizeFilterIntent(updates) {
  if (!updates || typeof updates !== 'object') return {};
  const result = {};

  // Category: normalize subcategories (jazz → live_music + subcategory)
  if ('category' in updates) {
    if (updates.category === null || updates.category === '') {
      result.category = null;
      result.subcategory = null;
    } else {
      const key = String(updates.category).toLowerCase().trim();
      const canonical = CATEGORY_NORMALIZE[key] || key;
      result.category = canonical;
      if (CATEGORY_NORMALIZE[key] && key !== canonical) {
        result.subcategory = key;
      } else {
        result.subcategory = null;
      }
      // Reject unknown categories (P1: only valid categories reach session state)
      if (!VALID_CATEGORIES.has(result.category)) {
        console.warn(`normalizeFilterIntent: rejected invalid category "${result.category}"`);
        delete result.category;
        delete result.subcategory;
      }
    }
  }

  // Free: coerce to boolean
  if ('free_only' in updates) {
    result.free_only = updates.free_only === null ? false : Boolean(updates.free_only);
  }

  // Time: validate HH:MM format
  if ('time_after' in updates) {
    if (updates.time_after === null) {
      result.time_after = null;
    } else {
      const ta = String(updates.time_after).trim();
      result.time_after = /^\d{2}:\d{2}$/.test(ta) ? ta : null;
    }
  }

  // Vibe: passthrough
  if ('vibe' in updates) {
    result.vibe = updates.vibe || null;
  }

  return result;
}

/**
 * Execute a unified LLM query: call unifiedRespond with events and options,
 * return the parsed result. Thin wrapper that both the unified branch
 * and handleMore can call.
 *
 * Returns { type, sms_text, picks, clear_filters, _raw, _usage, _provider }
 */
async function executeQuery(message, events, options = {}) {
  // Late require to avoid circular dep (ai.js → prompts.js → ... → pipeline.js)
  const { unifiedRespond } = require('./ai');

  const result = await unifiedRespond(message, {
    session: options.session,
    events,
    neighborhood: options.neighborhood,
    nearbyHoods: options.nearbyHoods,
    conversationHistory: options.conversationHistory,
    currentTime: options.currentTime,
    validNeighborhoods: options.validNeighborhoods,
    activeFilters: options.activeFilters,
    isSparse: options.isSparse,
    isCitywide: options.isCitywide,
    isBorough: options.isBorough,
    borough: options.borough,
    matchCount: options.matchCount,
    hardCount: options.hardCount,
    softCount: options.softCount,
    excludeIds: options.excludeIds,
    suggestedNeighborhood: options.suggestedNeighborhood,
    userHoodAlias: options.userHoodAlias,
    isLastBatch: options.isLastBatch,
    exhaustionSuggestion: options.exhaustionSuggestion,
    model: options.model,
  });

  return result;
}

module.exports = { applyFilters, resolveActiveFilters, buildEventMap, saveResponseFrame, buildExhaustionMessage, describeFilters, buildZeroMatchResponse, mergeFilters, eventMatchesFilters, buildTaggedPool, normalizeFilters, normalizeFilterIntent, failsTimeGate, executeQuery };
