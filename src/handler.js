const express = require('express');
const twilio = require('twilio');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { startTrace, saveTrace, getLatestTraceForPhone, getTraceById, recordAICost } = require('./traces');
const { getSession, setSession, clearSession, addToHistory, clearSessionInterval, acquireLock } = require('./session');
const { handleHelp, handleConversational, handleDetails, handleMore } = require('./intent-handlers');
const { sendRuntimeAlert } = require('./alerts');
const { getEventById } = require('./events');
const { lookupReferralCode, recordAttribution } = require('./referral');
const { saveResponseFrame, sendPickUrls } = require('./pipeline');
const { updateProfile } = require('./preference-profile');
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
 * Dispatch mechanical shortcuts (referral, help, conversational, details, more).
 * All paths are terminal: sendSMS + finalizeTrace + return.
 */
async function dispatchPreRouterIntent(route, ctx) {
  const { phone, session, trace, finalizeTrace } = ctx;

  if (route.intent === 'referral') {
    const referral = lookupReferralCode(route.referralCode);
    if (referral) {
      recordAttribution(phone, route.referralCode);
      // Agent brain: use welcome flow instead of canned intro
      if (process.env.PULSE_AGENT_BRAIN === 'true') {
        const { handleWelcome } = require('./agent-brain');
        try {
          const welcomeResult = await handleWelcome(phone, session, trace);
          trace.routing.result = { intent: 'welcome_referral', confidence: 1.0 };
          await sendSMS(phone, welcomeResult.sms);
          if (welcomeResult.picks?.length) await sendPickUrls(phone, welcomeResult.picks, welcomeResult.eventMap);
          finalizeTrace(welcomeResult.sms, 'referral');
          return;
        } catch (err) {
          console.warn('Welcome flow failed for referral, using canned intro:', err.message);
          // Fall through to existing canned messages
        }
      }
      const referredEvent = getEventById(referral.eventId);
      updateProfile(phone, {
        neighborhood: referredEvent?.neighborhood || null,
        filters: referredEvent?.category ? { category: referredEvent.category } : {},
        responseType: 'referral',
      }).catch(err => console.error('profile update failed:', err.message));
      const msg1 = "Hey! I'm Bestie — I dig through the best of what's happening in NYC daily that you'll never find on Google or Instagram alone. Comedy, DJ sets, trivia, indie film, art, late-night weirdness, and more across every neighborhood.";
      const msg2 = referredEvent?.neighborhood
        ? `Text me a vibe like "jazz tonight" or try "${referredEvent.neighborhood}" to start exploring. I'll send picks — reply a number for details, "more" to keep going, or just tell me what you're looking for.`
        : 'Text me a neighborhood like "Bushwick" or a vibe like "jazz tonight" to start exploring. I\'ll send picks — reply a number for details, "more" to keep going, or just tell me what you\'re looking for.';
      saveResponseFrame(phone, { picks: [], eventMap: {}, neighborhood: null, filters: null, offeredIds: [] });
      await sendSMS(phone, msg1);
      await sendSMS(phone, msg2);
      finalizeTrace(msg1 + '\n' + msg2, 'referral');
      return;
    }
    // Agent brain: use welcome flow even for expired referrals
    if (process.env.PULSE_AGENT_BRAIN === 'true') {
      const { handleWelcome } = require('./agent-brain');
      try {
        const welcomeResult = await handleWelcome(phone, session, trace);
        trace.routing.result = { intent: 'welcome_referral_expired', confidence: 1.0 };
        await sendSMS(phone, welcomeResult.sms);
        if (welcomeResult.picks?.length) await sendPickUrls(phone, welcomeResult.picks, welcomeResult.eventMap);
        finalizeTrace(welcomeResult.sms, 'referral_expired');
        return;
      } catch (err) {
        console.warn('Welcome flow failed for expired referral, using canned intro:', err.message);
      }
    }
    const msg1 = "Hey! I'm Bestie — I dig through the best of what's happening in NYC daily that you'll never find on Google or Instagram alone. Comedy, DJ sets, trivia, indie film, art, late-night weirdness, and more across every neighborhood.";
    const msg2 = 'Text me a neighborhood like "Bushwick" or a vibe like "jazz tonight" to start exploring. I\'ll send picks — reply a number for details, "more" to keep going, or just tell me what you\'re looking for.';
    saveResponseFrame(phone, { picks: [], eventMap: {}, neighborhood: null, filters: null, offeredIds: [] });
    await sendSMS(phone, msg1);
    await sendSMS(phone, msg2);
    finalizeTrace(msg1 + '\n' + msg2, 'referral_expired');
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

  const { handleAgentBrainRequest, checkMechanical } = require('./agent-brain');

  // Mechanical pre-check: help, bare numbers, "more" — $0 AI cost
  const mechanical = checkMechanical(message, session);
  if (mechanical) {
    // Set up session + history for mechanical handlers
    if (!getSession(phone)) setSession(phone, {});
    addToHistory(phone, 'user', message);

    trace.routing.pre_routed = true;
    trace.routing.result = { intent: mechanical.intent, confidence: 1.0 };
    trace.routing.latency_ms = 0;
    trace.brain_tool = null;
    trace.brain_provider = 'mechanical';

    const route = { ...mechanical };
    const ctx = { phone, message, masked, session, trace, route, finalizeTrace, trackAICost: (usage, provider) => trackAICost(phone, usage, provider), recordAICost };

    if (session?.pendingNearby) {
      setSession(phone, { pendingNearby: null, pendingFilters: null, pendingMessage: null });
    }

    await dispatchPreRouterIntent(route, ctx);
    return trace.id;
  }

  // Agent brain handles everything else
  return handleAgentBrainRequest(phone, message, session, trace, finalizeTrace);
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
