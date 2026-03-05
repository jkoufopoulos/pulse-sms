# First-Message Experience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every first message (greeting, referral, cold open) returns real, dynamically-scored event picks instead of instructions — proving Pulse's taste in the first 5 seconds.

**Architecture:** Add an `interestingness` score to events (computed at cache time, deterministic, $0). Remove canned greeting/referral responses. Route first-touch messages through the agent brain with a welcome-specific compose prompt that uses interestingness-ranked citywide events. Session wiring makes picks actionable (reply number for details, "more" for next batch).

**Tech Stack:** Node.js, existing event cache, Gemini Flash Lite (brainCompose), existing session/pipeline modules.

---

### Task 1: Add interestingness scoring function to events.js

**Files:**
- Modify: `src/events.js` (add `scoreInterestingness` function after `classifyInteractionFormat` ~line 123)
- Test: `test/unit/events.test.js` (append tests)

**Step 1: Write the failing test**

Append to `test/unit/events.test.js`:

```js
// ---- scoreInterestingness ----
const { scoreInterestingness } = require('../../src/events');

console.log('\nscoreInterestingness:');

// Discovery + one-off + intimate = max score (6)
check('discovery one-off intimate = 6', scoreInterestingness({
  source_vibe: 'discovery', is_recurring: false, venue_size: 'intimate', interaction_format: null,
}) === 6);

// Mainstream + recurring + massive = min score (-3)
check('mainstream recurring massive = -3', scoreInterestingness({
  source_vibe: 'mainstream', is_recurring: true, venue_size: 'massive', interaction_format: null,
}) === -3);

// Recurring interactive gets rarity 1 not 0
check('niche recurring interactive = 3', scoreInterestingness({
  source_vibe: 'niche', is_recurring: true, venue_size: null, interaction_format: 'interactive',
}) === 3);

// Platform + one-off + no venue info = 2
check('platform one-off unknown venue = 2', scoreInterestingness({
  source_vibe: 'platform', is_recurring: false, venue_size: null, interaction_format: null,
}) === 2);

// Missing source_vibe defaults to platform (0)
check('no source_vibe = platform default', scoreInterestingness({
  is_recurring: false, venue_size: 'medium',
}) === 2);
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/events.test.js`
Expected: FAIL — `scoreInterestingness is not a function`

**Step 3: Write minimal implementation**

Add to `src/events.js` after the `classifyInteractionFormat` function (after line ~123):

```js
/**
 * Score an event for "interestingness" — how likely it is to impress a first-time user.
 * Deterministic, $0. Used to rank citywide pools for first-message and "surprise me" queries.
 *
 * Score range: -3 (recurring mainstream at massive venue) to 6 (one-off discovery at intimate venue).
 */
const VIBE_SCORES = { discovery: 3, niche: 2, platform: 0, mainstream: -2 };
const VENUE_SCORES = { intimate: 1, medium: 0, large: -1, massive: -1 };

function scoreInterestingness(event) {
  const vibeScore = VIBE_SCORES[event.source_vibe] ?? 0;
  const rarityScore = !event.is_recurring ? 2
    : (event.interaction_format === 'interactive' ? 1 : 0);
  const venueScore = VENUE_SCORES[event.venue_size] ?? 0;
  return vibeScore + rarityScore + venueScore;
}
```

Add `scoreInterestingness` to the `module.exports` at the bottom of `events.js`.

**Step 4: Run test to verify it passes**

Run: `node test/unit/events.test.js`
Expected: All scoreInterestingness checks PASS

**Step 5: Commit**

```bash
git add src/events.js test/unit/events.test.js
git commit -m "feat: add interestingness scoring for first-message picks"
```

---

### Task 2: Add `getTopPicks` to events.js — interestingness-ranked citywide pool

**Files:**
- Modify: `src/events.js` (add `getTopPicks` function, export it)
- Test: `test/unit/events.test.js` (append tests)

**Step 1: Write the failing test**

Append to `test/unit/events.test.js`:

```js
// ---- getTopPicks (category diversity) ----
const { selectDiversePicks } = require('../../src/events');

console.log('\nselectDiversePicks:');

const scoredPool = [
  { id: '1', category: 'comedy', interestingness: 6 },
  { id: '2', category: 'comedy', interestingness: 5 },
  { id: '3', category: 'live_music', interestingness: 5 },
  { id: '4', category: 'art', interestingness: 4 },
  { id: '5', category: 'comedy', interestingness: 4 },
  { id: '6', category: 'nightlife', interestingness: 3 },
];

const picks = selectDiversePicks(scoredPool, 3);
check('returns 3 picks', picks.length === 3);
check('first pick is highest score', picks[0].id === '1');
check('no two picks share a category', new Set(picks.map(p => p.category)).size === 3);

// When pool has < 3 categories, fill with best remaining
const twoCategories = [
  { id: '1', category: 'comedy', interestingness: 6 },
  { id: '2', category: 'comedy', interestingness: 5 },
  { id: '3', category: 'comedy', interestingness: 4 },
];
const picks2 = selectDiversePicks(twoCategories, 3);
check('fills from best remaining when diversity exhausted', picks2.length === 3);

// Empty pool
check('empty pool returns empty', selectDiversePicks([], 3).length === 0);
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/events.test.js`
Expected: FAIL — `selectDiversePicks is not a function`

**Step 3: Write minimal implementation**

Add to `src/events.js` after `scoreInterestingness`:

```js
/**
 * Select N picks from a scored pool, maximizing category diversity.
 * Takes the highest-scored event, then picks from unseen categories, then fills remaining slots.
 */
function selectDiversePicks(scoredPool, count = 3) {
  if (scoredPool.length === 0) return [];
  const sorted = [...scoredPool].sort((a, b) => b.interestingness - a.interestingness);
  const picks = [];
  const usedCategories = new Set();

  // First pass: one per category
  for (const event of sorted) {
    if (picks.length >= count) break;
    if (!usedCategories.has(event.category)) {
      picks.push(event);
      usedCategories.add(event.category);
    }
  }

  // Second pass: fill remaining slots with best available
  if (picks.length < count) {
    const pickIds = new Set(picks.map(p => p.id));
    for (const event of sorted) {
      if (picks.length >= count) break;
      if (!pickIds.has(event.id)) picks.push(event);
    }
  }

  return picks;
}

/**
 * Get the top interestingness-ranked events for first-message / "surprise me" queries.
 * Returns up to `count` events with category diversity enforced.
 * Uses today+tomorrow date gate by default, widens to 7 days if pool is thin.
 */
async function getTopPicks(count = 10) {
  if (eventCache.length === 0) {
    await refreshCache();
  }

  const qualityFiltered = applyQualityGates(eventCache);
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);

  // First try: today + tomorrow only
  let dateFiltered = qualityFiltered.filter(e => {
    const d = getEventDate(e);
    if (!d) return false;
    return d >= todayNyc && d <= tomorrowNyc;
  });

  // Widen to 7 days if pool is thin (< 5 scoreable events)
  if (dateFiltered.length < 5) {
    const weekOutNyc = getNycDateString(7);
    dateFiltered = qualityFiltered.filter(e => {
      const d = getEventDate(e);
      if (!d) return false;
      return d >= todayNyc && d <= weekOutNyc;
    });
  }

  // Score each event
  const scored = dateFiltered.map(e => ({
    ...e,
    interestingness: scoreInterestingness(e),
  }));

  return selectDiversePicks(scored, count);
}
```

Add `getTopPicks` and `selectDiversePicks` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `node test/unit/events.test.js`
Expected: All selectDiversePicks checks PASS

**Step 5: Commit**

```bash
git add src/events.js test/unit/events.test.js
git commit -m "feat: add getTopPicks with interestingness ranking and category diversity"
```

---

### Task 3: Add welcome compose prompt to agent-brain.js

**Files:**
- Modify: `src/agent-brain.js` (add `WELCOME_COMPOSE_SYSTEM` prompt and `welcomeCompose` function)

**Step 1: Add the welcome compose prompt**

Add after the `BRAIN_COMPOSE_SYSTEM` constant (~line 500) in `src/agent-brain.js`:

```js
const WELCOME_COMPOSE_SYSTEM = `You are Bestie, an NYC nightlife and events SMS bot. Compose a WELCOME message for a brand-new user.

FORMAT (MANDATORY):
Line 1: "I'm Bestie — your plugged-in friend for NYC. Tell me what you're into tonight, just ask. Here's a few things on my radar:"
Blank line
Then 3 numbered picks with emoji category markers:
1) [emoji] Event description — time, price
2) [emoji] Event description — time, price
3) [emoji] Event description — time, price
Blank line
Last line: "Any of those sound good? Or tell me a vibe, a neighborhood, whatever."

EMOJI MAP (use these for category markers):
comedy/theater: use a theater/comedy emoji
live_music/jazz/dj/nightlife: use a music emoji
art: use an art emoji
film: use a film emoji
community/trivia/food_drink: use a community/social emoji
other: use a sparkle emoji

RULES:
- Pick exactly 3 events from the provided list. They are pre-ranked by interestingness — respect the ranking but you may reorder slightly for narrative flow.
- Each pick MUST include: event name, venue name, neighborhood in parentheses, time, and price ("$20", "free", "cover").
- Make each pick sound like a tip from a friend who just found out about it. Opinionated, vivid, concise.
- Label TODAY events as "tonight", TOMORROW as "tomorrow".
- Under 480 characters total. No URLs.
- Do NOT change the intro line or the CTA line — use them exactly as specified above.

Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id", "why": "short reason"}] }`;
```

**Step 2: Add the `welcomeCompose` function**

Add after the `brainCompose` function:

```js
/**
 * Compose a welcome message from interestingness-ranked events.
 * Uses the same Gemini → Anthropic fallback as brainCompose.
 */
async function welcomeCompose(events) {
  const todayNyc = getNycDateString(0);
  const eventLines = events.slice(0, 6).map((e, i) => {
    const day = e.date_local === todayNyc ? 'TODAY' : 'TOMORROW';
    const time = e.start_time_local ? new Date(e.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : 'evening';
    const price = e.is_free ? 'Free' : (e.price_display || 'check price');
    const vibe = e.source_vibe ? `[${e.source_vibe}]` : '';
    const venue = e.venue_size ? `[${e.venue_size}]` : '';
    return `${i + 1}. [${day}] ${e.name} at ${e.venue_name || 'TBA'} (${e.neighborhood || 'NYC'}) — ${time}, ${price} | ${e.category} ${vibe} ${venue} | id:${e.id}`;
  }).join('\n');

  const userPrompt = `Pick 3 events for a welcome message. Events ranked by interestingness (best first):\n\n${eventLines}`;

  // Try Gemini first
  const client = getGeminiClient();
  if (client) {
    try {
      const model = client.getGenerativeModel({
        model: process.env.PULSE_MODEL_ROUTE_GEMINI || 'gemini-2.5-flash-lite',
        systemInstruction: WELCOME_COMPOSE_SYSTEM,
        safetySettings: GEMINI_SAFETY,
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
          responseMimeType: 'application/json',
          responseSchema: BRAIN_COMPOSE_SCHEMA,
        },
      });
      const result = await withTimeout(
        model.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
        10_000, 'welcomeCompose'
      );
      const text = result.response.text();
      const usage = { input_tokens: result.response.usageMetadata?.promptTokenCount || 0,
                      output_tokens: result.response.usageMetadata?.candidatesTokenCount || 0 };
      const parsed = JSON.parse(stripCodeFences(text));
      const sms = smartTruncate(parsed.sms_text);
      return { sms_text: sms, picks: parsed.picks || [], _raw: text, _usage: usage, _provider: 'gemini' };
    } catch (err) {
      console.warn('welcomeCompose Gemini failed, falling back to Anthropic:', err.message);
    }
  }

  // Anthropic fallback
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropicClient = new Anthropic();
  const response = await withTimeout(anthropicClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: WELCOME_COMPOSE_SYSTEM + '\n\nReturn ONLY valid JSON, no other text.',
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 10000 }), 12000, 'welcomeCompose-anthropic');
  const raw = response.content?.[0]?.text || '';
  const usage = response.usage || {};
  const parsed = JSON.parse(stripCodeFences(raw));
  const sms = smartTruncate(parsed.sms_text);
  return { sms_text: sms, picks: parsed.picks || [], _raw: raw, _usage: usage, _provider: 'anthropic' };
}
```

Add `welcomeCompose` to the `module.exports` at line 986.

**Step 3: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: add welcomeCompose prompt and function for first-message picks"
```

---

### Task 4: Wire first-message flow into agent brain — handle greetings as welcome picks

**Files:**
- Modify: `src/agent-brain.js` (`checkMechanical` and `handleAgentBrainRequest`)
- Modify: `src/handler.js` (`dispatchPreRouterIntent` referral path)

**Step 1: Add `isFirstMessage` helper and `handleWelcome` to agent-brain.js**

Add after `checkMechanical` (~line 236):

```js
/**
 * Detect if this is a first-touch message (no session, or greeting/referral).
 */
function isFirstMessage(session) {
  return !session || (!session.lastPicks?.length && !session.lastNeighborhood && !session.conversationHistory?.length);
}
```

Add `handleWelcome` function (before `handleAgentBrainRequest`):

```js
/**
 * Handle first-message welcome flow: fetch interestingness-ranked events,
 * compose welcome+picks, save session, send SMS.
 * Returns { sms, intent, picks, activeFilters, eventMap } like executeSearchEvents.
 */
async function handleWelcome(phone, session, trace) {
  const { getTopPicks } = require('./events');

  const eventsStart = Date.now();
  const topEvents = await getTopPicks(10);
  trace.events.getEvents_ms = Date.now() - eventsStart;
  trace.events.candidates_count = topEvents.length;
  trace.events.candidate_ids = topEvents.map(e => e.id);
  trace.events.sent_to_claude = topEvents.length;
  trace.events.sent_ids = topEvents.map(e => e.id);
  trace.events.sent_pool = topEvents.map(e => ({
    id: e.id, name: e.name, venue_name: e.venue_name, neighborhood: e.neighborhood,
    category: e.category, start_time_local: e.start_time_local, date_local: e.date_local,
    is_free: e.is_free, price_display: e.price_display, source_name: e.source_name,
    source_vibe: e.source_vibe || null, interestingness: e.interestingness,
  }));

  if (topEvents.length === 0) {
    // Stale cache fallback — use current intro
    const sms = "Hey! I'm Bestie \u2014 I find the stuff in NYC you won't find on Instagram. Tell me a neighborhood, a vibe, or what you're in the mood for tonight.";
    saveResponseFrame(phone, { picks: [], eventMap: {}, neighborhood: null, filters: null, offeredIds: [] });
    return { sms, intent: 'conversational', picks: [], activeFilters: {}, eventMap: {} };
  }

  const composeStart = Date.now();
  const result = await welcomeCompose(topEvents);
  trace.composition.latency_ms = Date.now() - composeStart;
  trace.composition.raw_response = result._raw || null;
  trace.composition.active_filters = {};
  trace.composition.neighborhood_used = 'citywide';

  recordAICost(trace, 'compose', result._usage, result._provider);
  trackAICost(phone, result._usage, result._provider);

  // Validate picks
  const eventMap = {};
  for (const e of topEvents) eventMap[e.id] = e;
  const validPicks = validatePicks(result.picks, topEvents);

  trace.composition.picks = validPicks.map(p => {
    const evt = eventMap[p.event_id];
    return {
      ...p, date_local: evt?.date_local || null, event_name: evt?.name || null,
      venue_name: evt?.venue_name || null, neighborhood: evt?.neighborhood || null,
      category: evt?.category || null, is_free: evt?.is_free ?? null,
      price_display: evt?.price_display || null, start_time_local: evt?.start_time_local || null,
      source_vibe: evt?.source_vibe || null,
    };
  });

  saveResponseFrame(phone, {
    picks: validPicks,
    eventMap,
    neighborhood: null,
    filters: null,
    offeredIds: validPicks.map(p => p.event_id),
    visitedHoods: ['citywide'],
  });

  return { sms: result.sms_text, intent: 'events', picks: validPicks, activeFilters: {}, eventMap };
}
```

**Step 2: Modify `handleAgentBrainRequest` to intercept first messages**

In `handleAgentBrainRequest` (~line 903), after the history snapshot and `addToHistory` call (line 909), add before the `try` block:

```js
  // First-message welcome flow: intercept greetings and cold opens
  if (isFirstMessage(session)) {
    try {
      const welcomeResult = await handleWelcome(phone, session, trace);
      trace.routing.pre_routed = true;
      trace.routing.result = { intent: 'welcome', confidence: 1.0 };
      trace.routing.latency_ms = 0;
      trace.brain_tool = 'welcome';
      trace.brain_provider = 'welcome';

      await sendSMS(phone, welcomeResult.sms);
      if (welcomeResult.picks?.length) await sendPickUrls(phone, welcomeResult.picks, welcomeResult.eventMap);
      finalizeTrace(welcomeResult.sms, welcomeResult.intent);
      return trace.id;
    } catch (err) {
      console.warn('Welcome flow failed, falling back to agent brain:', err.message);
      // Fall through to normal agent brain flow
    }
  }
```

**Important:** This intercept should happen AFTER `checkMechanical` returns null (which it will for greetings since the agent brain `checkMechanical` doesn't handle greetings — it lets them through to the brain). But it should happen BEFORE `callAgentBrain`. The `isFirstMessage` check ensures we only do this for truly new users, not for someone mid-session saying "hey" again.

**Step 3: Modify handler.js referral path to use welcome flow**

In `src/handler.js`, `dispatchPreRouterIntent`, the referral handling (lines 184-210) currently sends two canned messages. When `PULSE_AGENT_BRAIN=true`, replace with a welcome flow call. In the referral block, after `recordAttribution`, add:

```js
    // Agent brain: use welcome flow instead of canned intro
    if (process.env.PULSE_AGENT_BRAIN === 'true') {
      const { handleWelcome } = require('./agent-brain');
      const welcomeResult = await handleWelcome(phone, session, trace);
      trace.routing.result = { intent: 'welcome_referral', confidence: 1.0 };
      await sendSMS(phone, welcomeResult.sms);
      if (welcomeResult.picks?.length) {
        const { sendPickUrls } = require('./pipeline');
        await sendPickUrls(phone, welcomeResult.picks, welcomeResult.eventMap);
      }
      finalizeTrace(welcomeResult.sms, 'referral');
      return;
    }
```

**Step 4: Commit**

```bash
git add src/agent-brain.js src/handler.js
git commit -m "feat: wire first-message welcome flow into agent brain and referral paths"
```

---

### Task 5: Remove the post-first-picks preference tip

**Files:**
- Modify: `src/unified-flow.js` (remove tip SMS, lines 378-383)

**Step 1: Remove the preference tip**

In `src/unified-flow.js`, find and remove the one-time preference tip block (lines 378-383):

Remove:
```js
  // One-time preference tip after first successful picks response
  const isFirstPicks = filterCompliantPicks.length > 0
    && !session?.shownPreferenceTip
    && (session?.conversationHistory?.length || 0) <= 1;
  if (isFirstPicks) {
    await sendSMS(phone, 'Tip: Tell me what you\u2019re into \u2014 "I love comedy and late-night stuff" or "mostly free events" \u2014 and I\u2019ll start prioritizing those for you.');
  }
```

Also remove the `shownPreferenceTip` session persistence (line 399):
```js
  if (isFirstPicks) setSession(phone, { shownPreferenceTip: true });
```

**Step 2: Verify no other references to shownPreferenceTip**

Run: `grep -r shownPreferenceTip src/` — should return nothing after the edit.

**Step 3: Commit**

```bash
git add src/unified-flow.js
git commit -m "feat: remove post-first-picks preference tip (welcome message replaces it)"
```

---

### Task 6: Add eval scenarios for first-message welcome flow

**Files:**
- Modify: `data/fixtures/multi-turn-scenarios.json` (add 3-4 new scenarios)

**Step 1: Add first-message scenarios**

Add these scenarios to the multi-turn scenarios fixture:

1. **Greeting welcome** — User sends "hey", expects picks (not instructions)
2. **Prefilled welcome** — User sends "Hey send me some stuff to do tonight!", expects picks
3. **Welcome then details** — User sends "hey", gets picks, replies "1", gets details
4. **Welcome then neighborhood** — User sends "hey", gets picks, replies "bushwick", gets neighborhood picks

Each scenario should have assertions that:
- Response contains numbered picks (not just instructions)
- Response is under 480 chars
- Response mentions real event data (venue names, times, prices)
- Session has picks saved (details/more work after)

**Step 2: Run eval locally to verify scenarios parse**

Run: `PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js` (in background)
Then: `node scripts/run-scenario-evals.js --name "welcome" --url http://localhost:3000`

**Step 3: Commit**

```bash
git add data/fixtures/multi-turn-scenarios.json
git commit -m "feat: add first-message welcome eval scenarios"
```

---

### Task 7: Manual smoke test and eyeball validation

**Step 1: Boot the server with agent brain enabled**

```bash
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_AGENT_BRAIN=true node src/server.js
```

Wait for cache to load.

**Step 2: Test first-message responses**

```bash
# Greeting
curl -s -X POST http://localhost:3000/api/sms/test -H 'Content-Type: application/json' -d '{"Body":"hey"}' | jq '.messages'

# Prefilled
curl -s -X POST http://localhost:3000/api/sms/test -H 'Content-Type: application/json' -d '{"Body":"Hey send me some stuff to do tonight!"}' | jq '.messages'

# Then details
curl -s -X POST http://localhost:3000/api/sms/test -H 'Content-Type: application/json' -d '{"Body":"1","From":"+10000000000"}' | jq '.messages'
```

**Step 3: Eyeball the interestingness ranking**

```bash
# Check what getTopPicks returns
node -e "
  const { refreshCache, getTopPicks, scoreInterestingness } = require('./src/events');
  refreshCache().then(async () => {
    const picks = await getTopPicks(10);
    picks.forEach((e, i) => console.log(
      i+1, e.interestingness, e.source_vibe, e.category, e.name?.slice(0,40), e.venue_name?.slice(0,20), e.neighborhood
    ));
  });
"
```

Verify: top picks are discovery/niche sources, one-offs, intimate/medium venues. No Ticketmaster or Eventbrite in the top 5 unless the pool is thin.

**Step 4: Verify 480-char compliance**

Check that all welcome messages are under 480 chars. If they're running over, adjust the `WELCOME_COMPOSE_SYSTEM` prompt to be more aggressive about brevity, or drop to 2 picks.

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: first-message experience — dynamic welcome picks replace canned intros"
```

---

## Summary of changes

| File | Change |
|------|--------|
| `src/events.js` | Add `scoreInterestingness`, `selectDiversePicks`, `getTopPicks` |
| `src/agent-brain.js` | Add `WELCOME_COMPOSE_SYSTEM`, `welcomeCompose`, `isFirstMessage`, `handleWelcome`; intercept first messages in `handleAgentBrainRequest` |
| `src/handler.js` | Referral path uses welcome flow when agent brain enabled |
| `src/unified-flow.js` | Remove preference tip SMS |
| `test/unit/events.test.js` | Tests for scoring, diversity selection |
| `data/fixtures/multi-turn-scenarios.json` | Welcome eval scenarios |

**Not changed:** pre-router.js (greeting regex stays for non-agent-brain fallback path), prompts.js (unified flow prompt unchanged), session.js, pipeline.js, all scraper files.
