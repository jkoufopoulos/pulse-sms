/**
 * agent-loop.js — True agent loop orchestrator for Pulse SMS.
 *
 * Uses runAgentLoop() from llm.js to run a multi-turn tool calling loop.
 * Tool execution delegates to existing pure functions from brain-execute.js.
 * Session save happens AFTER the loop based on which tools were called.
 *
 * Design:
 *   - respond tool: SMS text comes from params.message (model writes it in tool call)
 *   - search_events tool: SMS text comes from loopResult.text (model writes after seeing results)
 *   - Internal data (_poolResult, _moreResult, _detailsResult) attached to tool results for session save
 *   - sanitizeForLLM strips _ prefixed keys before data goes to the model
 */

const { runAgentLoop } = require('./llm');
const { MODELS } = require('./model-config');
const { BRAIN_TOOLS, buildBrainSystemPrompt, serializePoolForContinuation } = require('./brain-llm');
const { buildSearchPool, executeMore, executeDetails } = require('./brain-execute');
const { buildEventMap, saveResponseFrame, buildExhaustionMessage, sendPickUrls } = require('./pipeline');
const { sendSMS, maskPhone } = require('./twilio');
const { recordAICost } = require('./traces');
const { getSession, setSession, addToHistory } = require('./session');
const { trackAICost } = require('./request-guard');
const { updateProfile } = require('./preference-profile');
const { smartTruncate, injectMissingPrices } = require('./formatters');
const { sendRuntimeAlert } = require('./alerts');
const { getAdjacentNeighborhoods, getNycDateString } = require('./geo');

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
 * Derive the response intent from the tool calls made during the loop.
 * Used for tracing.
 */
function deriveIntent(toolCalls) {
  if (!toolCalls?.length) return 'conversational';

  // Last search_events call determines intent
  const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search_events');
  if (lastSearch) {
    const intent = lastSearch.params?.intent;
    if (intent === 'more') return 'more';
    if (intent === 'details') return 'details';
    return 'events';
  }

  // Only respond or compose_sms calls
  const lastRespond = [...toolCalls].reverse().find(tc => tc.name === 'respond');
  if (lastRespond) return 'conversational';

  // compose_sms without search_events — shouldn't happen but handle it
  const lastCompose = [...toolCalls].reverse().find(tc => tc.name === 'compose_sms');
  if (lastCompose) return 'events';

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
  if (toolName === 'respond') {
    return { ok: true, intent: params.intent };
  }

  if (toolName === 'compose_sms') {
    return { ok: true };
  }

  if (toolName === 'search_events') {
    // --- More intent ---
    if (params.intent === 'more') {
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

      // Serialize events for LLM
      const todayNyc = getNycDateString(0);
      const tomorrowNyc = getNycDateString(1);
      const serialized = {
        neighborhood: moreResult.neighborhood || 'NYC',
        match_count: moreResult.events.length,
        is_last_batch: moreResult.isLastBatch || false,
        suggestions: moreResult.suggestions,
        events: moreResult.events.map(e => ({
          id: e.id, name: (e.name || '').slice(0, 80), venue_name: e.venue_name,
          neighborhood: e.neighborhood,
          day: e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local,
          start_time_local: e.start_time_local,
          is_free: e.is_free, price_display: e.price_display, category: e.category,
          short_detail: (e.short_detail || e.description_short || '').slice(0, 100),
          recurring: e.is_recurring ? e.recurrence_label : undefined,
          venue_size: e.venue_size || undefined,
          source_vibe: e.source_vibe || undefined,
        })),
      };

      // Populate trace
      if (moreResult.events?.length) {
        trace.events.sent_ids = moreResult.events.map(e => e.id);
        trace.events.sent_pool = moreResult.events.map(e => ({
          id: e.id, name: e.name, venue_name: e.venue_name,
          neighborhood: e.neighborhood, category: e.category,
          is_free: e.is_free, price_display: e.price_display,
        }));
      }

      return {
        ...serialized,
        _moreResult: moreResult,
      };
    }

    // --- Details intent ---
    if (params.intent === 'details') {
      const detailsResult = executeDetails(params.pick_reference, session);

      if (detailsResult.noPicks) {
        return {
          not_found: true,
          message: "I don't have any picks loaded -- tell me what you're looking for!",
          _detailsResult: detailsResult,
        };
      }

      if (detailsResult.stalePicks) {
        const hood = detailsResult.neighborhood;
        return {
          stale: true,
          message: hood
            ? `I don't have a pick list up right now -- ask for more ${hood} picks, or tell me what you're looking for!`
            : "I don't have a pick list up right now -- tell me what you're looking for!",
          _detailsResult: detailsResult,
        };
      }

      if (!detailsResult.found) {
        return {
          not_found: true,
          message: "I'm not sure which event you mean -- can you be more specific?",
          _detailsResult: detailsResult,
        };
      }

      // Found — compose details SMS from template (no LLM call needed)
      const event = detailsResult.event;
      const price = event.is_free ? 'Free' : (event.price_display || 'Check price');
      const desc = event.description_short || event.short_detail || '';
      const time = event.start_time_local
        ? new Date(event.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
        : 'tonight';
      const lines = [
        `${event.name} — ${event.venue_name}, ${event.neighborhood || ''}`,
        `${time} | ${price}`,
        desc ? `\n${desc}` : '',
      ].filter(Boolean);
      const detailSms = lines.join('\n');
      return {
        ok: true,
        _smsText: detailSms,
        _detailsResult: detailsResult,
      };
    }

    // --- Regular search (new_search, refine, pivot) ---
    const poolResult = await buildSearchPool(params, session, phone, trace);

    if (poolResult.zeroMatch) {
      return {
        zero_match: true,
        message: poolResult.zeroMatch.sms,
        _poolResult: null,
        _zeroMatch: poolResult.zeroMatch,
      };
    }

    // Serialize pool for LLM
    const serialized = serializePoolForContinuation(poolResult);

    return {
      ...serialized,
      _poolResult: poolResult,
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
 */
function saveSessionFromToolCalls(phone, session, toolCalls, smsText) {
  if (!toolCalls?.length) return;

  const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search_events');
  const lastRespond = [...toolCalls].reverse().find(tc => tc.name === 'respond');
  const lastCompose = [...toolCalls].reverse().find(tc => tc.name === 'compose_sms');

  // Build picks: prefer compose_sms (structured), fall back to extractPicksFromSms (fuzzy)
  const composePickIds = lastCompose?.params?.picks || [];
  let composePicks = composePickIds.map((id, i) => ({ rank: i + 1, event_id: id }));

  // respond only (no search) — preserve existing session
  if (!lastSearch && lastRespond) {
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
    return;
  }

  if (!lastSearch) return;

  const { params, result } = lastSearch;
  const intent = params.intent;

  // Zero match — already saved in buildSearchPool
  if (result?._zeroMatch) return;

  // Details — don't change picks/neighborhood
  if (intent === 'details') {
    // No session change for details — picks stay the same
    return;
  }

  // More — update pool with more batch
  if (intent === 'more') {
    const moreResult = result?._moreResult;
    if (!moreResult) return;

    if (moreResult.exhausted) {
      const exhaust = result._exhaustResult || {};
      saveResponseFrame(phone, {
        mode: 'more',
        picks: [],
        prevSession: session,
        eventMap: session?.lastEvents || {},
        neighborhood: moreResult.neighborhood,
        filters: moreResult.activeFilters || {},
        offeredIds: [],
        pending: exhaust.suggestedHood ? { neighborhood: exhaust.suggestedHood, filters: moreResult.activeFilters || {} } : null,
      });
      return;
    }

    const eventMap = buildEventMap(moreResult.events || []);
    const morePicks = composePicks.length > 0 ? composePicks : extractPicksFromSms(smsText, moreResult.events || []);

    saveResponseFrame(phone, {
      mode: 'more',
      picks: morePicks,
      prevSession: session,
      eventMap: session?.lastEvents || eventMap,
      neighborhood: moreResult.neighborhood,
      filters: moreResult.activeFilters || {},
      offeredIds: (moreResult.events || []).map(e => e.id),
      pending: (moreResult.isLastBatch && moreResult.suggestions?.length)
        ? { neighborhood: moreResult.suggestions[0], filters: moreResult.activeFilters || {} }
        : null,
    });
    return;
  }

  // Regular search (new_search, refine, pivot)
  const poolResult = result?._poolResult;
  if (!poolResult) return;

  const eventMap = buildEventMap(poolResult.curated || []);
  for (const e of (poolResult.pool || [])) eventMap[e.id] = e;

  const allEvents = [...(poolResult.curated || []), ...(poolResult.pool || [])];
  const searchPicks = composePicks.length > 0 ? composePicks : extractPicksFromSms(smsText, allEvents);

  saveResponseFrame(phone, {
    picks: searchPicks,
    eventMap,
    neighborhood: poolResult.hood,
    borough: poolResult.borough,
    filters: poolResult.activeFilters,
    offeredIds: searchPicks.map(p => p.event_id),
    visitedHoods: [...new Set([...(session?.visitedHoods || []), poolResult.hood || poolResult.borough || 'citywide'])],
    pending: poolResult.suggestedHood ? { neighborhood: poolResult.suggestedHood, filters: poolResult.activeFilters } : null,
  });

  updateProfile(phone, { neighborhood: poolResult.hood, filters: poolResult.activeFilters, responseType: 'event_picks' })
    .catch(err => console.error('profile update failed:', err.message));
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function handleAgentRequest(phone, message, session, trace, finalizeTrace) {
  const masked = maskPhone(phone);

  // Set up session + history
  if (!getSession(phone)) setSession(phone, {});
  addToHistory(phone, 'user', message);

  const systemPrompt = buildBrainSystemPrompt(session);

  try {
    // Track raw results (with _ fields) for session save
    const rawResults = [];
    const executeAndTrack = async (toolName, params) => {
      const result = await executeTool(toolName, params, session, phone, trace);
      rawResults.push({ name: toolName, params, result });
      return sanitizeForLLM(result);  // LLM only sees clean version
    };

    const loopResult = await runAgentLoop(
      MODELS.brain, systemPrompt, message, BRAIN_TOOLS,
      executeAndTrack,
      { maxIterations: 3, timeout: 12000, stopTools: ['respond', 'compose_sms'] }
    );

    // Record costs
    recordAICost(trace, 'brain', loopResult.totalUsage, loopResult.provider);
    trackAICost(phone, loopResult.totalUsage, loopResult.provider);

    // Trace
    trace.brain_provider = loopResult.provider;
    trace.brain_tool_calls = loopResult.toolCalls.map(tc => ({ name: tc.name, params: tc.params }));
    trace.routing.pre_routed = false;
    trace.routing.provider = loopResult.provider;

    // Determine SMS: compose_sms > respond > _smsText (details) > loopResult.text
    let smsText;
    const lastCompose = [...rawResults].reverse().find(tc => tc.name === 'compose_sms');
    const lastRespond = [...rawResults].reverse().find(tc => tc.name === 'respond');
    const detailsResult = [...rawResults].reverse().find(tc => tc.result?._smsText);
    if (lastCompose) {
      smsText = lastCompose.params.sms_text;
    } else if (lastRespond) {
      smsText = lastRespond.params.message;
    } else if (detailsResult) {
      smsText = detailsResult.result._smsText;
    } else {
      smsText = loopResult.text;
    }
    // Fallback: if model failed to compose (MALFORMED_FUNCTION_CALL), build SMS from pool
    if (!smsText) {
      const lastSearchFb = [...rawResults].reverse().find(tc => tc.name === 'search_events');
      const pool = lastSearchFb?.result?._poolResult?.pool;
      if (pool?.length > 0) {
        const top3 = pool.slice(0, 3);
        const hood = lastSearchFb.result?._poolResult?.hood || 'NYC';
        const lines = top3.map(e => {
          const price = e.is_free ? 'free' : (e.price_display || 'check price');
          return `${e.name} — ${e.venue_name}, ${e.start_time_local ? new Date(e.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : 'tonight'} (${price})`;
        });
        smsText = `Tonight in ${hood}:\n\n${lines.join('\n')}\n\nReply 1-3 for details or MORE for more picks.`;
        console.warn(`[agent-loop] Used template fallback for SMS composition`);
      }
    }
    smsText = smartTruncate(smsText || "Tell me what you're in the mood for -- drop a neighborhood or a vibe.");

    // History
    for (const tc of rawResults) {
      addToHistory(phone, 'tool_call', '', { name: tc.name, params: tc.params });
    }

    // Session save
    saveSessionFromToolCalls(phone, session, rawResults, smsText);

    // Price injection for search results
    const lastSearch = [...rawResults].reverse().find(tc => tc.name === 'search_events');
    if (lastSearch?.result?._poolResult) {
      const poolResult = lastSearch.result._poolResult;
      const eventMap = buildEventMap(poolResult.curated || []);
      for (const e of (poolResult.pool || [])) eventMap[e.id] = e;
      const allEvents = [...(poolResult.curated || []), ...(poolResult.pool || [])];
      const pricePicks = lastCompose
        ? (lastCompose.params.picks || []).map((id, i) => ({ rank: i + 1, event_id: id }))
        : extractPicksFromSms(smsText, allEvents);
      if (pricePicks.length > 0) {
        smsText = injectMissingPrices(smsText, pricePicks, eventMap);
      }
    }

    const intent = deriveIntent(rawResults);
    await sendSMS(phone, smsText);

    // Send pick URLs for details
    if (intent === 'details' && lastSearch?.result?._detailsResult) {
      const dr = lastSearch.result._detailsResult;
      if (dr.found && dr.event) {
        await sendPickUrls(phone, [dr.pick], { [dr.event.id]: dr.event });
      }
    }

    finalizeTrace(smsText, intent);

  } catch (err) {
    console.error('Agent loop error:', err.message);
    trace.brain_error = err.message;

    // Fallback to secondary model
    if (!err.message?.includes('fallback')) {
      try {
        console.warn(`Agent loop ${MODELS.brain} failed, trying ${MODELS.fallback}: ${err.message}`);
        const fallbackResult = await runAgentLoop(
          MODELS.fallback, systemPrompt, message, BRAIN_TOOLS,
          async (toolName, params) => sanitizeForLLM(await executeTool(toolName, params, session, phone, trace)),
          { maxIterations: 2, timeout: 12000, stopTools: ['respond', 'compose_sms'] }
        );

        recordAICost(trace, 'brain_fallback', fallbackResult.totalUsage, fallbackResult.provider);
        trackAICost(phone, fallbackResult.totalUsage, fallbackResult.provider);

        const fbCompose = [...fallbackResult.toolCalls].reverse().find(tc => tc.name === 'compose_sms');
        const fbRespond = [...fallbackResult.toolCalls].reverse().find(tc => tc.name === 'respond');
        let fbSmsText = fbCompose ? fbCompose.params.sms_text : fbRespond ? fbRespond.params.message : fallbackResult.text;
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

module.exports = {
  handleAgentRequest,
  executeTool,
  sanitizeForLLM,
  saveSessionFromToolCalls,
  extractPicksFromSms,
  deriveIntent,
};
