# Phase 4: Agent-Native Details and More — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move details and "more" into the agent brain, drop numbered list formatting, collapse tools from 3 to 2.

**Architecture:** `checkMechanical` reduced to help + TCPA only. `search_events` gains `more` and `details` intents. `get_details` tool deleted. SMS composition switches from numbered lists to natural prose. Agent writes all SMS via Gemini continuation.

**Tech Stack:** Gemini 2.5 Flash Lite (tool calling), Anthropic Haiku (fallback), existing pipeline/session modules.

**Design doc:** `docs/plans/2026-03-05-phase4-agent-native-design.md`

---

### Task 1: Gut `checkMechanical` to help + TCPA only

**Files:**
- Modify: `src/agent-brain.js:240-328` (checkMechanical function)

**Step 1: Write failing test**

Create `test/unit/agent-brain.test.js`:

```js
const { checkMechanical } = require('../../src/agent-brain');

// --- Preserved behaviors ---
describe('checkMechanical (Phase 4)', () => {
  test('help returns help intent', () => {
    expect(checkMechanical('help', null)).toEqual({ intent: 'help' });
    expect(checkMechanical('?', null)).toEqual({ intent: 'help' });
  });

  test('TCPA opt-out returns null (silent drop)', () => {
    expect(checkMechanical('STOP', null)).toBeNull();
    expect(checkMechanical('unsubscribe', null)).toBeNull();
  });

  // --- Everything else falls through to agent brain ---
  test('bare numbers fall through to agent brain', () => {
    const session = { lastPicks: [{ event_id: 'e1' }], lastResponseHadPicks: true };
    expect(checkMechanical('2', session)).toBeNull();
    expect(checkMechanical('1', session)).toBeNull();
  });

  test('"more" falls through to agent brain', () => {
    const session = { lastPicks: [{ event_id: 'e1' }] };
    expect(checkMechanical('more', session)).toBeNull();
    expect(checkMechanical('what else', session)).toBeNull();
  });

  test('greetings fall through to agent brain', () => {
    expect(checkMechanical('hey', null)).toBeNull();
    expect(checkMechanical('thanks', null)).toBeNull();
    expect(checkMechanical('bye', null)).toBeNull();
  });

  test('conversational signals fall through to agent brain', () => {
    expect(checkMechanical('cool', null)).toBeNull();
    expect(checkMechanical('nah', null)).toBeNull();
    expect(checkMechanical('ok', { lastPicks: [{ event_id: 'e1' }] })).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/agent-brain.test.js --no-cache`
Expected: FAIL — bare numbers, more, greetings currently return intents instead of null.

**Step 3: Gut checkMechanical**

Replace `src/agent-brain.js:240-328` (the entire `checkMechanical` function body) with:

```js
function checkMechanical(message, session) {
  const lower = message.toLowerCase().trim();

  // Help
  if (/^(help|\?)$/i.test(lower)) return { intent: 'help' };

  // TCPA (belt-and-suspenders — request-guard already handles this)
  if (OPT_OUT_KEYWORDS.test(lower)) return null;

  // Everything else → agent brain
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx jest test/unit/agent-brain.test.js --no-cache`
Expected: PASS

**Step 5: Run existing tests to check for regressions**

Run: `npm test`
Expected: All pass (no existing tests reference checkMechanical directly).

**Step 6: Commit**

```bash
git add src/agent-brain.js test/unit/agent-brain.test.js
git commit -m "feat: gut checkMechanical to help + TCPA only (Phase 4)"
```

---

### Task 2: Add `more` and `details` intents to `search_events` tool definitions

**Files:**
- Modify: `src/agent-brain.js:56-120` (BRAIN_TOOLS — Gemini tool defs)
- Modify: `src/agent-brain.js:503-544` (anthropicTools — Anthropic fallback tool defs)

**Step 1: Update Gemini BRAIN_TOOLS**

In `BRAIN_TOOLS[0].functionDeclarations`, modify `search_events`:

1. Add `'more'` and `'details'` to the `intent` enum (line ~89):
```js
enum: ['new_search', 'refine', 'pivot', 'more', 'details'],
```

2. Add `pick_reference` property to `search_events.parameters.properties` (after `intent`):
```js
pick_reference: {
  type: 'STRING',
  description: 'How the user referenced a previously shown pick. Can be a number ("2"), event name ("the comedy one"), or venue name ("Elsewhere"). Only used with intent: "details".',
  nullable: true,
},
```

3. Delete the entire `get_details` function declaration (lines ~94-103).

**Step 2: Update Anthropic fallback tools**

In `anthropicTools` array (~line 503-544):

1. Add `'more'` and `'details'` to `search_events.input_schema.properties.intent.enum`:
```js
enum: ['new_search', 'refine', 'pivot', 'more', 'details'],
```

2. Add `pick_reference` to `search_events.input_schema.properties`:
```js
pick_reference: { type: 'string', description: 'Reference to a previously shown pick (number, name, or venue). Used with intent: details.' },
```

3. Delete the entire `get_details` tool object (lines ~521-531).

**Step 3: Delete `executeGetDetails` function**

Delete `src/agent-brain.js:1180-1191` (the `executeGetDetails` function).

**Step 4: Update `handleAgentBrainRequest` to remove `get_details` branch**

In `src/agent-brain.js:1419-1433`, delete the `else if (brainResult.tool === 'get_details')` block entirely.

**Step 5: Remove `handleDetails` import**

In `src/agent-brain.js:26`, remove `handleDetails` from the import:
```js
const { handleHelp, handleMore } = require('./intent-handlers');
```

(Keep `handleMore` for now — Task 3 will refactor its logic into the search_events handler.)

**Step 6: Run tests**

Run: `npm test`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: add more/details intents to search_events, delete get_details tool"
```

---

### Task 3: Implement `executeMore` — the "more" intent handler

**Files:**
- Modify: `src/agent-brain.js` (add executeMore function, wire into handleAgentBrainRequest)
- Reference: `src/intent-handlers.js:216-326` (existing handleMore logic to port)
- Reference: `src/pipeline.js` (buildExhaustionMessage, resolveActiveFilters)

**Step 1: Write failing test**

Add to `test/unit/agent-brain.test.js`:

```js
const { executeMore } = require('../../src/agent-brain');

describe('executeMore', () => {
  test('returns events from session pool excluding already shown', () => {
    const session = {
      lastPicks: [{ event_id: 'e1' }],
      lastEvents: {
        e1: { id: 'e1', name: 'Event 1', neighborhood: 'Bushwick' },
        e2: { id: 'e2', name: 'Event 2', neighborhood: 'Bushwick' },
        e3: { id: 'e3', name: 'Event 3', neighborhood: 'Bushwick' },
      },
      allOfferedIds: ['e1'],
      allPicks: [{ event_id: 'e1' }],
      lastNeighborhood: 'Bushwick',
      lastFilters: {},
      lastResponseHadPicks: true,
    };
    const result = executeMore(session);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every(e => e.id !== 'e1')).toBe(true);
    expect(result.exhausted).toBe(false);
  });

  test('returns exhaustion metadata when pool is empty', () => {
    const session = {
      lastPicks: [{ event_id: 'e1' }],
      lastEvents: { e1: { id: 'e1', name: 'Event 1', neighborhood: 'Bushwick' } },
      allOfferedIds: ['e1'],
      allPicks: [{ event_id: 'e1' }],
      lastNeighborhood: 'Bushwick',
      lastFilters: {},
      visitedHoods: ['Bushwick'],
    };
    const result = executeMore(session);
    expect(result.events).toEqual([]);
    expect(result.exhausted).toBe(true);
    expect(result.suggestions).toBeDefined();
  });

  test('returns no-context message when no session', () => {
    const result = executeMore(null);
    expect(result.noContext).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/agent-brain.test.js --no-cache`
Expected: FAIL — `executeMore` is not exported.

**Step 3: Implement `executeMore`**

Add to `src/agent-brain.js` (after `executeSearchEvents`, before `executeRespond`):

```js
/**
 * Execute "more" intent: pull unseen events from session pool.
 * Returns event data for Gemini functionResponse continuation.
 * Pure function (no SMS sending, no session saves — caller handles those).
 */
function executeMore(session) {
  if (!session?.lastEvents || !session?.lastPicks?.length) {
    if (!session?.lastNeighborhood && !session?.lastBorough) {
      return { noContext: true };
    }
    return { events: [], exhausted: true, suggestions: [] };
  }

  const allOfferedIds = new Set(session.allOfferedIds || []);
  const allPickIds = new Set((session.allPicks || session.lastPicks || []).map(p => p.event_id));
  const allShownIds = new Set([...allOfferedIds, ...allPickIds]);

  const hood = session.lastNeighborhood;
  const { BOROUGHS } = require('./neighborhoods');
  const boroughHoods = session.lastBorough ? new Set(BOROUGHS[session.lastBorough] || []) : null;

  const allRemaining = Object.values(session.lastEvents).filter(e => !allShownIds.has(e.id));

  const inHoodRemaining = hood
    ? allRemaining.filter(e => e.neighborhood === hood)
    : boroughHoods
      ? allRemaining.filter(e => boroughHoods.has(e.neighborhood))
      : allRemaining;

  // Time gate
  const activeFilters = session.lastFilters || {};
  const { filterByTimeAfter } = require('./geo');
  const timeGated = activeFilters.time_after
    ? filterByTimeAfter(inHoodRemaining, activeFilters.time_after)
    : inHoodRemaining;

  // Name dedup: exclude events whose name matches any previously offered event
  const offeredNames = new Set(
    [...allShownIds].map(id => session.lastEvents[id]?.name?.toLowerCase()).filter(Boolean)
  );
  const nameDeduped = timeGated.filter(e => !offeredNames.has(e.name?.toLowerCase()));
  const pool = nameDeduped.length > 0 ? nameDeduped : timeGated;

  if (pool.length === 0) {
    const { getAdjacentNeighborhoods } = require('./geo');
    const adjHoods = hood ? getAdjacentNeighborhoods(hood, 4) : [];
    const visited = new Set(session.visitedHoods || [hood].filter(Boolean));
    const suggestions = adjHoods.filter(h => !visited.has(h)).slice(0, 3);
    return { events: [], exhausted: true, suggestions, neighborhood: hood };
  }

  const batch = pool.slice(0, 8);
  const isLastBatch = pool.length <= 8;

  let suggestions = [];
  if (isLastBatch && hood) {
    const { getAdjacentNeighborhoods } = require('./geo');
    const adjHoods = getAdjacentNeighborhoods(hood, 3);
    const visited = new Set(session.visitedHoods || []);
    suggestions = adjHoods.filter(h => !visited.has(h)).slice(0, 2);
  }

  return {
    events: batch,
    exhausted: false,
    isLastBatch,
    suggestions,
    neighborhood: hood,
    allShownIds: [...allShownIds],
  };
}
```

Export `executeMore` in the module.exports line.

**Step 4: Run test to verify it passes**

Run: `npx jest test/unit/agent-brain.test.js --no-cache`
Expected: PASS

**Step 5: Wire `executeMore` into `handleAgentBrainRequest`**

In the `search_events` branch of `handleAgentBrainRequest` (~line 1344), add a check for `intent: 'more'` before `buildSearchPool`:

```js
if (brainResult.tool === 'search_events') {
  // "more" intent: pull from session pool instead of fresh search
  if (brainResult.params.intent === 'more') {
    const moreResult = executeMore(session);

    if (moreResult.noContext) {
      const sms = "Tell me what you're in the mood for — comedy, live music, something weird? Or drop a neighborhood.";
      execResult = { sms, intent: 'conversational' };
    } else if (moreResult.exhausted) {
      const suggestText = moreResult.suggestions?.length
        ? ` Try ${moreResult.suggestions[0]}?`
        : ' Try a different neighborhood or vibe.';
      const sms = `That's everything I've got in ${moreResult.neighborhood || 'this area'}.${suggestText}`;
      saveResponseFrame(phone, {
        picks: [], eventMap: session?.lastEvents || {},
        neighborhood: moreResult.neighborhood,
        filters: session?.lastFilters || {},
        offeredIds: [],
        pending: moreResult.suggestions?.[0] ? { neighborhood: moreResult.suggestions[0], filters: session?.lastFilters || {} } : null,
      });
      execResult = { sms, intent: 'more' };
    } else if (brainResult.chat) {
      // Continue Gemini session with more events
      const todayNyc = getNycDateString(0);
      const tomorrowNyc = getNycDateString(1);
      const eventData = {
        neighborhood: moreResult.neighborhood || 'NYC',
        match_count: moreResult.events.length,
        is_last_batch: moreResult.isLastBatch || false,
        suggestions: moreResult.suggestions,
        events: moreResult.events.map(e => ({
          id: e.id, name: (e.name || '').slice(0, 80), venue_name: e.venue_name,
          neighborhood: e.neighborhood,
          day: e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local,
          start_time_local: e.start_time_local,
          is_free: e.is_free, price_display: e.price_display, category: e.category,
          short_detail: (e.short_detail || e.description_short || '').slice(0, 100),
          recurring: e.is_recurring ? e.recurrence_label : undefined,
          venue_size: e.venue_size || undefined,
          source_vibe: e.source_vibe || undefined,
        })),
      };

      try {
        const composeResult = await continueWithResults(brainResult.chat, eventData, trace);
        recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
        trackAICost(phone, composeResult._usage, composeResult._provider);
        trace.composition.raw_response = composeResult._raw || null;
        trace.composition.neighborhood_used = moreResult.neighborhood;

        const eventMap = session?.lastEvents || {};
        const validPicks = validatePicks(composeResult.picks, moreResult.events);

        // Name dedup against previously shown
        const prevPickNames = new Set(
          (session?.allPicks || session?.lastPicks || [])
            .map(p => eventMap[p.event_id]?.name?.toLowerCase())
            .filter(Boolean)
        );
        const dedupedPicks = validPicks.filter(p => {
          const evt = eventMap[p.event_id] || moreResult.events.find(e => e.id === p.event_id);
          return !evt || !prevPickNames.has(evt.name?.toLowerCase());
        });

        trace.composition.picks = dedupedPicks.map(p => {
          const evt = eventMap[p.event_id] || moreResult.events.find(e => e.id === p.event_id);
          return { ...p, event_name: evt?.name || null, venue_name: evt?.venue_name || null,
            neighborhood: evt?.neighborhood || null, category: evt?.category || null };
        });

        saveResponseFrame(phone, {
          mode: 'more', picks: dedupedPicks, prevSession: session,
          eventMap, neighborhood: moreResult.neighborhood,
          filters: session?.lastFilters || {},
          offeredIds: moreResult.events.map(e => e.id),
          pending: moreResult.suggestions?.[0] ? { neighborhood: moreResult.suggestions[0], filters: session?.lastFilters || {} } : null,
        });

        addToHistory(phone, 'tool_result', '', {
          match_count: moreResult.events.length,
          neighborhood: moreResult.neighborhood,
          picks: dedupedPicks.slice(0, 3).map(p => {
            const evt = eventMap[p.event_id] || moreResult.events.find(e => e.id === p.event_id);
            return { name: evt?.name, category: evt?.category };
          }),
        });

        execResult = {
          sms: composeResult.sms_text, intent: 'more',
          picks: dedupedPicks, eventMap,
        };
      } catch (err) {
        console.warn('More continuation failed, falling back to brainCompose:', err.message);
        // Fallback: use brainCompose on the more events
        const composeResult = await brainCompose(moreResult.events, {
          neighborhood: moreResult.neighborhood,
          activeFilters: session?.lastFilters || {},
          excludeIds: moreResult.allShownIds || [],
          matchCount: moreResult.events.length,
          isLastBatch: moreResult.isLastBatch,
        });
        recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
        trackAICost(phone, composeResult._usage, composeResult._provider);

        const eventMap = session?.lastEvents || {};
        const validPicks = validatePicks(composeResult.picks, moreResult.events);
        saveResponseFrame(phone, {
          mode: 'more', picks: validPicks, prevSession: session,
          eventMap, neighborhood: moreResult.neighborhood,
          filters: session?.lastFilters || {},
          offeredIds: moreResult.events.map(e => e.id),
        });

        execResult = { sms: composeResult.sms_text, intent: 'more', picks: validPicks, eventMap };
      }
    } else {
      // Anthropic fallback — use brainCompose
      const composeResult = await brainCompose(moreResult.events, {
        neighborhood: moreResult.neighborhood,
        activeFilters: session?.lastFilters || {},
        excludeIds: moreResult.allShownIds || [],
        matchCount: moreResult.events.length,
      });
      recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
      trackAICost(phone, composeResult._usage, composeResult._provider);

      const eventMap = session?.lastEvents || {};
      const validPicks = validatePicks(composeResult.picks, moreResult.events);
      saveResponseFrame(phone, {
        mode: 'more', picks: validPicks, prevSession: session,
        eventMap, neighborhood: moreResult.neighborhood,
        filters: session?.lastFilters || {},
        offeredIds: moreResult.events.map(e => e.id),
      });

      execResult = { sms: composeResult.sms_text, intent: 'more', picks: validPicks, eventMap };
    }

    // (skip to sendSMS below)
  } else {
    // existing buildSearchPool flow...
```

**Step 6: Run tests**

Run: `npm test`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/agent-brain.js test/unit/agent-brain.test.js
git commit -m "feat: implement executeMore for agent-native more intent"
```

---

### Task 4: Implement `executeDetails` — the "details" intent handler

**Files:**
- Modify: `src/agent-brain.js` (add executeDetails function, wire into handleAgentBrainRequest)
- Reference: `src/intent-handlers.js:80-163` (existing handleDetails logic)

**Step 1: Write failing test**

Add to `test/unit/agent-brain.test.js`:

```js
const { executeDetails } = require('../../src/agent-brain');

describe('executeDetails', () => {
  const session = {
    lastPicks: [
      { event_id: 'e1', why: 'great jazz' },
      { event_id: 'e2', why: 'funny comedy' },
    ],
    lastEvents: {
      e1: { id: 'e1', name: 'Jazz Night', venue_name: 'Blue Note', neighborhood: 'West Village',
        category: 'live_music', start_time_local: '21:30', price_display: '$20', is_free: false,
        description_short: 'Live jazz with rotating musicians', ticket_url: 'https://example.com' },
      e2: { id: 'e2', name: 'Open Mic Comedy', venue_name: 'Tiny Cupboard', neighborhood: 'Bushwick',
        category: 'comedy', start_time_local: '20:00', price_display: 'free', is_free: true,
        description_short: 'Weekly open mic', ticket_url: 'https://example.com/comedy' },
    },
    lastResponseHadPicks: true,
  };

  test('matches by number', () => {
    const result = executeDetails('2', session);
    expect(result.event.id).toBe('e2');
    expect(result.found).toBe(true);
  });

  test('matches by event name (fuzzy)', () => {
    const result = executeDetails('the jazz one', session);
    expect(result.event.id).toBe('e1');
  });

  test('matches by venue name', () => {
    const result = executeDetails('Tiny Cupboard', session);
    expect(result.event.id).toBe('e2');
  });

  test('returns notFound when no match', () => {
    const result = executeDetails('the karaoke show', session);
    expect(result.found).toBe(false);
  });

  test('returns noPicks when no session picks', () => {
    const result = executeDetails('2', { lastPicks: [] });
    expect(result.noPicks).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/agent-brain.test.js --no-cache`
Expected: FAIL — `executeDetails` not exported.

**Step 3: Implement `executeDetails`**

Add to `src/agent-brain.js` (after `executeMore`):

```js
/**
 * Execute "details" intent: match pick_reference against lastPicks.
 * Returns event details for Gemini functionResponse continuation.
 * Pure function — no SMS sending, no session saves.
 */
function executeDetails(pickReference, session) {
  if (!session?.lastPicks?.length || !session?.lastEvents) {
    return { noPicks: true, found: false };
  }

  // Guard: if last response didn't have picks, user is referencing stale list
  if (session.lastResponseHadPicks === false) {
    return { stalePicks: true, found: false, neighborhood: session.lastNeighborhood };
  }

  const picks = session.lastPicks;
  const events = session.lastEvents;
  const ref = (pickReference || '').toString().trim().toLowerCase();

  // 1. Try numeric match
  const num = parseInt(ref, 10);
  if (!isNaN(num) && num >= 1 && num <= picks.length) {
    const pick = picks[num - 1];
    const event = events[pick.event_id];
    if (event) return { found: true, event, pick, pickIndex: num };
  }

  // 2. Try event name match (substring)
  for (let i = 0; i < picks.length; i++) {
    const event = events[picks[i].event_id];
    if (event && event.name && event.name.toLowerCase().includes(ref)) {
      return { found: true, event, pick: picks[i], pickIndex: i + 1 };
    }
  }

  // 3. Try venue name match (substring)
  for (let i = 0; i < picks.length; i++) {
    const event = events[picks[i].event_id];
    if (event && event.venue_name && event.venue_name.toLowerCase().includes(ref)) {
      return { found: true, event, pick: picks[i], pickIndex: i + 1 };
    }
  }

  // 4. Try category match ("the comedy one")
  const categoryWords = ['comedy', 'jazz', 'music', 'trivia', 'film', 'theater', 'art', 'dance', 'dj', 'nightlife'];
  for (const word of categoryWords) {
    if (ref.includes(word)) {
      for (let i = 0; i < picks.length; i++) {
        const event = events[picks[i].event_id];
        if (event && event.category && event.category.toLowerCase().includes(word)) {
          return { found: true, event, pick: picks[i], pickIndex: i + 1 };
        }
      }
    }
  }

  return { found: false };
}
```

Export `executeDetails` in module.exports.

**Step 4: Run test to verify it passes**

Run: `npx jest test/unit/agent-brain.test.js --no-cache`
Expected: PASS

**Step 5: Wire `executeDetails` into `handleAgentBrainRequest`**

In the `search_events` branch, add a check for `intent: 'details'` (alongside the `more` check):

```js
} else if (brainResult.params.intent === 'details') {
  const detailsResult = executeDetails(brainResult.params.pick_reference, session);

  if (detailsResult.noPicks) {
    execResult = { sms: "I don't have any picks loaded — tell me what you're looking for!", intent: 'details' };
  } else if (detailsResult.stalePicks) {
    const hood = detailsResult.neighborhood;
    const sms = hood
      ? `I don't have a pick list up right now — ask for more ${hood} picks, or tell me what you're looking for!`
      : "I don't have a pick list up right now — tell me what you're looking for!";
    execResult = { sms, intent: 'details' };
  } else if (!detailsResult.found) {
    execResult = { sms: "I'm not sure which event you mean — can you be more specific?", intent: 'details' };
  } else if (brainResult.chat) {
    // Continue Gemini session with event details
    const event = detailsResult.event;
    const eventData = {
      intent: 'details',
      event: {
        id: event.id, name: event.name, venue_name: event.venue_name,
        neighborhood: event.neighborhood, category: event.category,
        start_time_local: event.start_time_local, date_local: event.date_local,
        is_free: event.is_free, price_display: event.price_display,
        description: event.description_short || event.short_detail || '',
        ticket_url: event.ticket_url || event.source_url || null,
        venue_address: event.venue_address || null,
        why: detailsResult.pick?.why || '',
      },
    };

    try {
      const composeResult = await continueWithResults(brainResult.chat, eventData, trace);
      recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
      trackAICost(phone, composeResult._usage, composeResult._provider);
      trace.composition.raw_response = composeResult._raw || null;

      execResult = { sms: smartTruncate(composeResult.sms_text), intent: 'details' };
    } catch (err) {
      console.warn('Details continuation failed, falling back to composeDetails:', err.message);
      const { composeDetails } = require('./ai');
      const result = await composeDetails(event, detailsResult.pick?.why);
      recordAICost(trace, 'compose', result._usage, result._provider);
      trackAICost(phone, result._usage, result._provider);
      execResult = { sms: smartTruncate(result.sms_text), intent: 'details' };
    }
  } else {
    // Anthropic fallback — use composeDetails
    const { composeDetails } = require('./ai');
    const event = detailsResult.event;
    const result = await composeDetails(event, detailsResult.pick?.why);
    recordAICost(trace, 'compose', result._usage, result._provider);
    trackAICost(phone, result._usage, result._provider);
    execResult = { sms: smartTruncate(result.sms_text), intent: 'details' };
  }
}
```

**Step 6: Run tests**

Run: `npm test`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/agent-brain.js test/unit/agent-brain.test.js
git commit -m "feat: implement executeDetails for agent-native details intent"
```

---

### Task 5: Update prompts — natural prose, more/details examples

**Files:**
- Modify: `src/agent-brain.js:122-249` (buildBrainSystemPrompt)
- Modify: `src/agent-brain.js:665-687` (BRAIN_COMPOSE_SYSTEM)

**Step 1: Update `buildBrainSystemPrompt`**

Replace the TOOLS, EXAMPLES, and AFTER TOOL EXECUTION sections (lines ~167-249):

```js
TOOLS:
- search_events: User wants events OR wants to interact with previously shown events. Call this for: neighborhoods, categories, time filters, "more" / "what else", detail requests (numbers, event names, "tell me about..."), and anything event-related. When in doubt, prefer search_events over respond.
- respond: ONLY for pure conversational messages with zero event intent: greetings ("hey"), thanks ("thanks!"), farewells ("bye"), or clearly off-topic questions. Write a brief warm SMS (max 480 chars).

INTENT GUIDE for search_events:
- "new_search": First request or starting over
- "refine": Adding/tightening a filter while keeping others (including neighborhood switches)
- "pivot": Explicitly changing what they're looking for ("forget the comedy")
- "more": User wants more picks from the same search ("more", "what else", "next", "keep going")
- "details": User is asking about a specific event from the last batch. Set pick_reference to however they referenced it ("2", "the comedy one", "Tiny Cupboard", "tell me about the DJ set")

EXAMPLES:
- "williamsburg" → search_events(neighborhood: "Williamsburg", intent: "new_search")
- "bushwick" → search_events(neighborhood: "Bushwick", intent: "new_search")
- "LES" → search_events(neighborhood: "Lower East Side", intent: "new_search")
- "brooklyn" → search_events(neighborhood: "Brooklyn", intent: "new_search")
- "what's happening tonight" → search_events(date_range: "today", intent: "new_search")
- "comedy" → search_events(category: "comedy", intent: "new_search")
- "free stuff in greenpoint" → search_events(neighborhood: "Greenpoint", free_only: true, intent: "new_search")
- "cool stuff this weekend" → search_events(date_range: "this_weekend", intent: "new_search")
- "music and trivia" → search_events(categories: ["live_music", "trivia"], intent: "new_search")
- "how about comedy" → search_events(category: "comedy", intent: "refine")
- "try bushwick" (with existing categories) → search_events(neighborhood: "Bushwick", intent: "refine")
- "forget the comedy" → search_events(intent: "pivot")
- "more" → search_events(intent: "more")
- "what else" → search_events(intent: "more")
- "what else you got" → search_events(intent: "more")
- "2" → search_events(intent: "details", pick_reference: "2")
- "tell me about the comedy one" → search_events(intent: "details", pick_reference: "the comedy one")
- "Tiny Cupboard" (when picks are showing) → search_events(intent: "details", pick_reference: "Tiny Cupboard")
- "thanks!" → respond(message: "Enjoy your night! Text me anytime.", intent: "thanks")
- "hey" → respond(message: "Hey! Drop a neighborhood or tell me what you're in the mood for.", intent: "greeting")
- "yes" / "yeah" / "sure" (with pending suggestion) → search_events with the suggested neighborhood
```

Replace the AFTER TOOL EXECUTION / FORMAT section (lines ~224-249):

```js
AFTER TOOL EXECUTION:
When you call search_events and receive event results back, write the SMS response directly as JSON.

COMPOSE RULES:
- Write natural, conversational prose — NOT a numbered list. Weave 1-3 picks into a warm message like a friend texting.
- Example: "Tiny Cupboard's got a free open mic tonight at 8, and there's a killer jazz quartet at Blue Note at 9:30 ($20). Or if you want something weird, there's an immersive art thing in Bushwick at 10. Any of these sound good?"
- Prefer TODAY over tomorrow. Prefer soonest events.
- Favor discovery: big concerts/touring acts are the default — everyone already knows about them. Unless the user asked for music/concerts/shows, deprioritize them. Lead with source_vibe:"discovery" events, intimate venues, interesting one-offs.
- EVERY pick MUST include: event name, venue name, your opinionated take, start time, and price ("$20", "free", "cover")
- Label TODAY as "tonight", TOMORROW as "tomorrow", further out by day name
- [NEARBY] events: mention the actual neighborhood naturally (e.g. "over in Fort Greene")
- If ALL picks are [NEARBY], lead with "Not much in [hood] tonight, but nearby..."
- Under 480 characters total. No URLs.
- Voice: friend texting. Opinionated, concise, warm.
- CONNECT your SMS to what the user originally asked.
- For DETAILS responses: write a rich, opinionated detail message. Include venue address, time, price, URL, and your take. Under 480 chars.
- For MORE responses with is_last_batch=true: mention that these are the last picks and suggest trying a different neighborhood if suggestions are provided. Do NOT say "reply MORE".

Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.
```

**Step 2: Update `BRAIN_COMPOSE_SYSTEM`**

Replace the entire `BRAIN_COMPOSE_SYSTEM` string (~line 665-687):

```js
const BRAIN_COMPOSE_SYSTEM = `You are Pulse, an NYC nightlife SMS bot. Write a short, warm SMS recommending events.

COMPOSE RULES:
- Write natural, conversational prose — NOT a numbered list. Weave 1-3 picks into a warm message like a friend texting.
- Example: "Tiny Cupboard's got a free open mic tonight at 8, and there's a killer jazz quartet at Blue Note at 9:30 ($20). Any of these sound good?"
- Pick 1-3 best events from the provided list. Prefer [MATCH] events first, then others.
- Prefer TODAY over tomorrow. Prefer soonest events.
- Favor discovery: lead with source_vibe:"discovery" events, intimate venues, interesting one-offs. When you see interaction_format:"interactive" + recurring, mention it naturally ("every Tuesday, great for becoming a regular").
- EVERY pick MUST include: event name, venue name, your opinionated take, start time, and price ("$20", "free", "cover")
- Label TODAY as "tonight", TOMORROW as "tomorrow", further out by day name
- [NEARBY] events: mention the actual neighborhood naturally. If ALL picks are [NEARBY], lead with "Not much in [hood] tonight, but nearby..."
- If SPARSE, be honest about slim pickings but still show what's available
- Under 480 characters total. No URLs.
- Voice: friend texting. Opinionated, concise, warm.

Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.`;
```

**Step 3: Run tests**

Run: `npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: update prompts for natural prose and more/details intents"
```

---

### Task 6: Clean up handler.js — simplify `dispatchPreRouterIntent`

**Files:**
- Modify: `src/handler.js:177-253` (dispatchPreRouterIntent)
- Modify: `src/handler.js:298-325` (handleMessageAI)

**Step 1: Simplify `dispatchPreRouterIntent`**

`checkMechanical` now only returns `{ intent: 'help' }` or `null`. Remove the details/more/conversational branches. The function only needs to handle referral and help:

```js
async function dispatchPreRouterIntent(route, ctx) {
  const { phone, session, trace, finalizeTrace } = ctx;

  if (route.intent === 'referral') {
    // ... (keep entire referral block unchanged)
  }

  if (route.intent === 'help') return handleHelp(ctx);
}
```

Remove the `handleConversational`, `handleDetails`, `handleMore` imports from line 6 — only keep `handleHelp`:
```js
const { handleHelp } = require('./intent-handlers');
```

**Step 2: Simplify `handleMessageAI`**

In lines ~316-318, remove the `pendingNearby` cleanup since mechanical handlers no longer set it:
```js
// Delete these lines:
if (session?.pendingNearby) {
  setSession(phone, { pendingNearby: null, pendingFilters: null, pendingMessage: null });
}
```

**Step 3: Run tests**

Run: `npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/handler.js
git commit -m "refactor: simplify handler — only help + referral in mechanical dispatch"
```

---

### Task 7: Update code evals for natural prose

**Files:**
- Modify: `src/evals/code-evals.js:217-241` (pick_count_accuracy)
- Modify: `src/evals/judge-evals.js:34` (numbered format instruction)
- Modify: `src/evals/judge-evals.js:162` (FORMAT criterion)

**Step 1: Update `pick_count_accuracy` eval**

The eval currently counts numbered items (`1)`, `2)`) in SMS and compares to `picks.length`. With natural prose there are no numbered items. Replace with a name-match check:

```js
pick_count_accuracy(trace) {
  const picks = trace.composition.picks || [];
  const sms = trace.output_sms || '';
  const intent = trace.output_intent;
  if (!['events', 'more'].includes(intent) || picks.length === 0) {
    return { name: 'pick_count_accuracy', pass: true, detail: 'not applicable' };
  }
  // Check that each pick's event name appears in the SMS
  let mentioned = 0;
  for (const p of picks) {
    const name = (p.event_name || '').toLowerCase();
    if (name && sms.toLowerCase().includes(name.slice(0, 20))) mentioned++;
  }
  const match = mentioned === picks.length;
  return {
    name: 'pick_count_accuracy',
    pass: match,
    detail: match ? `${picks.length} picks, ${mentioned} mentioned in SMS` : `${picks.length} picks but only ${mentioned} mentioned in SMS`,
  };
},
```

**Step 2: Update judge evals**

In `src/evals/judge-evals.js`:
- Line 34: Change "Bestie uses a numbered pick format" to "Pulse writes picks as natural conversational prose — NOT numbered lists. Judge the VOICE: does each pick sound opinionated and personal, or generic and robotic?"
- Line 162: Change FORMAT criterion from "Correct numbered format?" to "Natural conversational prose? Under 480 chars? Reads like a friend texting?"

**Step 3: Run eval checks**

Run: `npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/evals/code-evals.js src/evals/judge-evals.js
git commit -m "feat: update evals for natural prose format (drop numbered list checks)"
```

---

### Task 8: Clean up dead code in intent-handlers.js

**Files:**
- Modify: `src/intent-handlers.js`

**Step 1: Assess what's still used**

After Phase 4:
- `handleHelp` — still used by handler.js
- `handleConversational` — no longer called (was only from dispatchPreRouterIntent)
- `handleDetails` — no longer called (was from dispatchPreRouterIntent + executeGetDetails)
- `handleMore` — check if still referenced anywhere
- `composeViaBrain` — only used by handleMore
- `sendComposeWithLinks`, `topVibeWord`, `stripMoreReferences` — only used by handleMore

**Step 2: Check for remaining references**

Run: `grep -rn 'handleConversational\|handleDetails\|handleMore\|composeViaBrain\|sendComposeWithLinks\|stripMoreReferences\|topVibeWord' src/ --include='*.js' | grep -v intent-handlers.js | grep -v evals/`

If none of these are referenced outside intent-handlers.js and evals, delete them.

**Step 3: Simplify intent-handlers.js**

Keep only `handleHelp`. Delete everything else. The file becomes:

```js
const { sendSMS } = require('./twilio');
const { saveResponseFrame } = require('./pipeline');

async function handleHelp(ctx) {
  const msg1 = "Hey! I'm Pulse — I dig through the best of what's happening in NYC daily that you'll never find on Google or Instagram alone. Comedy, DJ sets, trivia, indie film, art, late-night weirdness, and more across every neighborhood.";
  const msg2 = 'Text me a neighborhood like "Bushwick" or a vibe like "jazz tonight" to start exploring. I\'ll send picks — just tell me what sounds good for details, or ask for more to keep going.';
  saveResponseFrame(ctx.phone, {
    picks: ctx.session?.lastPicks || [],
    eventMap: ctx.session?.lastEvents || {},
    neighborhood: ctx.session?.lastNeighborhood || null,
    filters: ctx.session?.lastFilters || null,
    offeredIds: ctx.session?.allOfferedIds || [],
    prevSession: ctx.session,
    lastResponseHadPicks: false,
  });
  await sendSMS(ctx.phone, msg1);
  await sendSMS(ctx.phone, msg2);
  console.log(`Help sent to ${ctx.masked}`);
  ctx.finalizeTrace(msg1 + '\n' + msg2, 'help');
}

module.exports = { handleHelp };
```

Note: update help text from "reply a number for details" to "just tell me what sounds good for details" to match the new natural prose model.

**Step 4: Run tests**

Run: `npm test`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/intent-handlers.js
git commit -m "refactor: remove dead intent handlers (details/more/conversational)"
```

---

### Task 9: Update ROADMAP.md and run full eval

**Files:**
- Modify: `ROADMAP.md`

**Step 1: Update ROADMAP.md**

Mark Phase 4 as done in the roadmap:
```
**Phase 4: Agent-Native Details and More** -- **Done (2026-03-0X)**

Moved details and "more" into agent brain as search_events intents. Dropped numbered list formatting for natural prose. Collapsed tools from 3 to 2 (deleted get_details). checkMechanical reduced to help + TCPA only.
```

Update the Current Architecture section to reflect 2 tools instead of 3.

**Step 2: Run full eval suite**

```bash
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js &
# Wait for cache to load
npm run eval
```

Review pass rate. Target: maintain >98% code eval pass rate after updating the pick_count_accuracy check.

**Step 3: Run LLM judge evals on a sample**

```bash
npm run eval:judges -- --concurrency 3 --category search
```

Check that natural prose gets good voice/format scores.

**Step 4: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark Phase 4 complete, update architecture"
```

---

Plan complete and saved to `docs/plans/2026-03-05-phase4-agent-native-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
