const express = require('express');
const twilio = require('twilio');
const { extractNeighborhood, NEIGHBORHOODS } = require('./neighborhoods');
const { composeResponse, unifiedRespond } = require('./ai');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { startTrace, saveTrace, getLatestTraceForPhone } = require('./traces');
const { getSession, setSession, clearSession, addToHistory, clearSessionInterval } = require('./session');
const { preRoute, getAdjacentNeighborhoods } = require('./pre-router');
const { handleHelp, handleConversational, handleDetails, handleMore } = require('./intent-handlers');
const { sendRuntimeAlert } = require('./alerts');
const { getEvents, getEventsCitywide, getEventById, scanCityWide, getCacheStatus } = require('./events');
const { lookupReferralCode, recordAttribution } = require('./referral');
const { filterKidsEvents, validatePerennialActivity } = require('./curation');
const { getPerennialPicks, toEventObjects } = require('./perennial');
const { applyFilters, buildEventMap, saveResponseFrame, mergeFilters, buildTaggedPool, tryTavilyFallback } = require('./pipeline');
const { updateProfile } = require('./preference-profile');

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

// --- IP-based rate limit for test endpoint (30 messages per IP per hour) ---
const ipRateLimits = new Map(); // ip → { count, resetTime }
const IP_RATE_LIMIT = 30;
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
      await Promise.race([
        handleMessage(testPhone, message.trim()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out (25s)')), TEST_TIMEOUT_MS)),
      ]);
      const captured = disableTestCapture(testPhone);
      const trace = getLatestTraceForPhone(maskPhone(testPhone));
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

  if (!process.env.PULSE_TEST_MODE && isOverBudget(phone)) {
    console.warn(`Over daily AI budget: ${masked}`);
    await sendSMS(phone, "You've hit your daily limit — check back tomorrow for more picks!");
    return;
  }

  try {
    await handleMessageAI(phone, message);
  } catch (err) {
    console.error('AI flow error:', err.message);
    try {
      await sendSMS(phone, "Bestie hit a snag — try again in a sec!");
    } catch (smsErr) {
      console.error(`[CRITICAL] Double failure for ${masked}: AI error="${err.message}", SMS error="${smsErr.message}" — user received nothing`);
    }
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
  const extracted = extractNeighborhood(message);
  let hood = extracted || null;
  if (!hood && session?.pendingNearby) {
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

  // Detect if user used an alias (e.g. "ridgewood" → Bushwick, "lic" → Long Island City)
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

  // Fetch events — neighborhood or citywide
  let events = [];
  let curated = [];
  let taggedPerennials = [];
  let isCitywide = false;
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
    // Merge perennial picks (marked as unmatched)
    const perennialPicks = getPerennialPicks(hood);
    const localPerennials = validatePerennialActivity(toEventObjects(perennialPicks.local, hood));
    const perennialCap = Math.min(4, 15 - Math.min(events.length, 15));
    taggedPerennials = localPerennials.slice(0, perennialCap).map(e => ({ ...e, filter_match: false }));
    events = [...events, ...taggedPerennials];

    // Tavily live-search fallback: fire when pool is exhausted and user already visited this hood
    const earlyExcludePicks = (session?.allPicks || session?.lastPicks || []).map(p => p.event_id);
    const earlyExcludeOffered = session?.allOfferedIds || [];
    const earlyExcludeSet = new Set([...earlyExcludePicks, ...earlyExcludeOffered]);
    const unseenEvents = events.filter(e => !earlyExcludeSet.has(e.id));
    if (unseenEvents.length === 0 && (session?.visitedHoods || []).includes(hood)) {
      const tavilyResult = await tryTavilyFallback(hood, activeFilters, [...earlyExcludeSet], trace);
      if (tavilyResult) {
        const tavilyTagged = tavilyResult.events.map(e => ({ ...e, filter_match: false }));
        events = [...events, ...tavilyTagged];
      }
    }
  } else {
    // Citywide flow — serve best events across all neighborhoods
    isCitywide = true;
    const eventsStart = Date.now();
    const raw = await getEventsCitywide({ dateRange: activeFilters.date_range });
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
  const suggestedHood = isSparse && nearbyHoods.length > 0 ? nearbyHoods[0] : null;

  console.log(`Unified flow: hood=${hood}, events=${events.length}, nearby=${nearbyHoods.join(',')}`);

  // Build exclude list from previously shown events
  const prevPickIds = (session?.allPicks || session?.lastPicks || []).map(p => p.event_id);
  const prevOfferedIds = session?.allOfferedIds || [];
  const excludeIds = [...new Set([...prevPickIds, ...prevOfferedIds])];

  return { hood, activeFilters, events, curated, taggedPerennials, matchCount, hardCount, softCount, isSparse, isCitywide, nearbyHoods, suggestedHood, excludeIds, now, userHoodAlias };
}

/**
 * Call unifiedRespond and capture trace/cost data.
 */
async function callUnified(message, unifiedCtx, session, history, phone, trace) {
  const { hood, events, nearbyHoods, now, activeFilters, isSparse, isCitywide, matchCount, hardCount, softCount, excludeIds, suggestedHood, userHoodAlias } = unifiedCtx;

  const composeStart = Date.now();
  const result = await unifiedRespond(message, {
    session,
    events,
    neighborhood: hood,
    nearbyHoods,
    conversationHistory: history,
    currentTime: now,
    validNeighborhoods: NEIGHBORHOOD_NAMES,
    activeFilters,
    isSparse,
    isCitywide,
    matchCount,
    hardCount,
    softCount,
    excludeIds,
    suggestedNeighborhood: suggestedHood,
    userHoodAlias,
  });
  trace.routing.latency_ms = Date.now() - composeStart; // unified call replaces both route + compose
  trace.composition.latency_ms = trace.routing.latency_ms;
  trace.routing.provider = 'anthropic';
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
      is_free: evt?.is_free || false,
      start_time_local: evt?.start_time_local || null,
    };
  });
  trace.composition.active_filters = activeFilters || null;
  trace.composition.neighborhood_used = hood;
  // Derive which prompt skills were activated (mirrors buildUnifiedPrompt logic)
  const activeSkills = ['core', 'sourceTiers'];
  if (events.some(e => (e.date_local || e.day) === new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) || e.day === 'TODAY')) activeSkills.push('tonightPriority');
  if (hood && !events.some(e => e.neighborhood === hood)) activeSkills.push('neighborhoodMismatch');
  if (events.some(e => e.source_name === 'perennial')) activeSkills.push('perennialFraming');
  if (events.some(e => e.source_name === 'tavily')) activeSkills.push('venueFraming');
  if (activeFilters?.free_only) activeSkills.push('freeEmphasis');
  if (history.length > 0) activeSkills.push('conversationAwareness');
  if (suggestedHood) activeSkills.push('nearbySuggestion');
  if (matchCount === 1 || (events.length <= 1)) activeSkills.push('singlePick');
  if (isCitywide && events.length > 0) activeSkills.push('citywide');
  const uniqueDates = new Set(events.map(e => e.date_local).filter(Boolean));
  if (uniqueDates.size >= 2) activeSkills.push('multiDay');
  trace.composition.active_skills = activeSkills;
  trackAICost(phone, result._usage, result._provider);

  return result;
}

/**
 * Handle the unified LLM response: clear_filters check + 3 response type handlers.
 * All paths are terminal: saveResponseFrame → updateProfile → sendSMS → finalizeTrace.
 */
async function handleUnifiedResponse(result, unifiedCtx, phone, session, trace, message, finalizeTrace) {
  let { hood, activeFilters, events, curated, taggedPerennials, suggestedHood } = unifiedCtx;

  // Filter state management after unified call
  // Only trust LLM's clear_filters when user message contains clear-intent language.
  // This prevents hallucination on normal conversational turns (BUG 1) while
  // preserving semantic clearing ("just show me what's good"). P1 compliant:
  // code validates LLM's claim against user's actual input.
  const CLEAR_SIGNALS = /\b(everything|all\b|fresh|reset|start over|no filter|drop|forget|nvm|never\s?mind|clear|what's good|whats good|whatever|surprise me)\b/i;
  if (result.clear_filters && CLEAR_SIGNALS.test(message)) {
    activeFilters = {};
  }

  // Handle response by type
  if (result.type === 'ask_neighborhood') {
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: session?.lastEvents || {},
      neighborhood: hood,
      filters: Object.values(activeFilters).some(Boolean) ? activeFilters : null,
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      pending: {
        neighborhood: suggestedHood,
        filters: activeFilters,
      },
      pendingMessage: message,
    });
    updateProfile(phone, { neighborhood: hood, filters: activeFilters, responseType: 'ask_neighborhood' })
      .catch(err => console.error('profile update failed:', err.message));
    await sendSMS(phone, result.sms_text);
    finalizeTrace(result.sms_text, 'events');
    return;
  }

  const eventMap = buildEventMap([...curated, ...taggedPerennials]);
  // Merge tagged pool events into eventMap so filter_match is available for validation
  for (const e of events) eventMap[e.id] = e;

  if (result.type === 'conversational' || !result.picks || result.picks.length === 0) {
    // Conversational or empty picks — save atomically, preserving existing picks/events for details/more
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: Object.keys(eventMap).length > 0 ? eventMap : (session?.lastEvents || {}),
      neighborhood: hood,
      filters: Object.values(activeFilters).some(Boolean) ? activeFilters : null,
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      pending: suggestedHood ? { neighborhood: suggestedHood, filters: activeFilters } : null,
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
  saveResponseFrame(phone, {
    picks: filterCompliantPicks,
    eventMap,
    neighborhood: hood,
    filters: activeFilters,
    offeredIds: filterCompliantPicks.map(p => p.event_id),
    pending: suggestedHood ? {
      neighborhood: suggestedHood,
      filters: activeFilters,
    } : null,
  });
  updateProfile(phone, { neighborhood: hood, filters: activeFilters, responseType: 'event_picks' })
    .catch(err => console.error('profile update failed:', err.message));
  finalizeTrace(result.sms_text, 'events');
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
    // Deterministic filter detection (category/time/vibe/free) — use unified branch for composition
    preDetectedFilters = preRouted.filters;
    trace.routing.pre_routed = true;
    trace.routing.result = { intent: preRouted.intent, neighborhood: preRouted.neighborhood, confidence: preRouted.confidence };
    trace.routing.latency_ms = 0;
    console.log(`Pre route (pre): intent=${preRouted.intent}, neighborhood=${preRouted.neighborhood} → unified with filters`);
  }

  // Pre-router clear_filters: wipe filters and fall through to unified branch
  if (preRouted && preRouted.intent === 'clear_filters') {
    setSession(phone, { lastFilters: null, pendingFilters: null });
    session = getSession(phone);
    trace.routing.pre_routed = true;
    trace.routing.result = { intent: 'clear_filters', neighborhood: preRouted.neighborhood, confidence: 1.0 };
    trace.routing.latency_ms = 0;
    console.log(`Pre route (pre): intent=clear_filters → unified with no filters`);
  }

  if (preRouted && !preDetectedFilters && preRouted.intent !== 'clear_filters') {
    // Pre-router matched — mechanical shortcuts
    const route = preRouted;
    trace.routing.pre_routed = true;
    trace.routing.result = { intent: route.intent, neighborhood: route.neighborhood, confidence: route.confidence };
    trace.routing.latency_ms = 0;
    console.log(`Pre route (pre): intent=${route.intent}, neighborhood=${route.neighborhood}, confidence=${route.confidence}`);

    // Shared compose helper (closure over message + trace) — needed by handleMore
    async function composeAndSend(composeEvents, hood, filters, intentLabel, { excludeIds, skills } = {}) {
      const enrichedSkills = { ...(skills || {}), hasConversationHistory: history.length > 0 };
      trace.events.sent_to_claude = composeEvents.length;
      trace.events.sent_ids = composeEvents.map(e => e.id);
      trace.events.sent_pool = composeEvents.map(e => ({
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
      const composeStart = Date.now();
      const result = await composeResponse(message, composeEvents, hood, filters, { excludeIds, skills: enrichedSkills, conversationHistory: history });
      trace.composition.latency_ms = Date.now() - composeStart;
      trackAICost(phone, result._usage);
      trace.composition.raw_response = result._raw || null;
      trace.composition.picks = (result.picks || []).map(p => {
        const evt = composeEvents.find(e => e.id === p.event_id);
        return {
          ...p,
          date_local: evt?.date_local || null,
          event_name: evt?.name || null,
          venue_name: evt?.venue_name || null,
          neighborhood: evt?.neighborhood || null,
          category: evt?.category || null,
          is_free: evt?.is_free || false,
          start_time_local: evt?.start_time_local || null,
        };
      });
      trace.composition.not_picked_reason = result.not_picked_reason || null;
      trace.composition.neighborhood_used = result.neighborhood_used || hood;
      return result;
    }

    const ctx = { phone, message, masked, session, trace, route, finalizeTrace, composeAndSend, trackAICost: (usage) => trackAICost(phone, usage) };

    // Clear pending state on any pre-routed intent
    if (session?.pendingNearby) {
      setSession(phone, { pendingNearby: null, pendingFilters: null, pendingMessage: null });
    }

    return dispatchPreRouterIntent(route, ctx);
  }

  // Unified LLM call — handles semantic messages + pre-detected filter follow-ups
  const unifiedCtx = await resolveUnifiedContext(message, session, preDetectedFilters, phone, trace);
  const result = await callUnified(message, unifiedCtx, session, history, phone, trace);
  await handleUnifiedResponse(result, unifiedCtx, phone, session, trace, message, finalizeTrace);
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
