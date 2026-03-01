const express = require('express');
const twilio = require('twilio');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { formatTime, smartTruncate } = require('./formatters');
const { startTrace, saveTrace, getLatestTraceForPhone, getTraceById, recordAICost } = require('./traces');
const { getSession, setSession, clearSession, addToHistory, clearSessionInterval, acquireLock } = require('./session');
const { preRoute } = require('./pre-router');
const { handleHelp, handleConversational, handleDetails, handleMore } = require('./intent-handlers');
const { sendRuntimeAlert } = require('./alerts');
const { getEventById } = require('./events');
const { lookupReferralCode, recordAttribution } = require('./referral');
const { saveResponseFrame, buildEventMap } = require('./pipeline');
const { updateProfile } = require('./preference-profile');
const { routeModel } = require('./model-router');
const { processedMessages, OPT_OUT_KEYWORDS, isOverBudget, trackAICost, getCostSummary, getBudgetUsedPct, ipRateLimits, IP_RATE_LIMIT, IP_RATE_WINDOW, clearGuardIntervals } = require('./request-guard');
const { resolveUnifiedContext, callUnified, handleUnifiedResponse, handleZeroMatch } = require('./unified-flow');

const router = express.Router();

// In-flight request counter for graceful shutdown
let inflightRequests = 0;
function getInflightCount() { return inflightRequests; }

// --- Twilio webhook signature validation ---
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
if (twilioAuthToken) {
  router.use('/incoming', twilio.webhook({ validate: true }));
}

// =======================================================
// Test endpoint — runs full pipeline, returns response over HTTP
// Gated behind PULSE_TEST_MODE=true env var
// =======================================================

const CORS_ORIGIN = 'https://jkoufopoulos.github.io';

function setCorsHeaders(res) {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

if (process.env.PULSE_TEST_MODE === 'true') {
  // CORS preflight
  router.options('/test', (req, res) => {
    setCorsHeaders(res);
    res.sendStatus(204);
  });

  router.post('/test', async (req, res) => {
    setCorsHeaders(res);

    // IP rate limit (skip when PULSE_NO_RATE_LIMIT is set for eval runs)
    if (!process.env.PULSE_NO_RATE_LIMIT) {
      const ip = req.ip;
      const now = Date.now();
      const entry = ipRateLimits.get(ip);
      if (entry && now < entry.resetTime) {
        if (entry.count >= IP_RATE_LIMIT) {
          return res.status(429).json({ error: 'Rate limit exceeded' });
        }
        entry.count++;
      } else {
        ipRateLimits.set(ip, { count: 1, resetTime: now + IP_RATE_WINDOW });
      }
    }

    const { Body: message, From: phone } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Missing Body parameter' });
    }
    const testPhone = phone || '+10000000000';
    enableTestCapture(testPhone);
    const TEST_TIMEOUT_MS = 25000; // 25s — return before Railway's 30s proxy timeout
    try {
      const traceId = await Promise.race([
        handleMessage(testPhone, message.trim()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out (25s)')), TEST_TIMEOUT_MS)),
      ]);
      const captured = disableTestCapture(testPhone);
      const trace = traceId ? getTraceById(traceId) : getLatestTraceForPhone(maskPhone(testPhone));
      const trace_summary = trace ? {
        id: trace.id,
        intent: trace.output_intent,
        neighborhood: trace.routing?.resolved_neighborhood,
        cache_size: trace.events?.cache_size,
        candidates_count: trace.events?.candidates_count,
        sent_to_claude: trace.events?.sent_to_claude,
        sent_pool: trace.events?.sent_pool,
        pool_meta: trace.events?.pool_meta,
        picks: trace.composition?.picks,
      } : null;
      res.json({ ok: true, messages: captured, trace_summary, trace });
    } catch (err) {
      const captured = disableTestCapture(testPhone);
      res.status(500).json({ error: err.message, messages: captured });
    }
  });
  console.log('Test endpoint enabled: POST /api/sms/test');
}

// =======================================================
// Webhook endpoint — responds immediately, processes async
// =======================================================

router.post('/incoming', (req, res) => {
  const { Body: message, From: phone, MessageSid: messageSid } = req.body;

  if (!message?.trim() || !phone) {
    return res.status(400).send('Missing message or phone number');
  }

  // Dedup: if we already processed this MessageSid, skip
  if (messageSid && processedMessages.has(messageSid)) {
    console.log(`Duplicate MessageSid ${messageSid}, skipping`);
    res.type('text/xml').send('<Response></Response>');
    return;
  }

  // Respond to Twilio immediately — prevents timeout + retries
  res.type('text/xml').send('<Response></Response>');

  // Register MessageSid only after processing succeeds — if handler crashes,
  // Twilio retries won't be permanently dropped (L13 fix)
  inflightRequests++;
  handleMessage(phone, message)
    .then(() => {
      if (messageSid) processedMessages.set(messageSid, Date.now());
    })
    .catch(err => {
      console.error('Async handler error:', err.message);
    })
    .finally(() => inflightRequests--);
});

// =======================================================
// Async message handler
// =======================================================

async function handleMessage(phone, message) {
  const unlock = await acquireLock(phone);
  try {
    const masked = maskPhone(phone);
    console.log(`SMS from ${masked}: ${message.slice(0, 80)}`);

    // TCPA compliance: never respond to opt-out keywords
    if (OPT_OUT_KEYWORDS.test(message.trim())) {
      console.log(`Opt-out keyword from ${masked}, not responding`);
      return;
    }

    if (!process.env.PULSE_TEST_MODE && isOverBudget(phone)) {
      console.warn(`Over daily AI budget: ${masked}`);
      await sendSMS(phone, "You've hit your daily limit — check back tomorrow for more picks!");
      return;
    }

    try {
      return await handleMessageAI(phone, message);
    } catch (err) {
      console.error('AI flow error:', err.message);
      try {
        await sendSMS(phone, "Bestie hit a snag — try again in a sec!");
      } catch (smsErr) {
        console.error(`[CRITICAL] Double failure for ${masked}: AI error="${err.message}", SMS error="${smsErr.message}" — user received nothing`);
      }
    }
  } finally {
    unlock();
  }
}

// =======================================================
// Orchestrator — routes message to the right intent handler
// =======================================================

/**
 * Dispatch pre-router mechanical shortcuts (referral, help, conversational, details, more).
 * All paths are terminal: sendSMS + finalizeTrace + return.
 */
async function dispatchPreRouterIntent(route, ctx) {
  const { phone, session, finalizeTrace } = ctx;

  if (route.intent === 'referral') {
    const referral = lookupReferralCode(route.referralCode);
    if (referral) {
      recordAttribution(phone, route.referralCode);
      const referredEvent = getEventById(referral.eventId);
      updateProfile(phone, {
        neighborhood: referredEvent?.neighborhood || null,
        filters: referredEvent?.category ? { category: referredEvent.category } : {},
        responseType: 'referral',
      }).catch(err => console.error('profile update failed:', err.message));
      const sms = referredEvent?.neighborhood
        ? `Hey! I'm Bestie — tell me what you're looking for or try "${referredEvent.neighborhood}" to get started!`
        : "Hey! I'm Bestie — tell me what you're looking for or text a neighborhood.";
      saveResponseFrame(phone, { picks: [], eventMap: {}, neighborhood: null, filters: null, offeredIds: [] });
      await sendSMS(phone, sms);
      finalizeTrace(sms, 'referral');
      return;
    }
    const sms = "Hey! I'm Bestie — tell me what you're looking for or text a neighborhood.";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'referral_expired');
    return;
  }

  if (route.intent === 'help') return handleHelp(ctx);
  if (route.intent === 'conversational') return handleConversational(ctx);
  if (route.intent === 'details') return handleDetails(ctx);

  if (route.intent === 'more') {
    ctx.neighborhood = session?.lastNeighborhood || null;
    try {
      return await handleMore(ctx);
    } catch (err) {
      console.error('more handler error:', err.message);
      const sms = "Couldn't load more picks right now — try again in a sec!";
      await sendSMS(phone, sms);
      finalizeTrace(sms, 'more');
    }
  }
}

async function handleMessageAI(phone, message) {
  const traceStart = Date.now();
  const masked = maskPhone(phone);
  let session = getSession(phone);
  const trace = startTrace(masked, message);

  if (session) {
    trace.session_before = {
      lastNeighborhood: session.lastNeighborhood || null,
      lastPicks: (session.lastPicks || []).map(p => ({ event_id: p.event_id })),
    };
  }

  function finalizeTrace(smsText, intent) {
    if (smsText) addToHistory(phone, 'assistant', smsText);
    trace.output_sms = smsText || null;
    trace.output_sms_length = smsText ? smsText.length : 0;
    trace.output_intent = intent || trace.routing.result?.intent || null;
    trace.total_latency_ms = Date.now() - traceStart;
    saveTrace(trace);

    const SLOW_THRESHOLD_MS = 10000;
    if (trace.total_latency_ms > SLOW_THRESHOLD_MS) {
      const breakdown = [
        `route: ${trace.routing.latency_ms}ms`,
        trace.events.getEvents_ms != null ? `events: ${trace.events.getEvents_ms}ms` : null,
        `compose: ${trace.composition.latency_ms}ms`,
        `total: ${trace.total_latency_ms}ms`,
      ].filter(Boolean).join(' | ');
      console.warn(`[SLOW] ${(trace.total_latency_ms / 1000).toFixed(1)}s | ${breakdown} | intent=${trace.output_intent} | msg="${trace.input_message.slice(0, 40)}"`);

      sendRuntimeAlert('slow_response', {
        total_ms: trace.total_latency_ms,
        routing_ms: trace.routing.latency_ms,
        compose_ms: trace.composition.latency_ms,
        events_ms: trace.events.getEvents_ms,
        intent: trace.output_intent,
        phone_masked: trace.phone_masked,
        message: trace.input_message,
      });
    }
  }

  // --- Route ---
  const preRouted = preRoute(message, session);
  // Snapshot previous conversation history BEFORE adding current message
  // (so Claude doesn't see the current message duplicated in both <user_message> and history)
  if (!getSession(phone)) setSession(phone, {});
  const history = getSession(phone)?.conversationHistory || [];
  addToHistory(phone, 'user', message);

  // Pre-router filter follow-ups: inject detected filters into session for unified branch
  let preDetectedFilters = null;
  if (preRouted && preRouted.intent === 'events') {
    if (preRouted.clearFilters) {
      // Deterministic filter clear (P6) — wipe session filters before unified call
      setSession(phone, { lastFilters: null, pendingFilters: null });
      session = getSession(phone);
      trace.routing.pre_routed = true;
      trace.routing.result = { intent: 'events', neighborhood: preRouted.neighborhood, confidence: 1.0 };
      trace.routing.latency_ms = 0;
      trace.routing.clear_filters = true;
      console.log(`Pre route (pre): clear_filters detected → unified with no filters`);
    } else {
      // Deterministic filter detection (category/time/vibe/free) — use unified branch for composition
      preDetectedFilters = preRouted.filters;
      trace.routing.pre_routed = true;
      trace.routing.result = { intent: preRouted.intent, neighborhood: preRouted.neighborhood, confidence: preRouted.confidence };
      trace.routing.latency_ms = 0;
      console.log(`Pre route (pre): intent=${preRouted.intent}, neighborhood=${preRouted.neighborhood} → unified with filters`);
    }
  }

  if (preRouted && !preDetectedFilters && !preRouted.clearFilters) {
    // Pre-router matched — mechanical shortcuts
    const route = preRouted;
    trace.routing.pre_routed = true;
    trace.routing.result = { intent: route.intent, neighborhood: route.neighborhood, confidence: route.confidence };
    trace.routing.latency_ms = 0;
    console.log(`Pre route (pre): intent=${route.intent}, neighborhood=${route.neighborhood}, confidence=${route.confidence}`);

    const ctx = { phone, message, masked, session, trace, route, finalizeTrace, trackAICost: (usage, provider) => trackAICost(phone, usage, provider), recordAICost };

    // Clear pending state on any pre-routed intent
    if (session?.pendingNearby) {
      setSession(phone, { pendingNearby: null, pendingFilters: null, pendingMessage: null });
    }

    await dispatchPreRouterIntent(route, ctx);
    return trace.id;
  }

  // Unified LLM call — handles semantic messages + pre-detected filter follow-ups
  const unifiedCtx = await resolveUnifiedContext(message, session, preDetectedFilters, phone, trace);

  // Zero-match bypass: when filters are active but match nothing, skip the LLM ($0 AI cost).
  // Skip if the LAST response was also a zero-match — let the LLM interpret the follow-up
  // (e.g. "paid is fine too" needs semantic understanding to clear free_only).
  // The flag auto-clears after one LLM turn via setResponseState.
  if (Object.values(unifiedCtx.activeFilters || {}).some(Boolean) &&
      unifiedCtx.matchCount === 0 && !session?.lastZeroMatch) {
    await handleZeroMatch(unifiedCtx, phone, session, trace, finalizeTrace);
    return trace.id;
  }

  // Compute model routing based on complexity signals
  const budgetUsedPct = getBudgetUsedPct(phone);

  const routing = routeModel({
    message,
    session,
    matchCount: unifiedCtx.matchCount,
    hardCount: unifiedCtx.hardCount,
    softCount: unifiedCtx.softCount,
    isSparse: unifiedCtx.isSparse,
    hood: unifiedCtx.hood,
    activeFilters: unifiedCtx.activeFilters,
    events: unifiedCtx.events,
    conversationHistory: history,
    isCitywide: unifiedCtx.isCitywide,
    hasPreDetectedFilters: !!preDetectedFilters,
    budgetUsedPct,
  });
  trace.routing.model_routing = routing;

  try {
    const result = await callUnified(message, unifiedCtx, session, history, phone, trace, { model: routing.model });
    await handleUnifiedResponse(result, unifiedCtx, phone, session, trace, message, finalizeTrace);
    // Clear lastZeroMatch after LLM turn so zero-match bypass can fire on the next turn
    if (session?.lastZeroMatch) setSession(phone, { lastZeroMatch: false });
  } catch (llmErr) {
    console.error('LLM failed, degraded fallback:', llmErr.message);
    await handleDegradedFallback(unifiedCtx, phone, session, trace, finalizeTrace, llmErr);
  }
  return trace.id;
}

/**
 * Degraded-mode fallback: compose deterministic picks from the pre-resolved
 * tagged pool when the LLM call fails. $0 AI cost, session saved (P4).
 */
async function handleDegradedFallback(unifiedCtx, phone, session, trace, finalizeTrace, err) {
  const { hood, activeFilters, events, curated } = unifiedCtx;

  // Pick top 3, preferring filter-matched events
  const matched = events.filter(e => e.filter_match === 'hard' || e.filter_match === 'soft');
  const pool = matched.length > 0 ? matched : events;
  const top = pool.slice(0, 3);

  if (top.length === 0) {
    trace.composition.latency_ms = 0;
    trace.composition.degraded_mode = true;
    trace.composition.degraded_error = err.message;
    const sms = "I'm having a moment — try again in a sec!";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'events');
    return;
  }

  // Format numbered picks deterministically
  const header = hood ? `Here's what's happening in ${hood}:` : "Here's what's happening tonight:";
  const lines = top.map((e, i) => {
    let line = `${i + 1}. ${e.name}`;
    if (e.venue_name && e.venue_name !== 'TBA') line += ` at ${e.venue_name}`;
    if (e.start_time_local) line += ` — ${formatTime(e.start_time_local)}`;
    if (e.is_free) line += ' (Free!)';
    return line;
  });
  const footer = 'Reply a number for details, or "more" for more picks.';
  const sms = smartTruncate(`${header}\n\n${lines.join('\n')}\n\n${footer}`);

  // P4: one save path — save session with fallback picks
  const eventMap = buildEventMap(curated);
  for (const e of events) eventMap[e.id] = e;
  const picks = top.map(e => ({ event_id: e.id, why: 'degraded fallback' }));

  saveResponseFrame(phone, {
    picks,
    eventMap,
    neighborhood: hood,
    filters: activeFilters,
    offeredIds: top.map(e => e.id),
    visitedHoods: [...new Set([...(session?.visitedHoods || []), hood || 'citywide'])],
  });

  trace.routing.latency_ms = trace.routing.latency_ms || 0;
  trace.composition.latency_ms = 0;
  trace.composition.degraded_mode = true;
  trace.composition.degraded_error = err.message;
  trace.composition.picks = top.map(e => ({
    event_id: e.id, why: 'degraded fallback',
    event_name: e.name, venue_name: e.venue_name,
    neighborhood: e.neighborhood, category: e.category,
  }));

  await sendSMS(phone, sms);
  finalizeTrace(sms, 'events');

  // Fire-and-forget runtime alert
  sendRuntimeAlert('llm_failure', {
    error: err.message,
    phone_masked: maskPhone(phone),
    hood,
    event_count: events.length,
    degraded_picks: top.length,
  });
}

// Cleanup intervals (for graceful shutdown)
function clearSmsIntervals() {
  clearGuardIntervals();
  clearSessionInterval();
}

module.exports = router;
module.exports.clearSmsIntervals = clearSmsIntervals;
module.exports.setSession = setSession;
module.exports.clearSession = clearSession;
module.exports._handleMessage = handleMessage; // exported for integration tests
module.exports.OPT_OUT_KEYWORDS = OPT_OUT_KEYWORDS;
module.exports.getCostSummary = getCostSummary;
module.exports.getInflightCount = getInflightCount;
