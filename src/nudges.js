/**
 * nudges.js — Recurrence nudge system.
 * Tracks recurring event interest, manages consent (REMIND ME / NUDGE OFF),
 * and sends deterministic nudge messages on a schedule.
 */

const { getDb } = require('./db');
const { hashPhone } = require('./session');

// --- DB queries ---

function upsertNudgeSub(phoneHash, phone, patternKey) {
  const d = getDb();
  const now = new Date().toISOString();
  const existing = d.prepare(
    'SELECT id, detail_count, consent_asked FROM nudge_subscriptions WHERE phone_hash = ? AND pattern_key = ?'
  ).get(phoneHash, patternKey);

  if (existing) {
    d.prepare(
      'UPDATE nudge_subscriptions SET detail_count = detail_count + 1, updated_at = ? WHERE id = ?'
    ).run(now, existing.id);
    return { id: existing.id, detail_count: existing.detail_count + 1, consent_asked: existing.consent_asked };
  }

  const result = d.prepare(
    'INSERT INTO nudge_subscriptions (phone_hash, phone, pattern_key, detail_count, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
  ).run(phoneHash, phone, patternKey, now, now);
  return { id: result.lastInsertRowid, detail_count: 1, consent_asked: 0 };
}

function getPendingConsent(phoneHash) {
  const d = getDb();
  return d.prepare(`
    SELECT ns.id, ns.pattern_key, rp.name, rp.venue_name
    FROM nudge_subscriptions ns
    JOIN recurring_patterns rp ON ns.pattern_key = rp.pattern_key
    WHERE ns.phone_hash = ? AND ns.consent_asked = 1 AND ns.opted_in = 0 AND ns.opted_out = 0
    LIMIT 1
  `).get(phoneHash);
}

function setOptedIn(subId) {
  const d = getDb();
  d.prepare('UPDATE nudge_subscriptions SET opted_in = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), subId);
}

function setOptedOut(phoneHash) {
  const d = getDb();
  d.prepare('UPDATE nudge_subscriptions SET opted_out = 1, updated_at = ? WHERE phone_hash = ?')
    .run(new Date().toISOString(), phoneHash);
}

function markConsentAsked(subId) {
  const d = getDb();
  d.prepare('UPDATE nudge_subscriptions SET consent_asked = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), subId);
}

function getDueNudges(nycDayOfWeek) {
  const d = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return d.prepare(`
    SELECT ns.id, ns.phone_hash, ns.phone, rp.name, rp.venue_name, rp.neighborhood, rp.time_local, rp.pattern_key
    FROM nudge_subscriptions ns
    JOIN recurring_patterns rp ON ns.pattern_key = rp.pattern_key
    WHERE ns.opted_in = 1
      AND ns.opted_out = 0
      AND rp.deactivated = 0
      AND rp.day_of_week = ?
      AND (ns.last_nudged IS NULL OR ns.last_nudged < ?)
  `).all(nycDayOfWeek, sevenDaysAgo);
}

function markNudgeSent(subId) {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare('UPDATE nudge_subscriptions SET last_nudged = ?, updated_at = ? WHERE id = ?')
    .run(now, now, subId);
}

// --- Consent flow ---

/**
 * Track a details request on a recurring event.
 * Returns a consent prompt string if threshold hit (detail_count reaches 2), or null.
 */
function trackRecurringDetail(phone, event) {
  if (!event?.is_recurring) return null;

  // Get pattern key from event or construct from name+venue+day
  let patternKey = event.recurrence_pattern_key;
  if (!patternKey) {
    if (!event.name || !event.venue_name || !event.date_local) return null;
    const dayIdx = new Date(event.date_local + 'T12:00:00').getDay();
    const { makePatternKey } = require('./db');
    patternKey = makePatternKey(event.name, event.venue_name, dayIdx);
  }

  const phoneHash = hashPhone(phone);
  const { id, detail_count, consent_asked } = upsertNudgeSub(phoneHash, phone, patternKey);

  if (detail_count === 2 && !consent_asked) {
    markConsentAsked(id);
    const name = event.name || 'that event';
    const venue = event.venue_name || 'there';
    return `Btw \u2014 want me to text you next time ${name} at ${venue} is on? Reply REMIND ME for reminders, or ignore this.`;
  }
  return null;
}

/**
 * Check if message is a nudge consent reply.
 * Returns { handled: true, intent, reply } or { handled: false }.
 */
function captureConsent(phone, message) {
  const lower = message.toLowerCase().trim();

  if (lower === 'nudge off') {
    setOptedOut(hashPhone(phone));
    return { handled: true, intent: 'nudge_optout', reply: "Done \u2014 no more reminders. You can still text me anytime for picks." };
  }

  if (lower === 'remind me') {
    const pending = getPendingConsent(hashPhone(phone));
    if (pending) {
      setOptedIn(pending.id);
      return { handled: true, intent: 'nudge_consent', reply: "You got it! I'll text you next time it's on. Reply NUDGE OFF anytime to stop." };
    }
    return { handled: false };
  }

  return { handled: false };
}

// --- Nudge message ---

/**
 * Build deterministic nudge SMS. No LLM call.
 */
function buildNudgeMessage(pattern) {
  const name = pattern.name || 'That event';
  const venue = pattern.venue_name || 'the usual spot';
  const hood = pattern.neighborhood || 'the neighborhood';

  let timeStr = 'tonight';
  if (pattern.time_local && /^\d{2}:\d{2}$/.test(pattern.time_local)) {
    const [h, m] = pattern.time_local.split(':').map(Number);
    const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
    const ampm = h >= 12 ? 'pm' : 'am';
    timeStr = m > 0 ? `${hour12}:${String(m).padStart(2, '0')}${ampm}` : `${hour12}${ampm}`;
  }

  return `${name} at ${venue} is back tonight at ${timeStr} \u2014 you know the vibe. Want me to look at what else is happening in ${hood}?`;
}

// --- Scheduler ---

let nudgeInterval = null;

async function checkAndSendNudges() {
  const nycNow = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', hour: 'numeric', hour12: false,
  });
  const parts = nycNow.split(', ');
  const dayName = parts[0];
  const hour = parseInt(parts[1]);

  const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const nycDay = dayMap[dayName];
  if (nycDay === undefined) {
    console.warn('nudge scheduler: could not determine NYC day');
    return;
  }

  const dueNudges = getDueNudges(nycDay);
  if (dueNudges.length === 0) return;

  // Filter to events where current time is 4-6 hours before start
  const nudgesToSend = dueNudges.filter(n => {
    if (!n.time_local || !/^\d{2}:\d{2}$/.test(n.time_local)) return false;
    const eventHour = parseInt(n.time_local.split(':')[0]);
    const hoursUntil = eventHour - hour;
    return hoursUntil >= 4 && hoursUntil <= 6;
  });

  if (nudgesToSend.length === 0) return;
  console.log(`nudge scheduler: sending ${nudgesToSend.length} nudges`);

  const { sendSMS } = require('./twilio');
  for (const nudge of nudgesToSend) {
    try {
      const msg = buildNudgeMessage(nudge);
      await sendSMS(nudge.phone, msg);
      markNudgeSent(nudge.id);
      console.log(`nudge sent to ${nudge.phone_hash.slice(0, 8)}...: ${nudge.name} at ${nudge.venue_name}`);
    } catch (err) {
      console.warn(`nudge send failed for sub ${nudge.id}:`, err.message);
    }
  }
}

function scheduleNudges() {
  if (!process.env.PULSE_NUDGES_ENABLED) {
    console.log('Nudge scheduler disabled (set PULSE_NUDGES_ENABLED=true to enable)');
    return;
  }
  nudgeInterval = setInterval(() => {
    checkAndSendNudges().catch(err =>
      console.error('nudge scheduler error:', err.message)
    );
  }, 60 * 60 * 1000);
  console.log('Nudge scheduler started (hourly check)');
}

function clearNudgeSchedule() {
  if (nudgeInterval) {
    clearInterval(nudgeInterval);
    nudgeInterval = null;
  }
}

module.exports = {
  upsertNudgeSub, getPendingConsent, setOptedIn, setOptedOut,
  markConsentAsked, getDueNudges, markNudgeSent,
  trackRecurringDetail, captureConsent,
  buildNudgeMessage, checkAndSendNudges, scheduleNudges, clearNudgeSchedule,
};
