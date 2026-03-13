const express = require('express');
const twilio = require('twilio');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { startTrace, saveTrace, getLatestTraceForPhone, getTraceById, recordAICost } = require('./traces');
const { getSession, setSession, clearSession, addToHistory, clearSessionInterval, acquireLock } = require('./session');
const { handleHelp } = require('./intent-handlers');
const { lookupReferralCode, recordAttribution } = require('./referral');
const { processedMessages, OPT_OUT_KEYWORDS, isOverBudget, trackAICost, getCostSummary, ipRateLimits, IP_RATE_LIMIT, IP_RATE_WINDOW, clearGuardIntervals } = require('./request-guard');


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

    const { Body: message, From: phone, Model: modelOverride } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Missing Body parameter' });
    }
    const testPhone = phone || '+10000000000';
    enableTestCapture(testPhone);

    // Temporarily override brain model if requested
    const { MODELS } = require('./model-config');
    const originalModel = MODELS.brain;
    if (modelOverride) MODELS.brain = modelOverride;

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
        nearby_highlight: trace.events?.nearby_highlight || null,
        picks: trace.composition?.picks,
      } : null;
      res.json({ ok: true, messages: captured, trace_summary, trace });
    } catch (err) {
      const captured = disableTestCapture(testPhone);
      res.status(500).json({ error: err.message, messages: captured });
    } finally {
      if (modelOverride) MODELS.brain = originalModel;
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
        await sendSMS(phone, "Pulse hit a snag — try again in a sec!");
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
 * Dispatch mechanical shortcuts (referral, help).
 * All paths are terminal: sendSMS + finalizeTrace + return.
 */
async function dispatchPreRouterIntent(route, ctx) {
  const { phone, session, trace, finalizeTrace } = ctx;

  if (route.intent === 'referral') {
    const referral = lookupReferralCode(route.referralCode);
    if (referral) recordAttribution(phone, route.referralCode);
    // Let the agent loop handle the welcome
    const { handleAgentRequest } = require('./agent-loop');
    return handleAgentRequest(phone, ctx.message, session, trace, finalizeTrace);
  }

  if (route.intent === 'help') return handleHelp(ctx);

  if (route.intent === 'proactive_opt_in') {
    const { setProactiveOptIn } = require('./preference-profile');
    setProactiveOptIn(phone, true);
    const reply = "You're in! I'll text you when something great comes up. Reply STOP NOTIFY anytime to turn it off.";
    await sendSMS(phone, reply);
    finalizeTrace(reply, 'proactive_opt_in');
    return;
  }

  if (route.intent === 'proactive_opt_out') {
    const { setProactiveOptIn } = require('./preference-profile');
    setProactiveOptIn(phone, false);
    const reply = "Got it — no more proactive texts. You can still text me anytime for picks.";
    await sendSMS(phone, reply);
    finalizeTrace(reply, 'proactive_opt_out');
    return;
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

    // Track engagement for proactive messages
    if (session.proactiveSeeded) {
      try {
        const { markRecommendationEngaged } = require('./db');
        const { hashPhone } = require('./preference-profile');
        const lastPick = session.lastPicks?.[0];
        if (lastPick?.event_id) {
          markRecommendationEngaged(hashPhone(phone), lastPick.event_id);
        }
        session.proactiveSeeded = false;
      } catch (err) {
        console.error('[PROACTIVE] Engagement tracking error:', err.message);
      }
    }
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
        trace.brain_latency_ms != null ? `brain: ${trace.brain_latency_ms}ms` : null,
        trace.events.getEvents_ms != null ? `events: ${trace.events.getEvents_ms}ms` : null,
        `compose: ${trace.composition.latency_ms}ms`,
        `total: ${trace.total_latency_ms}ms`,
        trace.brain_iterations?.length > 1 ? `iterations: ${trace.brain_iterations.map(it => `${it.tool}:${it.ms}ms`).join(',')}` : null,
      ].filter(Boolean).join(' | ');
      console.warn(`[SLOW] ${(trace.total_latency_ms / 1000).toFixed(1)}s | ${breakdown} | intent=${trace.output_intent} | msg="${trace.input_message.slice(0, 40)}"`);

    }
  }

  const { checkMechanical } = require('./agent-brain');

  // Mechanical pre-check: help + TCPA — $0 AI cost
  const mechanical = checkMechanical(message, session);
  if (mechanical) {
    if (!getSession(phone)) setSession(phone, {});
    addToHistory(phone, 'user', message);

    trace.routing.pre_routed = true;
    trace.routing.result = { intent: mechanical.intent, confidence: 1.0 };
    trace.routing.latency_ms = 0;
    trace.brain_tool = null;
    trace.brain_provider = 'mechanical';

    const route = { ...mechanical };
    const ctx = { phone, message, masked, session, trace, route, finalizeTrace, trackAICost: (usage, provider) => trackAICost(phone, usage, provider), recordAICost };

    await dispatchPreRouterIntent(route, ctx);
    return trace.id;
  }

  // Agent loop handles everything else
  const { handleAgentRequest } = require('./agent-loop');
  return handleAgentRequest(phone, message, session, trace, finalizeTrace);
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
