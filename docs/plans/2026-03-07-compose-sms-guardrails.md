# Compose SMS Guardrails Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Pre-curate the event pool so the model sees top candidates (not 100 events), add nearby neighborhood highlight signal, and validate compose_sms output — model owns editorial voice, code owns structural constraints.

**Architecture:** Code scores and trims the pool to top N (default 10) by interestingness before the model sees it. Code computes nearby_highlight when a nearby hood is notably stronger. Model writes sms_text and picks 1-3 events. Code validates (480 chars, 1-3 picks) and rebuilds only on failure.

**Tech Stack:** Node.js, existing `scoreInterestingness`/`selectDiversePicks` in events.js, existing `smartTruncate` in formatters.js.

---

### Task 1: Pre-curate pool by interestingness

The model currently sees up to 100 events from `buildTaggedPool`. That's too much noise — it picks 10 and lists them all. Score and trim the pool so the model sees a curated best-of.

**Files:**
- Modify: `src/brain-execute.js:330-348` (after buildTaggedPool, before trace logging)
- Modify: `src/brain-execute.js:408-418` (return object — add full pool for nearby computation)
- Test: `test/unit/brain-execute.test.js`

**Step 1: Write the failing test**

Create `test/unit/brain-execute.test.js`:

```js
const { check } = require('../helpers');
const { curatePool } = require('../../src/brain-execute');

console.log('\ncuratePool:');

const makeEvent = (id, hood, score, cat, opts = {}) => ({
  id, neighborhood: hood, category: cat,
  source_vibe: score >= 5 ? 'discovery' : 'platform',
  is_recurring: score < 3,
  editorial_signal: score >= 7,
  scarcity: score >= 8 ? 'one-night-only' : null,
  venue_size: 'medium',
  interaction_format: null,
  filter_match: opts.filter_match || false,
  ...opts,
});

// Pool of 15 events with varying quality
const pool = [
  makeEvent('e1', 'Greenpoint', 9, 'live_music', { editorial_signal: true, scarcity: 'one-night-only' }),
  makeEvent('e2', 'Greenpoint', 7, 'comedy'),
  makeEvent('e3', 'Greenpoint', 5, 'art'),
  makeEvent('e4', 'Greenpoint', 3, 'dj'),
  makeEvent('e5', 'Greenpoint', 1, 'trivia'),
  makeEvent('e6', 'Williamsburg', 9, 'live_music', { editorial_signal: true, scarcity: 'one-night-only' }),
  makeEvent('e7', 'Williamsburg', 8, 'comedy', { scarcity: 'one-night-only' }),
  makeEvent('e8', 'Williamsburg', 6, 'dj'),
  makeEvent('e9', 'Williamsburg', 4, 'art'),
  makeEvent('e10', 'LES', 5, 'jazz'),
  makeEvent('e11', 'Greenpoint', 2, 'community'),
  makeEvent('e12', 'Greenpoint', 1, 'food_drink'),
  makeEvent('e13', 'Greenpoint', 1, 'nightlife'),
  makeEvent('e14', 'Greenpoint', 0, 'trivia'),
  makeEvent('e15', 'Greenpoint', 0, 'dj'),
];

// Default: top 10
const result = curatePool(pool, 'Greenpoint');
check('default returns 10 or fewer', result.curatedPool.length <= 10);
check('keeps full pool for nearby computation', result.fullScoredPool.length === 15);
check('curated pool is sorted by interestingness', result.curatedPool[0].interestingness >= result.curatedPool[result.curatedPool.length - 1].interestingness);

// Custom limit
const small = curatePool(pool, 'Greenpoint', { poolSize: 5 });
check('custom poolSize=5', small.curatedPool.length <= 5);

// Requested hood events come first, nearby pad the rest
const hoodEvents = result.curatedPool.filter(e => e.neighborhood === 'Greenpoint');
check('requested hood events present', hoodEvents.length >= 1);

// Category diversity
const categories = new Set(result.curatedPool.map(e => e.category));
check('category diversity in curated pool', categories.size >= 3);
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/brain-execute.test.js`
Expected: FAIL — `curatePool` not exported

**Step 3: Write curatePool**

Add to `src/brain-execute.js` before `buildSearchPool`:

```js
const DEFAULT_POOL_SIZE = 10;

/**
 * Score and trim a tagged pool to the top N events by interestingness.
 * Requested hood events are prioritized, with category diversity enforced.
 * Returns both the curated pool (for the model) and full scored pool (for nearby highlight).
 */
function curatePool(pool, requestedHood, { poolSize = DEFAULT_POOL_SIZE } = {}) {
  // Score everything
  const scored = pool.map(e => ({
    ...e,
    interestingness: scoreInterestingness(e),
  }));

  // Split: requested hood vs nearby
  const inHood = scored.filter(e => e.neighborhood === requestedHood);
  const nearby = scored.filter(e => e.neighborhood !== requestedHood);

  // Select top events from requested hood with category diversity
  const hoodPicks = selectDiversePicks(inHood, poolSize);

  // If hood doesn't fill the pool, pad with best nearby
  let curated;
  if (hoodPicks.length >= poolSize) {
    curated = hoodPicks.slice(0, poolSize);
  } else {
    const nearbySorted = [...nearby].sort((a, b) => b.interestingness - a.interestingness);
    curated = [...hoodPicks, ...nearbySorted.slice(0, poolSize - hoodPicks.length)];
  }

  return {
    curatedPool: curated,
    fullScoredPool: scored,
  };
}
```

Also add import at top of brain-execute.js — `selectDiversePicks` from events.js:

```js
const { getEvents, getEventsForBorough, getEventsCitywide, getCacheStatus, scoreInterestingness, selectDiversePicks } = require('./events');
```

**Step 4: Export and run tests**

Add `curatePool` to module.exports. Run: `node test/unit/brain-execute.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/brain-execute.js test/unit/brain-execute.test.js
git commit -m "feat: curatePool — score and trim event pool to top N by interestingness"
```

---

### Task 2: Wire curatePool into buildSearchPool

**Files:**
- Modify: `src/brain-execute.js:331-348` (after buildTaggedPool, before trace logging)

**Step 1: Insert curatePool call after buildTaggedPool**

In `src/brain-execute.js`, after line 333 (`events = taggedResult.pool`), replace the pool with the curated version:

```js
  // 5. Build tagged pool
  const taggedResult = buildTaggedPool(curated, activeFilters, { citywide: isCitywide || isBorough });
  const { matchCount, hardCount, softCount, isSparse } = taggedResult;

  // 5b. Score and trim pool to top N for the model
  const { curatedPool, fullScoredPool } = curatePool(taggedResult.pool, hood, { poolSize: DEFAULT_POOL_SIZE });
  events = curatedPool;
```

Update the return object (around line 408) to include `fullScoredPool` for nearby highlight computation:

```js
  return {
    zeroMatch: null,
    pool: events,          // curated pool (top N) — sent to model
    fullScoredPool,        // full scored pool — used for nearby highlight
    curated: curated,      // raw candidates before tagging
    activeFilters,
    hood, borough, isBorough, isCitywide,
    matchCount, hardCount, softCount, isSparse,
    nearbyHoods,
    suggestedHood,
    excludeIds,
  };
```

**Step 2: Run full tests**

Run: `npm test`
Expected: all pass. Trace logging still works (sent_to_claude will now be ~10 instead of ~100).

**Step 3: Commit**

```bash
git add src/brain-execute.js
git commit -m "feat: wire curatePool into buildSearchPool — model sees top 10 not top 100"
```

---

### Task 3: Compute nearby neighborhood highlight

**Files:**
- Modify: `src/brain-execute.js` (new function + wire into buildSearchPool return)
- Test: `test/unit/brain-execute.test.js`

**Step 1: Write the failing test**

Add to `test/unit/brain-execute.test.js`:

```js
// ---- computeNearbyHighlight ----
console.log('\ncomputeNearbyHighlight:');

const { computeNearbyHighlight } = require('../../src/brain-execute');

const reqEvents = [
  { neighborhood: 'Greenpoint', interestingness: 3 },
  { neighborhood: 'Greenpoint', interestingness: 2 },
  { neighborhood: 'Greenpoint', interestingness: 1 },
];
const nearbyEvts = [
  { id: 'n1', name: 'MAYHEM Ball', venue_name: '3 Dollar Bill', neighborhood: 'Williamsburg', interestingness: 9, editorial_signal: true, scarcity: 'one-night-only' },
  { id: 'n2', name: 'Sofar Sounds', venue_name: 'Secret Location', neighborhood: 'Williamsburg', interestingness: 7, scarcity: 'one-night-only' },
  { id: 'n3', name: 'Some DJ Night', venue_name: 'Elsewhere', neighborhood: 'Williamsburg', interestingness: 6 },
];

const hl = computeNearbyHighlight(reqEvents, nearbyEvts, 'Greenpoint');
check('highlight present when nearby is stronger', hl !== null);
check('highlight hood is Williamsburg', hl.hood === 'Williamsburg');
check('highlight has top_pick', hl.top_pick.includes('MAYHEM'));
check('highlight has reason', hl.reason.length > 0);

// No highlight when requested hood is strong
const strongReq = [
  { neighborhood: 'Greenpoint', interestingness: 9 },
  { neighborhood: 'Greenpoint', interestingness: 8 },
  { neighborhood: 'Greenpoint', interestingness: 7 },
];
const weakNearby = [{ neighborhood: 'Williamsburg', interestingness: 2 }];
check('no highlight when requested is stronger', computeNearbyHighlight(strongReq, weakNearby, 'Greenpoint') === null);
check('no highlight with empty nearby', computeNearbyHighlight(reqEvents, [], 'Greenpoint') === null);
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/brain-execute.test.js`
Expected: FAIL — `computeNearbyHighlight` not exported

**Step 3: Write computeNearbyHighlight**

Add to `src/brain-execute.js`:

```js
/**
 * Compare interestingness of requested hood vs nearby hoods.
 * Returns a highlight object if a nearby hood is notably stronger, null otherwise.
 */
function computeNearbyHighlight(requestedEvents, nearbyEvents, requestedHood) {
  if (!nearbyEvents || nearbyEvents.length === 0) return null;

  const reqScores = requestedEvents
    .filter(e => e.neighborhood === requestedHood)
    .map(e => e.interestingness || 0)
    .sort((a, b) => b - a)
    .slice(0, 3);
  const reqAvg = reqScores.length > 0 ? reqScores.reduce((a, b) => a + b, 0) / reqScores.length : 0;

  const byHood = {};
  for (const e of nearbyEvents) {
    if (e.neighborhood === requestedHood) continue;
    if (!byHood[e.neighborhood]) byHood[e.neighborhood] = [];
    byHood[e.neighborhood].push(e);
  }

  let bestHood = null;
  let bestAvg = 0;
  let bestEvents = [];
  for (const [hood, events] of Object.entries(byHood)) {
    const scores = events.map(e => e.interestingness || 0).sort((a, b) => b - a).slice(0, 3);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestHood = hood;
      bestEvents = events.sort((a, b) => (b.interestingness || 0) - (a.interestingness || 0));
    }
  }

  // Only highlight if nearby is notably stronger (50%+ higher avg, minimum 3 point gap)
  if (!bestHood || bestAvg < reqAvg * 1.5 || bestAvg - reqAvg < 3) return null;

  const topPick = bestEvents[0];
  const scarcityCount = bestEvents.filter(e => e.scarcity).length;
  const editorialCount = bestEvents.filter(e => e.editorial_signal).length;

  const reasons = [];
  if (scarcityCount > 0) reasons.push(`${scarcityCount} one-night-only event${scarcityCount > 1 ? 's' : ''}`);
  if (editorialCount > 0) reasons.push(`${editorialCount} editor's pick${editorialCount > 1 ? 's' : ''}`);
  if (reasons.length === 0) reasons.push('stronger lineup tonight');

  return {
    hood: bestHood,
    reason: reasons.join(', '),
    top_pick: `${topPick.name} at ${topPick.venue_name}`,
  };
}
```

**Step 4: Export and run tests**

Add `computeNearbyHighlight` to module.exports. Run: `node test/unit/brain-execute.test.js`
Expected: PASS

**Step 5: Wire into buildSearchPool return**

After the `curatePool` call (added in Task 2), compute the nearby highlight from the full scored pool:

```js
  // 5c. Compute nearby highlight from full pool (before trimming)
  const reqPoolEvents = fullScoredPool.filter(e => e.neighborhood === hood);
  const nearbyPoolEvents = fullScoredPool.filter(e => e.neighborhood !== hood);
  const nearbyHighlight = hood ? computeNearbyHighlight(reqPoolEvents, nearbyPoolEvents, hood) : null;
```

Add `nearbyHighlight` to the return object.

**Step 6: Run full tests**

Run: `npm test`
Expected: all pass

**Step 7: Commit**

```bash
git add src/brain-execute.js test/unit/brain-execute.test.js
git commit -m "feat: computeNearbyHighlight — tease nearby hoods when they're stronger"
```

---

### Task 4: Add nearby_highlight to pool serializer

**Files:**
- Modify: `src/brain-llm.js:197-234` (serializePoolForContinuation)

**Step 1: Pass nearby_highlight through to model**

In `src/brain-llm.js`, update `serializePoolForContinuation` to destructure `nearbyHighlight` from poolResult (line 200) and add it to the return object (line 225):

```js
  const { pool, hood: neighborhood, activeFilters, isSparse, matchCount,
          nearbyHoods, suggestedHood, excludeIds, isCitywide, isBorough, borough,
          nearbyHighlight } = poolResult;

  // ... existing code ...

  return {
    neighborhood: hoodLabel,
    filter: filterDesc || undefined,
    match_count: matchCount,
    sparse: isSparse || undefined,
    nearby_hoods: isSparse ? nearbyHoods : undefined,
    suggested_neighborhood: suggestedHood || undefined,
    exclude_ids: excludeIds?.length > 0 ? excludeIds : undefined,
    nearby_highlight: nearbyHighlight || undefined,
    events,
  };
```

**Step 2: Run full tests**

Run: `npm test`
Expected: all pass

**Step 3: Commit**

```bash
git add src/brain-llm.js
git commit -m "feat: serialize nearby_highlight in pool data for model"
```

---

### Task 5: Update prompt — nearby tease, pick count, no prices

**Files:**
- Modify: `src/brain-llm.js:164-189` (buildBrainSystemPrompt SMS FORMAT section)

**Step 1: Finalize SMS FORMAT section**

The prompt was partially updated earlier in this session. Verify and finalize the full SMS FORMAT block in `buildBrainSystemPrompt`:

```
SMS FORMAT:
- Pick 1-3 events. Be opinionated — recommend the best, don't list everything.
- Each pick on its own line: Event Name — Venue, time. Add a few words about what it actually is if the name doesn't make it obvious (e.g. "live jazz trio", "standup showcase", "indie DJ night").
- Don't include price in the initial picks — save that for details. Never write "price not listed" or "TBA".
- Say "tonight" for today evening, "today at [time]" for afternoon. "tomorrow" for tomorrow.
- ALWAYS lead with events in the neighborhood the user asked about, even if there are only 1-2. Then you can add nearby options: "Also in nearby Williamsburg..." Only say a neighborhood is quiet if there are literally zero events there.
- If the search results include a nearby_highlight, consider teasing that neighborhood in a closing line. Keep it natural — "Williamsburg's stacked tonight too" not "nearby_highlight detected."
- HARD LIMIT: 480 characters total. No URLs. If your message is over 480 chars, cut picks — never send a truncated message.
- For details: write a rich description with venue, time, price. No URL (sent separately).
- For more with is_last_batch=true: mention these are the last picks, suggest a different neighborhood.
```

**Step 2: Run full tests**

Run: `npm test`
Expected: all pass

**Step 3: Commit**

```bash
git add src/brain-llm.js
git commit -m "feat: finalize prompt — 1-3 picks, describe events, tease nearby, no prices"
```

---

### Task 6: Validate compose_sms output in agent-loop.js

**Files:**
- Modify: `src/agent-loop.js:452-481` (SMS determination block)
- Test: `test/unit/agent-loop.test.js`

**Step 1: Write the failing test**

Add to `test/unit/agent-loop.test.js`:

```js
// ---- validateComposeSms ----
console.log('\nvalidateComposeSms:');

const { validateComposeSms } = require('../../src/agent-loop');

const goodPool = [
  { id: 'e1', name: 'Jazz Night', venue_name: 'Blue Note', neighborhood: 'Greenwich Village', start_time_local: '2026-03-07T22:00:00', is_free: false, price_display: '$20', category: 'jazz' },
  { id: 'e2', name: 'Comedy Hour', venue_name: 'Tiny Cupboard', neighborhood: 'LES', start_time_local: '2026-03-07T21:00:00', is_free: true, price_display: null, category: 'comedy' },
  { id: 'e3', name: 'Art Opening', venue_name: 'Pioneer Works', neighborhood: 'Red Hook', start_time_local: '2026-03-07T19:00:00', is_free: true, price_display: null, category: 'art' },
];

// Good SMS passes through unchanged
const good = validateComposeSms('Tonight in GP:\n\nJazz Night — Blue Note, 10pm\nComedy Hour — Tiny Cupboard, 9pm', ['e1', 'e2'], goodPool);
check('valid SMS passes through', good.smsText.includes('Jazz Night'));
check('valid SMS not rebuilt', good.rebuilt === false);

// Over 480 chars triggers rebuild
const longText = 'x'.repeat(500);
const rebuilt = validateComposeSms(longText, ['e1', 'e2', 'e3'], goodPool);
check('over 480 triggers rebuild', rebuilt.rebuilt === true);
check('rebuilt SMS under 480', rebuilt.smsText.length <= 480);

// Over 3 picks triggers rebuild
const tooMany = validateComposeSms('lots of picks', ['e1', 'e2', 'e3', 'e4'], goodPool);
check('>3 picks triggers rebuild', tooMany.rebuilt === true);

// Empty picks triggers rebuild
const noPicks = validateComposeSms('no picks here', [], goodPool);
check('0 picks triggers rebuild', noPicks.rebuilt === true);
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/agent-loop.test.js`
Expected: FAIL — `validateComposeSms` not exported

**Step 3: Write validateComposeSms**

Add to `src/agent-loop.js` before `handleAgentRequest`:

```js
/**
 * Validate compose_sms output. If sms_text > 480 chars or picks outside 1-3,
 * rebuild from pool events. Model owns editorial voice; this is the safety net.
 */
function validateComposeSms(smsText, pickIds, pool) {
  const valid = smsText && smsText.length <= 480 && pickIds.length >= 1 && pickIds.length <= 3;
  if (valid) return { smsText, picks: pickIds, rebuilt: false };

  console.warn(`[agent-loop] compose_sms validation failed: ${smsText?.length || 0} chars, ${pickIds.length} picks — rebuilding`);

  const useIds = pickIds.slice(0, 3);
  const poolMap = new Map(pool.map(e => [e.id, e]));
  let events = useIds.map(id => poolMap.get(id)).filter(Boolean);
  if (events.length === 0) events = pool.slice(0, 3);

  const lines = events.map(e => {
    const time = e.start_time_local
      ? new Date(e.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
      : 'tonight';
    return `${e.name} — ${e.venue_name}, ${time}`;
  });
  const hood = events[0]?.neighborhood || 'NYC';
  const rebuilt = `Tonight in ${hood}:\n\n${lines.join('\n')}\n\nReply a number for details or "more" for more picks`;

  return {
    smsText: smartTruncate(rebuilt),
    picks: events.map(e => e.id),
    rebuilt: true,
  };
}
```

**Step 4: Export and run tests**

Add `validateComposeSms` to module.exports. Run: `node test/unit/agent-loop.test.js`
Expected: PASS

**Step 5: Wire into handleAgentRequest**

In `src/agent-loop.js` around line 457, replace:

```js
// Before:
if (lastCompose) {
  smsText = lastCompose.params.sms_text;

// After:
if (lastCompose) {
  const lastSearch = [...rawResults].reverse().find(tc => tc.name === 'search_events');
  const pool = lastSearch?.result?._poolResult?.pool || [];
  const validated = validateComposeSms(lastCompose.params.sms_text, lastCompose.params.picks || [], pool);
  smsText = validated.smsText;
  if (validated.rebuilt) {
    trace.composition.rebuilt = true;
    lastCompose.params.picks = validated.picks;
  }
```

**Step 6: Update the existing MALFORMED_FUNCTION_CALL fallback** (line 466-480)

Drop prices from template fallback to match new format:

```js
    if (!smsText) {
      const lastSearchFb = [...rawResults].reverse().find(tc => tc.name === 'search_events');
      const pool = lastSearchFb?.result?._poolResult?.pool;
      if (pool?.length > 0) {
        const top3 = pool.slice(0, 3);
        const hood = lastSearchFb.result?._poolResult?.hood || 'NYC';
        const lines = top3.map(e => {
          const time = e.start_time_local
            ? new Date(e.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
            : 'tonight';
          return `${e.name} — ${e.venue_name}, ${time}`;
        });
        smsText = `Tonight in ${hood}:\n\n${lines.join('\n')}\n\nReply a number for details or "more" for more picks`;
        console.warn(`[agent-loop] Used template fallback for SMS composition`);
      }
    }
```

**Step 7: Run full tests**

Run: `npm test`
Expected: all pass

**Step 8: Commit**

```bash
git add src/agent-loop.js test/unit/agent-loop.test.js
git commit -m "feat: validate compose_sms — rebuild on >480 chars or >3 picks, update fallback"
```

---

### Task 7: End-to-end verification on Railway

**Step 1: Deploy**

Run: `railway up`
Wait ~2-3 min for build.

**Step 2: Test in simulator**

Send "greenpoint" in the simulator. Verify:
- 1-3 picks (not 10)
- No "price not listed"
- Event descriptions when names are unclear
- Under 480 chars, no truncation
- If Williamsburg is stronger, a tease line appears

**Step 3: Check traces**

Look at the trace for the test message:
- `events.sent_to_claude` should be ~10 (not 100)
- `brain_tool_calls` should show `compose_sms` with 1-3 picks
- `composition.rebuilt` should be absent (model got it right) or `true` (validation caught it)

**Step 4: Run scenario evals**

Run: `node scripts/run-scenario-evals.js --url https://web-production-c8fdb.up.railway.app`
Verify code eval pass rate holds or improves.

**Step 5: Experiment with pool size**

If picks feel too narrow, try `DEFAULT_POOL_SIZE = 15` or `20` in brain-execute.js and redeploy. The constant is in one place — easy to tune.
