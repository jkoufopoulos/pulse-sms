'use strict';

/**
 * Proactive outreach — sends personalized event recommendations to opted-in users.
 * Post-scrape hook: scan opted-in users, score events, compose LLM message, send SMS.
 */

const PROACTIVE_THRESHOLD = 5;

// ---- Opt-in prompt logic ----

/**
 * Check whether the agent should append the opt-in CTA to its response.
 * Prompt on session 1 and session 3, max 2 prompts total.
 */
function shouldPromptOptIn(profile) {
  if (!profile) return false;
  if (profile.proactiveOptIn) return false;
  const count = profile.proactivePromptCount || 0;
  if (count >= 2) return false;
  const session = profile.sessionCount || 0;
  return session === 1 || session === 3;
}

// ---- Event matching ----

/**
 * Score an event against a user profile for proactive recommendation.
 * Returns a numeric score. Threshold for sending: 5.
 */
function scoreMatch(event, profile) {
  let score = 0;

  // Neighborhood: +3 if in user's top 2
  const topHoods = Object.entries(profile.neighborhoods || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([hood]) => hood);
  if (topHoods.includes(event.neighborhood)) score += 3;

  // Category: +2 if matches user's top categories
  const topCats = Object.entries(profile.categories || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat]) => cat);
  if (topCats.includes(event.category)) score += 2;

  // Interestingness: normalize from range -3..6 to 1..3
  const raw = event.interestingness ?? 0;
  const normalized = Math.max(1, Math.min(3, Math.round((raw + 3) / 3)));
  score += normalized;

  // Scarcity: +1 for one-night-only
  if (event.scarcity) score += 1;

  // Editorial: +1 for editorially picked events
  if (event.editorial_signal) score += 1;

  return score;
}

/**
 * Find the single best event match for a user, excluding already-recommended events.
 * Returns the event object or null if nothing clears the threshold.
 */
function findBestMatch(events, profile, excludeEventIds) {
  if (!events?.length) return null;

  const excluded = new Set(excludeEventIds || []);
  let bestEvent = null;
  let bestScore = -1;

  for (const event of events) {
    if (excluded.has(event.id)) continue;
    const score = scoreMatch(event, profile);
    if (score >= PROACTIVE_THRESHOLD && score > bestScore) {
      bestScore = score;
      bestEvent = event;
    }
  }

  return bestEvent;
}

// ---- Message composition ----

const PROACTIVE_FOOTER = '\nReply STOP NOTIFY to turn off';

/**
 * Compose a proactive SMS using the LLM.
 * Returns the full message string (content + footer), capped at 480 chars.
 */
async function composeProactiveMessage(event, profile) {
  const { lookupVenueProfile } = require('./venues');
  const { generate } = require('./llm');
  const { MODEL_ROLES } = require('./model-config');

  const venueVibe = lookupVenueProfile(event.venue_name)?.vibe || '';
  const topHood = Object.entries(profile.neighborhoods || {})
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'your area';
  const topCats = Object.keys(profile.categories || {}).slice(0, 2).join(' and ') || 'all kinds of';

  const prompt = `You're Pulse, texting a user proactively about an event you think they'd love. They're into ${topHood} and tend to go to ${topCats} events.

Event: ${event.name}
Venue: ${event.venue_name || 'TBA'}${venueVibe ? ` — ${venueVibe}` : ''}
When: ${event.date_local} ${event.start_time_local || ''}
Neighborhood: ${event.neighborhood || 'NYC'}
${event.is_free ? 'Free' : event.price_display ? `Price: ${event.price_display}` : ''}

Write a single SMS under 320 characters that sounds like a friend giving a tip. Lead with why this is worth their night. End with "Reply for details."`;

  const result = await generate(prompt, {
    system: 'You write brief, enthusiastic SMS messages about NYC events. No emoji. No hashtags. Sound like a plugged-in local friend, not a marketing bot.',
    model: MODEL_ROLES.brain,
    max_tokens: 150,
  });

  const content = (result.text || '').trim().slice(0, 320);
  return content + PROACTIVE_FOOTER;
}

// ---- Post-scrape hook ----

let proactivePaused = false;

function pauseProactive() { proactivePaused = true; }
function resumeProactive() { proactivePaused = false; }
function isProactivePaused() { return proactivePaused; }

const COOLDOWN_DAYS = 7;
const CHURN_DAYS = 30;

/**
 * Post-scrape hook: scan opted-in users, find best matches, compose and send.
 */
async function processProactiveMessages(eventCache) {
  if (process.env.PULSE_PROACTIVE_ENABLED !== 'true') {
    console.log('[PROACTIVE] Disabled (set PULSE_PROACTIVE_ENABLED=true to enable)');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  if (proactivePaused) {
    console.log('[PROACTIVE] Paused — skipping');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  const { getOptInEligibleUsers, getProfile } = require('./preference-profile');
  const { sendSMS } = require('./twilio');
  const { insertRecommendations } = require('./db');
  const { saveResponseFrame } = require('./pipeline');
  const { hashPhone } = require('./preference-profile');

  const eligiblePhones = getOptInEligibleUsers();
  console.log(`[PROACTIVE] ${eligiblePhones.length} opted-in users`);

  let sent = 0, skipped = 0, errors = 0;
  const now = Date.now();

  for (const phone of eligiblePhones) {
    try {
      const profile = getProfile(phone);

      // Skip churned users (no session in 30 days)
      if (profile.lastActiveDate) {
        const daysSinceActive = (now - new Date(profile.lastActiveDate).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceActive > CHURN_DAYS) { skipped++; continue; }
      }

      // Check 7-day cooldown via event_recommendations table
      const db = require('./db');
      const phoneHash = hashPhone(phone);
      const lastSend = db.getDb().prepare(
        'SELECT MAX(recommended_at) as last FROM event_recommendations WHERE phone_hash = ?'
      ).get(phoneHash);

      if (lastSend?.last) {
        const daysSinceLast = (now - new Date(lastSend.last).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLast < COOLDOWN_DAYS) { skipped++; continue; }
      }

      // Get already-recommended event IDs
      const pastRecs = db.getDb().prepare(
        'SELECT event_id FROM event_recommendations WHERE phone_hash = ?'
      ).all(phoneHash).map(r => r.event_id);

      // Find best match
      const bestEvent = findBestMatch(eventCache, profile, pastRecs);
      if (!bestEvent) { skipped++; continue; }

      // Compose and send
      const message = await composeProactiveMessage(bestEvent, profile);
      await sendSMS(phone, message);

      // Record recommendation
      insertRecommendations(phoneHash, [bestEvent.id]);

      // Seed session for reply handling (P4: via saveResponseFrame)
      saveResponseFrame(phone, {
        mode: 'fresh',
        picks: [{ event_id: bestEvent.id, pick_number: 1 }],
        neighborhood: bestEvent.neighborhood,
        eventMap: { [bestEvent.id]: bestEvent },
        lastResponseHadPicks: true,
      });

      sent++;
      console.log(`[PROACTIVE] Sent to ****${phone.slice(-4)}: ${bestEvent.name}`);

    } catch (err) {
      errors++;
      console.error(`[PROACTIVE] Error for user: ${err.message}`);
    }
  }

  console.log(`[PROACTIVE] Done: ${sent} sent, ${skipped} skipped, ${errors} errors`);
  return { sent, skipped, errors };
}

module.exports = {
  shouldPromptOptIn,
  scoreMatch,
  findBestMatch,
  composeProactiveMessage,
  processProactiveMessages,
  pauseProactive,
  resumeProactive,
  isProactivePaused,
  PROACTIVE_THRESHOLD,
};
