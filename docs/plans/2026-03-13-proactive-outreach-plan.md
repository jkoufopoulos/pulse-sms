# Proactive Outreach Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pulse texts opted-in users when a high-confidence event match appears, turning Pulse from a search tool into a retention engine.

**Architecture:** Post-scrape hook scans opted-in users against fresh events, scores matches, composes LLM message, sends via Twilio. Opt-in/out handled mechanically via NOTIFY/STOP NOTIFY keywords. Session seeded for reply handling via saveResponseFrame.

**Tech Stack:** Node.js, SQLite (better-sqlite3), Twilio, Gemini (via llm.js)

**Spec:** `docs/plans/2026-03-13-proactive-outreach-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/proactive.js` | Create | Core proactive logic: scoring, composition, scheduling |
| `test/unit/proactive.test.js` | Create | Unit tests for scoring, opt-in checks, matching |
| `src/preference-profile.js` | Modify | Replace `proactiveOptInPromptedAt` with `proactivePromptCount`, add opt-in/out setters |
| `src/agent-brain.js` | Modify | Add NOTIFY and STOP NOTIFY to `checkMechanical` |
| `src/brain-llm.js` | Modify | Add conditional opt-in CTA instruction to system prompt |
| `src/events.js` | Modify | Hook `processProactiveMessages()` into post-scrape chain |
| `src/handler.js` | Modify | Detect proactive-seeded sessions for engagement tracking |

---

## Chunk 1: Opt-in Infrastructure

### Task 1: Update preference profile schema

**Files:**
- Modify: `src/preference-profile.js:35-54` (blankProfile)
- Modify: `src/preference-profile.js:60-130` (updateProfile)
- Test: `test/unit/preference-profile.test.js`

- [ ] **Step 1: Write failing tests for proactivePromptCount**

Add to `test/unit/preference-profile.test.js`:

```javascript
// ---- proactive opt-in ----
console.log('\nproactive opt-in:');

check('blank profile has proactivePromptCount 0', (() => {
  const p = getProfile('proactive-test-1');
  return p.proactivePromptCount === 0;
})());

check('blank profile has proactiveOptIn false', (() => {
  const p = getProfile('proactive-test-2');
  return p.proactiveOptIn === false;
})());

check('setProactiveOptIn sets flag and date', (() => {
  setProactiveOptIn('proactive-test-3', true);
  const p = getProfile('proactive-test-3');
  return p.proactiveOptIn === true && p.proactiveOptInDate !== null;
})());

check('setProactiveOptIn false clears flag', (() => {
  setProactiveOptIn('proactive-test-4', true);
  setProactiveOptIn('proactive-test-4', false);
  const p = getProfile('proactive-test-4');
  return p.proactiveOptIn === false;
})());

check('incrementProactivePromptCount increments', (() => {
  incrementProactivePromptCount('proactive-test-5');
  incrementProactivePromptCount('proactive-test-5');
  const p = getProfile('proactive-test-5');
  return p.proactivePromptCount === 2;
})());
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setProactiveOptIn` and `incrementProactivePromptCount` not defined

- [ ] **Step 3: Update blankProfile and add helper functions**

In `src/preference-profile.js`:

Replace `proactiveOptInPromptedAt: null` (line ~52) with `proactivePromptCount: 0` in `blankProfile()`.

Add after `getOptInEligibleUsers()` (~line 199):

```javascript
function setProactiveOptIn(phone, optIn) {
  const profile = getProfile(phone);
  profile.proactiveOptIn = !!optIn;
  profile.proactiveOptInDate = optIn ? new Date().toISOString() : profile.proactiveOptInDate;
  scheduleDiskWrite();
}

function incrementProactivePromptCount(phone) {
  const profile = getProfile(phone);
  profile.proactivePromptCount = (profile.proactivePromptCount || 0) + 1;
  scheduleDiskWrite();
}
```

Add `setProactiveOptIn` and `incrementProactivePromptCount` to `module.exports`.

Update the import in the test file to include the new exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass including new proactive opt-in tests

- [ ] **Step 5: Commit**

```bash
git add src/preference-profile.js test/unit/preference-profile.test.js
git commit -m "feat: add proactive opt-in profile helpers (setProactiveOptIn, incrementProactivePromptCount)"
```

---

### Task 2: Add NOTIFY and STOP NOTIFY to checkMechanical

**Files:**
- Modify: `src/agent-brain.js:9-14` (checkMechanical)
- Test: `test/unit/agent-brain.test.js`

- [ ] **Step 1: Write failing tests for NOTIFY keywords**

Add to `test/unit/agent-brain.test.js`:

```javascript
// ---- NOTIFY keyword handling ----
console.log('\nNOTIFY keywords:');

check('NOTIFY returns proactive_opt_in intent', (() => {
  const result = checkMechanical('NOTIFY', {});
  return result?.intent === 'proactive_opt_in';
})());

check('notify lowercase works', (() => {
  const result = checkMechanical('notify', {});
  return result?.intent === 'proactive_opt_in';
})());

check('STOP NOTIFY returns proactive_opt_out intent', (() => {
  const result = checkMechanical('STOP NOTIFY', {});
  return result?.intent === 'proactive_opt_out';
})());

check('stop notify lowercase works', (() => {
  const result = checkMechanical('stop notify', {});
  return result?.intent === 'proactive_opt_out';
})());

check('UNSUBSCRIBE NOTIFY returns proactive_opt_out intent', (() => {
  const result = checkMechanical('UNSUBSCRIBE NOTIFY', {});
  return result?.intent === 'proactive_opt_out';
})());

check('STOP alone still returns null (TCPA)', (() => {
  const result = checkMechanical('STOP', {});
  return result === null;
})());

check('STOP NOTIFY does not trigger TCPA opt-out', (() => {
  const result = checkMechanical('STOP NOTIFY', {});
  return result?.intent === 'proactive_opt_out';
})());
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — checkMechanical returns null for NOTIFY

- [ ] **Step 3: Add NOTIFY handling to checkMechanical**

In `src/agent-brain.js`, modify `checkMechanical` (lines 9-14). The STOP NOTIFY check must come **before** the OPT_OUT_KEYWORDS check:

```javascript
function checkMechanical(message, session) {
  const lower = message.toLowerCase().trim();
  if (/^(help|\?)$/i.test(lower)) return { intent: 'help' };
  if (/^(stop|unsubscribe)\s+notify$/i.test(lower)) return { intent: 'proactive_opt_out' };
  if (/^notify$/i.test(lower)) return { intent: 'proactive_opt_in' };
  if (OPT_OUT_KEYWORDS.test(lower)) return null;
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent-brain.js test/unit/agent-brain.test.js
git commit -m "feat: add NOTIFY and STOP NOTIFY mechanical keywords for proactive opt-in/out"
```

---

### Task 3: Wire NOTIFY intents in handler

**Files:**
- Modify: `src/handler.js:233-252` (mechanical dispatch section)
- Test: Manual via simulator

- [ ] **Step 1: Add proactive intent handling in dispatchPreRouterIntent**

In `src/handler.js`, find `dispatchPreRouterIntent` (line 183). The existing pattern dispatches by `route.intent`. Add cases after the `help` handler (line 194):

```javascript
  if (route.intent === 'help') return handleHelp(ctx);

  if (route.intent === 'proactive_opt_in') {
    const { setProactiveOptIn } = require('./preference-profile');
    setProactiveOptIn(phone, true);
    const reply = "You're in! I'll text you when something great comes up. Reply STOP NOTIFY anytime to turn it off.";
    await sendSMS(phone, reply);
    finalizeTrace(reply, 'proactive_opt_in');
    return;
  }

  if (route.intent === 'proactive_opt_out') {
    const { setProactiveOptIn } = require('./preference-profile');
    setProactiveOptIn(phone, false);
    const reply = "Got it — no more proactive texts. You can still text me anytime for picks.";
    await sendSMS(phone, reply);
    finalizeTrace(reply, 'proactive_opt_out');
    return;
  }
```

Note: Follow the same pattern as `handleHelp` — call `sendSMS`, `finalizeTrace`, and return. The caller (`handleMessageAI` line 250) already returns `trace.id` after `dispatchPreRouterIntent` completes.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass (no new test needed — handler tests are integration-level)

- [ ] **Step 3: Commit**

```bash
git add src/handler.js
git commit -m "feat: wire NOTIFY/STOP NOTIFY intents to profile updates and SMS replies"
```

---

### Task 4: Add opt-in CTA to system prompt

**Files:**
- Modify: `src/brain-llm.js:118-252` (buildBrainSystemPrompt)
- Modify: `src/preference-profile.js` (need to pass profile data to prompt)

- [ ] **Step 1: Add shouldPromptOptIn to proactive.js**

Create `src/proactive.js` with the first export:

```javascript
'use strict';

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

module.exports = { shouldPromptOptIn };
```

- [ ] **Step 2: Write tests for shouldPromptOptIn**

Create `test/unit/proactive.test.js`:

```javascript
const { check } = require('../helpers');
const { shouldPromptOptIn } = require('../../src/proactive');

console.log('\nshouldPromptOptIn:');

check('null profile returns false', shouldPromptOptIn(null) === false);

check('already opted in returns false', shouldPromptOptIn({
  proactiveOptIn: true, proactivePromptCount: 0, sessionCount: 1
}) === false);

check('session 1 with 0 prompts returns true', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 0, sessionCount: 1
}) === true);

check('session 2 returns false', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 1, sessionCount: 2
}) === false);

check('session 3 with 1 prompt returns true', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 1, sessionCount: 3
}) === true);

check('session 3 with 2 prompts returns false (max reached)', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 2, sessionCount: 3
}) === false);

check('session 4 returns false', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 1, sessionCount: 4
}) === false);
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Inject opt-in instruction into system prompt**

In `src/brain-llm.js`, in `buildBrainSystemPrompt()`, add to the `sessionContext` block (around line 144, after existing session context lines):

```javascript
const { shouldPromptOptIn } = require('./proactive');
const { getProfile } = require('./preference-profile');
```

Then in the function body, after building sessionContext, add:

```javascript
// Proactive opt-in CTA
const profile = session?.phone ? getProfile(session.phone) : null;
const promptOptIn = shouldPromptOptIn(profile);
```

And in the prompt template, add a conditional section after the sign-off instructions:

```javascript
${promptOptIn ? `
PROACTIVE OPT-IN: This user hasn't opted into proactive recommendations yet. At the end of your picks response, append on a new line:
"PS — Want me to text you when something great comes up? Reply NOTIFY to opt in."
Only add this to responses that include event picks, not to detail responses or conversation.` : ''}
```

Note: The system prompt function takes `session` as its parameter. If `session.phone` is not available, check how the phone is passed — it may need to be added to the session object or passed as a separate parameter. Read the call site in `agent-loop.js` to verify.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/proactive.js test/unit/proactive.test.js src/brain-llm.js
git commit -m "feat: add opt-in CTA to system prompt for session 1 and 3"
```

---

## Chunk 2: Event Matching & Scoring

### Task 5: Implement scoreMatch

**Files:**
- Modify: `src/proactive.js`
- Modify: `test/unit/proactive.test.js`

- [ ] **Step 1: Write failing tests for scoreMatch**

Add to `test/unit/proactive.test.js`:

```javascript
const { scoreMatch } = require('../../src/proactive');

console.log('\nscoreMatch:');

const baseEvent = {
  id: 'e1', name: 'Test Event', venue_name: 'Test Venue',
  neighborhood: 'Bushwick', category: 'dj',
  interestingness: 3, scarcity: null, editorial_signal: false,
};

const baseProfile = {
  neighborhoods: { Bushwick: 5, Williamsburg: 3 },
  categories: { dj: 4, live_music: 2 },
  sessionCount: 3,
};

check('neighborhood match scores +3', (() => {
  const score = scoreMatch(baseEvent, baseProfile);
  return score >= 3;
})());

check('no neighborhood match scores lower', (() => {
  const event = { ...baseEvent, neighborhood: 'Harlem' };
  const score = scoreMatch(event, baseProfile);
  return score < scoreMatch(baseEvent, baseProfile);
})());

check('category match adds +2', (() => {
  const noCategory = { ...baseEvent, category: 'theater' };
  const diff = scoreMatch(baseEvent, baseProfile) - scoreMatch(noCategory, baseProfile);
  return diff === 2;
})());

check('scarcity bonus adds +1', (() => {
  const scarce = { ...baseEvent, scarcity: 'one-night-only' };
  return scoreMatch(scarce, baseProfile) === scoreMatch(baseEvent, baseProfile) + 1;
})());

check('editorial bonus adds +1', (() => {
  const editorial = { ...baseEvent, editorial_signal: true };
  return scoreMatch(editorial, baseProfile) === scoreMatch(baseEvent, baseProfile) + 1;
})());

check('high interestingness normalizes correctly', (() => {
  const boring = { ...baseEvent, interestingness: -2 };
  const exciting = { ...baseEvent, interestingness: 6 };
  return scoreMatch(exciting, baseProfile) > scoreMatch(boring, baseProfile);
})());
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `scoreMatch` not defined

- [ ] **Step 3: Implement scoreMatch**

Add to `src/proactive.js`:

```javascript
/**
 * Score an event against a user profile for proactive recommendation.
 * Returns a numeric score. Threshold for sending: 5.
 *
 * Weights:
 *   Neighborhood match (top 2): +3
 *   Category match (top categories): +2
 *   Interestingness (normalized -3..6 → 1..3): +1 to +3
 *   Scarcity (one-night-only): +1
 *   Editorial signal: +1
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
```

Add `scoreMatch` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/proactive.js test/unit/proactive.test.js
git commit -m "feat: implement scoreMatch for proactive event-user matching"
```

---

### Task 6: Implement findBestMatch

**Files:**
- Modify: `src/proactive.js`
- Modify: `test/unit/proactive.test.js`

- [ ] **Step 1: Write failing tests**

Add to `test/unit/proactive.test.js`:

```javascript
const { findBestMatch } = require('../../src/proactive');

console.log('\nfindBestMatch:');

const events = [
  { id: 'e1', neighborhood: 'Bushwick', category: 'dj', interestingness: 3, scarcity: 'one-night-only', editorial_signal: true },
  { id: 'e2', neighborhood: 'Harlem', category: 'theater', interestingness: 1, scarcity: null, editorial_signal: false },
  { id: 'e3', neighborhood: 'Bushwick', category: 'live_music', interestingness: 4, scarcity: null, editorial_signal: false },
];

const profile = {
  neighborhoods: { Bushwick: 5 },
  categories: { dj: 4 },
  sessionCount: 3,
};

check('returns highest scoring event', (() => {
  const best = findBestMatch(events, profile, []);
  return best?.id === 'e1';
})());

check('excludes already-recommended events', (() => {
  const best = findBestMatch(events, profile, ['e1']);
  return best?.id === 'e3';
})());

check('returns null if nothing clears threshold', (() => {
  const lowProfile = { neighborhoods: {}, categories: {}, sessionCount: 1 };
  const weakEvents = [{ id: 'w1', neighborhood: 'Harlem', category: 'theater', interestingness: -2, scarcity: null, editorial_signal: false }];
  return findBestMatch(weakEvents, lowProfile, []) === null;
})());

check('returns null for empty events', findBestMatch([], profile, []) === null);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: Implement findBestMatch**

Add to `src/proactive.js`:

```javascript
const PROACTIVE_THRESHOLD = 5;

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
```

Add `findBestMatch` to `module.exports`.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/proactive.js test/unit/proactive.test.js
git commit -m "feat: implement findBestMatch with threshold filtering and dedup"
```

---

## Chunk 3: Message Composition & Sending

### Task 7: Implement composeProactiveMessage

**Files:**
- Modify: `src/proactive.js`
- Modify: `test/unit/proactive.test.js`

- [ ] **Step 1: Implement composeProactiveMessage**

Add to `src/proactive.js`:

```javascript
const { generate } = require('./llm');
const { lookupVenueProfile } = require('./venues');

const PROACTIVE_FOOTER = '\nReply STOP NOTIFY to turn off';

/**
 * Compose a proactive SMS using the LLM.
 * Returns the full message string (content + footer), capped at 480 chars.
 */
async function composeProactiveMessage(event, profile) {
  const venueVibe = lookupVenueProfile(event.venue_name)?.vibe || '';
  const topHood = Object.entries(profile.neighborhoods || {})
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'your area';

  const prompt = `You're Pulse, texting a user proactively about an event you think they'd love. They're into ${topHood} and tend to go to ${Object.keys(profile.categories || {}).slice(0, 2).join(' and ') || 'all kinds of'} events.

Event: ${event.name}
Venue: ${event.venue_name || 'TBA'}${venueVibe ? ` — ${venueVibe}` : ''}
When: ${event.date_local} ${event.start_time_local || ''}
Neighborhood: ${event.neighborhood || 'NYC'}
${event.is_free ? 'Free' : event.price_display ? `Price: ${event.price_display}` : ''}

Write a single SMS under 320 characters that sounds like a friend giving a tip. Lead with why this is worth their night. End with "Reply for details."`;

  const { MODEL_ROLES } = require('./model-config');
  const result = await generate(prompt, {
    system: 'You write brief, enthusiastic SMS messages about NYC events. No emoji. No hashtags. Sound like a plugged-in local friend, not a marketing bot.',
    model: MODEL_ROLES.brain,
    max_tokens: 150,
  });

  const content = (result.text || '').trim().slice(0, 320);
  return content + PROACTIVE_FOOTER;
}
```

Add `composeProactiveMessage` to `module.exports`.

- [ ] **Step 2: Write a basic structure test**

Add to `test/unit/proactive.test.js`:

```javascript
console.log('\ncomposeProactiveMessage:');

check('composeProactiveMessage exported', typeof require('../../src/proactive').composeProactiveMessage === 'function');
```

Note: Full composition testing requires LLM calls — test the function signature here, test output quality manually via simulator.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/proactive.js test/unit/proactive.test.js
git commit -m "feat: implement LLM-composed proactive message with venue vibe"
```

---

### Task 8: Implement processProactiveMessages

**Files:**
- Modify: `src/proactive.js`
- Modify: `test/unit/proactive.test.js`

- [ ] **Step 1: Implement the main post-scrape hook**

Add to `src/proactive.js`:

```javascript
const { sendSMS } = require('./twilio');
const { getOptInEligibleUsers, getProfile, getTopNeighborhood } = require('./preference-profile');
const { insertRecommendations } = require('./db');
const { saveResponseFrame } = require('./pipeline');
const { hashPhone } = require('./session');

const COOLDOWN_DAYS = 7;
const CHURN_DAYS = 30;

/**
 * Post-scrape hook: scan opted-in users, find best matches, compose and send.
 * Called after each scrape completes.
 */
async function processProactiveMessages(eventCache) {
  if (process.env.PULSE_PROACTIVE_ENABLED !== 'true') {
    console.log('[PROACTIVE] Disabled (set PULSE_PROACTIVE_ENABLED=true to enable)');
    return { sent: 0, skipped: 0, errors: 0 };
  }

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

      // Seed session for reply handling (P4: one save path via saveResponseFrame)
      // Note: saveResponseFrame may need a `proactiveSeeded` field added to its
      // accepted params. If not feasible, track proactive sends via the
      // event_recommendations table instead — check if the user's last
      // recommendation was within 2 hours to detect proactive-seeded sessions.
      saveResponseFrame(phone, {
        mode: 'fresh',
        picks: [{ event_id: bestEvent.id, pick_number: 1 }],
        neighborhood: bestEvent.neighborhood,
        eventMap: { [bestEvent.id]: bestEvent },
        lastResponseHadPicks: true,
        proactiveSeeded: true,
      });

      sent++;
      console.log(`[PROACTIVE] Sent to ${phone.slice(-4)}: ${bestEvent.name}`);

    } catch (err) {
      errors++;
      console.error(`[PROACTIVE] Error for user: ${err.message}`);
    }
  }

  console.log(`[PROACTIVE] Done: ${sent} sent, ${skipped} skipped, ${errors} errors`);
  return { sent, skipped, errors };
}
```

Add `processProactiveMessages` to `module.exports`.

- [ ] **Step 2: Write structure test**

Add to `test/unit/proactive.test.js`:

```javascript
console.log('\nprocessProactiveMessages:');
check('processProactiveMessages exported', typeof require('../../src/proactive').processProactiveMessages === 'function');
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/proactive.js test/unit/proactive.test.js
git commit -m "feat: implement processProactiveMessages post-scrape hook"
```

---

### Task 9: Hook into post-scrape chain

**Files:**
- Modify: `src/events.js:~690` (after post-scrape audit)

- [ ] **Step 1: Add proactive hook to refreshCache**

In `src/events.js`, find the post-scrape section (after the scrape audit try/catch block, around line 690). Add:

```javascript
// Proactive outreach — send personalized event recommendations to opted-in users
try {
  const { processProactiveMessages } = require('./proactive');
  processProactiveMessages(eventCache).catch(err =>
    console.error('[PROACTIVE] Post-scrape hook failed:', err.message)
  );
} catch (err) {
  console.error('[PROACTIVE] Module load failed:', err.message);
}
```

Note: This is an async fire-and-forget — it won't block the scrape completion. Errors are caught and logged, never thrown.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/events.js
git commit -m "feat: hook processProactiveMessages into post-scrape chain"
```

---

## Chunk 4: Reply Handling & Engagement Tracking

### Task 10: Detect proactive-seeded sessions and track engagement

**Files:**
- Modify: `src/handler.js:~197-256` (handleMessageAI)

- [ ] **Step 1: Add engagement tracking**

In `src/handler.js`, in `handleMessageAI`, after loading the session (around line 197-200), add engagement detection:

```javascript
// Track engagement for proactive messages
if (session?.proactiveSeeded) {
  try {
    const { markRecommendationEngaged } = require('./db');
    const { hashPhone } = require('./session');
    const lastPick = session.lastPicks?.[0];
    if (lastPick?.event_id) {
      markRecommendationEngaged(hashPhone(phone), lastPick.event_id);
    }
    // Clear the flag so we only track once
    session.proactiveSeeded = false;
  } catch (err) {
    console.error('[PROACTIVE] Engagement tracking error:', err.message);
  }
}
```

This runs on the first reply after a proactive message. The session flows into the normal agent loop from there.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/handler.js
git commit -m "feat: track proactive message engagement on user reply"
```

---

### Task 11: Add proactivePromptCount increment to agent loop

**Files:**
- Modify: `src/agent-loop.js` (after response sent, when opt-in CTA was included)

- [ ] **Step 1: Increment prompt count after picks response**

In `src/agent-loop.js`, after the agent sends a response that includes picks (near `saveResponseFrame` call), add:

```javascript
// Increment proactive prompt count if CTA was shown
const { shouldPromptOptIn } = require('./proactive');
const { getProfile, incrementProactivePromptCount } = require('./preference-profile');
const profile = getProfile(phone);
if (shouldPromptOptIn(profile)) {
  incrementProactivePromptCount(phone);
}
```

Note: This checks the same condition used in the system prompt. If the CTA was injected by the prompt, we increment the counter so it's only shown the right number of times.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/agent-loop.js
git commit -m "feat: increment proactivePromptCount after opt-in CTA shown"
```

---

### Task 12: Add NOTIFY/STOP NOTIFY scenario evals

**Files:**
- Modify: `data/fixtures/multi-turn-scenarios.json`

- [ ] **Step 1: Add eval scenarios**

Add to the scenarios array in `data/fixtures/multi-turn-scenarios.json`:

```json
{
  "name": "Mechanical: NOTIFY opts in to proactive",
  "category": "happy_path",
  "turns": [
    { "sender": "user", "message": "NOTIFY" },
    { "sender": "pulse", "message": "You're in", "assert": "contains" }
  ],
  "testing": "NOTIFY keyword triggers proactive opt-in with confirmation",
  "expected_behavior": "Mechanical response confirming opt-in",
  "failure_modes": ["Treated as conversation instead of mechanical", "No confirmation"],
  "difficulty": "must_pass"
},
{
  "name": "Mechanical: STOP NOTIFY opts out without TCPA",
  "category": "edge_case",
  "turns": [
    { "sender": "user", "message": "NOTIFY" },
    { "sender": "pulse", "message": "You're in", "assert": "contains" },
    { "sender": "user", "message": "STOP NOTIFY" },
    { "sender": "pulse", "message": "no more proactive", "assert": "contains" }
  ],
  "testing": "STOP NOTIFY disables proactive without full TCPA opt-out",
  "expected_behavior": "Proactive disabled, user can still text for picks",
  "failure_modes": ["Full TCPA opt-out triggered", "No confirmation", "Proactive not disabled"],
  "difficulty": "must_pass"
}
```

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add data/fixtures/multi-turn-scenarios.json
git commit -m "feat: add NOTIFY and STOP NOTIFY scenario evals"
```

---

### Task 13: Add pause endpoint and auto-pause

**Files:**
- Modify: `src/proactive.js`
- Modify: `src/server.js`

- [ ] **Step 1: Add pause state and endpoint**

In `src/proactive.js`, add at module level:

```javascript
let proactivePaused = false;

function pauseProactive() { proactivePaused = true; }
function resumeProactive() { proactivePaused = false; }
function isProactivePaused() { return proactivePaused; }
```

Add the pause check at the top of `processProactiveMessages`:

```javascript
if (proactivePaused) {
  console.log('[PROACTIVE] Paused — skipping');
  return { sent: 0, skipped: 0, errors: 0 };
}
```

Add `pauseProactive`, `resumeProactive`, `isProactivePaused` to `module.exports`.

In `src/server.js`, add an API route (near other `/api/` routes):

```javascript
app.post('/api/proactive/pause', (req, res) => {
  const { pauseProactive } = require('./proactive');
  pauseProactive();
  console.log('[PROACTIVE] Manually paused via API');
  res.json({ status: 'paused' });
});

app.post('/api/proactive/resume', (req, res) => {
  const { resumeProactive } = require('./proactive');
  resumeProactive();
  console.log('[PROACTIVE] Resumed via API');
  res.json({ status: 'resumed' });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/proactive.js src/server.js
git commit -m "feat: add /api/proactive/pause and /resume endpoints with manual kill switch"
```

---

### Task 14: Update ROADMAP.md

Note: Renumbered from Task 13.

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Mark Phase 10 items as done**

Update the Phase 10 section in ROADMAP.md:

- [x] Proactive message scheduler
- [x] Selection logic (scoreMatch + findBestMatch)
- [x] Opt-in flow (NOTIFY keyword, session 1 + 3 CTA)
- [x] Opt-out flow (STOP NOTIFY)
- [x] LLM-composed messages with tastemaker voice
- [x] Engagement tracking
- [x] Kill switch (PULSE_PROACTIVE_ENABLED env var)
- [x] Scenario evals for NOTIFY keywords

Add to Completed Work table with date.

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark Phase 10 proactive outreach as done"
```

---

## Chunk 5: Deploy & Validate

### Task 14: Deploy and test

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Deploy to Railway**

```bash
railway up
```

Wait ~2-3 min for build to complete. Verify health:

```bash
curl https://web-production-c8fdb.up.railway.app/health
```

- [ ] **Step 3: Test opt-in flow via simulator**

Open `https://web-production-c8fdb.up.railway.app/test` and:
1. Send a neighborhood as a new phone number — verify picks response includes the opt-in CTA
2. Reply `NOTIFY` — verify opt-in confirmation
3. Reply `STOP NOTIFY` — verify opt-out confirmation without TCPA opt-out
4. Send another neighborhood — verify normal session still works

- [ ] **Step 4: Run scenario evals**

```bash
node scripts/run-scenario-evals.js --url https://web-production-c8fdb.up.railway.app --concurrency 5
```

Expected: Code eval pass rate ≥99.5%, new NOTIFY scenarios pass

- [ ] **Step 5: Enable proactive on Railway**

Set `PULSE_PROACTIVE_ENABLED=true` in Railway env vars. The next scrape cycle will trigger proactive message processing.
