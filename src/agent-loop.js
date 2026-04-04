/**
 * agent-loop.js — True agent loop orchestrator for Pulse SMS.
 *
 * Uses runAgentLoop() from llm.js to run a multi-turn tool calling loop.
 * Tool execution delegates to existing pure functions from brain-execute.js.
 * Session save happens AFTER the loop based on which tools were called.
 *
 * Design:
 *   - SMS text always comes from loopResult.text (model writes plain text after tool results, or directly for conversational turns)
 *   - Internal data (_poolResult, _placePoolResult, _moreResult, _welcomeResult) attached to tool results for session save
 *   - sanitizeForLLM strips _ prefixed keys before data goes to the model
 */

const { runAgentLoop, generate } = require('./llm');
const { MODELS } = require('./model-config');
const { BRAIN_TOOLS, buildBrainSystemPrompt, buildNativeHistory, serializePoolForContinuation, cleanEventName } = require('./brain-llm');
const { serializePlacePoolForContinuation, searchPlaces, lookupVenueFromGoogle } = require('./places');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const { buildSearchPool, executeMore, executeWelcome } = require('./brain-execute');
const { buildEventMap, saveResponseFrame, buildExhaustionMessage, sendPickUrls } = require('./pipeline');
const { sendSMS, maskPhone } = require('./twilio');
const { recordAICost } = require('./traces');
const { getSession, setSession, addToHistory, hashPhone } = require('./session');
const { trackAICost } = require('./request-guard');
const { smartTruncate } = require('./formatters');
const { lookupVenueProfile } = require('./venues');
const { sendRuntimeAlert } = require('./alerts');
const { getAdjacentNeighborhoods, getNycDateString } = require('./geo');

// ---------------------------------------------------------------------------
// Strip markdown from SMS — models sometimes ignore "plain text only" instruction
// ---------------------------------------------------------------------------

function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // **bold**
    .replace(/\*(.+?)\*/g, '$1')       // *italic*
    .replace(/__(.+?)__/g, '$1')       // __bold__
    .replace(/_(.+?)_/g, '$1')         // _italic_
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](url)
}

// ---------------------------------------------------------------------------
// SMS length enforcement — agentic rewrite loop
// ---------------------------------------------------------------------------

const SMS_CHAR_LIMIT = 480;

/**
 * If smsText exceeds 480 chars, ask the model to shorten it (1 attempt).
 * Returns the original text if already within limit, or the shortened version.
 * Falls through to smartTruncate if the rewrite still exceeds the limit.
 */
async function rewriteIfTooLong(smsText, trace) {
  if (!smsText || smsText.length <= SMS_CHAR_LIMIT) return smsText;

  const overBy = smsText.length - SMS_CHAR_LIMIT;
  console.log(`[agent-loop] SMS is ${smsText.length} chars (${overBy} over limit), requesting rewrite`);

  try {
    const result = await generate(MODELS.brain,
      'You are an SMS editor. Shorten the following SMS to under 480 characters. Keep the same events, tone, and style. Do not add anything new. Return ONLY the shortened SMS text, nothing else.',
      `This SMS is ${smsText.length} characters but must be under 480. Shorten it:\n\n${smsText}`,
      { maxTokens: 512, temperature: 0, timeout: 5000 }
    );

    const rewritten = (result.text || '').trim();
    if (rewritten && rewritten.length <= SMS_CHAR_LIMIT && rewritten.length > 50) {
      console.log(`[agent-loop] Rewrite succeeded: ${smsText.length} → ${rewritten.length} chars`);
      if (trace) trace.composition.rewrite = { from: smsText.length, to: rewritten.length };
      return rewritten;
    }
    console.warn(`[agent-loop] Rewrite returned ${rewritten.length} chars, falling back to truncate`);
  } catch (err) {
    console.warn(`[agent-loop] Rewrite failed: ${err.message}`);
  }

  return smsText; // smartTruncate will handle it downstream
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Strip keys prefixed with _ from an object (shallow).
 * Used to remove internal metadata before sending tool results to the LLM.
 */
function sanitizeForLLM(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const clean = {};
  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith('_')) clean[key] = value;
  }
  return clean;
}

/**
 * Match event names/venues in SMS text against the event pool to determine
 * which events the LLM mentioned. Case-insensitive substring match on
 * first 30 chars of name.
 * Returns [{ rank, event_id, why }].
 */
function extractPicksFromSms(smsText, events) {
  if (!smsText || !events?.length) return [];
  const lower = smsText.toLowerCase();
  const picks = [];
  const usedIds = new Set();

  for (const event of events) {
    if (usedIds.has(event.id)) continue;

    // Try name match (first 30 chars)
    const name = (event.name || '').toLowerCase().slice(0, 30);
    const venue = (event.venue_name || '').toLowerCase();

    let matched = false;
    if (name.length >= 3 && lower.includes(name)) {
      matched = true;
    } else if (venue.length >= 3 && lower.includes(venue)) {
      matched = true;
    }

    if (matched) {
      usedIds.add(event.id);
      picks.push({
        rank: picks.length + 1,
        event_id: event.id,
        why: `mentioned in SMS (name/venue match)`,
      });
    }
  }

  return picks;
}

/**
 * Match place names in SMS text against the place pool to determine
 * which places the LLM mentioned. Returns [{ rank, place_id }].
 */
function extractPlacePicksFromSms(smsText, places) {
  if (!smsText || !places?.length) return [];
  const lower = smsText.toLowerCase();
  const picks = [];
  const usedIds = new Set();

  for (const place of places) {
    if (usedIds.has(place.place_id)) continue;
    const name = (place.name || '').toLowerCase().slice(0, 30);
    if (name.length >= 3 && lower.includes(name)) {
      usedIds.add(place.place_id);
      picks.push({ rank: picks.length + 1, place_id: place.place_id });
    }
  }
  return picks;
}

/**
 * Infer search types from a natural language query.
 * Returns array of types: 'events', 'bars', 'restaurants'.
 */
function inferTypesFromQuery(query) {
  if (!query) return ['events'];
  const lower = query.toLowerCase();
  const types = [];
  if (/\b(bar|bars|drink|drinks|cocktail|cocktails|dive|pub|pubs|beer|beers|speakeasy)\b/.test(lower)) types.push('bars');
  if (/\b(restaurant|restaurants|dinner|eat|eating|food|brunch|lunch|pizza|sushi|tacos)\b/.test(lower)) types.push('restaurants');
  if (/\b(event|events|show|shows|concert|concerts|music|comedy|jazz|dj|theater|art|film|trivia|dance|nightlife|open mic)\b/.test(lower)) types.push('events');
  if (types.length === 0 && /\b(happening|going on|to do|tonight|weekend|what's up)\b/.test(lower)) types.push('events');
  return types.length > 0 ? types : ['events'];
}

/**
 * Derive the response intent from the tool calls made during the loop.
 * Used for tracing.
 */
function deriveIntent(toolCalls) {
  if (!toolCalls?.length) return 'conversational';

  // Clarify intent wins — it's a terminal action
  if (toolCalls.some(tc => tc.name === 'clarify')) return 'clarify';

  // Details intent wins if ANY search used it (agent may do a follow-up search after details)
  const hasDetails = toolCalls.some(tc => tc.name === 'search' && tc.params?.intent === 'details');
  if (hasDetails) return 'details';

  const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search');
  if (lastSearch) {
    const intent = lastSearch.params?.intent;
    if (intent === 'more') return 'more';
    // Check if it was a welcome (no neighborhood, no types)
    if (!lastSearch.params?.neighborhood && !lastSearch.params?.types) return 'welcome';
    // Check if places-only
    const types = lastSearch.params?.types || [];
    if (types.length > 0 && !types.includes('events')) return 'places';
    return 'events';
  }

  return 'conversational';
}

// ---------------------------------------------------------------------------
// Tool execution callback
// ---------------------------------------------------------------------------

/**
 * Execute a tool call from the agent loop.
 * Returns result with _ prefixed internal data for session save.
 * The caller wraps this with sanitizeForLLM before passing to the LLM.
 */
async function executeTool(toolName, params, session, phone, trace) {
  if (toolName === 'search') {
    const { intent, neighborhood, types, filters, reference } = params;
    const searchTypes = types || inferTypesFromQuery(params.query);

    // --- Details intent ---
    if (intent === 'details') {
      // Place details
      if (session?.lastResultType === 'places' && session?.lastPlaces?.length && session?.lastPlaceMap) {
        const places = session.lastPlaces.map(p => {
          const place = session.lastPlaceMap[p.place_id];
          if (!place) return null;
          return {
            type: place.place_type || 'bar',
            place_id: place.place_id, name: place.name, neighborhood: place.neighborhood,
            address: place.address, place_type: place.place_type,
            price_level: place.price_level, rating: place.rating,
            review_count: place.user_ratings_total,
            editorial_summary: place.editorial_summary || undefined,
            google_maps_url: place.google_maps_url || undefined,
            serves_cocktails: place.serves_cocktails || undefined,
            serves_wine: place.serves_wine || undefined,
            outdoor_seating: place.outdoor_seating || undefined,
            good_for_groups: place.good_for_groups || undefined,
            live_music: place.live_music || undefined,
            open_hours: place.open_hours_json || undefined,
          };
        }).filter(Boolean);

        return {
          reference,
          items: places,
          message: `The user wants details about "${reference || 'a place'}". Here are the places you showed them. Identify which one they mean and compose a rich details response with vibe, what to expect, and logistics (address, hours, Google Maps link). If you can't tell which one, ask them to clarify.`,
        };
      }

      // Event details
      if (!session?.lastPicks?.length || !session?.lastEvents) {
        return {
          not_found: true,
          message: "I don't have any picks loaded -- tell me what you're looking for!",
        };
      }

      if (session.lastResponseHadPicks === false) {
        const hood = session.lastNeighborhood;
        return {
          stale: true,
          message: hood
            ? `I don't have a pick list up right now -- ask for more ${hood} picks, or tell me what you're looking for!`
            : "I don't have a pick list up right now -- tell me what you're looking for!",
        };
      }

      const events = session.lastPicks.map(p => {
        const e = session.lastEvents[p.event_id];
        if (!e) return null;
        return {
          type: 'event',
          id: e.id, name: cleanEventName((e.name || '').slice(0, 80)),
          venue_name: e.venue_name, neighborhood: e.neighborhood,
          start_time_local: e.start_time_local, category: e.category,
          is_free: e.is_free, price_display: e.price_display,
          description_short: e.description_short || e.short_detail || '',
          editorial_note: e.editorial_note || undefined,
          recurring: e.is_recurring ? e.recurrence_label : undefined,
          venue_profile: lookupVenueProfile(e.venue_name) || undefined,
        };
      }).filter(Boolean);

      return {
        reference,
        items: events,
        message: `The user wants details about "${reference || 'a pick'}". Here are the picks you showed them. Identify which one they mean and compose a rich details response with venue, time, price, and description. If you can't tell which one, ask them to clarify.`,
      };
    }

    // --- More intent ---
    if (intent === 'more') {
      // Place more
      if (session?.lastResultType === 'places') {
        if (!session?.lastPlaceMap) {
          return { no_context: true, message: "Tell me what neighborhood you're looking for bars or restaurants in!" };
        }
        const hood = neighborhood || session.lastNeighborhood;
        // Infer place type from session
        const firstPlace = Object.values(session.lastPlaceMap)[0];
        const placeType = (searchTypes.includes('restaurants') ? 'restaurant' : searchTypes.includes('bars') ? 'bar' : null)
          || firstPlace?.place_type || 'bar';
        if (!hood) {
          return { no_context: true, message: "What neighborhood are you looking in?" };
        }
        const pool = await searchPlaces(hood, placeType, { vibe: filters?.vibe });
        const shownIds = new Set((session.lastPlaces || []).map(p => p.place_id));
        const fresh = pool.filter(p => !shownIds.has(p.place_id));
        if (fresh.length === 0) {
          return { exhausted: true, message: `That's all the ${placeType}s I've got in ${hood}! Try a different neighborhood or vibe.` };
        }
        const serialized = serializePlacePoolForContinuation(fresh, hood, placeType, filters?.vibe);
        const items = (serialized.places || []).map(p => ({ type: placeType, ...p }));
        return {
          neighborhood: serialized.neighborhood,
          count: items.length,
          items,
          _placePoolResult: { places: fresh, neighborhood: hood, placeType, vibe: filters?.vibe },
        };
      }

      // Event more
      const moreResult = executeMore(session);
      if (moreResult.noContext) {
        return {
          no_context: true,
          message: "Tell me what you're in the mood for -- comedy, live music, something weird? Or drop a neighborhood.",
          _moreResult: moreResult,
        };
      }
      if (moreResult.exhausted) {
        const exhaust = buildExhaustionMessage(moreResult.neighborhood, {
          adjacentHoods: moreResult.neighborhood ? getAdjacentNeighborhoods(moreResult.neighborhood, 4) : [],
          visitedHoods: session?.visitedHoods || [moreResult.neighborhood].filter(Boolean),
          filters: moreResult.activeFilters || {},
          borough: session?.lastBorough,
        });
        return {
          exhausted: true,
          message: exhaust.message,
          suggested_hood: exhaust.suggestedHood,
          _moreResult: moreResult,
          _exhaustResult: exhaust,
        };
      }

      const todayNyc = getNycDateString(0);
      const tomorrowNyc = getNycDateString(1);
      const items = moreResult.events.map(e => ({
        type: 'event',
        id: e.id, name: cleanEventName((e.name || '').slice(0, 80)), venue_name: e.venue_name,
        neighborhood: e.neighborhood,
        day: e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local,
        start_time_local: e.start_time_local,
        is_free: e.is_free, price_display: e.price_display, category: e.category,
        short_detail: (e.short_detail || e.description_short || '').slice(0, 100),
        recurring: e.is_recurring ? e.recurrence_label : undefined,
        venue_size: e.venue_size || undefined,
        source_vibe: e.source_vibe || undefined,
      }));

      if (moreResult.events?.length) {
        trace.events.sent_ids = moreResult.events.map(e => e.id);
        trace.events.sent_pool = moreResult.events.map(e => ({
          id: e.id, name: e.name, venue_name: e.venue_name,
          neighborhood: e.neighborhood, category: e.category,
          is_free: e.is_free, price_display: e.price_display,
          source_name: e.source_name,
        }));
      }

      return {
        neighborhood: moreResult.neighborhood || 'NYC',
        count: items.length,
        is_last_batch: moreResult.isLastBatch || false,
        suggestions: moreResult.suggestions,
        items,
        _moreResult: moreResult,
      };
    }

    // --- Discover intent ---
    const wantsEvents = searchTypes.includes('events');
    const wantsPlaces = searchTypes.includes('bars') || searchTypes.includes('restaurants');

    // Welcome case: no neighborhood, no types, returning user
    if (!neighborhood && !wantsPlaces && !filters && session?.conversationHistory?.length) {
      const result = await executeWelcome();
      const events = (result.topEvents || []).map(e => ({
        type: 'event',
        id: e.id, name: cleanEventName((e.name || '').slice(0, 80)), venue_name: e.venue_name,
        neighborhood: e.neighborhood, start_time_local: e.start_time_local,
        is_free: e.is_free, price_display: e.price_display, category: e.category,
        short_detail: (e.short_detail || e.description_short || '').slice(0, 100),
        source_vibe: e.source_vibe || undefined,
      }));
      const msg = events.length > 0
        ? "Here are tonight's top picks across NYC. Introduce yourself as Pulse and recommend 1-2 of these. End with a question — ask what neighborhood they're in or what vibe they're looking for."
        : "No events loaded yet. Introduce yourself as Pulse, say you're a plugged-in friend for NYC nightlife, and ask what neighborhood they're in or what they're looking for tonight.";
      return {
        ok: true,
        neighborhood: 'citywide',
        count: events.length,
        message: msg,
        items: events.length > 0 ? events : undefined,
        _welcomeResult: result,
      };
    }

    // Fan out event + place searches in parallel
    const results = {};
    const promises = [];

    if (wantsEvents) {
      const eventParams = {
        neighborhood,
        intent: 'new_search',
      };
      if (filters) {
        if (filters.categories?.length === 1) eventParams.category = filters.categories[0];
        else if (filters.categories?.length > 1) eventParams.categories = filters.categories;
        if (filters.free_only) eventParams.free_only = true;
        if (filters.time_after) eventParams.time_after = filters.time_after;
        if (filters.date_range) eventParams.date_range = filters.date_range;
      }
      promises.push(
        buildSearchPool(eventParams, session, phone, trace)
          .then(r => { results.eventPool = r; })
      );
    }

    if (wantsPlaces) {
      const hood = neighborhood || session?.lastNeighborhood;
      const placeType = searchTypes.includes('restaurants') ? 'restaurant' : 'bar';
      if (hood) {
        promises.push(
          searchPlaces(hood, placeType, { vibe: filters?.vibe })
            .then(pool => {
              if (pool.length > 0) {
                results.placePool = { places: pool, neighborhood: hood, placeType, vibe: filters?.vibe };
              }
            })
            .catch(err => { console.warn('Place search failed:', err.message); })
        );
      } else if (!wantsEvents) {
        // Places-only with no neighborhood
        return {
          no_neighborhood: true,
          message: "What neighborhood are you looking in? Drop a name like Williamsburg, Bushwick, or LES.",
        };
      }
    }

    await Promise.all(promises);

    // Handle zero-match for events-only search
    if (wantsEvents && !wantsPlaces && results.eventPool?.zeroMatch) {
      return {
        zero_match: true,
        message: results.eventPool.zeroMatch.sms,
        _poolResult: null,
        _zeroMatch: results.eventPool.zeroMatch,
      };
    }

    // Build unified result
    const items = [];
    let resultNeighborhood = neighborhood || 'NYC';
    let meta = {};

    if (results.eventPool && !results.eventPool.zeroMatch) {
      const eventSerialized = serializePoolForContinuation(results.eventPool);
      resultNeighborhood = eventSerialized.neighborhood;
      meta = {
        filter: eventSerialized.filter,
        sparse: eventSerialized.sparse,
        nearby_hoods: eventSerialized.nearby_hoods,
        suggested_neighborhood: eventSerialized.suggested_neighborhood,
        nearby_highlight: eventSerialized.nearby_highlight,
      };
      for (const e of (eventSerialized.events || [])) {
        items.push({ type: 'event', ...e });
      }
    }

    if (results.placePool) {
      const placeSerialized = serializePlacePoolForContinuation(
        results.placePool.places, results.placePool.neighborhood,
        results.placePool.placeType, results.placePool.vibe
      );
      if (!results.eventPool || results.eventPool.zeroMatch) {
        resultNeighborhood = placeSerialized.neighborhood;
      }
      for (const p of (placeSerialized.places || [])) {
        items.push({ type: results.placePool.placeType || 'bar', ...p });
      }
    }

    // Place-only with no results and no API key
    if (wantsPlaces && !wantsEvents && items.length === 0) {
      if (!GOOGLE_MAPS_API_KEY) {
        return {
          not_available: true,
          message: "Place search isn't available right now — but I can find you events! What are you in the mood for?",
        };
      }
      const placeType = searchTypes.includes('restaurants') ? 'restaurant' : 'bar';
      return {
        zero_match: true,
        message: `I couldn't find any ${placeType}s in ${neighborhood || 'that area'}. Try a different neighborhood or type!`,
      };
    }

    return {
      neighborhood: resultNeighborhood,
      count: items.length,
      ...meta,
      items,
      _poolResult: results.eventPool?.zeroMatch ? null : results.eventPool || null,
      _placePoolResult: results.placePool || null,
    };
  }

  if (toolName === 'lookup_venue') {
    const { venue_name, neighborhood } = params;

    // Check hand-written profiles first (richest data)
    const existingProfile = lookupVenueProfile(venue_name);
    if (existingProfile) {
      return { ...existingProfile, name: venue_name, _source: 'venue_profile' };
    }

    // Call Google Places
    const result = await lookupVenueFromGoogle(venue_name, neighborhood);
    if (result._source === undefined) result._source = 'google_places';
    return result;
  }

  if (toolName === 'clarify') {
    return {
      reason: params.reason,
      question: params.question,
      options: params.options || [],
      confidence: params.confidence ?? null,
      implicit_filters: params.implicit_filters || null,
    };
  }

  // Unknown tool
  return { error: `Unknown tool: ${toolName}` };
}

// ---------------------------------------------------------------------------
// Post-loop session save
// ---------------------------------------------------------------------------

/**
 * Save session state based on which tools were called during the loop.
 * Uses saveResponseFrame (P4: one save path).
 * Picks are derived from pool event IDs (not fuzzy SMS text matching).
 */
function saveSessionFromToolCalls(phone, session, toolCalls, smsText) {
  if (!toolCalls?.length) return;

  // Clarify — save pending clarification for next turn
  const clarifyCall = toolCalls.find(tc => tc.name === 'clarify');
  if (clarifyCall) {
    const { reason, options, implicit_filters, confidence, question } = clarifyCall.params || {};
    setSession(phone, {
      ...session,
      pendingClarification: { reason, options, implicit_filters: implicit_filters || null, confidence: confidence ?? null, question },
    });
    return;
  }

  const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search');

  // No search tool called (conversational turn) — preserve existing session
  if (!lastSearch) {
    if (toolCalls.length === 0) {
      // Pure conversational — no tools at all. Preserve session via saveResponseFrame.
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
    }
    return;
  }

  const { params, result } = lastSearch;
  const intent = params.intent;

  // Welcome
  if (result?._welcomeResult) {
    const wr = result._welcomeResult;
    saveResponseFrame(phone, {
      picks: wr.picks || [],
      eventMap: wr.eventMap || {},
      neighborhood: 'citywide',
      offeredIds: (wr.picks || []).map(p => p.event_id),
      visitedHoods: ['citywide'],
    });
    return;
  }

  // Zero match — already saved in buildSearchPool
  if (result?._zeroMatch) return;

  // Details — track engagement only, don't change session state
  if (intent === 'details') {
    try {
      const db = require('./db');
      const ph = hashPhone(phone);
      for (const pick of (session?.lastPicks || [])) {
        if (pick.event_id) db.markRecommendationEngaged(ph, pick.event_id);
      }
    } catch (err) {
      console.warn('engagement tracking failed:', err.message);
    }
    return;
  }

  // More
  if (intent === 'more') {
    if (result?._placePoolResult) {
      const pr = result._placePoolResult;
      const placeMap = {};
      for (const p of pr.places) placeMap[p.place_id] = p;
      const placePicks = pr.places.slice(0, 5).map((p, i) => ({ rank: i + 1, place_id: p.place_id }));
      saveResponseFrame(phone, {
        picks: [], eventMap: {}, neighborhood: pr.neighborhood,
        offeredIds: [],
        visitedHoods: [...new Set([...(session?.visitedHoods || []), pr.neighborhood])],
        lastResponseHadPicks: false, placePicks, placeMap, resultType: 'places',
      });
      return;
    }
    const moreResult = result?._moreResult;
    if (!moreResult) return;
    if (moreResult.exhausted) {
      const exhaust = result._exhaustResult || {};
      saveResponseFrame(phone, {
        mode: 'more', picks: [], prevSession: session,
        eventMap: session?.lastEvents || {}, neighborhood: moreResult.neighborhood,
        filters: moreResult.activeFilters || {}, offeredIds: [],
        pending: exhaust.suggestedHood ? { neighborhood: exhaust.suggestedHood, filters: moreResult.activeFilters || {} } : null,
      });
      return;
    }
    const eventMap = buildEventMap(moreResult.events || []);
    // Use pool order as picks (no fuzzy SMS matching needed)
    const morePicks = moreResult.events.slice(0, 5).map((e, i) => ({ rank: i + 1, event_id: e.id }));
    saveResponseFrame(phone, {
      mode: 'more', picks: morePicks, prevSession: session,
      eventMap: session?.lastEvents || eventMap, neighborhood: moreResult.neighborhood,
      filters: moreResult.activeFilters || {},
      offeredIds: (moreResult.events || []).map(e => e.id),
      pending: (moreResult.isLastBatch && moreResult.suggestions?.length)
        ? { neighborhood: moreResult.suggestions[0], filters: moreResult.activeFilters || {} } : null,
    });
    trackRecommendations(phone, morePicks.map(p => p.event_id));
    return;
  }

  // --- Discover ---
  const poolResult = result?._poolResult;
  const placeResult = result?._placePoolResult;

  // Build place state if present
  const placeMap = {};
  let placePicks = [];
  if (placeResult?.places?.length > 0) {
    for (const p of placeResult.places) placeMap[p.place_id] = p;
    placePicks = placeResult.places.slice(0, 5).map((p, i) => ({ rank: i + 1, place_id: p.place_id }));
  }

  // Places-only
  if (!poolResult && placeResult) {
    saveResponseFrame(phone, {
      picks: [], eventMap: {}, neighborhood: placeResult.neighborhood,
      offeredIds: [],
      visitedHoods: [...new Set([...(session?.visitedHoods || []), placeResult.neighborhood])],
      lastResponseHadPicks: false, placePicks, placeMap, resultType: 'places',
    });
    return;
  }

  if (!poolResult) return;

  // Events (possibly mixed with places)
  const eventMap = buildEventMap(poolResult.curated || []);
  for (const e of (poolResult.pool || [])) eventMap[e.id] = e;
  // Use pool order as picks — these are the events the model saw
  const allPoolEvents = [...(poolResult.curated || []), ...(poolResult.pool || [])];
  const picks = allPoolEvents.slice(0, 5).map((e, i) => ({ rank: i + 1, event_id: e.id }));

  saveResponseFrame(phone, {
    picks, eventMap,
    neighborhood: poolResult.hood, borough: poolResult.borough,
    filters: poolResult.activeFilters,
    offeredIds: picks.map(p => p.event_id),
    visitedHoods: [...new Set([...(session?.visitedHoods || []), poolResult.hood || poolResult.borough || 'citywide'])],
    pending: poolResult.suggestedHood ? { neighborhood: poolResult.suggestedHood, filters: poolResult.activeFilters } : null,
    placePicks, placeMap, resultType: placeResult ? 'mixed' : 'events',
  });

  trackRecommendations(phone, picks.map(p => p.event_id));
}

/** Track recommendation IDs in SQLite (non-blocking). */
function trackRecommendations(phone, eventIds) {
  const ids = eventIds.filter(Boolean);
  if (ids.length === 0) return;
  try {
    const db = require('./db');
    db.insertRecommendations(hashPhone(phone), ids);
  } catch (err) {
    console.warn('recommendation tracking failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function handleAgentRequest(phone, message, session, trace, finalizeTrace) {
  const masked = maskPhone(phone);

  // Set up session + history
  if (!getSession(phone)) setSession(phone, {});
  if (!session) session = getSession(phone);
  addToHistory(phone, 'user', message);

  // --- Pending clarification bridging ---
  const pending = session?.pendingClarification;
  if (pending) {
    // Detect if user ignored clarification and sent a new query
    const { extractNeighborhood } = require('./neighborhoods');
    const hasNeighborhood = !!extractNeighborhood(message);
    const hasCategory = /\b(comedy|jazz|live music|dj|trivia|film|theater|art|dance|nightlife|bars?|restaurant|dinner|brunch)\b/i.test(message);
    const isNewQuery = hasNeighborhood && hasCategory;

    if (!isNewQuery && pending.implicit_filters) {
      // Merge implicit_filters into session as lastFilters
      const merged = { ...(session.lastFilters || {}) };
      if (pending.implicit_filters.neighborhood && !session.lastNeighborhood) {
        setSession(phone, { lastNeighborhood: pending.implicit_filters.neighborhood });
        session.lastNeighborhood = pending.implicit_filters.neighborhood;
      }
      if (pending.implicit_filters.category) {
        merged.categories = [pending.implicit_filters.category];
      }
      if (pending.implicit_filters.time) {
        merged.date_range = pending.implicit_filters.time;
      }
      if (Object.keys(merged).length > 0) {
        setSession(phone, { lastFilters: merged });
        session.lastFilters = merged;
      }
    }

    // Clear pendingClarification — must not persist to a third turn
    setSession(phone, { pendingClarification: null });
    session.pendingClarification = null;
  }

  // Quick URL resend — $0, no LLM call needed
  if (session?.lastSentUrl && /\b(url|link|send.*(link|url))\b/i.test(message)) {
    await sendSMS(phone, session.lastSentUrl);
    addToHistory(phone, 'assistant', session.lastSentUrl);
    trace.output_sms = session.lastSentUrl;
    finalizeTrace(session.lastSentUrl, 'url_resend');
    return trace.id;
  }

  const systemPrompt = buildBrainSystemPrompt(session);

  let smsSent = false;
  try {
    // Track raw results (with _ fields) for session save
    const rawResults = [];
    let clarifySeenInBatch = false;
    const executeAndTrack = async (toolName, params) => {
      // Edge case: clarify + other tools in parallel — clarify wins, skip others
      if (toolName === 'clarify') {
        clarifySeenInBatch = true;
        const result = await executeTool(toolName, params, session, phone, trace);
        rawResults.push({ name: toolName, params, result });
        return sanitizeForLLM(result);
      }
      if (clarifySeenInBatch) {
        console.warn(`[agent-loop] Skipping ${toolName} — clarify was called in same batch`);
        return { skipped: true, reason: 'clarify_in_batch' };
      }
      const result = await executeTool(toolName, params, session, phone, trace);
      rawResults.push({ name: toolName, params, result });
      return sanitizeForLLM(result);  // LLM only sees clean version
    };

    const priorMessages = buildNativeHistory(session?.conversationHistory);

    // Remove clarify tool after a clarification turn — enforce one-question max
    const tools = pending
      ? BRAIN_TOOLS.filter(t => t.name !== 'clarify')
      : BRAIN_TOOLS;

    const loopResult = await runAgentLoop(
      MODELS.brain, systemPrompt, message, tools,
      executeAndTrack,
      { maxIterations: 3, timeout: 12000, priorMessages, stopTools: ['clarify'] }
    );

    // Record costs
    recordAICost(trace, 'brain', loopResult.totalUsage, loopResult.provider);
    trackAICost(phone, loopResult.totalUsage, loopResult.provider);

    // Trace
    trace.brain_provider = loopResult.provider;
    trace.brain_latency_ms = loopResult.elapsed_ms || null;
    trace.brain_iterations = loopResult.iterations || [];
    trace.brain_tool_calls = loopResult.toolCalls.map(tc => ({ name: tc.name, params: tc.params }));
    trace.routing.pre_routed = false;
    trace.routing.provider = loopResult.provider;

    // SMS comes from model's plain text output (after tool results, or directly for conversational)
    let smsText = loopResult.text;

    // Clarify stop-tool: use the question text as SMS
    const clarifyCall = loopResult.toolCalls.find(tc => tc.name === 'clarify');
    if (clarifyCall) {
      smsText = clarifyCall.params?.question || smsText;
    }
    // Fallback: if model failed to compose (MALFORMED_FUNCTION_CALL), build SMS from pool
    if (!smsText) {
      const lastSearchFb = [...rawResults].reverse().find(tc => tc.name === 'search');
      const pool = lastSearchFb?.result?._poolResult?.pool;
      if (pool?.length > 0) {
        const top3 = pool.slice(0, 3);
        const hood = lastSearchFb.result?._poolResult?.hood || 'NYC';
        const lines = top3.map(e => {
          const time = e.start_time_local
            ? new Date(e.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
            : 'tonight';
          return `${e.name} — ${e.venue_name}, ${time}`;
        });
        smsText = `Tonight in ${hood}:\n\n${lines.join('\n')}\n\nReply a number for details or "more" for more picks`;
        console.warn(`[agent-loop] Used template fallback for SMS composition`);
      }
    }
    smsText = smsText || "Tell me what you're in the mood for -- drop a neighborhood or a vibe.";
    smsText = await rewriteIfTooLong(smsText, trace);
    smsText = stripMarkdown(smsText);
    smsText = smartTruncate(smsText); // final safety net

    // History — save tool calls + search summaries
    for (const tc of rawResults) {
      addToHistory(phone, 'tool_call', '', { name: tc.name, params: tc.params });
      // Save search summary for richer conversation context
      if (tc.name === 'search' && tc.result && !tc.result.not_found && !tc.result.stale) {
        const r = tc.result;
        const hood = r._poolResult?.hood || r._placePoolResult?.neighborhood || r._welcomeResult ? 'citywide' : null;
        const count = (r.items || []).length || r._moreResult?.events?.length || 0;
        const resultType = r._placePoolResult && !r._poolResult ? 'places' : r._poolResult ? 'events' : null;
        if (hood || count) {
          addToHistory(phone, 'search_summary', '', {
            neighborhood: hood,
            match_count: count,
            result_type: resultType,
          });
        }
      }
    }

    // Session save
    saveSessionFromToolCalls(phone, session, rawResults, smsText);

    const intent = deriveIntent(rawResults);
    await sendSMS(phone, smsText);
    smsSent = true;

    // Send pick URLs for details
    if (intent === 'details') {
      let urlSent = false;
      const detailEvents = Object.values(session?.lastEvents || {});
      const detailPicks = extractPicksFromSms(smsText, detailEvents);
      if (detailPicks.length > 0) {
        const { isReliableEventUrl } = require('./formatters');
        const evt = session?.lastEvents?.[detailPicks[0].event_id];
        const url = evt?.ticket_url || (isReliableEventUrl(evt?.source_url) ? evt.source_url : null);
        if (url) {
          await sendSMS(phone, url);
          setSession(phone, { lastSentUrl: url });
          urlSent = true;
        }
        await sendPickUrls(phone, detailPicks.slice(1), session?.lastEvents || {});
      }

      // Place URL sending (Google Maps link)
      if (!urlSent && detailPicks.length === 0 && session?.lastResultType === 'places') {
        const placePool = Object.values(session?.lastPlaceMap || {});
        const placePicks = extractPlacePicksFromSms(smsText, placePool);
        if (placePicks.length > 0) {
          const place = session.lastPlaceMap[placePicks[0].place_id];
          if (place?.google_maps_url) {
            await sendSMS(phone, place.google_maps_url);
            setSession(phone, { lastSentUrl: place.google_maps_url });
            urlSent = true;
          }
        }
      }

      // Google Maps URL from lookup_venue (only if no URL was already sent)
      if (!urlSent) {
        const lookupCall = rawResults.find(tc => tc.name === 'lookup_venue' && tc.result?.google_maps_url);
        if (lookupCall) {
          await sendSMS(phone, lookupCall.result.google_maps_url);
          setSession(phone, { lastSentUrl: lookupCall.result.google_maps_url });
        }
      }
    }

    finalizeTrace(smsText, intent);

  } catch (err) {
    // If main SMS was already sent, don't send another — just log the post-send error
    if (smsSent) {
      console.error('Post-send error (SMS already delivered):', err.message);
      trace.brain_error = `post_send: ${err.message}`;
      if (!trace.output_sms) finalizeTrace(null, deriveIntent(rawResults));
      return trace.id;
    }

    console.error('Agent loop error:', err.message);
    trace.brain_error = err.message;

    // Fallback to secondary model
    if (!err.message?.includes('fallback')) {
      try {
        console.warn(`Agent loop ${MODELS.brain} failed, trying ${MODELS.fallback}: ${err.message}`);
        const fbPriorMessages = buildNativeHistory(session?.conversationHistory);
        const fallbackResult = await runAgentLoop(
          MODELS.fallback, systemPrompt, message, BRAIN_TOOLS,
          async (toolName, params) => sanitizeForLLM(await executeTool(toolName, params, session, phone, trace)),
          { maxIterations: 2, timeout: 12000, priorMessages: fbPriorMessages }
        );

        recordAICost(trace, 'brain_fallback', fallbackResult.totalUsage, fallbackResult.provider);
        trackAICost(phone, fallbackResult.totalUsage, fallbackResult.provider);
        trace.brain_latency_ms = (trace.brain_latency_ms || 0) + (fallbackResult.elapsed_ms || 0);
        trace.brain_iterations = [...(trace.brain_iterations || []), ...(fallbackResult.iterations || [])];

        let fbSmsText = fallbackResult.text;
        fbSmsText = smartTruncate(fbSmsText || "Tell me what you're in the mood for!");

        await sendSMS(phone, fbSmsText);
        finalizeTrace(fbSmsText, deriveIntent(fallbackResult.toolCalls));
        return trace.id;
      } catch (err2) {
        console.error('Fallback also failed:', err2.message);
        trace.brain_error += ` fallback: ${err2.message}`;
      }
    }

    const sms = "Pulse hit a snag -- try again in a sec!";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'error');

    sendRuntimeAlert('agent_loop_error', {
      error: err.message,
      phone_masked: masked,
      message: message.slice(0, 80),
    });
  }

  return trace.id;
}

/**
 * Eval check: detect if SMS ends with a question but no clarify tool was called.
 * Returns true if this is a "question leak" — model bypassed the clarify tool.
 */
function detectQuestionLeak(smsText, toolCalls) {
  if (!smsText) return false;
  const trimmed = smsText.trim();
  if (trimmed.endsWith('?') && !toolCalls?.some(tc => tc.name === 'clarify')) {
    const okPatterns = [/you going\??$/i, /want (me to|more|details)/i, /sound good\??$/i, /interest(ed|ing)\??$/i];
    if (okPatterns.some(p => p.test(trimmed))) return false;
    return true;
  }
  return false;
}

module.exports = {
  handleAgentRequest,
  executeTool,
  sanitizeForLLM,
  saveSessionFromToolCalls,
  extractPicksFromSms,
  extractPlacePicksFromSms,
  deriveIntent,
  inferTypesFromQuery,
  rewriteIfTooLong,
  stripMarkdown,
  detectQuestionLeak,
  SMS_CHAR_LIMIT,
};
