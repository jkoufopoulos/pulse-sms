const express = require('express');
const twilio = require('twilio');
const { extractNeighborhood, NEIGHBORHOODS } = require('./neighborhoods');
const { getEvents } = require('./events');
const { routeMessage, composeResponse } = require('./ai');
const { sendSMS, maskPhone, enableTestCapture, disableTestCapture } = require('./twilio');
const { parseAsNycTime } = require('./geo');
const { searchTavilyEvents } = require('./sources');
const { startTrace, saveTrace } = require('./traces');

const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

// --- Adjacent neighborhood helper (Euclidean approx, fine for NYC scale) ---
function getAdjacentNeighborhoods(hood, count = 3) {
  const target = NEIGHBORHOODS[hood];
  if (!target) return [];
  return Object.entries(NEIGHBORHOODS)
    .filter(([name]) => name !== hood)
    .map(([name, data]) => ({
      name,
      dist: Math.sqrt(Math.pow(target.lat - data.lat, 2) + Math.pow(target.lng - data.lng, 2)),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, count)
    .map(d => d.name);
}

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

// --- Event detail formatting ---
function formatTime(isoStr) {
  // Bare date (no time component) — parse as local to avoid UTC midnight shift
  if (!/T|:/.test(isoStr)) {
    try {
      const [y, m, d] = isoStr.split('-').map(Number);
      if (y && m && d) {
        return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      }
    } catch {}
    return isoStr;
  }
  try {
    // Use parseAsNycTime to correctly handle offset-less ISO strings
    // (e.g. Eventbrite's "2026-02-15T19:00:00" which is NYC local, not UTC)
    const ms = parseAsNycTime(isoStr);
    if (isNaN(ms)) return isoStr;
    return new Date(ms).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return isoStr; }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Strip UTM and tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref' || key === 'fbclid' || key === 'aff') {
        u.searchParams.delete(key);
      }
    }
    let clean = u.toString().replace(/\?$/, '');

    // Shorten Eventbrite: extract trailing numeric ID → eventbrite.com/e/<id>
    const ebMatch = clean.match(/eventbrite\.com\/e\/.*?(\d{10,})$/);
    if (ebMatch) return `https://www.eventbrite.com/e/${ebMatch[1]}`;

    // Shorten Dice: extract hash prefix → dice.fm/event/<hash>
    const diceMatch = clean.match(/dice\.fm\/event\/([a-z0-9]+)-/);
    if (diceMatch) return `https://dice.fm/event/${diceMatch[1]}`;

    // Shorten Songkick: strip slug after concert ID
    const skMatch = clean.match(/(songkick\.com\/concerts\/\d+)/);
    if (skMatch) return `https://www.${skMatch[1]}`;

    return clean;
  } catch { return url; }
}

function formatEventDetails(event) {
  const venue = event.venue_name && event.venue_name !== 'TBA' ? event.venue_name : null;

  // Dedupe: skip "at Venue" if event name already contains venue
  let detail = event.name || '';
  if (venue && !detail.toLowerCase().includes(venue.toLowerCase())) {
    detail += ` at ${venue}`;
  }

  // Time — show end time compactly if same day
  if (event.start_time_local) {
    detail += `\n${formatTime(event.start_time_local)}`;
    if (event.end_time_local) {
      try {
        const startMs = parseAsNycTime(event.start_time_local);
        const endMs = parseAsNycTime(event.end_time_local);
        const start = new Date(startMs);
        const end = new Date(endMs);
        // Compare dates in NYC timezone
        const startDate = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const endDate = end.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        if (startDate === endDate) {
          detail += ` – ${end.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}`;
        } else {
          detail += ` – ${formatTime(event.end_time_local)}`;
        }
      } catch {
        detail += ` – ${formatTime(event.end_time_local)}`;
      }
    }
  }

  if (event.is_free) detail += `\nFree!`;
  else if (event.price_display) detail += `\n${event.price_display}`;

  if (event.venue_address) detail += `\n${event.venue_address}`;
  if (event.ticket_url) detail += `\n${cleanUrl(event.ticket_url)}`;

  // Only show map_hint if it adds info beyond the address
  if (event.map_hint && (!event.venue_address || !event.venue_address.includes(event.map_hint))) {
    detail += `\nNear ${event.map_hint}`;
  }

  return detail.slice(0, 480);
}

// --- Deterministic pre-router (skips Claude for obvious intents) ---
function preRoute(message, session) {
  const msg = message.trim();
  const lower = msg.toLowerCase();
  const base = { filters: { free_only: false, category: null, vibe: null }, event_reference: null, reply: null, confidence: 1.0 };

  // Help
  if (/^(help|\?)$/i.test(msg)) {
    return { ...base, intent: 'help', neighborhood: null };
  }

  // Bare numbers → details (only if session has picks)
  if (/^[1-3]$/.test(msg) && session?.lastPicks?.length > 0) {
    return { ...base, intent: 'details', neighborhood: null, event_reference: msg };
  }

  // More
  if (/^(more|show me more|what else|anything else|what else you got|next|what's next)$/i.test(msg)) {
    return { ...base, intent: 'more', neighborhood: session?.lastNeighborhood || null };
  }

  // Free
  if (/^(free|free stuff|free events|free tonight|anything free)$/i.test(msg)) {
    return { ...base, intent: 'free', neighborhood: session?.lastNeighborhood || null, filters: { free_only: true, category: null, vibe: null } };
  }

  // Event name match from session picks (e.g. "vince anderson" matches "Rev. Vince Anderson @ Union Pool")
  if (session?.lastPicks && session?.lastEvents && lower.length >= 3) {
    for (let i = 0; i < session.lastPicks.length; i++) {
      const event = session.lastEvents[session.lastPicks[i].event_id];
      if (!event?.name) continue;
      if (event.name.toLowerCase().includes(lower)) {
        return { ...base, intent: 'details', neighborhood: null, event_reference: String(i + 1) };
      }
    }
  }

  // Greetings
  if (/^(hey|hi|hello|yo|sup|what's up|wassup|hola|howdy)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! Text me a neighborhood and I'll find you something good tonight." };
  }

  // Thanks
  if (/^(thanks|thank you|thx|ty|appreciate it|cheers)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Anytime! Text a neighborhood when you're ready to go out again." };
  }

  // Bye
  if (/^(bye|later|peace|gn|good night|night|see ya|cya|deuces)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Later! Hit me up whenever." };
  }

  // Bare neighborhood (short messages only — longer ones need Claude for intent/filters)
  if (msg.length <= 25) {
    const hood = extractNeighborhood(msg);
    if (hood) {
      return { ...base, intent: 'events', neighborhood: hood };
    }
  }

  return null; // Fall through to Claude
}

// --- Session store for DETAILS/MORE/FREE ---
// Maps phone → { lastPicks, lastEvents, lastNeighborhood, timestamp }
const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours

function getSession(phone) {
  const s = sessions.get(phone);
  if (s && Date.now() - s.timestamp < SESSION_TTL) return s;
  return null;
}

function setSession(phone, data) {
  sessions.set(phone, { ...data, timestamp: Date.now() });
}

// Clean stale sessions every 10 minutes
const sessionInterval = setInterval(() => {
  try {
    const cutoff = Date.now() - SESSION_TTL;
    for (const [phone, data] of sessions) {
      if (data.timestamp < cutoff) sessions.delete(phone);
    }
  } catch (e) { console.error('Session cleanup error:', e); }
}, 10 * 60 * 1000);

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
    enableTestCapture();
    try {
      await handleMessage(testPhone, message.trim());
      const captured = disableTestCapture() || [];
      res.json({ ok: true, messages: captured });
    } catch (err) {
      const captured = disableTestCapture() || [];
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
    const reply = route.reply || "Hey! I'm Pulse — your go-to for what's happening in NYC tonight. Just text me a neighborhood, a landmark, or even a subway stop and I'll send you my best picks. Try something like \"East Village\" or \"near Prospect Park\" and we'll go from there!";
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

      // Specific pick number requested
      const pickIndex = Math.min(ref - 1, picks.length - 1);
      const pick = picks[Math.max(0, pickIndex)];
      const event = session.lastEvents[pick.event_id];
      if (event) {
        const sms = formatEventDetails(event);
        await sendSMS(phone, sms);
        console.log(`Details ${ref} sent to ${masked}`);
        finalizeTrace(sms, 'details');
        return;
      }
    }
    const sms = "I don't have any recent picks to pull up — text me a neighborhood and let's start fresh!";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'details');
    return;
  }

  // --- Resolve neighborhood ---
  let neighborhood = route.neighborhood;

  // Validate against known neighborhoods
  if (neighborhood && !NEIGHBORHOOD_NAMES.includes(neighborhood)) {
    const validated = extractNeighborhood(neighborhood);
    neighborhood = validated || null;
  }

  // Fall back to session neighborhood
  if (!neighborhood) {
    neighborhood = session?.lastNeighborhood || null;
  }

  // Still no neighborhood — ask the user
  if (!neighborhood && route.intent === 'events') {
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'events');
    return;
  }

  // Helper: capture compose trace data and finalize
  async function composeAndSend(composeEvents, hood, filters, intentLabel) {
    trace.events.sent_to_claude = composeEvents.length;
    trace.events.sent_ids = composeEvents.map(e => e.id);

    const composeStart = Date.now();
    const result = await composeResponse(message, composeEvents, hood, filters);
    trace.composition.latency_ms = Date.now() - composeStart;
    trace.composition.raw_response = result._raw || null;
    trace.composition.picks = result.picks || [];
    trace.composition.not_picked_reason = result.not_picked_reason || null;
    trace.composition.neighborhood_used = result.neighborhood_used || hood;

    return result;
  }

  // --- More ---
  if (route.intent === 'more') {
    const allShownIds = new Set((session?.allPicks || session?.lastPicks || []).map(p => p.event_id));

    if (session && session.lastEvents) {
      const remaining = Object.values(session.lastEvents).filter(e => !allShownIds.has(e.id));
      if (remaining.length > 0) {
        const hood = neighborhood || session.lastNeighborhood;
        const composeRemaining = remaining.slice(0, 8);
        trace.events.cache_size = Object.keys(session.lastEvents).length;
        trace.events.candidates_count = remaining.length;
        trace.events.candidate_ids = remaining.map(e => e.id);
        const result = await composeAndSend(composeRemaining, hood, route.filters, 'more');
        const newAllPicks = [...(session.allPicks || session.lastPicks || []), ...(result.picks || [])];
        setSession(phone, { lastPicks: result.picks || [], allPicks: newAllPicks, lastEvents: session.lastEvents, lastNeighborhood: hood });
        await sendSMS(phone, result.sms_text);
        console.log(`More sent to ${masked}`);
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

    const hood = neighborhood || session.lastNeighborhood;

    // Check if we have unused Tavily events from a previous search
    const tavilyRemaining = (session.tavilyEvents || [])
      .filter(e => !allShownIds.has(e.id));

    if (tavilyRemaining.length > 0) {
      const composeEvents = tavilyRemaining.slice(0, 8);
      trace.events.candidates_count = tavilyRemaining.length;
      trace.events.candidate_ids = tavilyRemaining.map(e => e.id);
      const result = await composeAndSend(composeEvents, hood, route.filters, 'more');
      const newAllPicks = [...(session.allPicks || session.lastPicks || []), ...(result.picks || [])];
      setSession(phone, {
        ...session,
        lastPicks: result.picks || [],
        allPicks: newAllPicks,
        lastNeighborhood: hood,
      });
      await sendSMS(phone, result.sms_text);
      console.log(`More (tavily cache) sent to ${masked}`);
      finalizeTrace(result.sms_text, 'more');
      return;
    }

    if (!session.tavilySearched) {
      // First time exhausting cache — try Tavily
      await sendSMS(phone, `Digging deeper for ${hood} events, one sec...`);

      try {
        const tavilyEvents = await searchTavilyEvents(hood);

        // Filter out any events we've already shown
        const fresh = tavilyEvents.filter(e => !allShownIds.has(e.id));

        if (fresh.length > 0) {
          const composeEvents = fresh.slice(0, 8);
          trace.events.candidates_count = fresh.length;
          trace.events.candidate_ids = fresh.map(e => e.id);
          const result = await composeAndSend(composeEvents, hood, route.filters, 'more');
          const tavilyEventMap = {};
          for (const e of tavilyEvents) tavilyEventMap[e.id] = e;
          const newAllPicks = [...(session.allPicks || session.lastPicks || []), ...(result.picks || [])];
          setSession(phone, {
            ...session,
            lastPicks: result.picks || [],
            allPicks: newAllPicks,
            lastEvents: { ...session.lastEvents, ...tavilyEventMap },
            tavilyEvents: tavilyEvents,
            tavilySearched: true,
            lastNeighborhood: hood,
          });
          await sendSMS(phone, result.sms_text);
          console.log(`Tavily results sent to ${masked}`);
          finalizeTrace(result.sms_text, 'more');
          return;
        }
      } catch (err) {
        console.error('Tavily fallback error:', err.message);
      }

      // Tavily failed or found nothing
      session.tavilySearched = true;
      setSession(phone, { ...session, tavilySearched: true });
    }

    // Truly exhausted — all sources + Tavily done
    const nearby = getAdjacentNeighborhoods(hood, 2);
    const suggestion = nearby.length > 0 ? ` Try ${nearby.join(' or ')} — they're close by.` : ' Try a different neighborhood or check back later!';
    const sms = `That's all I could find near ${hood}.${suggestion}`;
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
    let freeEvents = events.filter(e => e.is_free);

    // If cached free events can't fill at least 2 picks, supplement with Tavily
    if (freeEvents.length < 2) {
      await sendSMS(phone, freeEvents.length > 0
        ? `Let me see what else is free near ${hood}...`
        : `Checking what's free near ${hood}...`);

      try {
        const tavilyResults = await searchTavilyEvents(hood, {
          query: `best free things to do near ${hood} NYC tonight bars with games pool shuffleboard arcade cheap hangouts`,
        });

        if (tavilyResults.length > 0) {
          // Merge Tavily results with cached free events, deduped
          const seen = new Set(freeEvents.map(e => e.id));
          for (const e of tavilyResults) {
            if (!seen.has(e.id)) {
              seen.add(e.id);
              freeEvents.push(e);
            }
          }

          // Cache Tavily results in session for "more" follow-ups
          session = session || {};
          session.tavilyEvents = tavilyResults;
          session.tavilySearched = true;
        }
      } catch (err) {
        console.error('Tavily free search error:', err.message);
      }
    }

    if (freeEvents.length === 0) {
      const sms = `Not finding free stuff near ${hood} tonight — text "${hood}" for everything or try a different neighborhood.`;
      await sendSMS(phone, sms);
      finalizeTrace(sms, 'free');
      return;
    }

    trace.events.cache_size = events.length;
    trace.events.candidates_count = freeEvents.length;
    trace.events.candidate_ids = freeEvents.map(e => e.id);
    const result = await composeAndSend(freeEvents.slice(0, 8), hood, route.filters, 'free');
    const eventMap = {};
    for (const e of freeEvents) eventMap[e.id] = e;
    setSession(phone, {
      lastPicks: result.picks || [],
      lastEvents: eventMap,
      lastNeighborhood: hood,
      tavilyEvents: session?.tavilyEvents || [],
      tavilySearched: session?.tavilySearched || false,
    });
    await sendSMS(phone, result.sms_text);
    console.log(`Free events sent to ${masked}`);
    finalizeTrace(result.sms_text, 'free');
    return;
  }

  // --- Unknown intent guard ---
  if (!['events', 'free', 'more', 'details', 'help', 'conversational'].includes(route.intent)) {
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
  const hood = neighborhood;
  let events = await getEvents(hood);
  console.log(`Found ${events.length} events near ${hood}`);

  // Apply free_only filter when routed as events but user asked for free
  if (route.filters?.free_only) {
    events = events.filter(e => e.is_free);
  }

  if (events.length === 0) {
    const nearby = getAdjacentNeighborhoods(hood, 2);
    const suggestion = nearby.length > 0 ? ` Try ${nearby.join(' or ')}?` : ' Check back later!';
    const sms = `Quiet night in ${hood} — not seeing much right now.${suggestion}`;
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'events');
    return;
  }

  // Pre-filter to top 8 by proximity to reduce token cost
  const composeEvents = events.slice(0, 8);

  // Capture event funnel data
  trace.events.cache_size = events.length;
  trace.events.candidates_count = events.length;
  trace.events.candidate_ids = events.map(e => e.id);

  // CALL 2: Compose response
  const result = await composeAndSend(composeEvents, hood, route.filters, 'events');

  // Keep full event map in session so MORE can access remaining events
  const eventMap = {};
  for (const e of events) eventMap[e.id] = e;

  setSession(phone, { lastPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: result.neighborhood_used || hood });

  await sendSMS(phone, result.sms_text);
  console.log(`AI response sent to ${masked}`);
  finalizeTrace(result.sms_text, 'events');
}

// Cleanup intervals (for graceful shutdown)
function clearSmsIntervals() {
  clearInterval(dedupInterval);
  clearInterval(rateLimitInterval);
  clearInterval(sessionInterval);
}

module.exports = router;
module.exports.clearSmsIntervals = clearSmsIntervals;
module.exports.setSession = setSession;
