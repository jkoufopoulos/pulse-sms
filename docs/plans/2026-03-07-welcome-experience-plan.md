# Welcome Experience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the first-message welcome experience where new users get curated picks immediately, routed by the agent LLM but executed deterministically ($0, sub-second).

**Architecture:** Add a `show_welcome` tool to the agent brain. When a new user sends a casual greeting, the agent calls this tool instead of `respond`. The tool fetches top picks via `getTopPicks()`, formats them deterministically, and returns the SMS. Session is saved via `saveResponseFrame`. The CTA shifts from "text me a neighborhood" to "tell me what you're in the mood for."

**Tech Stack:** Node.js, existing agent loop (`llm.js`/`agent-loop.js`), `getTopPicks` from `events.js`, `saveResponseFrame` from `pipeline.js`.

---

### Task 1: Add `show_welcome` tool definition to `BRAIN_TOOLS`

**Files:**
- Modify: `src/brain-llm.js:31-105` (BRAIN_TOOLS array)

**Step 1: Write the failing test**

In `test/unit/agent-loop.test.js`, add at the end:

```js
// ---- show_welcome in BRAIN_TOOLS ----
console.log('\nshow_welcome tool:');

const { BRAIN_TOOLS } = require('../../src/brain-llm');
const welcomeTool = BRAIN_TOOLS.find(t => t.name === 'show_welcome');
check('show_welcome tool exists in BRAIN_TOOLS', !!welcomeTool);
check('show_welcome has no required params', !welcomeTool.parameters.required || welcomeTool.parameters.required.length === 0);
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/agent-loop.test.js`
Expected: FAIL — `show_welcome tool exists in BRAIN_TOOLS` fails

**Step 3: Add `show_welcome` to `BRAIN_TOOLS`**

In `src/brain-llm.js`, add this entry to the `BRAIN_TOOLS` array after the `compose_sms` tool (after line 104, before the closing `]`):

```js
  {
    name: 'show_welcome',
    description: 'Show tonight\'s top picks as a welcome message. ONLY call this when the SESSION CONTEXT says "First message — new session" AND the user sent a casual greeting (hey, hi, yo, hello, what\'s up, etc). Do NOT use for returning users, specific requests, questions, or abuse.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
```

**Step 4: Run test to verify it passes**

Run: `node test/unit/agent-loop.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add test/unit/agent-loop.test.js src/brain-llm.js
git commit -m "feat: add show_welcome tool definition to BRAIN_TOOLS"
```

---

### Task 2: Update system prompt to indicate first-session status

**Files:**
- Modify: `src/brain-llm.js:109-177` (buildBrainSystemPrompt)

**Step 1: Write the failing test**

In `test/unit/agent-loop.test.js`, add at the end:

```js
// ---- buildBrainSystemPrompt first-session indicator ----
console.log('\nbuildBrainSystemPrompt first-session:');

const { buildBrainSystemPrompt } = require('../../src/brain-llm');

const freshSession = {};
const freshPrompt = buildBrainSystemPrompt(freshSession);
check('fresh session prompt contains first-message indicator', freshPrompt.includes('First message'));

const returningSession = { conversationHistory: [{ role: 'user', content: 'hey' }], lastNeighborhood: 'bushwick' };
const returningPrompt = buildBrainSystemPrompt(returningSession);
check('returning session prompt does NOT contain first-message indicator', !returningPrompt.includes('First message'));
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/agent-loop.test.js`
Expected: FAIL — `fresh session prompt contains first-message indicator` fails

**Step 3: Add first-session detection to `buildBrainSystemPrompt`**

In `src/brain-llm.js`, in the `buildBrainSystemPrompt` function, modify the `sessionContext` construction. Replace the block starting at line 110:

```js
function buildBrainSystemPrompt(session) {
  const isFirstMessage = !session?.conversationHistory?.length && !session?.lastNeighborhood;

  const sessionContext = session
    ? [
      isFirstMessage ? 'First message — new session. Use show_welcome for casual greetings.' : null,
      session.lastNeighborhood ? `Current neighborhood: ${session.lastNeighborhood}` : null,
```

Everything else in the function stays the same. We're just adding one line at the top of the array when it's a first message.

**Step 4: Update TOOL FLOW in system prompt**

In the same function, update the TOOL FLOW block (line 156-159). Replace:

```
TOOL FLOW:
- Conversational messages (greetings, questions, thanks): call respond.
```

With:

```
TOOL FLOW:
- First message + casual greeting: call show_welcome (shows tonight's top picks).
- Conversational messages (questions, thanks, farewells): call respond.
```

**Step 5: Run test to verify it passes**

Run: `node test/unit/agent-loop.test.js`
Expected: PASS

**Step 6: Commit**

```bash
git add test/unit/agent-loop.test.js src/brain-llm.js
git commit -m "feat: system prompt indicates first-session status for show_welcome routing"
```

---

### Task 3: Add `executeWelcome` to `brain-execute.js`

**Files:**
- Modify: `src/brain-execute.js` (add executeWelcome + helpers)
- Modify: `src/events.js` (verify getTopPicks export — already exported, no change needed)

**Step 1: Write the failing test**

Create tests in `test/unit/agent-brain.test.js`, add at the end:

```js
// ---- executeWelcome ----
console.log('\nexecuteWelcome:');

// We need to test the formatting helpers without hitting the real event cache.
// Import the helpers directly.
const { formatWelcomePick, welcomeTimeLabel } = require('../../src/brain-execute');

check('formatWelcomePick exists', typeof formatWelcomePick === 'function');
check('welcomeTimeLabel exists', typeof welcomeTimeLabel === 'function');

// Test welcomeTimeLabel with a today event
const todayEvent = {
  date_local: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  start_time_local: new Date(new Date().setHours(20, 0, 0)).toISOString(),
};
const todayLabel = welcomeTimeLabel(todayEvent);
check('today event label contains "tonight" or "today"', todayLabel.includes('tonight') || todayLabel.includes('today'));

// Test formatWelcomePick
const testEvent = {
  name: 'Jazz Night',
  venue_name: 'Blue Note',
  neighborhood: 'Greenwich Village',
  category: 'jazz',
  is_free: false,
  price_display: '$20',
  date_local: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  start_time_local: new Date(new Date().setHours(20, 0, 0)).toISOString(),
};
const pickLine = formatWelcomePick(testEvent, 1);
check('pick line starts with rank', pickLine.startsWith('1)'));
check('pick line contains event name', pickLine.includes('Jazz Night'));
check('pick line contains venue', pickLine.includes('Blue Note'));
check('pick line contains neighborhood', pickLine.includes('Greenwich Village'));
check('pick line contains price', pickLine.includes('$20'));
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/agent-brain.test.js`
Expected: FAIL — `formatWelcomePick exists` fails (not exported yet)

**Step 3: Add the welcome helpers and `executeWelcome` to `brain-execute.js`**

Add the following at the end of `src/brain-execute.js`, just before the `module.exports` line:

```js
// --- Welcome experience helpers (deterministic, $0) ---

const { parseAsNycTime } = require('./geo');
const { smartTruncate } = require('./formatters');

const WELCOME_EMOJI = {
  comedy: '\u{1F3AD}', theater: '\u{1F3AD}',
  live_music: '\u{1F3B5}', nightlife: '\u{1F3B5}',
  art: '\u{1F3A8}', film: '\u{1F3AC}',
  community: '\u{1F389}', food_drink: '\u{1F389}',
};

/**
 * Format a compact time label for welcome picks.
 * Today -> "tonight" or "today Xpm". Tomorrow -> "tomorrow Xpm". Further -> "Sat Xpm".
 */
function welcomeTimeLabel(event) {
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);
  const eventDate = event.date_local || null;

  let timeStr = '';
  if (event.start_time_local) {
    const ms = parseAsNycTime(event.start_time_local);
    if (!isNaN(ms)) {
      const d = new Date(ms);
      timeStr = d.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: '2-digit',
      }).replace(':00', '').toLowerCase();
    }
  }

  if (eventDate === todayNyc) {
    if (!timeStr) return 'tonight';
    const hour = event.start_time_local ? new Date(parseAsNycTime(event.start_time_local)).getHours() : 18;
    return hour >= 18 ? `tonight ${timeStr}` : `today ${timeStr}`;
  }
  if (eventDate === tomorrowNyc) {
    return timeStr ? `tomorrow ${timeStr}` : 'tomorrow';
  }
  if (eventDate) {
    const dayName = new Date(eventDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    return timeStr ? `${dayName} ${timeStr}` : dayName;
  }
  return timeStr || 'tonight';
}

/**
 * Format a single welcome pick line: emoji Name — Venue (Hood), time, price
 */
function formatWelcomePick(event, rank) {
  const emoji = WELCOME_EMOJI[event.category] || '\u2728';
  const venue = event.venue_name || '';
  const hood = event.neighborhood ? ` (${event.neighborhood})` : '';
  const time = welcomeTimeLabel(event);
  const price = event.is_free ? 'free' : (event.price_display || '');
  const priceStr = price ? `, ${price}` : '';
  return `${rank}) ${emoji} ${event.name} \u2014 ${venue}${hood}, ${time}${priceStr}`;
}

/**
 * Execute the show_welcome tool: fetch top picks, format deterministically.
 * Returns { smsText, picks, eventMap } or { smsText } (fallback, no events).
 */
async function executeWelcome() {
  const { getTopPicks } = require('./events');
  const topEvents = await getTopPicks(5);

  if (topEvents.length === 0) {
    return {
      smsText: "Hey, I'm Pulse \u2014 your plugged-in friend for NYC nightlife. Tell me what you're in the mood for tonight.",
      picks: [],
      eventMap: {},
    };
  }

  const picks3 = topEvents.slice(0, 3);
  const pickLines = picks3.map((e, i) => formatWelcomePick(e, i + 1));
  const smsText = smartTruncate(
    `I'm Pulse \u2014 here's what's good tonight:\n\n${pickLines.join('\n')}\n\nAny of those? Or tell me what you're in the mood for`
  );

  const eventMap = {};
  for (const e of topEvents) eventMap[e.id] = e;

  const picks = picks3.map((e, i) => ({
    rank: i + 1,
    event_id: e.id,
    why: `interestingness: ${e.interestingness}, ${e.source_vibe || 'unknown'} source`,
  }));

  return { smsText, picks, eventMap };
}
```

**Step 4: Update the `module.exports`**

Replace the existing exports line:

```js
module.exports = {
  resolveDateRange, executeMore, executeDetails, validatePicks,
  buildSearchPool,
};
```

With:

```js
module.exports = {
  resolveDateRange, executeMore, executeDetails, validatePicks,
  buildSearchPool, executeWelcome, formatWelcomePick, welcomeTimeLabel,
};
```

**Step 5: Run test to verify it passes**

Run: `node test/unit/agent-brain.test.js`
Expected: PASS

**Step 6: Commit**

```bash
git add test/unit/agent-brain.test.js src/brain-execute.js
git commit -m "feat: add executeWelcome + formatting helpers to brain-execute.js"
```

---

### Task 4: Handle `show_welcome` in `executeTool` and `saveSessionFromToolCalls`

**Files:**
- Modify: `src/agent-loop.js:121-270` (executeTool) and `src/agent-loop.js:280-381` (saveSessionFromToolCalls)

**Step 1: Write the failing test**

In `test/unit/agent-loop.test.js`, add at the end:

```js
// ---- deriveIntent with show_welcome ----
console.log('\nderiveIntent with show_welcome:');

check('show_welcome -> events', deriveIntent([{ name: 'show_welcome', params: {} }]) === 'welcome');
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/agent-loop.test.js`
Expected: FAIL — returns 'conversational' instead of 'welcome'

**Step 3: Wire `show_welcome` into `executeTool`**

In `src/agent-loop.js`, add the import for `executeWelcome` at line 18. Change:

```js
const { buildSearchPool, executeMore, executeDetails } = require('./brain-execute');
```

To:

```js
const { buildSearchPool, executeMore, executeDetails, executeWelcome } = require('./brain-execute');
```

Then in the `executeTool` function (around line 121), add a new handler before the `search_events` handler. After the `compose_sms` handler (after line 128), add:

```js
  if (toolName === 'show_welcome') {
    const result = await executeWelcome();
    return {
      ok: true,
      _welcomeResult: result,
      _smsText: result.smsText,
    };
  }
```

**Step 4: Wire `show_welcome` into `deriveIntent`**

In the `deriveIntent` function (around line 89), add at the top of the function body, after the early return for no tool calls:

```js
  const hasWelcome = toolCalls.find(tc => tc.name === 'show_welcome');
  if (hasWelcome) return 'welcome';
```

**Step 5: Wire `show_welcome` into `saveSessionFromToolCalls`**

In `saveSessionFromToolCalls` (around line 280), add handling for `show_welcome` after the `lastRespond` line. Add after line 285:

```js
  const lastWelcome = [...toolCalls].reverse().find(tc => tc.name === 'show_welcome');
```

Then add a new block after `if (!lastSearch && lastRespond)` (after line 304), before `if (!lastSearch) return;`:

```js
  // show_welcome — save welcome picks as initial session state
  if (lastWelcome) {
    const wr = lastWelcome.result?._welcomeResult;
    if (wr) {
      saveResponseFrame(phone, {
        picks: wr.picks || [],
        eventMap: wr.eventMap || {},
        neighborhood: 'citywide',
        filters: null,
        offeredIds: (wr.picks || []).map(p => p.event_id),
        visitedHoods: ['citywide'],
      });
    }
    return;
  }
```

**Step 6: Add `show_welcome` as a stop tool in `handleAgentRequest`**

In `handleAgentRequest` (around line 408), update the `stopTools` array:

```js
      { maxIterations: 3, timeout: 12000, stopTools: ['respond', 'compose_sms', 'show_welcome'] }
```

**Step 7: Handle `show_welcome` SMS extraction in `handleAgentRequest`**

The existing code at line 425 already handles `_smsText` from tool results:
```js
const detailsResult = [...rawResults].reverse().find(tc => tc.result?._smsText);
```
This will pick up the `_smsText` from `show_welcome` too, so no change needed here.

**Step 8: Run test to verify it passes**

Run: `node test/unit/agent-loop.test.js`
Expected: PASS

**Step 9: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 10: Commit**

```bash
git add test/unit/agent-loop.test.js src/agent-loop.js
git commit -m "feat: wire show_welcome tool into executeTool, deriveIntent, and saveSessionFromToolCalls"
```

---

### Task 5: Smoke test end-to-end on simulator

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Test on simulator**

Open the SMS simulator at `http://localhost:3000/test` and send:
- "hey" → expect welcome picks with tonight's events
- New session + "bushwick" → expect search results, NOT welcome
- New session + "how do I use this" → expect explanation from `respond`

**Step 3: Verify session behavior**

After welcome, send "2" → expect details for pick #2 (session has picks from welcome).
After welcome, send "more" → expect more picks (session has event pool).

**Step 4: Deploy and verify on Railway**

Run: `railway up`
Wait 2-3 minutes, then test on `https://web-production-c8fdb.up.railway.app/test`.

**Step 5: Commit any fixes**

If any issues found, fix and commit.

---

### Task 6: Update ROADMAP.md

**Files:**
- Modify: `ROADMAP.md`

**Step 1: Add to completed work**

Add an entry to the "Completed Work" section:

```
- **(2026-03-07):** Restored welcome experience. `show_welcome` tool: agent-routed, deterministically-executed. New users get top 3 picks on first greeting. CTA shifted from "text me a neighborhood" to "tell me what you're in the mood for" (vibe-first).
```

**Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: document welcome experience restoration in ROADMAP"
```
