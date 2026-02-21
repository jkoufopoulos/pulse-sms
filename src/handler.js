const express = require('express');
const twilio = require('twilio');
const { extractNeighborhood, NEIGHBORHOODS } = require('./neighborhoods');
const { routeMessage, composeResponse } = require('./ai');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { startTrace, saveTrace } = require('./traces');
const { getSession, setSession, clearSession, addToHistory, clearSessionInterval } = require('./session');
const { preRoute } = require('./pre-router');
const { handleHelp, handleConversational, handleDetails, handleMore, handleFree, handleNudgeAccept, handleEventsDefault } = require('./intent-handlers');
const { sendRuntimeAlert } = require('./alerts');

const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

const router = express.Router();

// --- Twilio webhook signature validation ---
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
if (twilioAuthToken) {
  router.use('/incoming', twilio.webhook({ validate: true }));
}

// --- Twilio retry deduplication ---
// Twilio sends the same MessageSid on retries. Track recent ones to avoid duplicate processing.
const processedMessages = new Map(); // MessageSid → timestamp
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes

// Clean stale dedup entries every 5 minutes
const dedupInterval = setInterval(() => {
  try {
    const cutoff = Date.now() - DEDUP_TTL;
    for (const [sid, ts] of processedMessages) {
      if (ts < cutoff) processedMessages.delete(sid);
    }
  } catch (e) { console.error('Dedup cleanup error:', e); }
}, 5 * 60 * 1000);

// --- Cost-based daily AI budget per user ---
const aiBudgets = new Map(); // phone → { cost_usd, date }
const DAILY_BUDGET_USD = 0.10;
// Per-token pricing by provider
const PRICING = {
  anthropic: { input: 1.00 / 1_000_000, output: 5.00 / 1_000_000 },  // Haiku 4.5
  gemini:    { input: 0.10 / 1_000_000, output: 0.40 / 1_000_000 },  // Gemini 2.0 Flash
};

function getNycDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isOverBudget(phone) {
  const today = getNycDate();
  const entry = aiBudgets.get(phone);
  if (!entry || entry.date !== today) return false;
  return entry.cost_usd >= DAILY_BUDGET_USD;
}

function trackAICost(phone, usage, provider = 'anthropic') {
  if (!usage) return;
  const pricing = PRICING[provider] || PRICING.anthropic;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cost = inputTokens * pricing.input + outputTokens * pricing.output;

  const today = getNycDate();
  const entry = aiBudgets.get(phone);
  if (!entry || entry.date !== today) {
    aiBudgets.set(phone, { cost_usd: cost, date: today });
  } else {
    entry.cost_usd += cost;
  }
}

// Clean stale budget + IP rate limit entries every 10 minutes
const rateLimitInterval = setInterval(() => {
  try {
    const today = getNycDate();
    for (const [phone, entry] of aiBudgets) {
      if (entry.date !== today) aiBudgets.delete(phone);
    }
    const now = Date.now();
    for (const [ip, entry] of ipRateLimits) {
      if (now >= entry.resetTime) ipRateLimits.delete(ip);
    }
  } catch (e) { console.error('Budget cleanup error:', e); }
}, 10 * 60 * 1000);

// =======================================================
// Test endpoint — runs full pipeline, returns response over HTTP
// Gated behind PULSE_TEST_MODE=true env var
// =======================================================

// --- IP-based rate limit for test endpoint (7 messages per IP per hour) ---
const ipRateLimits = new Map(); // ip → { count, resetTime }
const IP_RATE_LIMIT = 7;
const IP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour

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

    // IP rate limit
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

    const { Body: message, From: phone } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Missing Body parameter' });
    }
    const testPhone = phone || '+10000000000';
    enableTestCapture(testPhone);
    try {
      await handleMessage(testPhone, message.trim());
      const captured = disableTestCapture(testPhone);
      res.json({ ok: true, messages: captured });
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
  handleMessage(phone, message)
    .then(() => {
      if (messageSid) processedMessages.set(messageSid, Date.now());
    })
    .catch(err => {
      console.error('Async handler error:', err.message);
    });
});

// =======================================================
// Async message handler
// =======================================================

// --- TCPA opt-out keywords — must not respond to these ---
const OPT_OUT_KEYWORDS = /^\s*(stop|unsubscribe|cancel|quit)\b/i;

async function handleMessage(phone, message) {
  const masked = maskPhone(phone);
  console.log(`SMS from ${masked}: ${message.slice(0, 80)}`);

  // TCPA compliance: never respond to opt-out keywords
  if (OPT_OUT_KEYWORDS.test(message.trim())) {
    console.log(`Opt-out keyword from ${masked}, not responding`);
    return;
  }

  if (isOverBudget(phone)) {
    console.warn(`Over daily AI budget: ${masked}`);
    await sendSMS(phone, "You've hit your daily limit — check back tomorrow for more picks!");
    return;
  }

  try {
    await handleMessageAI(phone, message);
  } catch (err) {
    console.error('AI flow error:', err.message);
    try {
      await sendSMS(phone, "Pulse hit a snag — try again in a sec!");
    } catch (smsErr) {
      console.error(`[CRITICAL] Double failure for ${masked}: AI error="${err.message}", SMS error="${smsErr.message}" — user received nothing`);
    }
  }
}

// =======================================================
// Orchestrator — routes message to the right intent handler
// =======================================================

async function handleMessageAI(phone, message) {
  const traceStart = Date.now();
  const masked = maskPhone(phone);
  const session = getSession(phone);
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
  let route;
  if (preRouted) {
    route = preRouted;
    trace.routing.pre_routed = true;
    trace.routing.result = { intent: route.intent, neighborhood: route.neighborhood, confidence: route.confidence };
    trace.routing.latency_ms = 0;
  } else {
    const routeStart = Date.now();
    route = await routeMessage(message, session, NEIGHBORHOOD_NAMES);
    trace.routing.latency_ms = Date.now() - routeStart;
    trace.routing.pre_routed = false;
    trace.routing.result = { intent: route.intent, neighborhood: route.neighborhood, confidence: route.confidence };
    trace.routing.raw_response = route._raw || null;
    trace.routing.provider = route._provider || 'anthropic';
    trackAICost(phone, route._usage, route._provider);
  }
  console.log(`${preRouted ? 'Pre' : 'AI'} route (${route._provider || 'pre'}): intent=${route.intent}, neighborhood=${route.neighborhood}, confidence=${route.confidence}`);

  // Snapshot previous conversation history BEFORE adding current message
  // (so Claude doesn't see the current message duplicated in both <user_message> and history)
  if (!getSession(phone)) setSession(phone, {});
  const history = getSession(phone)?.conversationHistory || [];
  addToHistory(phone, 'user', message);

  // Shared compose helper (closure over message + trace)
  async function composeAndSend(composeEvents, hood, filters, intentLabel, { excludeIds, skills } = {}) {
    const enrichedSkills = { ...(skills || {}), hasConversationHistory: history.length > 0 };
    trace.events.sent_to_claude = composeEvents.length;
    trace.events.sent_ids = composeEvents.map(e => e.id);
    const composeStart = Date.now();
    const result = await composeResponse(message, composeEvents, hood, filters, { excludeIds, skills: enrichedSkills, conversationHistory: history });
    trace.composition.latency_ms = Date.now() - composeStart;
    trackAICost(phone, result._usage);
    trace.composition.raw_response = result._raw || null;
    trace.composition.picks = (result.picks || []).map(p => {
      const evt = composeEvents.find(e => e.id === p.event_id);
      return { ...p, date_local: evt?.date_local || null };
    });
    trace.composition.not_picked_reason = result.not_picked_reason || null;
    trace.composition.neighborhood_used = result.neighborhood_used || hood;
    return result;
  }

  const ctx = { phone, message, masked, session, trace, route, finalizeTrace, composeAndSend, trackAICost: (usage) => trackAICost(phone, usage) };

  // Clear stale nudge state when intent isn't a nudge response —
  // prevents "yeah" in unrelated messages from triggering old nearby redirect
  if (route.intent !== 'nudge_accept' && session?.pendingNearby) {
    setSession(phone, { pendingNearby: null });
  }

  // --- Simple intents (no neighborhood needed) ---
  if (route.intent === 'help') return handleHelp(ctx);
  if (route.intent === 'conversational') return handleConversational(ctx);
  if (route.intent === 'details') return handleDetails(ctx);

  // --- Resolve neighborhood ---
  const extracted = extractNeighborhood(message);
  let neighborhood = extracted || route.neighborhood;
  if (neighborhood && !NEIGHBORHOOD_NAMES.includes(neighborhood)) {
    const validated = extractNeighborhood(neighborhood);
    neighborhood = validated || null;
  }
  if (!neighborhood) neighborhood = session?.lastNeighborhood || null;
  trace.routing.resolved_neighborhood = neighborhood;
  ctx.neighborhood = neighborhood;

  // No neighborhood for events intent — ask the user
  if (!neighborhood && route.intent === 'events') {
    if (route.filters?.free_only || route.filters?.category) {
      setSession(phone, { pendingFilters: route.filters, pendingMessage: message });
    }
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'events');
    return;
  }

  // --- Dispatch: more and free run before pending filters (matches original order) ---
  // Intent handlers that call Claude are wrapped so errors produce
  // intent-specific messages instead of the generic "Pulse hit a snag".
  const INTENT_ERROR_MSGS = {
    more: "Couldn't load more picks right now — try again in a sec!",
    free: "Couldn't find free events right now — try again in a sec!",
    events: "Couldn't load events right now — try again in a sec!",
  };

  async function dispatchWithFallback(handler, intentLabel) {
    try {
      return await handler(ctx);
    } catch (err) {
      console.error(`${intentLabel} handler error:`, err.message);
      const sms = INTENT_ERROR_MSGS[intentLabel] || "Pulse hit a snag — try again in a sec!";
      await sendSMS(phone, sms);
      finalizeTrace(sms, intentLabel);
    }
  }

  if (route.intent === 'more') return dispatchWithFallback(handleMore, 'more');
  if (route.intent === 'free') return dispatchWithFallback(handleFree, 'free');

  // --- Restore pending filters (only for events/nudge_accept) ---
  const pendingFilters = session?.pendingFilters;
  if (pendingFilters) {
    if (pendingFilters.free_only && !route.filters?.free_only) {
      route.filters = { ...route.filters, free_only: true };
    }
    if (pendingFilters.category && !route.filters?.category) {
      route.filters = { ...route.filters, category: pendingFilters.category };
    }
    if (pendingFilters.time_after && !route.filters?.time_after) {
      route.filters = { ...route.filters, time_after: pendingFilters.time_after };
    }
    // Restore original message context for compose
    if (session?.pendingMessage) {
      ctx.pendingMessage = session.pendingMessage;
    }
    setSession(phone, { pendingFilters: null, pendingMessage: null });
  }

  // Pending filters may redirect events→free
  if (route.filters?.free_only && route.intent === 'events') {
    return dispatchWithFallback(handleFree, 'free');
  }

  if (route.intent === 'nudge_accept') {
    try {
      const handled = await handleNudgeAccept(ctx);
      if (handled) return;
    } catch (err) {
      console.error('nudge_accept handler error:', err.message);
      // Fall through to events on nudge error
    }
  }

  // Unknown intent guard
  if (!['events', 'nudge_accept'].includes(route.intent)) {
    console.warn(`Unknown intent "${route.intent}", treating as events`);
  }

  // Ask for neighborhood if we still don't have one
  if (!neighborhood) {
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(phone, sms);
    finalizeTrace(sms, route.intent);
    return;
  }

  return dispatchWithFallback(handleEventsDefault, 'events');
}

// Cleanup intervals (for graceful shutdown)
function clearSmsIntervals() {
  clearInterval(dedupInterval);
  clearInterval(rateLimitInterval);
  clearSessionInterval();
}

module.exports = router;
module.exports.clearSmsIntervals = clearSmsIntervals;
module.exports.setSession = setSession;
module.exports.clearSession = clearSession;
module.exports._handleMessage = handleMessage; // exported for integration tests
module.exports.OPT_OUT_KEYWORDS = OPT_OUT_KEYWORDS;
