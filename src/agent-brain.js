/**
 * Agent Brain — Orchestrator for Pulse's LLM-powered SMS agent.
 *
 * Routes incoming messages: checkMechanical (help + TCPA, $0) → callAgentBrain (Gemini tool calling).
 * Tool execution and LLM calling are split into brain-execute.js and brain-llm.js.
 *
 * This file re-exports from both modules so existing require('./agent-brain') calls work unchanged.
 */

const { extractNeighborhood, NEIGHBORHOODS, detectBorough } = require('./neighborhoods');
const { getAdjacentNeighborhoods } = require('./geo');
const { sendSMS, maskPhone } = require('./twilio');
const { startTrace, saveTrace, recordAICost } = require('./traces');
const { getSession, setSession, addToHistory } = require('./session');
const { trackAICost, OPT_OUT_KEYWORDS } = require('./request-guard');
const { handleHelp } = require('./intent-handlers');
const { saveResponseFrame, buildEventMap, buildExhaustionMessage, describeFilters, sendPickUrls } = require('./pipeline');
const { smartTruncate } = require('./formatters');
const { sendRuntimeAlert } = require('./alerts');
const { updateProfile } = require('./preference-profile');
const { getNycDateString } = require('./geo');

// Split modules
const {
  callAgentBrain, continueWithResults, serializePoolForContinuation,
  brainCompose, welcomeCompose, buildBrainSystemPrompt,
  GEMINI_SAFETY, getGeminiClient, BRAIN_COMPOSE_SYSTEM, BRAIN_COMPOSE_SCHEMA,
  WELCOME_COMPOSE_SYSTEM, extractGeminiUsage, callAgentBrainAnthropic,
  withTimeout, stripCodeFences, reconcilePicks, BRAIN_TOOLS,
} = require('./brain-llm');
const {
  executeSearchEvents, executeRespond, handleWelcome,
  executeMore, executeDetails, buildSearchPool, resolveDateRange, validatePicks,
} = require('./brain-execute');

// --- Mechanical shortcuts ($0) ---

function checkMechanical(message, session) {
  const lower = message.toLowerCase().trim();

  // Help
  if (/^(help|\?)$/i.test(lower)) return { intent: 'help' };

  // TCPA (belt-and-suspenders — request-guard already handles this)
  if (OPT_OUT_KEYWORDS.test(lower)) return null;

  // Everything else → agent brain
  return null;
}

/**
 * Detect if this is a first-touch message (no session context).
 */
function isFirstMessage(session) {
  return !session || (!session.lastPicks?.length && !session.lastNeighborhood && !session.conversationHistory?.length);
}

// --- Main orchestrator ---

async function handleAgentBrainRequest(phone, message, session, trace, finalizeTrace) {
  const masked = maskPhone(phone);

  // Snapshot history BEFORE adding current message
  const history = session?.conversationHistory || [];
  if (!getSession(phone)) setSession(phone, {});
  addToHistory(phone, 'user', message);

  // First-message welcome flow: intercept vague cold opens for new users.
  // Skip if the message has specific intent (neighborhood, category, time, etc.)
  // — those should go through the normal agent brain for targeted results.
  const hasSpecificIntent = extractNeighborhood(message) || detectBorough(message);
  if (isFirstMessage(session) && !hasSpecificIntent) {
    try {
      const welcomeResult = await handleWelcome(phone, session, trace);
      trace.routing.pre_routed = true;
      trace.routing.result = { intent: 'welcome', confidence: 1.0 };
      trace.routing.latency_ms = 0;
      trace.brain_tool = 'welcome';
      trace.brain_provider = 'welcome';

      await sendSMS(phone, welcomeResult.sms);
      if (welcomeResult.picks?.length) await sendPickUrls(phone, welcomeResult.picks, welcomeResult.eventMap);
      finalizeTrace(welcomeResult.sms, welcomeResult.intent);
      return trace.id;
    } catch (err) {
      console.warn('Welcome flow failed, falling back to agent brain:', err.message);
      // Fall through to normal agent brain flow
    }
  }

  try {
    // Call the brain
    const brainResult = await callAgentBrain(message, session, phone, trace);

    // Record brain trace data
    trace.brain_tool = brainResult.tool;
    trace.brain_params = brainResult.params;
    trace.brain_latency_ms = brainResult.latency_ms;
    trace.brain_provider = brainResult.provider;
    trace.routing.pre_routed = false;
    trace.routing.latency_ms = brainResult.latency_ms;
    trace.routing.provider = brainResult.provider;
    // Populate model_routing for eval compatibility
    trace.routing.model_routing = {
      score: 0,
      tier: 'brain',
      model: brainResult.provider === 'gemini' ? 'gemini-2.5-flash-lite' : 'claude-haiku-4.5',
    };

    recordAICost(trace, 'brain', brainResult.usage, brainResult.provider);
    trackAICost(phone, brainResult.usage, brainResult.provider);

    console.log(`Agent brain: tool=${brainResult.tool}, params=${JSON.stringify(brainResult.params)}, provider=${brainResult.provider}, ${brainResult.latency_ms}ms`);

    // Record tool call in structured history
    addToHistory(phone, 'tool_call', '', {
      name: brainResult.tool,
      params: brainResult.params,
    });

    // Execute the tool
    let execResult;

    if (brainResult.tool === 'search_events' && brainResult.params.intent === 'more') {
      // --- More intent: pull next batch from session pool ---
      const moreResult = executeMore(session);

      if (moreResult.noContext) {
        execResult = {
          sms: "Tell me what you're in the mood for — comedy, live music, something weird? Or drop a neighborhood.",
          intent: 'conversational',
        };
      } else if (moreResult.exhausted) {
        const exhaust = buildExhaustionMessage(moreResult.neighborhood, {
          adjacentHoods: moreResult.neighborhood ? getAdjacentNeighborhoods(moreResult.neighborhood, 4) : [],
          visitedHoods: session?.visitedHoods || [moreResult.neighborhood].filter(Boolean),
          filters: moreResult.activeFilters || {},
          borough: session?.lastBorough,
        });
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
        addToHistory(phone, 'tool_result', '', {
          match_count: 0,
          neighborhood: moreResult.neighborhood || 'unknown',
          exhausted: true,
        });
        execResult = { sms: exhaust.message, intent: 'more' };
      } else if (brainResult.chat) {
        // Single-turn: continue same Gemini session with more events
        try {
          const todayNyc = getNycDateString(0);
          const tomorrowNyc = getNycDateString(1);
          const eventData = {
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

          const composeResult = await continueWithResults(brainResult.chat, eventData, trace);
          recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
          trackAICost(phone, composeResult._usage, composeResult._provider);
          trace.composition.raw_response = composeResult._raw || null;
          trace.composition.neighborhood_used = moreResult.neighborhood;

          // Validate picks against the more batch
          const validPicks = validatePicks(composeResult.picks, moreResult.events);
          const eventMap = buildEventMap(moreResult.events);

          trace.composition.picks = validPicks.map(p => {
            const evt = eventMap[p.event_id];
            return { ...p, date_local: evt?.date_local || null, event_name: evt?.name || null,
              venue_name: evt?.venue_name || null, neighborhood: evt?.neighborhood || null,
              category: evt?.category || null, is_free: evt?.is_free ?? null,
              price_display: evt?.price_display || null, start_time_local: evt?.start_time_local || null,
              source_vibe: evt?.source_vibe || null };
          });

          saveResponseFrame(phone, {
            mode: 'more',
            picks: validPicks,
            prevSession: session,
            eventMap: session?.lastEvents || eventMap,
            neighborhood: moreResult.neighborhood,
            filters: moreResult.activeFilters || {},
            offeredIds: moreResult.events.map(e => e.id),
            pending: (moreResult.isLastBatch && moreResult.suggestions?.length) ? { neighborhood: moreResult.suggestions[0], filters: moreResult.activeFilters || {} } : null,
          });

          addToHistory(phone, 'tool_result', '', {
            picks: validPicks.slice(0, 3).map(p => {
              const evt = eventMap[p.event_id];
              return { name: evt?.name, category: evt?.category, neighborhood: evt?.neighborhood };
            }),
            match_count: moreResult.events.length,
            neighborhood: moreResult.neighborhood || 'unknown',
          });

          execResult = {
            sms: composeResult.sms_text,
            intent: 'more',
            picks: validPicks,
            activeFilters: moreResult.activeFilters,
            eventMap,
          };
        } catch (err) {
          // Fallback to brainCompose if continuation fails
          console.warn('More continuation failed, falling back to brainCompose:', err.message);
          trace.brain_error = (trace.brain_error || '') + ` more_continuation: ${err.message}`;
          const composed = await brainCompose(moreResult.events, {
            neighborhood: moreResult.neighborhood || 'NYC',
            activeFilters: moreResult.activeFilters || {},
          });
          recordAICost(trace, 'compose', composed._usage, composed._provider);
          trackAICost(phone, composed._usage, composed._provider);
          const validPicks = validatePicks(composed.picks, moreResult.events);
          const eventMap = buildEventMap(moreResult.events);
          saveResponseFrame(phone, {
            mode: 'more',
            picks: validPicks,
            prevSession: session,
            eventMap: session?.lastEvents || eventMap,
            neighborhood: moreResult.neighborhood,
            filters: moreResult.activeFilters || {},
            offeredIds: moreResult.events.map(e => e.id),
          });
          addToHistory(phone, 'tool_result', '', {
            picks: validPicks.slice(0, 3).map(p => {
              const evt = eventMap[p.event_id];
              return { name: evt?.name, category: evt?.category, neighborhood: evt?.neighborhood };
            }),
            match_count: moreResult.events.length,
            neighborhood: moreResult.neighborhood || 'unknown',
          });
          execResult = { sms: composed.sms_text, intent: 'more', picks: validPicks, eventMap };
        }
      } else {
        // Anthropic fallback — skip Gemini for compose since it already failed for routing
        const composed = await brainCompose(moreResult.events, {
          neighborhood: moreResult.neighborhood || 'NYC',
          activeFilters: moreResult.activeFilters || {},
          skipGemini: true,
        });
        recordAICost(trace, 'compose', composed._usage, composed._provider);
        trackAICost(phone, composed._usage, composed._provider);
        const validPicks = validatePicks(composed.picks, moreResult.events);
        const eventMap = buildEventMap(moreResult.events);
        saveResponseFrame(phone, {
          mode: 'more',
          picks: validPicks,
          prevSession: session,
          eventMap: session?.lastEvents || eventMap,
          neighborhood: moreResult.neighborhood,
          filters: moreResult.activeFilters || {},
          offeredIds: moreResult.events.map(e => e.id),
        });
        addToHistory(phone, 'tool_result', '', {
          picks: validPicks.slice(0, 3).map(p => {
            const evt = eventMap[p.event_id];
            return { name: evt?.name, category: evt?.category, neighborhood: evt?.neighborhood };
          }),
          match_count: moreResult.events.length,
          neighborhood: moreResult.neighborhood || 'unknown',
        });
        execResult = { sms: composed.sms_text, intent: 'more', picks: validPicks, eventMap };
      }
    } else if (brainResult.tool === 'search_events' && brainResult.params.intent === 'details') {
      // --- Details intent: match pick_reference against session lastPicks ---
      const detailsResult = executeDetails(brainResult.params.pick_reference, session);

      if (detailsResult.noPicks) {
        execResult = { sms: "I don't have any picks loaded — tell me what you're looking for!", intent: 'details' };
      } else if (detailsResult.stalePicks) {
        const hood = detailsResult.neighborhood;
        const sms = hood
          ? `I don't have a pick list up right now — ask for more ${hood} picks, or tell me what you're looking for!`
          : "I don't have a pick list up right now — tell me what you're looking for!";
        execResult = { sms, intent: 'details' };
      } else if (!detailsResult.found) {
        execResult = { sms: "I'm not sure which event you mean — can you be more specific?", intent: 'details' };
      } else if (brainResult.chat) {
        // Continue Gemini session with event details
        const event = detailsResult.event;
        const eventData = {
          intent: 'details',
          event: {
            id: event.id, name: event.name, venue_name: event.venue_name,
            neighborhood: event.neighborhood, category: event.category,
            start_time_local: event.start_time_local, date_local: event.date_local,
            is_free: event.is_free, price_display: event.price_display,
            description: event.description_short || event.short_detail || '',
            ticket_url: event.ticket_url || event.source_url || null,
            venue_address: event.venue_address || null,
            why: detailsResult.pick?.why || '',
          },
        };

        try {
          const composeResult = await continueWithResults(brainResult.chat, eventData, trace);
          recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
          trackAICost(phone, composeResult._usage, composeResult._provider);
          trace.composition.raw_response = composeResult._raw || null;
          execResult = { sms: smartTruncate(composeResult.sms_text), intent: 'details' };
        } catch (err) {
          console.warn('Details continuation failed, falling back to composeDetails:', err.message);
          const { composeDetails } = require('./ai');
          const result = await composeDetails(event, detailsResult.pick?.why);
          recordAICost(trace, 'compose', result._usage, result._provider);
          trackAICost(phone, result._usage, result._provider);
          execResult = { sms: smartTruncate(result.sms_text), intent: 'details' };
        }
      } else {
        // Anthropic fallback — skip Gemini for compose since it already failed for routing
        const { composeDetails } = require('./ai');
        const event = detailsResult.event;
        const result = await composeDetails(event, detailsResult.pick?.why, { skipGemini: true });
        recordAICost(trace, 'compose', result._usage, result._provider);
        trackAICost(phone, result._usage, result._provider);
        execResult = { sms: smartTruncate(result.sms_text), intent: 'details' };
      }
    } else if (brainResult.tool === 'search_events') {
      const poolResult = await buildSearchPool(brainResult.params, session, phone, trace);

      if (poolResult.zeroMatch) {
        addToHistory(phone, 'tool_result', '', {
          match_count: 0,
          neighborhood: poolResult.zeroMatch.activeFilters?.neighborhood || 'unknown',
        });
        execResult = poolResult.zeroMatch;
      } else if (brainResult.chat) {
        // Single-turn: continue same Gemini session with event results
        try {
          const eventData = serializePoolForContinuation(poolResult);
          const composeResult = await continueWithResults(brainResult.chat, eventData, trace);

          recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
          trackAICost(phone, composeResult._usage, composeResult._provider);
          trace.composition.raw_response = composeResult._raw || null;
          trace.composition.active_filters = poolResult.activeFilters;
          trace.composition.neighborhood_used = poolResult.hood;

          // Validate picks + save session
          const eventMap = buildEventMap(poolResult.curated);
          for (const e of poolResult.pool) eventMap[e.id] = e;
          const allEvents = [...poolResult.curated, ...poolResult.pool.filter(e => !eventMap[e.id] || eventMap[e.id] === e)];
          const validPicks = validatePicks(composeResult.picks, allEvents);

          trace.composition.picks = validPicks.map(p => {
            const evt = eventMap[p.event_id];
            return { ...p, date_local: evt?.date_local || null, event_name: evt?.name || null,
              venue_name: evt?.venue_name || null, neighborhood: evt?.neighborhood || null,
              category: evt?.category || null, is_free: evt?.is_free ?? null,
              price_display: evt?.price_display || null, start_time_local: evt?.start_time_local || null,
              source_vibe: evt?.source_vibe || null };
          });

          saveResponseFrame(phone, {
            picks: validPicks, eventMap,
            neighborhood: poolResult.hood, borough: poolResult.borough,
            filters: poolResult.activeFilters,
            offeredIds: validPicks.map(p => p.event_id),
            visitedHoods: [...new Set([...(session?.visitedHoods || []), poolResult.hood || poolResult.borough || 'citywide'])],
            pending: poolResult.suggestedHood ? { neighborhood: poolResult.suggestedHood, filters: poolResult.activeFilters } : null,
          });

          updateProfile(phone, { neighborhood: poolResult.hood, filters: poolResult.activeFilters, responseType: 'event_picks' })
            .catch(err => console.error('profile update failed:', err.message));

          // Record tool result in structured history
          addToHistory(phone, 'tool_result', '', {
            picks: validPicks.slice(0, 3).map(p => {
              const evt = eventMap[p.event_id];
              return { name: evt?.name, category: evt?.category, neighborhood: evt?.neighborhood };
            }),
            match_count: poolResult.matchCount,
            neighborhood: poolResult.hood || poolResult.borough || 'citywide',
          });

          execResult = {
            sms: composeResult.sms_text,
            intent: validPicks.length > 0 ? 'events' : 'conversational',
            picks: validPicks,
            activeFilters: poolResult.activeFilters,
            eventMap,
          };
        } catch (err) {
          // Fallback to standalone brainCompose if continuation fails
          console.warn('Single-turn continuation failed, falling back to brainCompose:', err.message);
          trace.brain_error = (trace.brain_error || '') + ` continuation: ${err.message}`;
          execResult = await executeSearchEvents(brainResult.params, session, phone, trace);
        }
      } else {
        // Anthropic fallback — skip Gemini for compose since it already failed for routing
        execResult = await executeSearchEvents(brainResult.params, session, phone, trace, { skipGemini: true });
      }
    } else if (brainResult.tool === 'respond') {
      execResult = await executeRespond(brainResult.params, session, phone, trace);
    } else {
      // Unknown tool — treat as conversational
      execResult = { sms: "Having a moment — try again!", intent: 'conversational' };
    }

    // Send SMS and finalize
    await sendSMS(phone, execResult.sms);
    if (execResult.picks) await sendPickUrls(phone, execResult.picks, execResult.eventMap);
    finalizeTrace(execResult.sms, execResult.intent);

  } catch (err) {
    console.error('Agent brain error:', err.message);
    trace.brain_error = err.message;

    // Send a friendly error message
    const sms = "Pulse hit a snag — try again in a sec!";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'error');

    sendRuntimeAlert('agent_brain_error', {
      error: err.message,
      phone_masked: masked,
      message: message.slice(0, 80),
    });
  }

  return trace.id;
}

module.exports = {
  // Orchestrator
  checkMechanical, handleAgentBrainRequest,
  // Re-exports from brain-llm.js
  callAgentBrain, brainCompose, welcomeCompose, buildBrainSystemPrompt,
  // Re-exports from brain-execute.js
  resolveDateRange, validatePicks, buildSearchPool, executeMore, executeDetails, handleWelcome,
};
