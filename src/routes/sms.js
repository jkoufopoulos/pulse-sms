const express = require('express');
const twilio = require('twilio');
const { extractNeighborhood, NEIGHBORHOODS } = require('../utils/neighborhoods');
const { getEvents } = require('../services/events');
const { pickEvents, interpretMessage, routeMessage, composeResponse } = require('../services/ai');
const { renderSMS } = require('../services/sms-render');
const { sendSMS, maskPhone } = require('../services/sms');

const USE_AI_ROUTING = process.env.PULSE_AI_ROUTING !== 'false'; // default: true
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

// --- Event detail formatting ---
function formatEventDetails(event) {
  let detail = `${event.name}`;
  if (event.venue_name && event.venue_name !== 'TBA') detail += ` at ${event.venue_name}`;
  if (event.start_time_local) detail += `\n${event.start_time_local}`;
  if (event.end_time_local) detail += ` – ${event.end_time_local}`;
  if (event.is_free) detail += `\nFree!`;
  else if (event.price_display) detail += `\n${event.price_display}`;
  if (event.venue_address) detail += `\n${event.venue_address}`;
  if (event.ticket_url) detail += `\nTickets: ${event.ticket_url}`;
  if (event.map_hint) detail += `\nNear: ${event.map_hint}`;
  return detail.slice(0, 480);
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
    const captured = [];
    // Temporarily replace sendSMS to capture output
    const smsService = require('../services/sms');
    const originalSend = smsService.sendSMS;
    smsService.sendSMS = async (to, body) => {
      captured.push({ to, body, timestamp: new Date().toISOString() });
      console.log(`[TEST] Would send to ${to}: ${body.slice(0, 80)}...`);
      return { sid: 'TEST_' + Date.now() };
    };
    try {
      await handleMessage(testPhone, message.trim());
      res.json({ ok: true, messages: captured });
    } catch (err) {
      res.status(500).json({ error: err.message, messages: captured });
    } finally {
      smsService.sendSMS = originalSend;
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
// Async message handler — dispatcher routes to AI or legacy
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

  if (USE_AI_ROUTING) {
    try {
      await handleMessageAI(phone, message);
    } catch (err) {
      // Don't fall back to legacy if Twilio is the problem — it'll just fail again
      if (err.message?.includes('sendSMS timed out') || err.code === 20003 || err.status >= 500) {
        console.error('Twilio/send failure, not retrying via legacy:', err.message);
        return;
      }
      console.error('AI flow error, falling back to legacy:', err.message);
      try {
        await handleMessageLegacy(phone, message);
      } catch (legacyErr) {
        console.error('Legacy flow also failed:', legacyErr.message);
      }
    }
  } else {
    await handleMessageLegacy(phone, message);
  }
}

// =======================================================
// AI flow — Claude-first routing + composition
// =======================================================

async function handleMessageAI(phone, message) {
  const masked = maskPhone(phone);
  const session = getSession(phone);

  // CALL 1: Route the message
  const route = await routeMessage(message, session, NEIGHBORHOOD_NAMES);
  console.log(`AI route: intent=${route.intent}, neighborhood=${route.neighborhood}, confidence=${route.confidence}`);

  // --- Help ---
  if (route.intent === 'help') {
    const reply = route.reply || "Pulse — text a neighborhood, landmark, or subway stop to get tonight's picks.\n\nExamples: East Village, Williamsburg, near Prospect Park, Bedford Ave\n\nDETAILS — more info (DETAILS 2 for pick #2)\nMORE — next batch\nFREE — free events only";
    await sendSMS(phone, reply.slice(0, 480));
    console.log(`Help sent to ${masked}`);
    return;
  }

  // --- Conversational ---
  if (route.intent === 'conversational') {
    const reply = route.reply || "Hey! Text a neighborhood whenever you're ready to go out.";
    await sendSMS(phone, reply.slice(0, 480));
    console.log(`Conversational reply sent to ${masked}`);
    return;
  }

  // --- Details ---
  if (route.intent === 'details') {
    const picks = session?.lastPicks;
    if (session && picks?.length > 0) {
      const pickIndex = Math.min((parseInt(route.event_reference, 10) || 1) - 1, picks.length - 1);
      const pick = picks[Math.max(0, pickIndex)];
      const event = session.lastEvents[pick.event_id];
      if (event) {
        await sendSMS(phone, formatEventDetails(event));
        console.log(`Details sent to ${masked}`);
        return;
      }
    }
    await sendSMS(phone, "No recent picks to show details for. Text a neighborhood to get started!");
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
    await sendSMS(phone, "Hey! What neighborhood are you near? (e.g. 'East Village', 'Williamsburg', 'LES')");
    return;
  }

  // --- More ---
  if (route.intent === 'more') {
    if (session && session.lastEvents) {
      const allShownIds = new Set((session.allPicks || session.lastPicks || []).map(p => p.event_id));
      const remaining = Object.values(session.lastEvents).filter(e => !allShownIds.has(e.id));
      if (remaining.length > 0) {
        const hood = neighborhood || session.lastNeighborhood;
        const composeRemaining = remaining.slice(0, 8);
        const result = await composeResponse(message, composeRemaining, hood, route.filters);
        const newAllPicks = [...(session.allPicks || session.lastPicks || []), ...(result.picks || [])];
        setSession(phone, { lastPicks: result.picks || [], allPicks: newAllPicks, lastEvents: session.lastEvents, lastNeighborhood: hood });
        await sendSMS(phone, result.sms_text);
        console.log(`More sent to ${masked}`);
        return;
      }
    }
    await sendSMS(phone, session ? "That's all I've got for now. Try a different neighborhood or check back later!" : "Text a neighborhood to get started! (e.g. 'East Village', 'Williamsburg')");
    return;
  }

  // --- Free ---
  if (route.intent === 'free') {
    if (!neighborhood && !session?.lastNeighborhood) {
      await sendSMS(phone, "Hey! What neighborhood are you near? (e.g. 'East Village', 'Williamsburg', 'LES')");
      return;
    }
    const hood = neighborhood || session.lastNeighborhood;
    const events = await getEvents(hood);
    const freeEvents = events.filter(e => e.is_free);
    if (freeEvents.length === 0) {
      await sendSMS(phone, `No free events found near ${hood} tonight. Text "${hood}" to see all events instead.`);
      return;
    }
    const result = await composeResponse(message, freeEvents, hood, route.filters);
    const eventMap = {};
    for (const e of freeEvents) eventMap[e.id] = e;
    setSession(phone, { lastPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: hood });
    await sendSMS(phone, result.sms_text);
    console.log(`Free events sent to ${masked}`);
    return;
  }

  // --- Unknown intent guard ---
  if (!['events', 'free', 'more', 'details', 'help', 'conversational'].includes(route.intent)) {
    console.warn(`Unknown intent "${route.intent}", treating as events`);
  }

  // Ask for neighborhood if we still don't have one
  if (!neighborhood) {
    await sendSMS(phone, "Hey! What neighborhood are you near? (e.g. 'East Village', 'Williamsburg', 'LES')");
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
    await sendSMS(phone, `Quiet night in ${hood} — not seeing much right now. Try a nearby neighborhood or check back later!`);
    return;
  }

  // Pre-filter to top 8 by proximity to reduce token cost
  const composeEvents = events.slice(0, 8);

  // CALL 2: Compose response
  const result = await composeResponse(message, composeEvents, hood, route.filters);

  // Keep full event map in session so MORE can access remaining events
  const eventMap = {};
  for (const e of events) eventMap[e.id] = e;

  setSession(phone, { lastPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: result.neighborhood_used || hood });

  await sendSMS(phone, result.sms_text);
  console.log(`AI response sent to ${masked}`);
}

// =======================================================
// Legacy flow — regex-first routing (original handleMessage)
// =======================================================

async function handleMessageLegacy(phone, message) {
  const masked = maskPhone(phone);

  try {
    const upper = message.trim().toUpperCase();

    // --- Handle HELP ---
    if (upper === 'HELP' || upper === 'HELP?' || upper === '?') {
      await sendSMS(phone, "Pulse — text a neighborhood, landmark, or subway stop to get tonight's picks.\n\nExamples: East Village, Williamsburg, near Prospect Park, Bedford Ave\n\nDETAILS — more info (DETAILS 2 for pick #2)\nMORE — next batch\nFREE — free events only");
      return;
    }

    // --- Follow-up intent detection (natural language → route) ---
    // Only triggers if user has an active session
    {
      const session = getSession(phone);
      if (session && session.lastPicks?.length > 0) {
        const lower = message.trim().toLowerCase();
        if (/\b(when|what time|how late|starts at)\b/.test(lower)) {
          // Route to DETAILS
          const lead = session.lastPicks[0];
          const event = session.lastEvents[lead.event_id];
          if (event) {
            await sendSMS(phone, formatEventDetails(event));
            console.log(`Follow-up DETAILS sent to ${masked}`);
            return;
          }
        }
        if (/\b(where|address|location|directions|how do i get)\b/.test(lower)) {
          const lead = session.lastPicks[0];
          const event = session.lastEvents[lead.event_id];
          if (event) {
            await sendSMS(phone, formatEventDetails(event));
            console.log(`Follow-up DETAILS sent to ${masked}`);
            return;
          }
        }
        if (/\b(tell me more|sounds good|interested|that one|i'm down|let's go)\b/.test(lower)) {
          const lead = session.lastPicks[0];
          const event = session.lastEvents[lead.event_id];
          if (event) {
            await sendSMS(phone, formatEventDetails(event));
            console.log(`Follow-up DETAILS sent to ${masked}`);
            return;
          }
        }
        if (/\b(free stuff|anything free|no cover)\b/.test(lower)) {
          // Route to FREE — checked before price/cover to avoid "no cover" → DETAILS
          const neighborhood = session.lastNeighborhood;
          const events = await getEvents(neighborhood);
          const freeEvents = events.filter(e => e.is_free);
          if (freeEvents.length === 0) {
            await sendSMS(phone, `No free events found near ${neighborhood} tonight. Text "${neighborhood}" to see all events instead.`);
            return;
          }
          const eventMap = {};
          for (const e of freeEvents) eventMap[e.id] = e;
          const picksResult = await pickEvents('show me free events only', freeEvents, neighborhood);
          const response = renderSMS(picksResult, eventMap);
          setSession(phone, { lastPicks: picksResult.picks || [], lastEvents: eventMap, lastNeighborhood: neighborhood });
          await sendSMS(phone, response);
          console.log(`Follow-up FREE sent to ${masked}`);
          return;
        }
        if (/\b(how much|cost|price|tickets|cover)\b/.test(lower)) {
          const lead = session.lastPicks[0];
          const event = session.lastEvents[lead.event_id];
          if (event) {
            await sendSMS(phone, formatEventDetails(event));
            console.log(`Follow-up DETAILS sent to ${masked}`);
            return;
          }
        }
        if (/\b(what else|anything else|other options|next|show me more)\b/.test(lower)) {
          // Route to MORE
          const shownIds = new Set(session.lastPicks.map(p => p.event_id));
          const remaining = Object.values(session.lastEvents).filter(e => !shownIds.has(e.id));
          if (remaining.length > 0) {
            const eventMap = {};
            for (const e of remaining) eventMap[e.id] = e;
            const picksResult = await pickEvents('show me more options', remaining, session.lastNeighborhood);
            const response = renderSMS(picksResult, eventMap);
            setSession(phone, { lastPicks: picksResult.picks || [], lastEvents: eventMap, lastNeighborhood: session.lastNeighborhood });
            await sendSMS(phone, response);
            console.log(`Follow-up MORE sent to ${masked}`);
            return;
          }
          await sendSMS(phone, "That's all I've got for now. Try a different neighborhood or check back later!");
          return;
        }
      }
    }

    // --- Handle DETAILS/MORE/FREE commands ---
    // Flexible matching: "DETAILS", "DETAILS 2", "details please" all work
    if (upper === 'DETAILS' || upper.startsWith('DETAILS ')) {
      const session = getSession(phone);
      if (session && session.lastPicks?.length > 0) {
        const pickNum = parseInt(upper.replace('DETAILS', '').trim(), 10) || 1;
        const pickIndex = Math.min(Math.max(0, pickNum - 1), session.lastPicks.length - 1);
        const pick = session.lastPicks[pickIndex];
        const event = session.lastEvents[pick.event_id];
        if (event) {
          await sendSMS(phone, formatEventDetails(event));
          console.log(`DETAILS ${pickNum} sent to ${masked}`);
          return;
        }
      }
      await sendSMS(phone, "No recent picks to show details for. Text a neighborhood to get started!");
      return;
    }

    if (upper === 'MORE' || upper.startsWith('MORE ')) {
      const session = getSession(phone);
      if (session && session.lastEvents) {
        const allShownIds = new Set((session.allPicks || session.lastPicks || []).map(p => p.event_id));
        const remaining = Object.values(session.lastEvents).filter(e => !allShownIds.has(e.id));
        if (remaining.length > 0) {
          const eventMap = {};
          for (const e of remaining) eventMap[e.id] = e;
          const picksResult = await pickEvents('show me more options', remaining, session.lastNeighborhood);
          const response = renderSMS(picksResult, eventMap);
          const newAllPicks = [...(session.allPicks || session.lastPicks || []), ...(picksResult.picks || [])];
          setSession(phone, { lastPicks: picksResult.picks || [], allPicks: newAllPicks, lastEvents: session.lastEvents, lastNeighborhood: session.lastNeighborhood });
          await sendSMS(phone, response);
          console.log(`MORE sent to ${masked}`);
          return;
        }
      }
      await sendSMS(phone, session ? "That's all I've got for now. Try a different neighborhood or check back later!" : "Text a neighborhood to get started! (e.g. 'East Village', 'Williamsburg')");
      return;
    }

    if (upper === 'FREE' || upper.startsWith('FREE ')) {
      const session = getSession(phone);
      const neighborhood = session?.lastNeighborhood || extractNeighborhood(message);
      if (!neighborhood) {
        await sendSMS(phone, "Hey! What neighborhood are you near? (e.g. 'East Village', 'Williamsburg', 'LES')");
        return;
      }
      const events = await getEvents(neighborhood);
      const freeEvents = events.filter(e => e.is_free);
      if (freeEvents.length === 0) {
        await sendSMS(phone, `No free events found near ${neighborhood} tonight. Text "${neighborhood}" to see all events instead.`);
        return;
      }
      const eventMap = {};
      for (const e of freeEvents) eventMap[e.id] = e;
      const picksResult = await pickEvents('show me free events only', freeEvents, neighborhood);
      const response = renderSMS(picksResult, eventMap);
      setSession(phone, { lastPicks: picksResult.picks || [], lastEvents: eventMap, lastNeighborhood: neighborhood });
      await sendSMS(phone, response);
      console.log(`FREE sent to ${masked}`);
      return;
    }

    // --- Normal flow ---

    // 1. Extract neighborhood from message, fall back to session
    let neighborhood = extractNeighborhood(message);

    if (!neighborhood) {
      const session = getSession(phone);
      if (session?.lastNeighborhood) {
        neighborhood = session.lastNeighborhood;
        console.log(`No neighborhood in message, using session: ${neighborhood}`);
      } else {
        // Claude fallback — interpret unrecognized message
        try {
          console.log(`No neighborhood found, trying Claude interpretation`);
          const interpretation = await interpretMessage(message);

          if (interpretation.neighborhood) {
            // Validate through extractNeighborhood
            const validated = extractNeighborhood(interpretation.neighborhood);
            if (validated) {
              neighborhood = validated;
              console.log(`Claude interpreted neighborhood: ${neighborhood}`);
            }
          }

          if (!neighborhood) {
            if (interpretation.reply) {
              await sendSMS(phone, interpretation.reply.slice(0, 480));
              console.log(`Claude reply sent to ${masked}`);
              return;
            }
            await sendSMS(phone, "Hey! What neighborhood are you near? (e.g. 'East Village', 'Williamsburg', 'LES')");
            return;
          }
        } catch (err) {
          console.error('interpretMessage error:', err.message);
          await sendSMS(phone, "Hey! What neighborhood are you near? (e.g. 'East Village', 'Williamsburg', 'LES')");
          return;
        }
      }
    }

    // 2. Get events (cache + Tavily fallback)
    const events = await getEvents(neighborhood);

    console.log(`Found ${events.length} events near ${neighborhood}`);

    // 3. Build event map for rendering
    const eventMap = {};
    for (const e of events) {
      eventMap[e.id] = e;
    }

    // 4. Call pickEvents → get JSON picks
    const picksResult = await pickEvents(message, events, neighborhood);

    console.log(`Picks: ${picksResult.picks?.length || 0}, clarification: ${picksResult.need_clarification}`);

    // 5. Render SMS from picks
    const response = renderSMS(picksResult, eventMap);

    // 6. Save session for DETAILS/MORE/FREE follow-ups
    setSession(phone, { lastPicks: picksResult.picks || [], lastEvents: eventMap, lastNeighborhood: neighborhood });

    // 7. Send via Twilio
    await sendSMS(phone, response);

    console.log(`Response sent to ${masked}`);
  } catch (err) {
    console.error('Error handling SMS:', err.message);

    try {
      await sendSMS(phone, "Pulse hit a snag — try again in a sec!");
    } catch (smsErr) {
      console.error(`Failed to send error SMS to ${maskPhone(phone)}:`, smsErr.message);
    }
  }
}

// Cleanup intervals (for graceful shutdown)
function clearSmsIntervals() {
  clearInterval(dedupInterval);
  clearInterval(rateLimitInterval);
  clearInterval(sessionInterval);
}

module.exports = router;
module.exports.clearSmsIntervals = clearSmsIntervals;
