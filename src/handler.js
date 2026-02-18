const express = require('express');
const twilio = require('twilio');
const { extractNeighborhood, NEIGHBORHOODS } = require('./neighborhoods');
const { getEvents } = require('./events');
const { routeMessage, composeResponse, composeDetails, isSearchUrl } = require('./ai');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { startTrace, saveTrace } = require('./traces');
const { getSession, setSession, clearSession, clearSessionInterval } = require('./session');
const { formatEventDetails, cleanUrl, smartTruncate } = require('./formatters');
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

  if (isRateLimited(phone)) {
    console.warn(`Rate limited: ${masked}`);
    await sendSMS(phone, "Easy there — give it a few minutes and try again!");
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
// AI flow — per-intent handlers + orchestrator
// =======================================================

const VIBE_WORDS = { live_music: 'some music', nightlife: 'some nightlife', comedy: 'some comedy', art: 'some art', community: 'something cool', food_drink: 'some food & drinks', theater: 'some theater' };

function topVibeWord(events) {
  const cats = {};
  for (const e of events) cats[e.category || 'events'] = (cats[e.category || 'events'] || 0) + 1;
  const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'events';
  return VIBE_WORDS[topCat] || 'some stuff going on';
}

function stripMoreReferences(text) {
  return text
    .replace(/,?\s*MORE for extra picks/gi, '')
    .replace(/,?\s*or MORE for more/gi, '')
    .replace(/,?\s*MORE for more picks/gi, '')
    .replace(/\s*Reply MORE[^.!\n]*/gi, '')
    .replace(/,?\s*MORE for more/gi, '');
}

// --- Help ---
async function handleHelp(ctx) {
  const reply = ctx.route.reply || "Hey! I'm Pulse — text me a neighborhood and I'll find tonight's best events.\n\nTry: \"East Village\", \"prospect park\", \"bedford ave\"\n\nYou can ask for comedy, jazz, free events, or any vibe. Reply a number for details on a pick, or \"more\" for more options.";
  const sms = smartTruncate(reply);
  await sendSMS(ctx.phone, sms);
  console.log(`Help sent to ${ctx.masked}`);
  ctx.finalizeTrace(sms, 'help');
}

// --- Conversational ---
async function handleConversational(ctx) {
  let reply = ctx.route.reply || "Hey! Text a neighborhood whenever you're ready to go out.";
  if (ctx.session?.lastNeighborhood) {
    reply = reply.replace(
      /text (?:me )?a neighborhood[^.]*/i,
      `say "more" for more ${ctx.session.lastNeighborhood} picks, or text a different neighborhood`
    );
  }
  const sms = smartTruncate(reply);
  await sendSMS(ctx.phone, sms);
  console.log(`Conversational reply sent to ${ctx.masked}`);
  ctx.finalizeTrace(sms, 'conversational');
}

// --- Details ---
async function handleDetails(ctx) {
  const picks = ctx.session?.lastPicks;
  if (ctx.session && picks?.length > 0) {
    const ref = parseInt(ctx.route.event_reference, 10);

    if (!ref || isNaN(ref)) {
      const details = picks.map((pick, i) => {
        const event = ctx.session.lastEvents[pick.event_id];
        return event ? `${i + 1}. ${formatEventDetails(event)}` : null;
      }).filter(Boolean);
      const allText = details.join('\n\n');
      const sms = smartTruncate(allText);
      await sendSMS(ctx.phone, sms);
      console.log(`All details sent to ${ctx.masked}`);
      ctx.finalizeTrace(sms, 'details');
      return;
    }

    if (ref > picks.length) {
      const sms = picks.length === 1
        ? "I only showed you 1 pick — reply 1 for details."
        : `I only showed you ${picks.length} picks — reply 1-${picks.length} for details.`;
      await sendSMS(ctx.phone, sms);
      ctx.finalizeTrace(sms, 'details');
      return;
    }
    const pickIndex = Math.max(0, ref - 1);
    const pick = picks[pickIndex];
    const event = ctx.session.lastEvents[pick.event_id];
    if (event) {
      try {
        const composeStart = Date.now();
        const result = await composeDetails(event, pick.why);
        ctx.trace.composition.latency_ms = Date.now() - composeStart;
        ctx.trace.composition.raw_response = result._raw || null;
        const sms = result.sms_text;
        await sendSMS(ctx.phone, sms);
        console.log(`Details ${ref} sent to ${ctx.masked}`);
        ctx.finalizeTrace(sms, 'details');
        return;
      } catch (err) {
        console.error('composeDetails error, falling back:', err.message);
        const sms = formatEventDetails(event);
        await sendSMS(ctx.phone, sms);
        ctx.finalizeTrace(sms, 'details');
        return;
      }
    }
  }
  const sms = "I don't have any recent picks to pull up — text me a neighborhood and let's start fresh!";
  await sendSMS(ctx.phone, sms);
  ctx.finalizeTrace(sms, 'details');
}

// --- More ---
async function handleMore(ctx) {
  const allOfferedIds = new Set(ctx.session?.allOfferedIds || []);
  const allPickIds = new Set((ctx.session?.allPicks || ctx.session?.lastPicks || []).map(p => p.event_id));
  const allShownIds = new Set([...allOfferedIds, ...allPickIds]);
  const hood = ctx.neighborhood || ctx.session?.lastNeighborhood;

  if (ctx.session && ctx.session.lastEvents) {
    const allRemaining = Object.values(ctx.session.lastEvents).filter(e => !allShownIds.has(e.id));

    if (allRemaining.length > 0) {
      const composeRemaining = allRemaining.slice(0, 8);
      const isLastBatch = allRemaining.length <= 8;
      const nearbyForExhaustion = isLastBatch ? getAdjacentNeighborhoods(hood, 3).filter(n => !(ctx.session?.visitedHoods || []).includes(n))[0] : null;
      const exhaustionSuggestion = nearbyForExhaustion
        ? `That's everything I've got in ${hood}! ${nearbyForExhaustion} is right nearby — want picks from there?`
        : `That's everything I've got in ${hood}! Try a different neighborhood for more.`;
      const extraContext = isLastBatch
        ? `\nNOTE: This is the LAST batch of events I have.\nOVERRIDE CLOSING LINE: Instead of "Reply 1-N for details, MORE for extra picks", use "Reply 1-N for details" (no MORE option). Then add "${exhaustionSuggestion}"`
        : '';

      ctx.trace.events.cache_size = Object.keys(ctx.session.lastEvents).length;
      ctx.trace.events.candidates_count = allRemaining.length;
      ctx.trace.events.candidate_ids = allRemaining.map(e => e.id);
      const result = await ctx.composeAndSend(composeRemaining, hood, ctx.route.filters, 'more', { excludeIds: [...allShownIds], extraContext });

      // Name-based dedup: filter out picks that share a name with previously shown events
      const prevPickNames = new Set(
        (ctx.session.allPicks || ctx.session.lastPicks || [])
          .map(p => ctx.session.lastEvents[p.event_id]?.name?.toLowerCase())
          .filter(Boolean)
      );
      result.picks = (result.picks || []).filter(p => {
        const evt = ctx.session.lastEvents[p.event_id];
        return !evt || !prevPickNames.has(evt.name?.toLowerCase());
      });

      if (isLastBatch) {
        result.sms_text = stripMoreReferences(result.sms_text);
      }

      const newAllPicks = [...(ctx.session.allPicks || ctx.session.lastPicks || []), ...(result.picks || [])];
      const newAllOfferedIds = [...allOfferedIds, ...composeRemaining.map(e => e.id)];
      const visitedHoods = new Set([...(ctx.session.visitedHoods || []), hood]);
      setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: newAllPicks, allOfferedIds: newAllOfferedIds, lastEvents: ctx.session.lastEvents, lastNeighborhood: hood, visitedHoods: [...visitedHoods] });
      await sendComposeWithLinks(ctx.phone, result, ctx.session.lastEvents);

      console.log(`More sent to ${ctx.masked} (${allRemaining.length} remaining${isLastBatch ? ', last batch' : ''})`);
      ctx.finalizeTrace(result.sms_text, 'more');
      return;
    }
  }

  if (!ctx.session?.lastNeighborhood) {
    const sms = "Text me a neighborhood and I'll find you something! East Village, Williamsburg, LES — whatever's close.";
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'more');
    return;
  }

  // All scraped events exhausted — check for unshown perennial picks
  const morePicks = getPerennialPicks(hood);
  const moreLocalPerennials = toEventObjects(morePicks.local, hood);
  const moreNearbyPerennials = toEventObjects(morePicks.nearby, hood, { isNearby: true });
  const allMorePerennials = [...moreLocalPerennials, ...moreNearbyPerennials];
  const allShownMoreIds = new Set([...(ctx.session?.allOfferedIds || []), ...(ctx.session?.allPicks || ctx.session?.lastPicks || []).map(p => p.event_id)]);
  const unshownPerennials = allMorePerennials.filter(e => !allShownMoreIds.has(e.id));

  if (unshownPerennials.length > 0) {
    const perennialBatch = unshownPerennials.slice(0, 4);
    const eventMap = { ...ctx.session.lastEvents };
    for (const e of perennialBatch) eventMap[e.id] = e;
    ctx.trace.events.cache_size = 0;
    ctx.trace.events.candidates_count = perennialBatch.length;
    ctx.trace.events.candidate_ids = perennialBatch.map(e => e.id);
    const perennialNearby = getAdjacentNeighborhoods(hood, 3).filter(n => !(ctx.session?.visitedHoods || []).includes(n))[0];
    const perennialSuggestion = perennialNearby
      ? `That's everything I've got in ${hood}! ${perennialNearby} is right nearby — want picks from there?`
      : `That's everything I've got in ${hood}! Try a different neighborhood for more.`;
    const extraContext = `\nNOTE: This is the LAST batch of recommendations I have.\nOVERRIDE CLOSING LINE: Instead of "Reply 1-N for details, MORE for extra picks", use "Reply 1-N for details" (no MORE option). Then add "${perennialSuggestion}"`;
    const result = await ctx.composeAndSend(perennialBatch, hood, ctx.route.filters, 'more', { excludeIds: [...allShownMoreIds], extraContext });
    result.sms_text = stripMoreReferences(result.sms_text);
    const newAllPicks = [...(ctx.session.allPicks || ctx.session.lastPicks || []), ...(result.picks || [])];
    const newAllOfferedIds = [...(ctx.session.allOfferedIds || []), ...perennialBatch.map(e => e.id)];
    const visitedHoods = new Set([...(ctx.session.visitedHoods || []), hood]);
    setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: newAllPicks, allOfferedIds: newAllOfferedIds, lastEvents: eventMap, lastNeighborhood: hood, visitedHoods: [...visitedHoods] });
    await sendComposeWithLinks(ctx.phone, result, eventMap);
    console.log(`Perennial picks sent to ${ctx.masked} after events exhausted in ${hood}`);
    ctx.finalizeTrace(result.sms_text, 'more');
    return;
  }

  // All events and perennials exhausted — suggest specific nearby neighborhood
  const visited = new Set(ctx.session?.visitedHoods || [hood]);
  const nearby = getAdjacentNeighborhoods(hood, 4).filter(n => !visited.has(n));
  const suggestion = nearby.length > 0 ? ` ${nearby[0]} is right nearby — want picks from there?` : ' Try a different neighborhood or check back later!';
  const sms = `That's all I've got in ${hood} tonight!${suggestion}`;
  await sendSMS(ctx.phone, sms);
  ctx.finalizeTrace(sms, 'more');
}

// --- Free ---
async function handleFree(ctx) {
  const hood = ctx.neighborhood;
  if (!hood) {
    setSession(ctx.phone, { pendingFilters: { ...ctx.route.filters, free_only: true } });
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'free');
    return;
  }

  const events = await getEvents(hood);
  const freeEvents = events.filter(e => e.is_free);

  // Apply category filter if present (from pending filters or route)
  let filteredFree = freeEvents;
  if (ctx.route.filters?.category) {
    const catFiltered = freeEvents.filter(e => e.category === ctx.route.filters.category);
    if (catFiltered.length > 0) filteredFree = catFiltered;
  }

  if (filteredFree.length === 0) {
    const nearbyHoods = getAdjacentNeighborhoods(hood, 3);
    for (const nearbyHood of nearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      let nearbyFree = nearbyEvents.filter(e => e.is_free);
      if (ctx.route.filters?.category) {
        const nearbyCat = nearbyFree.filter(e => e.category === ctx.route.filters.category);
        if (nearbyCat.length > 0) nearbyFree = nearbyCat;
      }
      if (nearbyFree.length > 0) {
        ctx.trace.events.cache_size = nearbyEvents.length;
        ctx.trace.events.candidates_count = nearbyFree.length;
        ctx.trace.events.candidate_ids = nearbyFree.map(e => e.id);
        const eventMap = {};
        for (const e of nearbyFree) eventMap[e.id] = e;
        const result = await ctx.composeAndSend(nearbyFree.slice(0, 8), nearbyHood, { ...ctx.route.filters, free_only: true }, 'free');
        setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
        await sendComposeWithLinks(ctx.phone, result, eventMap);
        console.log(`Free events from nearby ${nearbyHood} sent to ${ctx.masked}`);
        ctx.finalizeTrace(result.sms_text, 'free');
        return;
      }
    }
    const catLabel = ctx.route.filters?.category ? ctx.route.filters.category.replace(/_/g, ' ') + ' ' : '';
    const sms = `Nothing free ${catLabel}near ${hood} tonight — text "${hood}" for all events or try a different neighborhood!`;
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'free');
    return;
  }

  ctx.trace.events.cache_size = events.length;
  ctx.trace.events.candidates_count = Math.min(filteredFree.length, 8);
  ctx.trace.events.candidate_ids = filteredFree.slice(0, 8).map(e => e.id);
  const result = await ctx.composeAndSend(filteredFree.slice(0, 8), hood, ctx.route.filters, 'free');
  const eventMap = {};
  for (const e of filteredFree) eventMap[e.id] = e;
  setSession(ctx.phone, {
    lastPicks: result.picks || [],
    allPicks: result.picks || [],
    lastEvents: eventMap,
    lastNeighborhood: hood,
  });
  await sendComposeWithLinks(ctx.phone, result, eventMap);
  console.log(`Free events sent to ${ctx.masked}`);
  ctx.finalizeTrace(result.sms_text, 'free');
}

// --- Nudge accept (user said yes to travel suggestion) ---
// Returns true if handled, false to fall through to events
async function handleNudgeAccept(ctx) {
  const acceptedHood = ctx.route.neighborhood;
  if (acceptedHood === ctx.session?.pendingNearby && ctx.session?.pendingNearbyEvents && Object.keys(ctx.session.pendingNearbyEvents).length > 0) {
    const nearbyEvents = ctx.session.pendingNearbyEvents;
    const composeEvents = Object.values(nearbyEvents).slice(0, 8);
    ctx.trace.events.cache_size = Object.keys(nearbyEvents).length;
    ctx.trace.events.candidates_count = composeEvents.length;
    ctx.trace.events.candidate_ids = composeEvents.map(e => e.id);
    const result = await ctx.composeAndSend(composeEvents, acceptedHood, ctx.route.filters, 'nudge_accept');
    setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: nearbyEvents, lastNeighborhood: acceptedHood });
    await sendComposeWithLinks(ctx.phone, result, nearbyEvents);
    console.log(`Nudge accept: served ${acceptedHood} picks to ${ctx.masked}`);
    ctx.finalizeTrace(result.sms_text, 'nudge_accept');
    return true;
  }
  if (acceptedHood) {
    const counterEvents = await getEvents(acceptedHood);
    if (counterEvents.length > 0) {
      const composeEvents = counterEvents.slice(0, 8);
      ctx.trace.events.cache_size = counterEvents.length;
      ctx.trace.events.candidates_count = composeEvents.length;
      ctx.trace.events.candidate_ids = composeEvents.map(e => e.id);
      const eventMap = {};
      for (const e of counterEvents) eventMap[e.id] = e;
      const result = await ctx.composeAndSend(composeEvents, acceptedHood, ctx.route.filters, 'nudge_accept');
      setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: acceptedHood });
      await sendComposeWithLinks(ctx.phone, result, eventMap);
      console.log(`Nudge accept (counter-suggestion): served ${acceptedHood} picks to ${ctx.masked}`);
      ctx.finalizeTrace(result.sms_text, 'nudge_accept');
      return true;
    }
    const nearby2 = getAdjacentNeighborhoods(acceptedHood, 5);
    for (const nearbyHood of nearby2) {
      const nearbyEvents = await getEvents(nearbyHood);
      if (nearbyEvents.length > 0) {
        const composeEvents = nearbyEvents.slice(0, 8);
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        const result = await ctx.composeAndSend(composeEvents, nearbyHood, ctx.route.filters, 'nudge_accept');
        setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
        await sendComposeWithLinks(ctx.phone, result, eventMap);
        console.log(`Nudge accept (nearby fallback): served ${nearbyHood} picks to ${ctx.masked}`);
        ctx.finalizeTrace(result.sms_text, 'nudge_accept');
        return true;
      }
    }
  }
  console.warn('Nudge accept but no saved events, falling through to events');
  return false;
}

// --- Events (default) ---
async function handleEventsDefault(ctx) {
  let hood = ctx.neighborhood;
  let events = await getEvents(hood);
  console.log(`Found ${events.length} events near ${hood}`);

  // Apply free_only filter when routed as events but user asked for free
  if (ctx.route.filters?.free_only) {
    events = events.filter(e => e.is_free);
  }

  // Apply category filter (e.g. comedy, art, live_music)
  let categoryApplied = false;
  if (ctx.route.filters?.category) {
    const catEvents = events.filter(e => e.category === ctx.route.filters.category);
    if (catEvents.length > 0) {
      events = catEvents;
      categoryApplied = true;
    } else {
      const nearbyHoods = getAdjacentNeighborhoods(hood, 5);
      for (const nearbyHood of nearbyHoods) {
        const nearbyEvents = await getEvents(nearbyHood);
        const nearbyCat = nearbyEvents.filter(e => e.category === ctx.route.filters.category);
        if (nearbyCat.length > 0) {
          events = nearbyCat;
          console.log(`Category ${ctx.route.filters.category}: found ${nearbyCat.length} in ${nearbyHood} (not in ${hood})`);
          hood = nearbyHood;
          categoryApplied = true;
          break;
        }
      }
      if (events.filter(e => e.category === ctx.route.filters.category).length === 0) {
        const catName = ctx.route.filters.category.replace(/_/g, ' ');
        const sms = `Not seeing any ${catName} near ${hood} tonight. Text "${hood}" to see everything, or try a different neighborhood!`;
        await sendSMS(ctx.phone, sms);
        ctx.finalizeTrace(sms, 'events');
        return;
      }
    }
  }

  // Perennial picks — merge LOCAL picks only as event objects for compose
  const perennialPicks = getPerennialPicks(hood);
  const localPerennials = toEventObjects(perennialPicks.local, hood);
  const perennialCap = Math.min(4, 8 - Math.min(events.length, 8));
  const perennialEvents = localPerennials.slice(0, perennialCap);
  const composeEventsWithPerennials = [...events.slice(0, 8 - perennialEvents.length), ...perennialEvents];

  // Prevent redirect loops: if user already got a travel nudge, serve nearby events directly
  const alreadyNudged = !!ctx.session?.pendingNearby;

  if (events.length === 0) {
    // Check LOCAL perennial picks before nudging to a nearby neighborhood
    const zeroPicks = getPerennialPicks(hood);
    const zeroLocal = toEventObjects(zeroPicks.local, hood);
    const zeroPerennials = zeroLocal.slice(0, 4);
    if (zeroPerennials.length > 0) {
      const eventMap = {};
      for (const e of zeroPerennials) eventMap[e.id] = e;
      ctx.trace.events.cache_size = 0;
      ctx.trace.events.candidates_count = zeroPerennials.length;
      ctx.trace.events.candidate_ids = zeroPerennials.map(e => e.id);
      const result = await ctx.composeAndSend(zeroPerennials, hood, ctx.route.filters, 'events');
      setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: hood, visitedHoods: [hood] });
      await sendComposeWithLinks(ctx.phone, result, eventMap);
      console.log(`Perennial picks sent to ${ctx.masked} (zero scraped events in ${hood})`);
      ctx.finalizeTrace(result.sms_text, 'events');
      return;
    }

    // Find nearby neighborhoods WITH events for a proper travel nudge
    const nearbyHoods = getAdjacentNeighborhoods(hood, 5);
    for (const nearbyHood of nearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      if (nearbyEvents.length > 0) {
        if (alreadyNudged) {
          const composeEvents = nearbyEvents.slice(0, 8);
          const eventMap = {};
          for (const e of nearbyEvents) eventMap[e.id] = e;
          ctx.trace.events.cache_size = nearbyEvents.length;
          ctx.trace.events.candidates_count = composeEvents.length;
          ctx.trace.events.candidate_ids = composeEvents.map(e => e.id);
          const result = await ctx.composeAndSend(composeEvents, nearbyHood, ctx.route.filters, 'events');
          setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
          await sendComposeWithLinks(ctx.phone, result, eventMap);
          console.log(`Loop prevention: served ${nearbyHood} picks to ${ctx.masked} (skipped nudge)`);
          ctx.finalizeTrace(result.sms_text, 'events');
          return;
        }
        const vibeWord = topVibeWord(nearbyEvents);
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        setSession(ctx.phone, { pendingNearby: nearbyHood, pendingNearbyEvents: eventMap });
        const sms = `Hey not much going on in ${hood}... would you travel to ${nearbyHood} for ${vibeWord}?`;
        await sendSMS(ctx.phone, sms);
        console.log(`Nudge sent to ${ctx.masked}: ${hood} → ${nearbyHood} (${nearbyEvents.length} events)`);
        ctx.finalizeTrace(sms, 'events');
        return;
      }
    }
    const sms = `Quiet night in ${hood} — not seeing much right now. Check back later!`;
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'events');
    return;
  }

  // Check if any events are actually in the requested neighborhood
  const inHood = events.filter(e => e.neighborhood === hood);

  // Redirect to travel nudge when events are thin
  const thinWithNoPerennial = events.length <= 1 && localPerennials.length === 0;
  const fewNearbyOnly = inHood.length === 0 && events.length <= 2;
  if ((fewNearbyOnly || thinWithNoPerennial) && !alreadyNudged && !categoryApplied) {
    const thinNearbyHoods = getAdjacentNeighborhoods(hood, 5);
    for (const nearbyHood of thinNearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      if (nearbyEvents.length > 0) {
        const vibeWord = topVibeWord(nearbyEvents);
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        setSession(ctx.phone, { pendingNearby: nearbyHood, pendingNearbyEvents: eventMap });
        const sms = `Hey not much going on in ${hood}... would you travel to ${nearbyHood} for ${vibeWord}?`;
        await sendSMS(ctx.phone, sms);
        console.log(`Thin nudge to ${ctx.masked}: ${hood} → ${nearbyHood} (inHood=${inHood.length}, events=${events.length})`);
        ctx.finalizeTrace(sms, 'events');
        return;
      }
    }
  }

  // Compose response (scraped events + perennial picks merged)
  ctx.trace.events.cache_size = events.length;
  ctx.trace.events.candidates_count = composeEventsWithPerennials.length;
  ctx.trace.events.candidate_ids = composeEventsWithPerennials.map(e => e.id);
  const result = await ctx.composeAndSend(composeEventsWithPerennials, hood, ctx.route.filters, 'events');

  const eventMap = {};
  for (const e of events) eventMap[e.id] = e;
  for (const e of perennialEvents) eventMap[e.id] = e;

  // Validate picks — filter out any hallucinated event_ids not in event map
  const validPicks = (result.picks || []).filter(p => eventMap[p.event_id]);
  if (validPicks.length < (result.picks || []).length) {
    console.warn(`Filtered ${(result.picks || []).length - validPicks.length} hallucinated pick IDs`);
  }

  setSession(ctx.phone, { lastPicks: validPicks, allPicks: validPicks, allOfferedIds: composeEventsWithPerennials.map(e => e.id), lastEvents: eventMap, lastNeighborhood: result.neighborhood_used || hood, visitedHoods: [hood] });
  await sendComposeWithLinks(ctx.phone, result, eventMap);
  console.log(`AI response sent to ${ctx.masked}`);
  ctx.finalizeTrace(result.sms_text, 'events');
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
    trace.output_sms = smsText || null;
    trace.output_sms_length = smsText ? smsText.length : 0;
    trace.output_intent = intent || trace.routing.result?.intent || null;
    trace.total_latency_ms = Date.now() - traceStart;
    saveTrace(trace);
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
  }
  console.log(`${preRouted ? 'Pre' : 'AI'} route: intent=${route.intent}, neighborhood=${route.neighborhood}, confidence=${route.confidence}`);

  // Shared compose helper (closure over message + trace)
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

  const ctx = { phone, message, masked, session, trace, route, finalizeTrace, composeAndSend };

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
      setSession(phone, { pendingFilters: route.filters });
    }
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'events');
    return;
  }

  // --- Dispatch: more and free run before pending filters (matches original order) ---
  if (route.intent === 'more') return handleMore(ctx);
  if (route.intent === 'free') return handleFree(ctx);

  // --- Restore pending filters (only for events/nudge_accept) ---
  const pendingFilters = session?.pendingFilters;
  if (pendingFilters) {
    if (pendingFilters.free_only && !route.filters?.free_only) {
      route.filters = { ...route.filters, free_only: true };
    }
    if (pendingFilters.category && !route.filters?.category) {
      route.filters = { ...route.filters, category: pendingFilters.category };
    }
    setSession(phone, { pendingFilters: null });
  }

  // Pending filters may redirect events→free
  if (route.filters?.free_only && route.intent === 'events') {
    return handleFree(ctx);
  }

  if (route.intent === 'nudge_accept') {
    const handled = await handleNudgeAccept(ctx);
    if (handled) return;
    // Fall through to events
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

  return handleEventsDefault(ctx);
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
