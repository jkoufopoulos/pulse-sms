# Model-Composed Details Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the model resolve pick references and compose details responses instead of code-based substring matching.

**Architecture:** Remove `executeDetails` from the hot path. When intent is "details", return the full event data for `lastPicks` to the model. The model resolves which event the user means and composes a rich details response. URL sending uses `extractPicksFromSms` against `lastEvents` to find the detailed event.

**Tech Stack:** Node.js, existing agent loop infrastructure

---

### Task 1: Write failing test for new executeTool details behavior

**Files:**
- Modify: `test/unit/agent-loop.test.js`

**Step 1: Add test for executeTool returning event data instead of composed SMS**

Add at end of file:

```js
// ---- executeTool details returns event data for model ----
console.log('\nexecuteTool details returns event data:');

const { executeTool } = require('../../src/agent-loop');

const detailsSession = {
  lastPicks: [
    { rank: 1, event_id: 'e1' },
    { rank: 2, event_id: 'e2' },
  ],
  lastEvents: {
    e1: { id: 'e1', name: 'Jazz Night', venue_name: 'Blue Note', category: 'jazz', neighborhood: 'Greenwich Village', start_time_local: '2026-03-08T22:00:00', is_free: false, price_display: '$20', description_short: 'Weekly jazz jam session' },
    e2: { id: 'e2', name: 'Comedy Hour', venue_name: 'Tiny Cupboard', category: 'comedy', neighborhood: 'LES', start_time_local: '2026-03-08T21:00:00', is_free: true, description_short: 'Open mic comedy night' },
  },
  lastResponseHadPicks: undefined,
};
const dummyTrace = { events: {}, composition: {} };

// Returns event data (not _smsText)
const detResult = await executeTool('search_events', { intent: 'details', pick_reference: 'jazz' }, detailsSession, '+1234', dummyTrace);
check('details returns events array', Array.isArray(detResult.events));
check('details returns pick_reference', detResult.pick_reference === 'jazz');
check('details events have full data', detResult.events[0].description_short !== undefined);
check('details does NOT return _smsText', detResult._smsText === undefined);

// No picks returns not_found
const noPickResult = await executeTool('search_events', { intent: 'details', pick_reference: '1' }, { lastPicks: [] }, '+1234', dummyTrace);
check('details no picks returns not_found', noPickResult.not_found === true);

// Stale picks returns stale
const staleSession = { ...detailsSession, lastResponseHadPicks: false, lastNeighborhood: 'Bushwick' };
const staleResult = await executeTool('search_events', { intent: 'details', pick_reference: '1' }, staleSession, '+1234', dummyTrace);
check('details stale returns stale', staleResult.stale === true);
```

**Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E 'FAIL|details returns'`
Expected: FAIL — current executeTool returns `_smsText`, not `events` array

**Step 3: Commit**

```bash
git add test/unit/agent-loop.test.js
git commit -m "test: add failing tests for model-composed details"
```

---

### Task 2: Rewrite executeTool details path

**Files:**
- Modify: `src/agent-loop.js:259-307`

**Step 1: Replace the details block in executeTool**

Replace the entire `if (params.intent === 'details')` block (lines 259-307) with:

```js
    // --- Details intent: return event data for model to compose ---
    if (params.intent === 'details') {
      if (!session?.lastPicks?.length || !session?.lastEvents) {
        return {
          not_found: true,
          message: "I don't have any picks loaded -- tell me what you're looking for!",
        };
      }

      if (session.lastResponseHadPicks === false) {
        const hood = session.lastNeighborhood;
        return {
          stale: true,
          message: hood
            ? `I don't have a pick list up right now -- ask for more ${hood} picks, or tell me what you're looking for!`
            : "I don't have a pick list up right now -- tell me what you're looking for!",
        };
      }

      // Return full event data for all lastPicks — model resolves the reference
      const events = session.lastPicks.map(p => {
        const e = session.lastEvents[p.event_id];
        if (!e) return null;
        return {
          id: e.id, name: cleanEventName((e.name || '').slice(0, 80)),
          venue_name: e.venue_name, neighborhood: e.neighborhood,
          start_time_local: e.start_time_local, category: e.category,
          is_free: e.is_free, price_display: e.price_display,
          description_short: e.description_short || e.short_detail || '',
          recurring: e.is_recurring ? e.recurrence_label : undefined,
        };
      }).filter(Boolean);

      return {
        pick_reference: params.pick_reference,
        events,
        message: `The user wants details about "${params.pick_reference || 'a pick'}". Here are the picks you showed them. Identify which one they mean and compose a rich details response with venue, time, price, and description. If you can't tell which one, ask them to clarify.`,
      };
    }
```

**Step 2: Run tests**

Run: `npm test`
Expected: All tests pass including new details tests

**Step 3: Commit**

```bash
git add src/agent-loop.js
git commit -m "feat: return event data to model for details instead of code matching"
```

---

### Task 3: Update URL sending for model-composed details

**Files:**
- Modify: `src/agent-loop.js:604-611`

**Step 1: Replace the URL sending block**

The old code relied on `_detailsResult.event`. Now the model composes the response, so we extract the mentioned event from the SMS text using `extractPicksFromSms` against `lastEvents`.

Replace lines 604-611:

```js
    // Send pick URLs for details
    if (intent === 'details' && lastSearch) {
      const detailEvents = Object.values(session?.lastEvents || {});
      const detailPicks = extractPicksFromSms(smsText, detailEvents);
      if (detailPicks.length > 0) {
        const eventMap = session?.lastEvents || {};
        await sendPickUrls(phone, detailPicks.slice(0, 1), eventMap);
      }
    }
```

**Step 2: Run tests**

Run: `npm test`
Expected: All pass

**Step 3: Commit**

```bash
git add src/agent-loop.js
git commit -m "fix: URL sending for model-composed details uses SMS extraction"
```

---

### Task 4: Update system prompt for details composition

**Files:**
- Modify: `src/brain-llm.js:171-176`

**Step 1: Update the TOOL FLOW section**

Replace the details example block (lines 171-176) with:

```
- User asks about a pick you showed: call search_events({intent: "details", pick_reference: "the free show"}). You'll get back the full event data for your recent picks. Figure out which one the user means and write a rich details response — venue, time, price, description. If you can't tell which one they mean, ask them to clarify.
```

And replace the existing example block (lines 173-176):

```
Example — user says "tell me about the puma thing" after you showed Puma Blue and Salon Open Stage:
→ search_events({intent: "details", pick_reference: "the puma thing"})
You'll see the event data — identify Puma Blue as the match and compose details.
NOT respond — that loses the event context.
```

**Step 2: Run tests**

Run: `npm test`
Expected: All pass (prompt tests don't check exact wording)

**Step 3: Commit**

```bash
git add src/brain-llm.js
git commit -m "docs: update system prompt for model-composed details"
```

---

### Task 5: Verify with existing tests and clean up

**Files:**
- Modify: `test/unit/agent-brain.test.js` (verify executeDetails tests still pass — they test the function directly, which still exists)

**Step 1: Run full test suite**

Run: `npm test`
Expected: All pass. `executeDetails` tests in agent-brain.test.js still pass because the function still exists in brain-execute.js — it's just no longer called from the hot path.

**Step 2: Run eval suite (code evals only, no judge)**

Run: `node scripts/run-scenario-evals.js --url http://localhost:3000 --category details 2>&1 | tail -20`
Expected: Details scenarios should pass with model-composed responses.

**Step 3: Commit if any test adjustments were needed**

```bash
git add -A
git commit -m "chore: clean up after model-composed details migration"
```
