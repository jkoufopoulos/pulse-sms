/**
 * brain-execute.js — Tool execution, pool building, and event handling for the agent brain.
 */

const { extractNeighborhood, BOROUGHS, detectBorough } = require('./neighborhoods');
const { getAdjacentNeighborhoods, getNycDateString, filterByTimeAfter, filterUpcomingEvents } = require('./geo');
const { getEvents, getEventsForBorough, getEventsCitywide, getCacheStatus, scoreInterestingness, scoreSurprise, selectDiversePicks } = require('./events');
const { filterKidsEvents } = require('./curation');
const { buildTaggedPool, buildEventMap, saveResponseFrame, mergeFilters, buildZeroMatchResponse, describeFilters, failsTimeGate, eventMatchesFilters } = require('./pipeline');
const { setSession } = require('./session');

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

  // Drop events that already started 2+ hours ago
  curated = filterUpcomingEvents(curated);

  trace.events.getEvents_ms = Date.now() - eventsStart;
  trace.events.cache_size = getCacheStatus().cache_size;
  trace.events.candidates_count = curated.length;
  trace.events.candidate_ids = curated.map(e => e.id);

  // 5. Build tagged pool
  const taggedResult = buildTaggedPool(curated, activeFilters, { citywide: isCitywide || isBorough });
  const { matchCount, hardCount, softCount, isSparse } = taggedResult;

  // 5b. Score and trim pool to top N for the model
  const { getProfile } = require('./preference-profile');
  const userProfile = getProfile(phone);
  const { curatedPool: trimmedPool, fullScoredPool } = curatePool(taggedResult.pool, hood, { userProfile });
  events = trimmedPool;

  trace.events.sent_to_claude = events.length;
  trace.events.sent_ids = events.map(e => e.id);
  trace.events.sent_pool = events.map(e => ({
    id: e.id, name: e.name, venue_name: e.venue_name, neighborhood: e.neighborhood,
    category: e.category, start_time_local: e.start_time_local, date_local: e.date_local,
    is_free: e.is_free, price_display: e.price_display, source_name: e.source_name,
    filter_match: e.filter_match, ticket_url: e.ticket_url || null,
    source_vibe: e.source_vibe || null,
    editorial_signal: e.editorial_signal || false,
    scarcity: e.scarcity || null,
    interestingness: scoreInterestingness(e),
  }));
  trace.events.pool_meta = { matchCount, hardCount, softCount, isSparse };
  trace.events.full_scored_count = fullScoredPool.length;

  // Track why events were excluded from the pool
  const poolIds = new Set(events.map(e => e.id));
  const exclusions = {
    total_candidates: curated.length,
    sent_to_llm: events.length,
    excluded_count: curated.length - events.length,
    by_reason: {},
  };

  if (activeFilters.time_after) {
    const timeExcluded = curated.filter(e => !poolIds.has(e.id) && failsTimeGate(e, activeFilters.time_after));
    if (timeExcluded.length > 0) exclusions.by_reason.time_gate = timeExcluded.length;
  }
  if (activeFilters.category || (activeFilters.categories && activeFilters.categories.length > 0)) {
    const catMissed = curated.filter(e => !poolIds.has(e.id) && eventMatchesFilters(e, activeFilters) === false);
    if (catMissed.length > 0) exclusions.by_reason.category_mismatch = catMissed.length;
  }
  const accountedFor = Object.values(exclusions.by_reason).reduce((a, b) => a + b, 0);
  const poolCap = exclusions.excluded_count - accountedFor;
  if (poolCap > 0) exclusions.by_reason.pool_cap = poolCap;

  trace.events.exclusions = exclusions;

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

  // Remove previously-shown events from the pool so model never recycles picks
  const prevPickIds = (session?.allPicks || session?.lastPicks || []).map(p => p.event_id);
  const prevOfferedIds = session?.allOfferedIds || [];
  const excludeIds = [...new Set([...prevPickIds, ...prevOfferedIds])];
  const excludeSet = new Set(excludeIds);
  events = events.filter(e => !excludeSet.has(e.id));
  const suggestedHood = (isSparse || matchCount === 0) && nearbyHoods.length > 0 ? nearbyHoods[0] : null;

  // 7. Compute nearby highlight from full scored pool
  const reqPoolEvents = fullScoredPool.filter(e => e.neighborhood === hood);
  const nearbyPoolEvents = fullScoredPool.filter(e => e.neighborhood !== hood);
  const nearbyHighlight = hood ? computeNearbyHighlight(reqPoolEvents, nearbyPoolEvents, hood) : null;
  if (nearbyHighlight) console.log(`[nearby-highlight] ${hood} → ${nearbyHighlight.hood}: ${nearbyHighlight.reason}`);
  trace.events.nearby_highlight = nearbyHighlight || null;

  return {
    zeroMatch: null,
    pool: events,
    fullScoredPool,
    curated,
    activeFilters,
    hood, borough, isBorough, isCitywide,
    matchCount, hardCount, softCount, isSparse,
    nearbyHoods,
    suggestedHood,
    excludeIds,
    nearbyHighlight,
  };
}

// --- Welcome experience helpers (deterministic, $0) ---

const { parseAsNycTime } = require('./geo');
const { smartTruncate } = require('./formatters');

const WELCOME_EMOJI = {
  comedy: '\u{1F3AD}', theater: '\u{1F3AD}',
  live_music: '\u{1F3B5}', nightlife: '\u{1F3B5}',
  art: '\u{1F3A8}', film: '\u{1F3AC}',
  community: '\u{1F389}', food_drink: '\u{1F389}',
};

/**
 * Format a compact time label for welcome picks.
 * Today -> "tonight" or "today Xpm". Tomorrow -> "tomorrow Xpm". Further -> "Sat Xpm".
 */
function welcomeTimeLabel(event) {
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);
  const eventDate = event.date_local || null;

  let timeStr = '';
  if (event.start_time_local) {
    const ms = parseAsNycTime(event.start_time_local);
    if (!isNaN(ms)) {
      const d = new Date(ms);
      timeStr = d.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: '2-digit',
      }).replace(':00', '').toLowerCase();
    }
  }

  if (eventDate === todayNyc) {
    if (!timeStr) return 'tonight';
    const hour = event.start_time_local ? new Date(parseAsNycTime(event.start_time_local)).getHours() : 18;
    return hour >= 18 ? `tonight ${timeStr}` : `today ${timeStr}`;
  }
  if (eventDate === tomorrowNyc) {
    return timeStr ? `tomorrow ${timeStr}` : 'tomorrow';
  }
  if (eventDate) {
    const dayName = new Date(eventDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    return timeStr ? `${dayName} ${timeStr}` : dayName;
  }
  return timeStr || 'tonight';
}

/**
 * Format a single welcome pick line: emoji Name — Venue (Hood), time, price
 */
function formatWelcomePick(event, rank) {
  const emoji = WELCOME_EMOJI[event.category] || '\u2728';
  const venue = event.venue_name || '';
  const hood = event.neighborhood ? ` (${event.neighborhood})` : '';
  const time = welcomeTimeLabel(event);
  const price = event.is_free ? 'free' : (event.price_display || '');
  const priceStr = price ? `, ${price}` : '';
  return `${rank}) ${emoji} ${event.name} \u2014 ${venue}${hood}, ${time}${priceStr}`;
}

/**
 * Execute the show_welcome tool: fetch top picks for model to compose.
 * Returns { topEvents, picks, eventMap }. Model composes the SMS.
 */
async function executeWelcome() {
  const { getTopPicks } = require('./events');
  const topEvents = await getTopPicks(5);

  const eventMap = {};
  for (const e of topEvents) eventMap[e.id] = e;

  const picks = topEvents.slice(0, 3).map((e, i) => ({
    rank: i + 1,
    event_id: e.id,
    why: `interestingness: ${e.interestingness}, ${e.source_vibe || 'unknown'} source`,
  }));

  return { topEvents, picks, eventMap };
}

// --- Pool curation: score and trim to top N ---

/**
 * Compare interestingness of requested hood vs nearby hoods.
 * Returns a highlight object if a nearby hood is notably stronger, null otherwise.
 */
function computeNearbyHighlight(requestedEvents, nearbyEvents, requestedHood) {
  if (!nearbyEvents || nearbyEvents.length === 0) return null;

  const reqScores = requestedEvents
    .filter(e => e.neighborhood === requestedHood)
    .map(e => e.interestingness || 0)
    .sort((a, b) => b - a)
    .slice(0, 3);
  const reqAvg = reqScores.length > 0 ? reqScores.reduce((a, b) => a + b, 0) / reqScores.length : 0;

  const byHood = {};
  for (const e of nearbyEvents) {
    if (e.neighborhood === requestedHood) continue;
    if (!byHood[e.neighborhood]) byHood[e.neighborhood] = [];
    byHood[e.neighborhood].push(e);
  }

  let bestHood = null;
  let bestAvg = 0;
  let bestEvents = [];
  for (const [hood, events] of Object.entries(byHood)) {
    const scores = events.map(e => e.interestingness || 0).sort((a, b) => b - a).slice(0, 3);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestHood = hood;
      bestEvents = events.sort((a, b) => (b.interestingness || 0) - (a.interestingness || 0));
    }
  }

  if (!bestHood || bestAvg < reqAvg * 1.3 || bestAvg - reqAvg < 2) return null;

  const topPick = bestEvents[0];
  const scarcityCount = bestEvents.filter(e => e.scarcity).length;
  const editorialCount = bestEvents.filter(e => e.editorial_signal).length;

  const reasons = [];
  if (scarcityCount > 0) reasons.push(`${scarcityCount} one-night-only event${scarcityCount > 1 ? 's' : ''}`);
  if (editorialCount > 0) reasons.push(`${editorialCount} editor's pick${editorialCount > 1 ? 's' : ''}`);
  if (reasons.length === 0) reasons.push('stronger lineup tonight');

  return {
    hood: bestHood,
    reason: reasons.join(', '),
    top_pick: `${topPick.name} at ${topPick.venue_name}`,
  };
}

const DEFAULT_POOL_SIZE = 8;

/**
 * Score every event by interestingness, then select top N with category diversity.
 * Requested-hood events are prioritized; nearby events pad remaining slots.
 * Returns { curatedPool, fullScoredPool }.
 */
function curatePool(pool, requestedHood, { poolSize = DEFAULT_POOL_SIZE, userProfile = null } = {}) {
  if (!pool || pool.length === 0) {
    return { curatedPool: [], fullScoredPool: [] };
  }

  // 1. Score every event
  const fullScoredPool = pool.map(e => ({
    ...e,
    interestingness: scoreInterestingness(e),
  }));

  // 2. Split into requested hood vs nearby
  const hoodEvents = fullScoredPool.filter(e => e.neighborhood === requestedHood);
  const nearbyEvents = fullScoredPool.filter(e => e.neighborhood !== requestedHood);

  // 3. Pick top N from requested hood with category diversity
  const hoodPicks = selectDiversePicks(hoodEvents, poolSize);

  // 4. If hood doesn't fill poolSize, pad with best nearby sorted by interestingness
  let curatedPool;
  if (hoodPicks.length >= poolSize) {
    curatedPool = hoodPicks.slice(0, poolSize);
  } else {
    const nearbySorted = [...nearbyEvents].sort((a, b) => b.interestingness - a.interestingness);
    const remaining = poolSize - hoodPicks.length;
    curatedPool = [...hoodPicks, ...nearbySorted.slice(0, remaining)];
  }

  // 5. Serendipity slot: swap last pick for highest-surprise event if available
  if (curatedPool.length >= 3) {
    const pickedIds = new Set(curatedPool.map(e => e.id));
    const pickedCategories = new Set(curatedPool.map(e => e.category));

    // Find best serendipity candidate from the full pool (not already picked)
    let bestSurprise = null;
    let bestSerendipityScore = 0;

    for (const e of fullScoredPool) {
      if (pickedIds.has(e.id)) continue;
      const surprise = scoreSurprise(e, userProfile);
      if (surprise < 4) continue; // minimum surprise threshold
      const serendipityScore = e.interestingness * surprise;
      // Prefer events from a category not already in picks
      const categoryBonus = !pickedCategories.has(e.category) ? 1.5 : 1;
      const adjusted = serendipityScore * categoryBonus;
      if (adjusted > bestSerendipityScore) {
        bestSerendipityScore = adjusted;
        bestSurprise = { ...e, serendipity: true };
      }
    }

    if (bestSurprise) {
      curatedPool[curatedPool.length - 1] = bestSurprise;
    }
  }

  return { curatedPool, fullScoredPool };
}

module.exports = {
  resolveDateRange, executeMore, executeDetails, validatePicks,
  buildSearchPool, executeWelcome, formatWelcomePick, welcomeTimeLabel,
  curatePool, computeNearbyHighlight, DEFAULT_POOL_SIZE,
};
