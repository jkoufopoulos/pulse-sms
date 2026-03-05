/**
 * brain-execute.js — Tool execution, pool building, and event handling for the agent brain.
 */

const { extractNeighborhood, BOROUGHS, detectBorough } = require('./neighborhoods');
const { getAdjacentNeighborhoods, getNycDateString, filterByTimeAfter } = require('./geo');
const { getEvents, getEventsForBorough, getEventsCitywide, getCacheStatus } = require('./events');
const { filterKidsEvents } = require('./curation');
const { buildTaggedPool, buildEventMap, saveResponseFrame, mergeFilters, buildZeroMatchResponse, describeFilters } = require('./pipeline');
const { recordAICost } = require('./traces');
const { setSession } = require('./session');
const { trackAICost } = require('./request-guard');
const { updateProfile } = require('./preference-profile');
const { smartTruncate } = require('./formatters');
const { brainCompose, welcomeCompose } = require('./brain-llm');

// --- Date range resolution ---

function resolveDateRange(value) {
  if (!value) return null;
  const todayNyc = getNycDateString(0);

  switch (value) {
    case 'today':
      return { start: todayNyc, end: todayNyc };
    case 'tomorrow': {
      const tmrw = getNycDateString(1);
      return { start: tmrw, end: tmrw };
    }
    case 'this_weekend': {
      // Find next Saturday
      const now = new Date();
      const nycDay = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
        .format(now).slice(0, 3) === 'Sat' ? 0 :
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
          .format(now).slice(0, 3) === 'Sun' ? 0 : -1);
      // Simpler: use day-of-week offset
      const dayParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(now);
      const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const currentDay = dayMap[dayParts] ?? 0;
      // If it's already Saturday or Sunday, weekend starts today
      if (currentDay === 6) {
        return { start: todayNyc, end: getNycDateString(1) };
      }
      if (currentDay === 0) {
        return { start: todayNyc, end: todayNyc };
      }
      // Friday — include today through Sunday
      if (currentDay === 5) {
        return { start: todayNyc, end: getNycDateString(2) };
      }
      const daysToSat = 6 - currentDay;
      return { start: getNycDateString(daysToSat), end: getNycDateString(daysToSat + 1) };
    }
    case 'this_week': {
      // Today through Sunday
      const dayParts2 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date());
      const dayMap2 = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const currentDay2 = dayMap2[dayParts2] ?? 0;
      const daysToSunday = currentDay2 === 0 ? 0 : 7 - currentDay2;
      return { start: todayNyc, end: getNycDateString(daysToSunday) };
    }
    case 'next_week': {
      const dayParts3 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date());
      const dayMap3 = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const currentDay3 = dayMap3[dayParts3] ?? 0;
      const daysToNextMon = currentDay3 === 0 ? 1 : 8 - currentDay3;
      return { start: getNycDateString(daysToNextMon), end: getNycDateString(daysToNextMon + 6) };
    }
    default:
      return null;
  }
}

/**
 * Pure function: compute "more" pool from session state.
 * No side effects — no SMS sending, no session saves.
 */
function executeMore(session) {
  if (!session || !session.lastPicks || !session.lastEvents) {
    return { noContext: true };
  }

  const allOfferedIds = new Set(session.allOfferedIds || []);
  const allPickIds = new Set((session.allPicks || session.lastPicks || []).map(p => p.event_id));
  const allShownIds = new Set([...allOfferedIds, ...allPickIds]);
  const hood = session.lastNeighborhood;
  const activeFilters = session.lastFilters || {};

  // Filter out already-shown events
  const allRemaining = Object.values(session.lastEvents).filter(e => !allShownIds.has(e.id));

  // Filter by neighborhood/borough/citywide
  const boroughHoods = session.lastBorough ? new Set(BOROUGHS[session.lastBorough] || []) : null;
  const inHoodRemaining = hood
    ? allRemaining.filter(e => e.neighborhood === hood)
    : boroughHoods
      ? allRemaining.filter(e => boroughHoods.has(e.neighborhood))
      : allRemaining;

  // Hard time gate: exclude events before time_after
  const timeGated = activeFilters.time_after
    ? filterByTimeAfter(inHoodRemaining, activeFilters.time_after)
    : inHoodRemaining;

  // Name dedup: exclude events whose name matches any previously shown event
  const offeredNames = new Set(
    [...allShownIds].map(id => session.lastEvents[id]?.name?.toLowerCase()).filter(Boolean)
  );
  const nameDeduped = timeGated.filter(e => !offeredNames.has(e.name?.toLowerCase()));
  const dedupedPool = nameDeduped.length > 0 ? nameDeduped : timeGated;

  // Adjacent hood suggestions
  const adjacentHoods = hood ? getAdjacentNeighborhoods(hood, 3) : [];
  const suggestions = adjacentHoods.filter(h => !(session.visitedHoods || []).includes(h));

  if (dedupedPool.length === 0) {
    return {
      events: [],
      exhausted: true,
      suggestions,
      neighborhood: hood,
      allShownIds: [...allShownIds],
    };
  }

  const batch = dedupedPool.slice(0, 8);
  const isLastBatch = dedupedPool.length <= 8;

  return {
    events: batch,
    exhausted: false,
    isLastBatch,
    suggestions,
    neighborhood: hood,
    allShownIds: [...allShownIds],
    borough: session.lastBorough,
    activeFilters,
  };
}

/**
 * Execute "details" intent: match pick_reference against lastPicks.
 * Pure function — no SMS sending, no session saves.
 * Returns: { found, event, pick, pickIndex } or { noPicks } or { stalePicks } or { found: false }
 */
function executeDetails(pickReference, session) {
  if (!session?.lastPicks?.length || !session?.lastEvents) {
    return { noPicks: true, found: false };
  }

  // Guard: if last response didn't have picks, user is referencing stale list
  if (session.lastResponseHadPicks === false) {
    return { stalePicks: true, found: false, neighborhood: session.lastNeighborhood };
  }

  const picks = session.lastPicks;
  const events = session.lastEvents;
  const ref = (pickReference || '').toString().trim().toLowerCase();

  // 1. Try numeric match
  const num = parseInt(ref, 10);
  if (!isNaN(num) && num >= 1 && num <= picks.length) {
    const pick = picks[num - 1];
    const event = events[pick.event_id];
    if (event) return { found: true, event, pick, pickIndex: num };
  }

  // 2. Try event name match (substring)
  for (let i = 0; i < picks.length; i++) {
    const event = events[picks[i].event_id];
    if (event?.name && event.name.toLowerCase().includes(ref)) {
      return { found: true, event, pick: picks[i], pickIndex: i + 1 };
    }
  }

  // 3. Try venue name match (substring)
  for (let i = 0; i < picks.length; i++) {
    const event = events[picks[i].event_id];
    if (event?.venue_name && event.venue_name.toLowerCase().includes(ref)) {
      return { found: true, event, pick: picks[i], pickIndex: i + 1 };
    }
  }

  // 4. Try category match ("the comedy one")
  const categoryWords = ['comedy', 'jazz', 'music', 'trivia', 'film', 'theater', 'art', 'dance', 'dj', 'nightlife'];
  for (const word of categoryWords) {
    if (ref.includes(word)) {
      for (let i = 0; i < picks.length; i++) {
        const event = events[picks[i].event_id];
        if (event?.category?.toLowerCase().includes(word)) {
          return { found: true, event, pick: picks[i], pickIndex: i + 1 };
        }
      }
    }
  }

  return { found: false };
}

/**
 * Validate picks against event pool with name-match fallback.
 * Unlike strict ID filtering, this recovers picks where the LLM returned a
 * wrong ID but the event name matches one in the pool (common with near-duplicate events).
 */
function validatePicks(picks, events) {
  if (!picks || picks.length === 0 || !events || events.length === 0) return [];
  const idMap = new Map(events.map(e => [e.id, e]));
  const nameMap = new Map();
  for (const e of events) {
    const key = (e.name || '').toLowerCase().trim();
    if (key && !nameMap.has(key)) nameMap.set(key, e);
  }
  const usedIds = new Set();
  return picks.map(p => {
    if (!p) return null;
    // 1. Exact ID match
    if (p.event_id && idMap.has(p.event_id) && !usedIds.has(p.event_id)) {
      usedIds.add(p.event_id);
      return p;
    }
    // 2. Name match — check if pick's event_id looks like a name, or use event name from SMS context
    const pickName = (p.event_name || p.event_id || '').toLowerCase().trim();
    if (pickName) {
      // Exact name match
      const byName = nameMap.get(pickName);
      if (byName && !usedIds.has(byName.id)) {
        usedIds.add(byName.id);
        return { ...p, event_id: byName.id };
      }
      // Substring match — pick name contained in event name or vice versa
      for (const [name, evt] of nameMap) {
        if (usedIds.has(evt.id)) continue;
        if ((name.includes(pickName) || pickName.includes(name)) && name.length >= 3) {
          usedIds.add(evt.id);
          return { ...p, event_id: evt.id };
        }
      }
    }
    return null;
  }).filter(Boolean);
}

// --- Pool building: search_events steps 1-6 ---

/**
 * Build the event pool for a search_events call.
 * Steps 1-6: resolve neighborhood, build filters, fetch events, build tagged pool, handle zero match.
 * Does NOT compose — returns pool + metadata for the caller to compose.
 */
async function buildSearchPool(params, session, phone, trace) {
  // 1. Resolve neighborhood from brain params or session
  let hood = null;
  let borough = null;
  let isBorough = false;
  let isCitywide = false;

  if (params.neighborhood) {
    // Try to resolve as neighborhood first
    hood = extractNeighborhood(params.neighborhood);
    if (!hood) {
      // Try as borough
      const boroughResult = detectBorough(params.neighborhood);
      if (boroughResult) {
        isBorough = true;
        borough = boroughResult.borough;
      }
    }
  }

  // Fall back to session neighborhood if brain didn't specify one
  if (!hood && !borough && !isCitywide) {
    if (params.intent === 'new_search' && !params.neighborhood) {
      // New search with no neighborhood — citywide
      isCitywide = true;
    } else {
      hood = session?.lastNeighborhood || null;
      if (!hood) {
        const lastBorough = session?.lastBorough;
        if (lastBorough) {
          isBorough = true;
          borough = lastBorough;
        } else {
          isCitywide = true;
        }
      }
    }
  }

  // 2. Build filters from tool params
  const toolFilters = {};
  if (params.categories && Array.isArray(params.categories) && params.categories.length > 0) {
    // Multi-category: store as array for OR matching in buildTaggedPool
    toolFilters.categories = params.categories;
  } else if (params.category) {
    toolFilters.category = params.category;
  }
  if (params.free_only) toolFilters.free_only = true;
  if (params.time_after && /^\d{2}:\d{2}$/.test(params.time_after)) toolFilters.time_after = params.time_after;
  if (params.date_range) toolFilters.date_range = resolveDateRange(params.date_range);

  // 3. Merge or replace based on intent
  let activeFilters;
  if (params.intent === 'pivot' || params.intent === 'new_search') {
    activeFilters = toolFilters;
  } else {
    // refine — compound with existing
    activeFilters = mergeFilters(session?.lastFilters, toolFilters);
  }

  // 4. Fetch events
  let events = [];
  let curated = [];
  const eventsStart = Date.now();

  if (hood) {
    const raw = await getEvents(hood, { dateRange: activeFilters.date_range });
    curated = filterKidsEvents(raw);
  } else if (isBorough && borough) {
    const raw = await getEventsForBorough(borough, { dateRange: activeFilters.date_range, filters: activeFilters });
    curated = filterKidsEvents(raw);
  } else {
    isCitywide = true;
    const raw = await getEventsCitywide({ dateRange: activeFilters.date_range, filters: activeFilters });
    curated = filterKidsEvents(raw);
  }

  trace.events.getEvents_ms = Date.now() - eventsStart;
  trace.events.cache_size = getCacheStatus().cache_size;
  trace.events.candidates_count = curated.length;
  trace.events.candidate_ids = curated.map(e => e.id);

  // 5. Build tagged pool
  const taggedResult = buildTaggedPool(curated, activeFilters, { citywide: isCitywide || isBorough });
  events = taggedResult.pool;
  const { matchCount, hardCount, softCount, isSparse } = taggedResult;

  trace.events.sent_to_claude = events.length;
  trace.events.sent_ids = events.map(e => e.id);
  trace.events.sent_pool = events.map(e => ({
    id: e.id, name: e.name, venue_name: e.venue_name, neighborhood: e.neighborhood,
    category: e.category, start_time_local: e.start_time_local, date_local: e.date_local,
    is_free: e.is_free, price_display: e.price_display, source_name: e.source_name,
    filter_match: e.filter_match, ticket_url: e.ticket_url || null,
    source_vibe: e.source_vibe || null,
  }));
  trace.events.pool_meta = { matchCount, hardCount, softCount, isSparse };

  // 6. Zero match → deterministic response
  const nearbyHoods = hood ? getAdjacentNeighborhoods(hood, 3) : [];
  if (matchCount === 0 && Object.values(activeFilters).some(Boolean)) {
    const zeroResp = buildZeroMatchResponse(hood, activeFilters, nearbyHoods);
    trace.composition.latency_ms = 0;
    trace.composition.zero_match_bypass = true;
    trace.composition.zero_match_source = zeroResp.source;
    trace.composition.active_filters = activeFilters;
    trace.composition.neighborhood_used = hood;

    const eventMap = buildEventMap(curated);
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: Object.keys(eventMap).length > 0 ? eventMap : (session?.lastEvents || {}),
      neighborhood: hood,
      borough,
      filters: Object.values(activeFilters).some(Boolean) ? activeFilters : null,
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      pending: zeroResp.suggestedHood ? { neighborhood: zeroResp.suggestedHood, filters: activeFilters } : null,
      lastResponseHadPicks: false,
    });
    setSession(phone, { lastZeroMatch: true });

    return {
      zeroMatch: { sms: zeroResp.message, intent: 'events', picks: [], activeFilters },
    };
  }

  // Compute excludeIds and suggestedHood for compose
  const prevPickIds = (session?.allPicks || session?.lastPicks || []).map(p => p.event_id);
  const prevOfferedIds = session?.allOfferedIds || [];
  const excludeIds = [...new Set([...prevPickIds, ...prevOfferedIds])];
  const suggestedHood = (isSparse || matchCount === 0) && nearbyHoods.length > 0 ? nearbyHoods[0] : null;

  return {
    zeroMatch: null,
    pool: events,
    curated,
    activeFilters,
    hood, borough, isBorough, isCitywide,
    matchCount, hardCount, softCount, isSparse,
    nearbyHoods,
    suggestedHood,
    excludeIds,
  };
}

// --- Tool execution: search_events ---

async function executeSearchEvents(params, session, phone, trace) {
  const poolResult = await buildSearchPool(params, session, phone, trace);

  // Zero match → return immediately
  if (poolResult.zeroMatch) return poolResult.zeroMatch;

  // Compose SMS from pool via lightweight brain compose
  const composeStart = Date.now();
  const result = await brainCompose(poolResult.pool, {
    neighborhood: poolResult.hood,
    nearbyHoods: poolResult.nearbyHoods,
    activeFilters: poolResult.activeFilters,
    isSparse: poolResult.isSparse,
    isCitywide: poolResult.isCitywide,
    isBorough: poolResult.isBorough,
    borough: poolResult.borough,
    matchCount: poolResult.matchCount,
    excludeIds: poolResult.excludeIds,
    suggestedNeighborhood: poolResult.suggestedHood,
  });
  trace.composition.latency_ms = Date.now() - composeStart;
  trace.composition.raw_response = result._raw || null;
  trace.composition.active_filters = poolResult.activeFilters;
  trace.composition.neighborhood_used = poolResult.hood;

  recordAICost(trace, 'compose', result._usage, result._provider);
  trackAICost(phone, result._usage, result._provider);

  // Validate picks with name-match fallback for near-duplicate events
  const eventMap = buildEventMap(poolResult.curated);
  for (const e of poolResult.pool) eventMap[e.id] = e;
  const allEvents = [...poolResult.curated, ...poolResult.pool.filter(e => !eventMap[e.id] || eventMap[e.id] === e)];
  const validPicks = validatePicks(result.picks, allEvents);

  trace.composition.picks = validPicks.map(p => {
    const evt = eventMap[p.event_id];
    return {
      ...p,
      date_local: evt?.date_local || null,
      event_name: evt?.name || null,
      venue_name: evt?.venue_name || null,
      neighborhood: evt?.neighborhood || null,
      category: evt?.category || null,
      is_free: evt?.is_free ?? null,
      price_display: evt?.price_display || null,
      start_time_local: evt?.start_time_local || null,
      source_vibe: evt?.source_vibe || null,
    };
  });

  // Save session — tool params become the state (P1: code owns state)
  saveResponseFrame(phone, {
    picks: validPicks,
    eventMap,
    neighborhood: poolResult.hood,
    borough: poolResult.borough,
    filters: poolResult.activeFilters,
    offeredIds: validPicks.map(p => p.event_id),
    visitedHoods: [...new Set([...(session?.visitedHoods || []), poolResult.hood || poolResult.borough || 'citywide'])],
    pending: poolResult.suggestedHood ? { neighborhood: poolResult.suggestedHood, filters: poolResult.activeFilters } : null,
  });

  updateProfile(phone, { neighborhood: poolResult.hood, filters: poolResult.activeFilters, responseType: 'event_picks' })
    .catch(err => console.error('profile update failed:', err.message));

  return {
    sms: result.sms_text,
    intent: validPicks.length > 0 ? 'events' : 'conversational',
    picks: validPicks,
    activeFilters: poolResult.activeFilters,
    eventMap,
  };
}

// --- Tool execution: respond ---

async function executeRespond(params, session, phone, trace) {
  const sms = smartTruncate(params.message || "Hey! Tell me a neighborhood or what you're in the mood for.");

  // Preserve existing session state
  saveResponseFrame(phone, {
    picks: session?.lastPicks || [],
    eventMap: session?.lastEvents || {},
    neighborhood: session?.lastNeighborhood || null,
    borough: session?.lastBorough || null,
    filters: session?.lastFilters || null,
    offeredIds: session?.allOfferedIds || [],
    visitedHoods: session?.visitedHoods || [],
    lastResponseHadPicks: false,
  });

  // Map brain intents to valid system intents (greeting/thanks/farewell/etc → conversational)
  return { sms, intent: 'conversational' };
}

/**
 * Handle first-message welcome flow: fetch interestingness-ranked events,
 * compose welcome+picks, save session, send SMS.
 */
async function handleWelcome(phone, session, trace) {
  const { getTopPicks } = require('./events');

  const eventsStart = Date.now();
  const topEvents = await getTopPicks(10);
  trace.events.getEvents_ms = Date.now() - eventsStart;
  trace.events.candidates_count = topEvents.length;
  trace.events.candidate_ids = topEvents.map(e => e.id);
  trace.events.sent_to_claude = topEvents.length;
  trace.events.sent_ids = topEvents.map(e => e.id);
  trace.events.sent_pool = topEvents.map(e => ({
    id: e.id, name: e.name, venue_name: e.venue_name, neighborhood: e.neighborhood,
    category: e.category, start_time_local: e.start_time_local, date_local: e.date_local,
    is_free: e.is_free, price_display: e.price_display, source_name: e.source_name,
    source_vibe: e.source_vibe || null, interestingness: e.interestingness,
  }));

  if (topEvents.length === 0) {
    const sms = "Hey! I'm Pulse \u2014 I find the stuff in NYC you won't find on Instagram. Tell me a neighborhood, a vibe, or what you're in the mood for tonight.";
    saveResponseFrame(phone, { picks: [], eventMap: {}, neighborhood: null, filters: null, offeredIds: [] });
    return { sms, intent: 'conversational', picks: [], activeFilters: {}, eventMap: {} };
  }

  const composeStart = Date.now();
  const result = await welcomeCompose(topEvents);
  trace.composition.latency_ms = Date.now() - composeStart;
  trace.composition.raw_response = result._raw || null;
  trace.composition.active_filters = {};
  trace.composition.neighborhood_used = 'citywide';

  recordAICost(trace, 'compose', result._usage, result._provider);
  trackAICost(phone, result._usage, result._provider);

  const eventMap = {};
  for (const e of topEvents) eventMap[e.id] = e;
  const validPicks = validatePicks(result.picks, topEvents);

  trace.composition.picks = validPicks.map(p => {
    const evt = eventMap[p.event_id];
    return {
      ...p, date_local: evt?.date_local || null, event_name: evt?.name || null,
      venue_name: evt?.venue_name || null, neighborhood: evt?.neighborhood || null,
      category: evt?.category || null, is_free: evt?.is_free ?? null,
      price_display: evt?.price_display || null, start_time_local: evt?.start_time_local || null,
      source_vibe: evt?.source_vibe || null,
    };
  });

  saveResponseFrame(phone, {
    picks: validPicks,
    eventMap,
    neighborhood: null,
    filters: null,
    offeredIds: validPicks.map(p => p.event_id),
    visitedHoods: ['citywide'],
  });

  return { sms: result.sms_text, intent: 'events', picks: validPicks, activeFilters: {}, eventMap };
}

module.exports = {
  resolveDateRange, executeMore, executeDetails, validatePicks,
  buildSearchPool, executeSearchEvents, executeRespond, handleWelcome,
};
