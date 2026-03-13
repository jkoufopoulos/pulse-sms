const { check } = require('../helpers');

console.log('\nnudges:');

const {
  upsertNudgeSub, getPendingConsent, setOptedIn, setOptedOut,
  markConsentAsked, getDueNudges, markNudgeSent,
  captureConsent, buildNudgeMessage,
} = require('../../src/nudges');
const { getDb } = require('../../src/db');

// Ensure test pattern exists for joins
const db = getDb();
const hasPattern = db.prepare('SELECT 1 FROM recurring_patterns WHERE pattern_key = ?').get('trivia-blackrabbit');
if (!hasPattern) {
  db.prepare(`INSERT INTO recurring_patterns (pattern_key, name, venue_name, neighborhood, day_of_week, time_local, active_until, deactivated, first_seen, last_confirmed, created_at, updated_at)
    VALUES ('trivia-blackrabbit', 'Trivia Night', 'Black Rabbit', 'Greenpoint', 2, '20:00', '2026-12-31', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`).run();
}

// Clean slate
db.prepare('DELETE FROM nudge_subscriptions').run();

// --- upsertNudgeSub ---
const r1 = upsertNudgeSub('hash_abc', '+10001112222', 'trivia-blackrabbit');
check('first upsert: detail_count=1', r1.detail_count === 1);
check('first upsert: consent_asked=0', r1.consent_asked === 0);

const r2 = upsertNudgeSub('hash_abc', '+10001112222', 'trivia-blackrabbit');
check('second upsert: detail_count=2', r2.detail_count === 2);

// --- getPendingConsent (before consent_asked) ---
const pending1 = getPendingConsent('hash_abc');
check('no pending before consent_asked', pending1 === undefined);

// --- markConsentAsked + getPendingConsent ---
markConsentAsked(r2.id);
const pending2 = getPendingConsent('hash_abc');
check('pending after consent_asked', pending2 !== undefined);
check('pending has event name', pending2.name === 'Trivia Night');
check('pending has venue', pending2.venue_name === 'Black Rabbit');

// --- setOptedIn ---
setOptedIn(r2.id);
const pending3 = getPendingConsent('hash_abc');
check('no pending after opt-in', pending3 === undefined);

// --- getDueNudges ---
const due = getDueNudges(2); // Tuesday
check('due nudge found for opted-in sub', due.length === 1);
check('due nudge has venue', due[0].venue_name === 'Black Rabbit');
check('due nudge has phone', due[0].phone === '+10001112222');

// After marking sent, should not be due again (7-day cooldown)
markNudgeSent(due[0].id);
const due2 = getDueNudges(2);
check('not due after sent (7-day cooldown)', due2.length === 0);

// Wrong day should return nothing
const due3 = getDueNudges(3); // Wednesday
check('not due on wrong day', due3.length === 0);

// --- setOptedOut (global) ---
db.prepare('DELETE FROM nudge_subscriptions').run();
upsertNudgeSub('hash_xyz', '+10003334444', 'trivia-blackrabbit');
upsertNudgeSub('hash_xyz', '+10003334444', 'jazz-smalls');
setOptedOut('hash_xyz');
const allSubs = db.prepare('SELECT opted_out FROM nudge_subscriptions WHERE phone_hash = ?').all('hash_xyz');
check('global opt-out sets all subs', allSubs.every(s => s.opted_out === 1));

// --- captureConsent ---
console.log('\ncaptureConsent:');
db.prepare('DELETE FROM nudge_subscriptions').run();

// NUDGE OFF (no subs — still works)
const nudgeOff = captureConsent('+10005556666', 'nudge off');
check('NUDGE OFF is handled', nudgeOff.handled === true);
check('NUDGE OFF intent', nudgeOff.intent === 'nudge_optout');

// REMIND ME without pending consent
const noConsent = captureConsent('+10005556666', 'remind me');
check('REMIND ME without pending: not handled', noConsent.handled === false);

// Random message
const random = captureConsent('+10005556666', 'bushwick');
check('random message: not handled', random.handled === false);

// --- buildNudgeMessage ---
console.log('\nbuildNudgeMessage:');

const msg1 = buildNudgeMessage({ name: 'Trivia Night', venue_name: 'Black Rabbit', neighborhood: 'Greenpoint', time_local: '20:00' });
check('includes event name', msg1.includes('Trivia Night'));
check('includes venue', msg1.includes('Black Rabbit'));
check('includes neighborhood', msg1.includes('Greenpoint'));
check('includes formatted time', msg1.includes('8pm'));
check('includes hook', msg1.includes('what else'));
check('under 480 chars', msg1.length <= 480);

const msg2 = buildNudgeMessage({ name: 'Jazz Night', venue_name: 'Smalls', neighborhood: 'West Village', time_local: '21:30' });
check('formats half-hour time', msg2.includes('9:30pm'));

const msg3 = buildNudgeMessage({ name: 'Open Mic', venue_name: 'Union Hall', neighborhood: 'Park Slope', time_local: '19:00' });
check('formats 7pm', msg3.includes('7pm'));

// Clean up test data
db.prepare('DELETE FROM nudge_subscriptions').run();
db.prepare("DELETE FROM recurring_patterns WHERE pattern_key = 'trivia-blackrabbit'").run();
