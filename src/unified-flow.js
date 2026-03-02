const { extractNeighborhood, NEIGHBORHOODS, BOROUGHS, detectBorough } = require('./neighborhoods');
const { sendSMS } = require('./twilio');
const { recordAICost } = require('./traces');
const { getSession, setSession } = require('./session');
const { getAdjacentNeighborhoods } = require('./pre-router');
const { getEvents, getEventsForBorough, getEventsCitywide, getCacheStatus } = require('./events');
const { filterKidsEvents } = require('./curation');
const { buildEventMap, saveResponseFrame, mergeFilters, normalizeFilterIntent, buildTaggedPool, buildZeroMatchResponse, executeQuery } = require('./pipeline');
const { updateProfile } = require('./preference-profile');
const { trackAICost } = require('./request-guard');

const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

/**
 * Resolve unified context: neighborhood, filters, events, tagged pool.
 * Pure data preparation — no SMS sending, no LLM call.
 */
async function resolveUnifiedContext(message, session, preDetectedFilters, phone, trace) {
  // If pre-router detected filters (category/time/vibe/free), inject them for event pre-filtering
  if (preDetectedFilters) {
    setSession(phone, { pendingFilters: preDetectedFilters });
    session = getSession(phone);
  } else {
    trace.routing.pre_routed = false;
  }

  // Resolve neighborhood: explicit in message > affirmative nudge response > session fallback
  // Also check for borough — "brooklyn/williamsburg" or "yeah brooklyn" should use borough-level serving
  const extracted = extractNeighborhood(message);
  const boroughInMessage = detectBorough(message);
  let hood = extracted || null;

  // If message contains both a neighborhood AND its parent borough (e.g. "brooklyn/williamsburg"),
  // prefer borough-level serving — the user is being broad, not narrow
  if (hood && boroughInMessage && BOROUGHS[boroughInMessage.borough]?.includes(hood)) {
    hood = null; // Let borough branch below handle it
  }

  // Nudge-accept: only when no explicit borough/neighborhood was given
  if (!hood && !boroughInMessage && session?.pendingNearby) {
    if (/^(yes|yeah|ya|yep|yup|sure|ok|okay|down|bet|absolutely|definitely|why not|i'm down|im down)\b/i.test(message.trim())) {
      hood = session.pendingNearby;
    }
  }
  // If user provides explicit new neighborhood while having an active session,
  // clear pending filters to avoid stale pre-filtering (e.g. "try fort greene" after "no free comedy in Park Slope")
  // But keep pending filters when answering an ask_neighborhood prompt (no lastNeighborhood yet)
  if (extracted && session?.pendingFilters && session?.lastNeighborhood) {
    setSession(phone, { pendingFilters: null, pendingMessage: null });
    session = getSession(phone);
  }
  if (!hood) hood = session?.lastNeighborhood || null;
  if (hood && !NEIGHBORHOOD_NAMES.includes(hood)) {
    const validated = extractNeighborhood(hood);
    hood = validated || null;
  }
  trace.routing.resolved_neighborhood = hood;

  // Detect if user used an alias (e.g. "ridgewood" -> Bushwick, "lic" -> Long Island City)
  // so the LLM knows the resolution is correct and doesn't say "not in my system"
  let userHoodAlias = null;
  if (extracted && hood && !message.toLowerCase().includes(hood.toLowerCase())) {
    // Find which alias actually matched
    const hoodData = NEIGHBORHOODS[hood];
    if (hoodData) {
      const msgLower = message.toLowerCase();
      const matched = hoodData.aliases.find(a => a !== hood.toLowerCase() && msgLower.includes(a));
      userHoodAlias = matched || message.trim();
    }
  }

  // Resolve active filters: merge persisted filters with newly detected ones
  const activeFilters = mergeFilters(
    session?.lastFilters,
    preDetectedFilters || session?.pendingFilters || null
  );
  let matchCount = 0;
  let hardCount = 0;
  let softCount = 0;
  let isSparse = false;

  // Fetch events — neighborhood, borough, or citywide
  let events = [];
  let curated = [];
  let isCitywide = false;
  let isBorough = false;
  let borough = null;
  if (hood) {
    const eventsStart = Date.now();
    const raw = await getEvents(hood, { dateRange: activeFilters.date_range });
    trace.events.getEvents_ms = Date.now() - eventsStart;
    trace.events.cache_size = getCacheStatus().cache_size;
    curated = filterKidsEvents(raw);
    const taggedResult = buildTaggedPool(curated, activeFilters);
    trace.events.candidates_count = curated.length;
    trace.events.candidate_ids = curated.map(e => e.id);
    events = taggedResult.pool;
    matchCount = taggedResult.matchCount;
    hardCount = taggedResult.hardCount;
    softCount = taggedResult.softCount;
    isSparse = taggedResult.isSparse;

  } else {
    // Check for borough before falling through to citywide
    const boroughResult = detectBorough(message);
    if (boroughResult) {
      isBorough = true;
      borough = boroughResult.borough;
      const eventsStart = Date.now();
      const raw = await getEventsForBorough(borough, { dateRange: activeFilters.date_range, filters: activeFilters });
      trace.events.getEvents_ms = Date.now() - eventsStart;
      trace.events.cache_size = getCacheStatus().cache_size;
      curated = filterKidsEvents(raw);
      const taggedResult = buildTaggedPool(curated, activeFilters, { citywide: true });
      trace.events.candidates_count = curated.length;
      trace.events.candidate_ids = curated.map(e => e.id);
      events = taggedResult.pool;
      matchCount = taggedResult.matchCount;
      hardCount = taggedResult.hardCount;
      softCount = taggedResult.softCount;
      isSparse = taggedResult.isSparse;
    } else {
      // Citywide flow — serve best events across all neighborhoods
      isCitywide = true;
      const eventsStart = Date.now();
      const raw = await getEventsCitywide({ dateRange: activeFilters.date_range, filters: activeFilters });
      trace.events.getEvents_ms = Date.now() - eventsStart;
      trace.events.cache_size = getCacheStatus().cache_size;
      curated = filterKidsEvents(raw);
      const taggedResult = buildTaggedPool(curated, activeFilters, { citywide: true });
      trace.events.candidates_count = curated.length;
      trace.events.candidate_ids = curated.map(e => e.id);
      events = taggedResult.pool;
      matchCount = taggedResult.matchCount;
      hardCount = taggedResult.hardCount;
      softCount = taggedResult.softCount;
      isSparse = taggedResult.isSparse;
    }
  }
  const nearbyHoods = hood ? getAdjacentNeighborhoods(hood, 3) : [];

  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  trace.events.sent_to_claude = events.length;
  trace.events.sent_ids = events.map(e => e.id);
  trace.events.sent_pool = events.map(e => ({
    id: e.id,
    name: e.name,
    venue_name: e.venue_name,
    neighborhood: e.neighborhood,
    category: e.category,
    start_time_local: e.start_time_local,
    date_local: e.date_local,
    is_free: e.is_free,
    price_display: e.price_display,
    source_name: e.source_name,
    filter_match: e.filter_match,
    ticket_url: e.ticket_url || null,
  }));
  trace.events.pool_meta = { matchCount, hardCount, softCount, isSparse };

  // Derive suggested neighborhood deterministically (P5: code owns state)
  // Include matchCount===0 so pendingNearby is set for zero-match LLM responses too
  const suggestedHood = (isSparse || matchCount === 0) && nearbyHoods.length > 0 ? nearbyHoods[0] : null;

  console.log(`Unified flow: hood=${hood}, borough=${borough || 'none'}, events=${events.length}, nearby=${nearbyHoods.join(',')}`);

  // Build exclude list from previously shown events
  const prevPickIds = (session?.allPicks || session?.lastPicks || []).map(p => p.event_id);
  const prevOfferedIds = session?.allOfferedIds || [];
  const excludeIds = [...new Set([...prevPickIds, ...prevOfferedIds])];

  return { hood, activeFilters, events, curated, matchCount, hardCount, softCount, isSparse, isCitywide, isBorough, borough, nearbyHoods, suggestedHood, excludeIds, now, userHoodAlias, preDetectedFilters };
}

/**
 * Call executeQuery and capture trace/cost data.
 */
async function callUnified(message, unifiedCtx, session, history, phone, trace, { model } = {}) {
  const { hood, events, nearbyHoods, now, activeFilters, isSparse, isCitywide, isBorough, borough, matchCount, hardCount, softCount, excludeIds, suggestedHood, userHoodAlias } = unifiedCtx;

  const composeStart = Date.now();
  const result = await executeQuery(message, events, {
    session,
    neighborhood: hood,
    nearbyHoods,
    conversationHistory: history,
    currentTime: now,
    validNeighborhoods: NEIGHBORHOOD_NAMES,
    activeFilters,
    isSparse,
    isCitywide,
    isBorough,
    borough,
    matchCount,
    hardCount,
    softCount,
    excludeIds,
    suggestedNeighborhood: suggestedHood,
    userHoodAlias,
    model,
  });
  trace.routing.latency_ms = Date.now() - composeStart;
  trace.composition.latency_ms = trace.routing.latency_ms;
  trace.routing.provider = result._provider || 'anthropic';
  trace.routing.result = { intent: result.type, neighborhood: hood, confidence: 0.8 };
  trace.composition.raw_response = result._raw || null;
  trace.composition.picks = (result.picks || []).map(p => {
    const evt = events.find(e => e.id === p.event_id);
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
    };
  });
  trace.composition.active_filters = activeFilters || null;
  trace.composition.neighborhood_used = hood;
  // Derive which prompt skills were activated (mirrors buildUnifiedPrompt logic)
  const activeSkills = ['sourceTiers'];
  if (events.some(e => (e.date_local || e.day) === new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) || e.day === 'TODAY')) activeSkills.push('tonightPriority');
  if (hood && !events.some(e => e.neighborhood === hood)) activeSkills.push('neighborhoodMismatch');
  if (activeFilters?.free_only) activeSkills.push('freeEmphasis');
  if (history.length > 0) activeSkills.push('conversationAwareness');
  if (suggestedHood) activeSkills.push('nearbySuggestion');
  if (matchCount === 1 || (events.length <= 1)) activeSkills.push('singlePick');
  if ((isCitywide || isBorough) && events.length > 0) activeSkills.push('citywide');
  const uniqueDates = new Set(events.map(e => e.date_local).filter(Boolean));
  if (uniqueDates.size >= 2) activeSkills.push('multiDay');
  trace.composition.active_skills = activeSkills;
  recordAICost(trace, 'unified', result._usage, result._provider);
  trackAICost(phone, result._usage, result._provider);

  return result;
}

/**
 * Handle the unified LLM response: clear_filters check + 3 response type handlers.
 * All paths are terminal: saveResponseFrame -> updateProfile -> sendSMS -> finalizeTrace.
 */
async function handleUnifiedResponse(result, unifiedCtx, phone, session, trace, message, finalizeTrace) {
  let { hood, activeFilters, events, curated, suggestedHood, borough } = unifiedCtx;

  // Filter state management after unified call — gated by pre-router (P1: code owns state)
  // - clear_all: always trust (LLM handles semantic clearing the pre-router can't)
  // - modify when pre-router set filters: IGNORE (pre-router is deterministic ground truth;
  //   LLM is just echoing the ACTIVE_FILTER context it was given)
  // - modify when pre-router did NOT set filters: trust (first-message extraction, targeted clears)
  trace.composition = trace.composition || {};
  const hadPreDetectedFilters = !!(unifiedCtx.preDetectedFilters && Object.values(unifiedCtx.preDetectedFilters).some(Boolean));
  trace.composition.filter_state = {
    pre_router_filters: unifiedCtx.preDetectedFilters || null,
    llm_filter_intent: result.filter_intent || null,
    had_pre_detected: hadPreDetectedFilters,
  };

  if (result.filter_intent?.action === 'clear_all' || result.clear_filters) {
    activeFilters = {};
    trace.composition.filter_intent_action = 'clear_all';
    trace.composition.filter_state.decision = 'clear_all_trusted';
  } else if (result.filter_intent?.action === 'modify' && result.filter_intent?.updates) {
    if (hadPreDetectedFilters) {
      // Pre-router already set filters deterministically — ignore LLM's echo
      trace.composition.filter_intent_action = 'modify_ignored_pre_router';
      trace.composition.filter_state.decision = 'modify_ignored_pre_router';
    } else {
      const normalized = normalizeFilterIntent(result.filter_intent.updates);
      activeFilters = mergeFilters(activeFilters, normalized);
      trace.composition.filter_intent_action = 'modify';
      trace.composition.filter_intent_updates = normalized;
      trace.composition.filter_state.decision = 'modify_trusted';
    }
  }
  trace.composition.filter_state.final_filters = { ...activeFilters };

  // Handle response by type
  if (result.type === 'ask_neighborhood') {
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: session?.lastEvents || {},
      neighborhood: hood,
      borough,
      filters: Object.values(activeFilters).some(Boolean) ? activeFilters : null,
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      pending: {
        neighborhood: suggestedHood,
        filters: activeFilters,
      },
      pendingMessage: message,
      lastResponseHadPicks: false,
    });
    updateProfile(phone, { neighborhood: hood, filters: activeFilters, responseType: 'ask_neighborhood' })
      .catch(err => console.error('profile update failed:', err.message));
    await sendSMS(phone, result.sms_text);
    finalizeTrace(result.sms_text, 'events');
    return;
  }

  const eventMap = buildEventMap(curated);
  // Merge tagged pool events into eventMap so filter_match is available for validation
  for (const e of events) eventMap[e.id] = e;

  // Guardrail: LLM returned conversational but pool has matched events — override to event_picks
  // The LLM should always compose from matched events. If it chose conversational despite matches,
  // fall through to the event_picks path with deterministic picks from the pool.
  if ((result.type === 'conversational' || !result.picks || result.picks.length === 0)
      && unifiedCtx.matchCount > 0 && events.length > 0) {
    const matched = events.filter(e => e.filter_match === 'hard' || e.filter_match === 'soft');
    const fallbackPool = matched.length > 0 ? matched : events;
    if (fallbackPool.length > 0) {
      console.warn(`Conversational-with-pool override: type=${result.type}, matchCount=${unifiedCtx.matchCount}, forcing event_picks with ${fallbackPool.length} events`);
      result.type = 'event_picks';
      if (!result.picks || result.picks.length === 0) {
        result.picks = fallbackPool.slice(0, 3).map((e, i) => ({
          rank: i + 1,
          event_id: e.id,
        }));
      }
      trace.composition.conversational_override = true;
      // Fall through to event_picks handling below
    }
  }

  if (result.type === 'conversational' || !result.picks || result.picks.length === 0) {
    // Conversational or empty picks — save atomically, preserving existing picks/events for details/more
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: Object.keys(eventMap).length > 0 ? eventMap : (session?.lastEvents || {}),
      neighborhood: hood,
      borough,
      filters: Object.values(activeFilters).some(Boolean) ? activeFilters : null,
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      pending: suggestedHood ? { neighborhood: suggestedHood, filters: activeFilters } : null,
      lastResponseHadPicks: false,
    });
    updateProfile(phone, { neighborhood: hood, filters: activeFilters, responseType: 'conversational' })
      .catch(err => console.error('profile update failed:', err.message));
    await sendSMS(phone, result.sms_text);
    finalizeTrace(result.sms_text, 'conversational');
    return;
  }

  // Validate event IDs against pool (P7: catch hallucinated IDs before save)
  const validPicks = (result.picks || []).filter(p => eventMap[p.event_id]);

  // Filter compliance validation — strip non-matching picks when matches exist
  let filterCompliantPicks = validPicks;
  const hasActiveFilter = activeFilters && Object.values(activeFilters).some(Boolean);
  if (hasActiveFilter) {
    const poolEvents = Object.values(eventMap);
    const hasMatches = poolEvents.some(e => e.filter_match === 'hard' || e.filter_match === 'soft');
    if (hasMatches) {
      filterCompliantPicks = validPicks.filter(p => {
        const evt = eventMap[p.event_id];
        return evt?.filter_match === 'hard' || evt?.filter_match === 'soft';
      });
      if (filterCompliantPicks.length < validPicks.length) {
        console.warn(`Filter compliance: ${validPicks.length - filterCompliantPicks.length} non-matching picks stripped`);
        trace.composition.filter_violations = validPicks.length - filterCompliantPicks.length;
      }
    }
  }

  // Send SMS first — ensures user always gets a response even if session save fails
  await sendSMS(phone, result.sms_text);

  // One-time preference tip after first successful picks response
  const isFirstPicks = filterCompliantPicks.length > 0
    && !session?.shownPreferenceTip
    && (session?.conversationHistory?.length || 0) <= 1;
  if (isFirstPicks) {
    await sendSMS(phone, 'Tip: Tell me what you\u2019re into \u2014 "I love comedy and late-night stuff" or "mostly free events" \u2014 and I\u2019ll start prioritizing those for you.');
  }

  saveResponseFrame(phone, {
    picks: filterCompliantPicks,
    eventMap,
    neighborhood: hood,
    borough,
    filters: activeFilters,
    offeredIds: filterCompliantPicks.map(p => p.event_id),
    visitedHoods: [...new Set([...(session?.visitedHoods || []), hood || 'citywide'])],
    pending: suggestedHood ? {
      neighborhood: suggestedHood,
      filters: activeFilters,
    } : null,
  });
  // Persist tip flag via merge (setResponseState wipes non-frame fields)
  if (isFirstPicks) setSession(phone, { shownPreferenceTip: true });
  updateProfile(phone, { neighborhood: hood, filters: activeFilters, responseType: 'event_picks' })
    .catch(err => console.error('profile update failed:', err.message));
  finalizeTrace(result.sms_text, 'events');
}

/**
 * Handle zero-match bypass: when filters match nothing in a neighborhood,
 * compose a deterministic response and preserve filters in session.
 * $0 AI cost.
 */
async function handleZeroMatch(unifiedCtx, phone, session, trace, finalizeTrace) {
  const { hood, activeFilters, nearbyHoods, events, curated, borough } = unifiedCtx;
  const { message, suggestedHood, source } = buildZeroMatchResponse(hood, activeFilters, nearbyHoods);

  trace.routing.latency_ms = 0;
  trace.composition.latency_ms = 0;
  trace.composition.zero_match_bypass = true;
  trace.composition.zero_match_source = source;
  trace.composition.active_filters = activeFilters || null;
  trace.composition.neighborhood_used = hood;

  const eventMap = buildEventMap(curated);
  for (const e of events) eventMap[e.id] = e;

  const pending = suggestedHood
    ? { neighborhood: suggestedHood, filters: activeFilters }
    : null;

  saveResponseFrame(phone, {
    picks: session?.lastPicks || [],
    eventMap: Object.keys(eventMap).length > 0 ? eventMap : (session?.lastEvents || {}),
    neighborhood: hood,
    borough,
    filters: Object.values(activeFilters).some(Boolean) ? activeFilters : null,
    offeredIds: session?.allOfferedIds || [],
    visitedHoods: session?.visitedHoods || [],
    pending,
    lastResponseHadPicks: false,
  });
  updateProfile(phone, { neighborhood: hood, filters: activeFilters, responseType: 'zero_match' })
    .catch(err => console.error('profile update failed:', err.message));
  // Flag so consecutive zero-match turns fall through to LLM (allows filter modification)
  setSession(phone, { lastZeroMatch: true });
  await sendSMS(phone, message);
  finalizeTrace(message, 'events');
}

module.exports = { resolveUnifiedContext, callUnified, handleUnifiedResponse, handleZeroMatch };
