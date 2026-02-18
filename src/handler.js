const express = require('express');
const twilio = require('twilio');
const { extractNeighborhood, NEIGHBORHOODS } = require('./neighborhoods');
const { getEvents } = require('./events');
const { routeMessage, composeResponse, composeDetails, isSearchUrl } = require('./ai');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { startTrace, saveTrace } = require('./traces');
const { getSession, setSession, clearSession, clearSessionInterval } = require('./session');
const { formatEventDetails, cleanUrl } = require('./formatters');
const { getAdjacentNeighborhoods, preRoute } = require('./pre-router');
const { getPerennialPicks, toEventObjects } = require('./perennial');

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

// --- Simple in-memory rate limiter ---
const rateLimits = new Map(); // phone → { count, resetAt }
const RATE_LIMIT_MAX = 15; // max requests per phone per hour
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

function isRateLimited(phone) {
  const now = Date.now();
  const entry = rateLimits.get(phone);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(phone, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Clean stale rate limit entries every 10 minutes
const rateLimitInterval = setInterval(() => {
  try {
    const now = Date.now();
    for (const [phone, entry] of rateLimits) {
      if (now > entry.resetAt) rateLimits.delete(phone);
    }
  } catch (e) { console.error('Rate limit cleanup error:', e); }
}, 10 * 60 * 1000);

// --- Send compose result + follow-up link messages ---
// Sends the main sms_text, then each picked event's URL as a separate message
// so that iMessage/Android unfurls a rich link preview with venue images.
async function sendComposeWithLinks(phone, result, eventSource) {
  await sendSMS(phone, result.sms_text);

  const picks = result.picks || [];
  for (const pick of picks) {
    const event = eventSource[pick.event_id];
    if (!event) continue;
    const url = [event.ticket_url, event.source_url].find(u => u && !isSearchUrl(u));
    if (url) {
      await sendSMS(phone, cleanUrl(url));
    }
  }
}

// =======================================================
// Test endpoint — runs full pipeline, returns response over HTTP
// Gated behind PULSE_TEST_MODE=true env var
// =======================================================

if (process.env.PULSE_TEST_MODE === 'true') {
  router.post('/test', async (req, res) => {
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
  if (messageSid) {
    processedMessages.set(messageSid, Date.now());
  }

  // Respond to Twilio immediately — prevents timeout + retries
  res.type('text/xml').send('<Response></Response>');

  // Process asynchronously
  handleMessage(phone, message).catch(err => {
    console.error('Async handler error:', err.message);
  });
});

// =======================================================
// Async message handler
// =======================================================

// --- TCPA opt-out keywords — must not respond to these ---
const OPT_OUT_KEYWORDS = /^(stop|unsubscribe|cancel|quit|end)$/i;

async function handleMessage(phone, message) {
  const masked = maskPhone(phone);
  console.log(`SMS from ${masked}: ${message.slice(0, 80)}`);

  // TCPA compliance: never respond to opt-out keywords
  if (OPT_OUT_KEYWORDS.test(message.trim())) {
    console.log(`Opt-out keyword from ${masked}, not responding`);
    return;
  }

  // Rate limiting (disabled for now — re-enable when ready)
  // if (isRateLimited(phone)) {
  //   console.warn(`Rate limited: ${masked}`);
  //   await sendSMS(phone, "Easy there — give it a few minutes and try again!");
  //   return;
  // }

  try {
    await handleMessageAI(phone, message);
  } catch (err) {
    console.error('AI flow error:', err.message);
    try {
      await sendSMS(phone, "Pulse hit a snag — try again in a sec!");
    } catch (smsErr) {
      console.error(`Failed to send error SMS to ${masked}:`, smsErr.message);
    }
  }
}

// =======================================================
// AI flow — Claude-first routing + composition
// =======================================================

async function handleMessageAI(phone, message) {
  const traceStart = Date.now();
  const masked = maskPhone(phone);
  const session = getSession(phone);
  const trace = startTrace(masked, message);

  // Capture session state before processing
  if (session) {
    trace.session_before = {
      lastNeighborhood: session.lastNeighborhood || null,
      lastPicks: (session.lastPicks || []).map(p => ({ event_id: p.event_id })),
    };
  }

  // Helper: finalize and save trace
  function finalizeTrace(smsText, intent) {
    trace.output_sms = smsText || null;
    trace.output_sms_length = smsText ? smsText.length : 0;
    trace.output_intent = intent || trace.routing.result?.intent || null;
    trace.total_latency_ms = Date.now() - traceStart;
    saveTrace(trace);
  }

  // Try deterministic pre-routing first, fall back to Claude
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
  }
  console.log(`${preRouted ? 'Pre' : 'AI'} route: intent=${route.intent}, neighborhood=${route.neighborhood}, confidence=${route.confidence}`);

  // --- Help ---
  if (route.intent === 'help') {
    const reply = route.reply || "Hey! I'm Pulse — text me a neighborhood and I'll send you tonight's best picks. Try \"East Village\" or \"Williamsburg\" to start. You can ask for free events, specific vibes like comedy or live music, or reply \"more\" after any rec to keep exploring.";
    const sms = reply.slice(0, 480);
    await sendSMS(phone, sms);
    console.log(`Help sent to ${masked}`);
    finalizeTrace(sms, 'help');
    return;
  }

  // --- Conversational ---
  if (route.intent === 'conversational') {
    let reply = route.reply || "Hey! Text a neighborhood whenever you're ready to go out.";
    // If there's an active session, nudge toward "more" instead of generic redirect
    if (session?.lastNeighborhood) {
      reply = reply.replace(
        /text (?:me )?a neighborhood[^.]*/i,
        `say "more" for more ${session.lastNeighborhood} picks, or text a different neighborhood`
      );
    }
    const sms = reply.slice(0, 480);
    await sendSMS(phone, sms);
    console.log(`Conversational reply sent to ${masked}`);
    finalizeTrace(sms, 'conversational');
    return;
  }

  // --- Details ---
  if (route.intent === 'details') {
    const picks = session?.lastPicks;
    if (session && picks?.length > 0) {
      const ref = parseInt(route.event_reference, 10);

      if (!ref || isNaN(ref)) {
        // No number specified — show details for ALL picks
        const details = picks.map((pick, i) => {
          const event = session.lastEvents[pick.event_id];
          return event ? `${i + 1}. ${formatEventDetails(event)}` : null;
        }).filter(Boolean);
        const sms = details.join('\n\n').slice(0, 1500);
        await sendSMS(phone, sms);
        console.log(`All details sent to ${masked}`);
        finalizeTrace(sms, 'details');
        return;
      }

      // Specific pick number requested — use Claude for a conversational description
      const pickIndex = Math.min(ref - 1, picks.length - 1);
      const pick = picks[Math.max(0, pickIndex)];
      const event = session.lastEvents[pick.event_id];
      if (event) {
        try {
          const composeStart = Date.now();
          const result = await composeDetails(event, pick.why);
          trace.composition.latency_ms = Date.now() - composeStart;
          trace.composition.raw_response = result._raw || null;
          const sms = result.sms_text;
          await sendSMS(phone, sms);
          console.log(`Details ${ref} sent to ${masked}`);
          finalizeTrace(sms, 'details');
          return;
        } catch (err) {
          console.error('composeDetails error, falling back:', err.message);
          const sms = formatEventDetails(event);
          await sendSMS(phone, sms);
          finalizeTrace(sms, 'details');
          return;
        }
      }
    }
    const sms = "I don't have any recent picks to pull up — text me a neighborhood and let's start fresh!";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'details');
    return;
  }

  // --- Resolve neighborhood ---
  // Prefer deterministic extraction from user's message over Claude's interpretation
  // (Claude sometimes maps aliases wrong, e.g. "east wburg" → Williamsburg instead of Bushwick)
  const extracted = extractNeighborhood(message);
  let neighborhood = extracted || route.neighborhood;

  // Validate against known neighborhoods
  if (neighborhood && !NEIGHBORHOOD_NAMES.includes(neighborhood)) {
    const validated = extractNeighborhood(neighborhood);
    neighborhood = validated || null;
  }

  // Fall back to session neighborhood
  if (!neighborhood) {
    neighborhood = session?.lastNeighborhood || null;
  }

  // Capture the handler's resolved neighborhood in the trace
  trace.routing.resolved_neighborhood = neighborhood;

  // Still no neighborhood — ask the user
  if (!neighborhood && route.intent === 'events') {
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'events');
    return;
  }

  // Helper: capture compose trace data and finalize
  async function composeAndSend(composeEvents, hood, filters, intentLabel, { excludeIds, extraContext } = {}) {
    trace.events.sent_to_claude = composeEvents.length;
    trace.events.sent_ids = composeEvents.map(e => e.id);

    const composeStart = Date.now();
    const result = await composeResponse(message, composeEvents, hood, filters, { excludeIds, extraContext });
    trace.composition.latency_ms = Date.now() - composeStart;
    trace.composition.raw_response = result._raw || null;
    trace.composition.picks = (result.picks || []).map(p => {
      const evt = composeEvents.find(e => e.id === p.event_id);
      return { ...p, date_local: evt?.date_local || null };
    });
    trace.composition.not_picked_reason = result.not_picked_reason || null;
    trace.composition.neighborhood_used = result.neighborhood_used || hood;

    return result;
  }

  // --- More ---
  if (route.intent === 'more') {
    // Track events ever offered to Claude (not just picks) to prevent recycling
    const allOfferedIds = new Set(session?.allOfferedIds || []);
    const allPickIds = new Set((session?.allPicks || session?.lastPicks || []).map(p => p.event_id));
    const allShownIds = new Set([...allOfferedIds, ...allPickIds]);
    const hood = neighborhood || session?.lastNeighborhood;

    if (session && session.lastEvents) {
      const allRemaining = Object.values(session.lastEvents).filter(e => !allShownIds.has(e.id));

      if (allRemaining.length > 0) {
        const composeRemaining = allRemaining.slice(0, 8);
        // If this is the last batch (all remaining fit in one compose), hint to Claude
        const isLastBatch = allRemaining.length <= 8;
        const extraContext = isLastBatch
          ? `\nNOTE: This is the LAST batch of events I have.\nOVERRIDE CLOSING LINE: Instead of "Reply 1-N for details, MORE for extra picks", use "Reply 1-N for details" (no MORE option). Then add "That's everything I've got in ${hood}! Try a different neighborhood for more."`
          : '';

        trace.events.cache_size = Object.keys(session.lastEvents).length;
        trace.events.candidates_count = allRemaining.length;
        trace.events.candidate_ids = allRemaining.map(e => e.id);
        const result = await composeAndSend(composeRemaining, hood, route.filters, 'more', { excludeIds: [...allShownIds], extraContext });

        // Name-based dedup: filter out picks that share a name with previously shown events
        const prevPickNames = new Set(
          (session.allPicks || session.lastPicks || [])
            .map(p => session.lastEvents[p.event_id]?.name?.toLowerCase())
            .filter(Boolean)
        );
        result.picks = (result.picks || []).filter(p => {
          const evt = session.lastEvents[p.event_id];
          return !evt || !prevPickNames.has(evt.name?.toLowerCase());
        });

        // Post-process: strip MORE references from SMS when it's the last batch
        if (isLastBatch) {
          result.sms_text = result.sms_text
            .replace(/,?\s*MORE for extra picks/gi, '')
            .replace(/,?\s*or MORE for more/gi, '')
            .replace(/,?\s*MORE for more picks/gi, '')
            .replace(/\s*Reply MORE[^.!\n]*/gi, '')
            .replace(/,?\s*MORE for more/gi, '');
        }

        const newAllPicks = [...(session.allPicks || session.lastPicks || []), ...(result.picks || [])];
        const newAllOfferedIds = [...allOfferedIds, ...composeRemaining.map(e => e.id)];

        const visitedHoods = new Set([...(session.visitedHoods || []), hood]);
        setSession(phone, { lastPicks: result.picks || [], allPicks: newAllPicks, allOfferedIds: newAllOfferedIds, lastEvents: session.lastEvents, lastNeighborhood: hood, visitedHoods: [...visitedHoods] });
        await sendComposeWithLinks(phone, result, session.lastEvents);

        console.log(`More sent to ${masked} (${allRemaining.length} remaining${isLastBatch ? ', last batch' : ''})`);
        finalizeTrace(result.sms_text, 'more');
        return;
      }
    }

    if (!session?.lastNeighborhood) {
      const sms = "Text me a neighborhood and I'll find you something! East Village, Williamsburg, LES — whatever's close.";
      await sendSMS(phone, sms);
      finalizeTrace(sms, 'more');
      return;
    }

    // All scraped events exhausted — check for unshown perennial picks
    const morePicks = getPerennialPicks(hood);
    const moreLocalPerennials = toEventObjects(morePicks.local, hood);
    const moreNearbyPerennials = toEventObjects(morePicks.nearby, hood, { isNearby: true });
    const allMorePerennials = [...moreLocalPerennials, ...moreNearbyPerennials];
    const allShownMoreIds = new Set([...(session?.allOfferedIds || []), ...(session?.allPicks || session?.lastPicks || []).map(p => p.event_id)]);
    const unshownPerennials = allMorePerennials.filter(e => !allShownMoreIds.has(e.id));

    if (unshownPerennials.length > 0) {
      const perennialBatch = unshownPerennials.slice(0, 4);
      const eventMap = { ...session.lastEvents };
      for (const e of perennialBatch) eventMap[e.id] = e;
      trace.events.cache_size = 0;
      trace.events.candidates_count = perennialBatch.length;
      trace.events.candidate_ids = perennialBatch.map(e => e.id);
      const extraContext = `\nNOTE: This is the LAST batch of recommendations I have.\nOVERRIDE CLOSING LINE: Instead of "Reply 1-N for details, MORE for extra picks", use "Reply 1-N for details" (no MORE option). Then add "That's everything I've got in ${hood}! Try a different neighborhood for more."`;
      const result = await composeAndSend(perennialBatch, hood, route.filters, 'more', { excludeIds: [...allShownMoreIds], extraContext });
      result.sms_text = result.sms_text
        .replace(/,?\s*MORE for extra picks/gi, '')
        .replace(/,?\s*or MORE for more/gi, '')
        .replace(/,?\s*MORE for more picks/gi, '')
        .replace(/\s*Reply MORE[^.!\n]*/gi, '')
        .replace(/,?\s*MORE for more/gi, '');
      const newAllPicks = [...(session.allPicks || session.lastPicks || []), ...(result.picks || [])];
      const newAllOfferedIds = [...(session.allOfferedIds || []), ...perennialBatch.map(e => e.id)];
      const visitedHoods = new Set([...(session.visitedHoods || []), hood]);
      setSession(phone, { lastPicks: result.picks || [], allPicks: newAllPicks, allOfferedIds: newAllOfferedIds, lastEvents: eventMap, lastNeighborhood: hood, visitedHoods: [...visitedHoods] });
      await sendComposeWithLinks(phone, result, eventMap);
      console.log(`Perennial picks sent to ${masked} after events exhausted in ${hood}`);
      finalizeTrace(result.sms_text, 'more');
      return;
    }

    // All events and perennials exhausted — suggest nearby
    const visited = new Set(session?.visitedHoods || [hood]);
    const nearby = getAdjacentNeighborhoods(hood, 4).filter(n => !visited.has(n));
    const suggestion = nearby.length > 0 ? ` Want to try ${nearby[0]}? It's right nearby.` : ' Try a different neighborhood or check back later!';
    const sms = `That's all I've got in ${hood} tonight!${suggestion}`;
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'more');
    return;
  }

  // --- Free ---
  if (route.intent === 'free') {
    if (!neighborhood && !session?.lastNeighborhood) {
      const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
      await sendSMS(phone, sms);
      finalizeTrace(sms, 'free');
      return;
    }
    const hood = neighborhood || session.lastNeighborhood;
    const events = await getEvents(hood);
    const freeEvents = events.filter(e => e.is_free);

    // Add free perennial picks
    const freePicks = getPerennialPicks(hood);
    const freeLocalPerennials = toEventObjects(freePicks.local, hood).filter(e => e.is_free);
    const freeNearbyPerennials = toEventObjects(freePicks.nearby, hood, { isNearby: true }).filter(e => e.is_free);
    const freePerennials = [...freeLocalPerennials, ...freeNearbyPerennials];

    if (freeEvents.length === 0 && freePerennials.length === 0) {
      // Search nearby neighborhoods for free events
      const nearbyHoods = getAdjacentNeighborhoods(hood, 3);
      for (const nearbyHood of nearbyHoods) {
        const nearbyEvents = await getEvents(nearbyHood);
        const nearbyFree = nearbyEvents.filter(e => e.is_free);
        if (nearbyFree.length > 0) {
          trace.events.cache_size = nearbyEvents.length;
          trace.events.candidates_count = nearbyFree.length;
          trace.events.candidate_ids = nearbyFree.map(e => e.id);
          const eventMap = {};
          for (const e of nearbyFree) eventMap[e.id] = e;
          const result = await composeAndSend(nearbyFree.slice(0, 8), nearbyHood, { ...route.filters, free_only: true }, 'free');
          setSession(phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
          await sendComposeWithLinks(phone, result, eventMap);
          console.log(`Free events from nearby ${nearbyHood} sent to ${masked}`);
          finalizeTrace(result.sms_text, 'free');
          return;
        }
      }
      const sms = `Nothing free near ${hood} tonight — text "${hood}" for all events or try a different neighborhood.`;
      await sendSMS(phone, sms);
      finalizeTrace(sms, 'free');
      return;
    }

    // Merge free scraped events + free perennial picks
    const freePerennialCap = Math.min(4, 8 - Math.min(freeEvents.length, 8));
    const freeCombined = [...freeEvents.slice(0, 8 - Math.min(freePerennials.length, freePerennialCap)), ...freePerennials.slice(0, freePerennialCap)];
    trace.events.cache_size = events.length;
    trace.events.candidates_count = freeCombined.length;
    trace.events.candidate_ids = freeCombined.map(e => e.id);
    const result = await composeAndSend(freeCombined.slice(0, 8), hood, route.filters, 'free');
    const eventMap = {};
    for (const e of freeEvents) eventMap[e.id] = e;
    for (const e of freePerennials) eventMap[e.id] = e;
    setSession(phone, {
      lastPicks: result.picks || [],
      allPicks: result.picks || [],
      lastEvents: eventMap,
      lastNeighborhood: hood,
    });
    await sendComposeWithLinks(phone, result, eventMap);
    console.log(`Free events sent to ${masked}`);
    finalizeTrace(result.sms_text, 'free');
    return;
  }

  // --- Nudge accept (user said yes to travel suggestion) ---
  if (route.intent === 'nudge_accept') {
    const acceptedHood = route.neighborhood;
    // If user accepted the suggested neighborhood and we have pre-fetched events, serve them
    if (acceptedHood === session?.pendingNearby && session?.pendingNearbyEvents && Object.keys(session.pendingNearbyEvents).length > 0) {
      const nearbyEvents = session.pendingNearbyEvents;
      const composeEvents = Object.values(nearbyEvents).slice(0, 8);
      trace.events.cache_size = Object.keys(nearbyEvents).length;
      trace.events.candidates_count = composeEvents.length;
      trace.events.candidate_ids = composeEvents.map(e => e.id);
      const result = await composeAndSend(composeEvents, acceptedHood, route.filters, 'nudge_accept');
      setSession(phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: nearbyEvents, lastNeighborhood: acceptedHood });
      await sendComposeWithLinks(phone, result, nearbyEvents);
      console.log(`Nudge accept: served ${acceptedHood} picks to ${masked}`);
      finalizeTrace(result.sms_text, 'nudge_accept');
      return;
    }
    // User counter-suggested a different neighborhood — fetch events for that one
    if (acceptedHood) {
      const counterEvents = await getEvents(acceptedHood);
      if (counterEvents.length > 0) {
        const composeEvents = counterEvents.slice(0, 8);
        trace.events.cache_size = counterEvents.length;
        trace.events.candidates_count = composeEvents.length;
        trace.events.candidate_ids = composeEvents.map(e => e.id);
        const eventMap = {};
        for (const e of counterEvents) eventMap[e.id] = e;
        const result = await composeAndSend(composeEvents, acceptedHood, route.filters, 'nudge_accept');
        setSession(phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: acceptedHood });
        await sendComposeWithLinks(phone, result, eventMap);
        console.log(`Nudge accept (counter-suggestion): served ${acceptedHood} picks to ${masked}`);
        finalizeTrace(result.sms_text, 'nudge_accept');
        return;
      }
      // Counter-suggestion also has no events — find nearest with events, no more loops
      const nearby2 = getAdjacentNeighborhoods(acceptedHood, 5);
      for (const nearbyHood of nearby2) {
        const nearbyEvents = await getEvents(nearbyHood);
        if (nearbyEvents.length > 0) {
          const composeEvents = nearbyEvents.slice(0, 8);
          const eventMap = {};
          for (const e of nearbyEvents) eventMap[e.id] = e;
          const result = await composeAndSend(composeEvents, nearbyHood, route.filters, 'nudge_accept');
          setSession(phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
          await sendComposeWithLinks(phone, result, eventMap);
          console.log(`Nudge accept (nearby fallback): served ${nearbyHood} picks to ${masked}`);
          finalizeTrace(result.sms_text, 'nudge_accept');
          return;
        }
      }
    }
    // Fallback: treat as regular events request
    console.warn('Nudge accept but no saved events, falling through to events');
  }

  // --- Unknown intent guard ---
  if (!['events', 'free', 'more', 'details', 'help', 'conversational', 'nudge_accept'].includes(route.intent)) {
    console.warn(`Unknown intent "${route.intent}", treating as events`);
  }

  // Ask for neighborhood if we still don't have one
  if (!neighborhood) {
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(phone, sms);
    finalizeTrace(sms, route.intent);
    return;
  }

  // --- Events (default) ---
  let hood = neighborhood;
  let events = await getEvents(hood);
  console.log(`Found ${events.length} events near ${hood}`);

  // Apply free_only filter when routed as events but user asked for free
  if (route.filters?.free_only) {
    events = events.filter(e => e.is_free);
  }

  // Apply category filter (e.g. comedy, art, live_music)
  let categoryApplied = false;
  if (route.filters?.category) {
    const catEvents = events.filter(e => e.category === route.filters.category);
    if (catEvents.length > 0) {
      events = catEvents;
      categoryApplied = true;
    } else {
      // No local matches — search nearby neighborhoods for this category
      const nearbyHoods = getAdjacentNeighborhoods(hood, 5);
      let catFoundNearby = false;
      for (const nearbyHood of nearbyHoods) {
        const nearbyEvents = await getEvents(nearbyHood);
        const nearbyCat = nearbyEvents.filter(e => e.category === route.filters.category);
        if (nearbyCat.length > 0) {
          events = nearbyCat;
          console.log(`Category ${route.filters.category}: found ${nearbyCat.length} in ${nearbyHood} (not in ${hood})`);
          hood = nearbyHood;  // Update hood so compose and inHood check reference the right place
          catFoundNearby = true;
          categoryApplied = true;
          break;
        }
      }
      if (events.filter(e => e.category === route.filters.category).length === 0) {
        const catName = route.filters.category.replace(/_/g, ' ');
        const sms = `Not seeing any ${catName} near ${hood} tonight. Text "${hood}" to see everything, or try a different neighborhood!`;
        await sendSMS(phone, sms);
        finalizeTrace(sms, 'events');
        return;
      }
    }
  }

  // Perennial picks — merge LOCAL picks only as event objects for compose
  // (nearby perennial picks caused Claude to mention wrong neighborhoods, e.g. UWS for Washington Heights)
  const perennialPicks = getPerennialPicks(hood);
  const localPerennials = toEventObjects(perennialPicks.local, hood);
  const perennialCap = Math.min(4, 8 - Math.min(events.length, 8));
  const perennialEvents = localPerennials.slice(0, perennialCap);
  const composeEventsWithPerennials = [...events.slice(0, 8 - perennialEvents.length), ...perennialEvents];

  // Prevent redirect loops: if user already got a travel nudge, serve nearby events directly
  const alreadyNudged = !!session?.pendingNearby;

  if (events.length === 0) {

    // Check LOCAL perennial picks before nudging to a nearby neighborhood
    // (nearby perennial picks caused wrong-neighborhood mentions, e.g. UWS for Washington Heights)
    const zeroPicks = getPerennialPicks(hood);
    const zeroLocal = toEventObjects(zeroPicks.local, hood);
    const zeroPerennials = zeroLocal.slice(0, 4);
    if (zeroPerennials.length > 0) {
      const eventMap = {};
      for (const e of zeroPerennials) eventMap[e.id] = e;
      trace.events.cache_size = 0;
      trace.events.candidates_count = zeroPerennials.length;
      trace.events.candidate_ids = zeroPerennials.map(e => e.id);
      const result = await composeAndSend(zeroPerennials, hood, route.filters, 'events');
      setSession(phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: hood, visitedHoods: [hood] });
      await sendComposeWithLinks(phone, result, eventMap);
      console.log(`Perennial picks sent to ${masked} (zero scraped events in ${hood})`);
      finalizeTrace(result.sms_text, 'events');
      return;
    }

    // Find nearby neighborhoods WITH events for a proper travel nudge
    const nearbyHoods = getAdjacentNeighborhoods(hood, 5);
    for (const nearbyHood of nearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      if (nearbyEvents.length > 0) {
        if (alreadyNudged) {
          // Skip the nudge question — serve events directly to break the loop
          const composeEvents = nearbyEvents.slice(0, 8);
          const eventMap = {};
          for (const e of nearbyEvents) eventMap[e.id] = e;
          trace.events.cache_size = nearbyEvents.length;
          trace.events.candidates_count = composeEvents.length;
          trace.events.candidate_ids = composeEvents.map(e => e.id);
          const result = await composeAndSend(composeEvents, nearbyHood, route.filters, 'events');
          setSession(phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
          await sendComposeWithLinks(phone, result, eventMap);
          console.log(`Loop prevention: served ${nearbyHood} picks to ${masked} (skipped nudge)`);
          finalizeTrace(result.sms_text, 'events');
          return;
        }
        const cats = {};
        for (const e of nearbyEvents) cats[e.category || 'events'] = (cats[e.category || 'events'] || 0) + 1;
        const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'events';
        const vibeWord = { live_music: 'some music', nightlife: 'some nightlife', comedy: 'some comedy', art: 'some art', community: 'something cool', food_drink: 'some food & drinks', theater: 'some theater' }[topCat] || 'some stuff going on';
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        // Don't set lastNeighborhood — user hasn't committed to a neighborhood yet
        setSession(phone, { pendingNearby: nearbyHood, pendingNearbyEvents: eventMap });
        const sms = `Hey not much going on in ${hood}... would you travel to ${nearbyHood} for ${vibeWord}?`;
        await sendSMS(phone, sms);
        console.log(`Nudge sent to ${masked}: ${hood} → ${nearbyHood} (${nearbyEvents.length} events)`);
        finalizeTrace(sms, 'events');
        return;
      }
    }
    // No nearby neighborhoods with events either
    const sms = `Quiet night in ${hood} — not seeing much right now. Check back later!`;
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'events');
    return;
  }

  // Check if any events are actually in the requested neighborhood
  const inHood = events.filter(e => e.neighborhood === hood);

  // Redirect to travel nudge when:
  // 1) No events are in the requested hood (e.g. Astoria gets only UES events via proximity)
  // 2) Very thin cache (≤1 event) with no local perennial picks to supplement
  // Uses getAdjacentNeighborhoods (borough-aware) instead of event density
  const thinWithNoPerennial = events.length <= 1 && localPerennials.length === 0;
  if ((inHood.length === 0 || thinWithNoPerennial) && !alreadyNudged && !categoryApplied) {
    const thinNearbyHoods = getAdjacentNeighborhoods(hood, 5);
    for (const nearbyHood of thinNearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      if (nearbyEvents.length > 0) {
        const cats = {};
        for (const e of nearbyEvents) cats[e.category || 'events'] = (cats[e.category || 'events'] || 0) + 1;
        const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'events';
        const vibeWord = { live_music: 'some music', nightlife: 'some nightlife', comedy: 'some comedy', art: 'some art', community: 'something cool', food_drink: 'some food & drinks', theater: 'some theater' }[topCat] || 'some stuff going on';
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        setSession(phone, { pendingNearby: nearbyHood, pendingNearbyEvents: eventMap });
        const sms = `Hey not much going on in ${hood}... would you travel to ${nearbyHood} for ${vibeWord}?`;
        await sendSMS(phone, sms);
        console.log(`Thin nudge to ${masked}: ${hood} → ${nearbyHood} (inHood=${inHood.length}, events=${events.length})`);
        finalizeTrace(sms, 'events');
        return;
      }
    }
    // No nearby hoods with events either — fall through to compose with what we have
  }

  // Capture event funnel data
  trace.events.cache_size = events.length;
  trace.events.candidates_count = composeEventsWithPerennials.length;
  trace.events.candidate_ids = composeEventsWithPerennials.map(e => e.id);

  // CALL 2: Compose response (scraped events + perennial picks merged)
  const result = await composeAndSend(composeEventsWithPerennials, hood, route.filters, 'events');

  // Keep full event map in session so MORE can access remaining events + perennials
  const eventMap = {};
  for (const e of events) eventMap[e.id] = e;
  for (const e of perennialEvents) eventMap[e.id] = e;

  setSession(phone, { lastPicks: result.picks || [], allPicks: result.picks || [], allOfferedIds: composeEventsWithPerennials.map(e => e.id), lastEvents: eventMap, lastNeighborhood: result.neighborhood_used || hood, visitedHoods: [hood] });

  await sendComposeWithLinks(phone, result, eventMap);
  console.log(`AI response sent to ${masked}`);
  finalizeTrace(result.sms_text, 'events');
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
