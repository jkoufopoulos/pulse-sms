const express = require('express');
const twilio = require('twilio');
const { extractNeighborhood } = require('../utils/neighborhoods');
const { getEvents } = require('../services/events');
const { pickEvents } = require('../services/ai');
const { renderSMS } = require('../services/sms-render');
const { sendSMS } = require('../services/sms');

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
  const cutoff = Date.now() - DEDUP_TTL;
  for (const [sid, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(sid);
  }
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
  const now = Date.now();
  for (const [phone, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(phone);
  }
}, 10 * 60 * 1000);

// --- PII masking ---
function maskPhone(phone) {
  if (!phone || phone.length < 4) return '****';
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}

// --- Session store for DETAILS/MORE/FREE ---
// Maps phone → { lastPicks, lastEvents, lastNeighborhood, timestamp }
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

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
  const cutoff = Date.now() - SESSION_TTL;
  for (const [phone, data] of sessions) {
    if (data.timestamp < cutoff) sessions.delete(phone);
  }
}, 10 * 60 * 1000);

// =======================================================
// Webhook endpoint — responds immediately, processes async
// =======================================================

router.post('/incoming', (req, res) => {
  const { Body: message, From: phone, MessageSid: messageSid } = req.body;

  if (!message || !phone) {
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
// Async message handler — all the heavy lifting happens here
// =======================================================

async function handleMessage(phone, message) {
  const masked = maskPhone(phone);
  console.log(`SMS from ${masked}: ${message.slice(0, 80)}`);

  // Rate limiting
  if (isRateLimited(phone)) {
    console.warn(`Rate limited: ${masked}`);
    return;
  }

  try {
    const upper = message.trim().toUpperCase();

    // --- Handle HELP ---
    if (upper === 'HELP' || upper === 'HELP?' || upper === '?') {
      await sendSMS(phone, "NightOwl — text a neighborhood (e.g. 'East Village', 'Williamsburg', 'LES') to get tonight's picks.\n\nCommands:\nDETAILS — more info on top pick\nMORE — next batch of events\nFREE — free events only");
      return;
    }

    // --- Handle DETAILS/MORE/FREE commands ---
    // Flexible matching: "DETAILS", "DETAILS 2", "details please" all work
    if (upper === 'DETAILS' || upper.startsWith('DETAILS ')) {
      const session = getSession(phone);
      if (session && session.lastPicks?.length > 0) {
        const lead = session.lastPicks[0];
        const event = session.lastEvents[lead.event_id];
        if (event) {
          let detail = `${event.name}`;
          if (event.venue_name && event.venue_name !== 'TBA') detail += ` at ${event.venue_name}`;
          if (event.venue_address) detail += `\n${event.venue_address}`;
          if (event.ticket_url) detail += `\nTickets: ${event.ticket_url}`;
          if (event.map_hint) detail += `\nNear: ${event.map_hint}`;
          await sendSMS(phone, detail.slice(0, 480));
          console.log(`DETAILS sent to ${masked}`);
          return;
        }
      }
      await sendSMS(phone, "No recent picks to show details for. Text a neighborhood to get started!");
      return;
    }

    if (upper === 'MORE' || upper.startsWith('MORE ')) {
      const session = getSession(phone);
      if (session && session.lastEvents) {
        const shownIds = new Set((session.lastPicks || []).map(p => p.event_id));
        const remaining = Object.values(session.lastEvents).filter(e => !shownIds.has(e.id));
        if (remaining.length > 0) {
          const eventMap = {};
          for (const e of remaining) eventMap[e.id] = e;
          const picksResult = await pickEvents('show me more options', remaining, session.lastNeighborhood);
          const response = renderSMS(picksResult, eventMap);
          setSession(phone, { lastPicks: picksResult.picks || [], lastEvents: eventMap, lastNeighborhood: session.lastNeighborhood });
          await sendSMS(phone, response);
          console.log(`MORE sent to ${masked}`);
          return;
        }
      }
      await sendSMS(phone, "That's all I've got for now. Try a different neighborhood or check back later!");
      return;
    }

    if (upper === 'FREE' || upper.startsWith('FREE ')) {
      const session = getSession(phone);
      const neighborhood = session?.lastNeighborhood || extractNeighborhood(message) || 'Midtown';
      const events = await getEvents(neighborhood);
      const freeEvents = events.filter(e => e.is_free);
      if (freeEvents.length === 0) {
        await sendSMS(phone, `No free events found near ${neighborhood} tonight. Try "MORE" for other options.`);
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
        await sendSMS(phone, "Hey! What neighborhood are you near? (e.g. 'East Village', 'Williamsburg', 'LES')");
        return;
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
      await sendSMS(phone, "NightOwl hit a snag — try again in a sec!");
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
