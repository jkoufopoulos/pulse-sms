# Pick Reasoning Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make it easy to answer "why did the agent pick these events out of ~3k?" by enriching traces with pool scores, exclusion reasons, and LLM reasoning at each narrowing stage.

**Architecture:** Three changes — (1) add interestingness scores to `sent_pool` in traces, (2) add `reasoning` field to LLM compose schema so the model explains its selection logic, (3) surface both in the existing eval-ui trace detail view. No new dashboards or APIs.

**Tech Stack:** Node.js, existing trace system, Gemini Flash Lite compose schema.

---

### Task 1: Add interestingness scores to trace `sent_pool`

**Files:**
- Modify: `src/brain-execute.js:340-346` (search pool sent_pool)
- Modify: `src/brain-execute.js:508-513` (welcome sent_pool)
- Modify: `src/events.js` (export `scoreInterestingness`)

**Step 1: Export scoreInterestingness from events.js**

In `src/events.js`, find the `module.exports` and add `scoreInterestingness` to it.

**Step 2: Run tests to verify nothing breaks**

Run: `npm test`
Expected: All existing tests pass. `scoreInterestingness` is already tested in `test/unit/events.test.js`.

**Step 3: Add interestingness score to sent_pool in buildSearchPool**

In `src/brain-execute.js:340-346`, add `interestingness` to each event in `sent_pool`:

```js
const { scoreInterestingness } = require('./events');

// In buildSearchPool, replace the sent_pool mapping:
trace.events.sent_pool = events.map(e => ({
  id: e.id, name: e.name, venue_name: e.venue_name, neighborhood: e.neighborhood,
  category: e.category, start_time_local: e.start_time_local, date_local: e.date_local,
  is_free: e.is_free, price_display: e.price_display, source_name: e.source_name,
  filter_match: e.filter_match, ticket_url: e.ticket_url || null,
  source_vibe: e.source_vibe || null,
  interestingness: scoreInterestingness(e),
}));
```

**Step 4: Add interestingness score to welcome sent_pool in handleWelcome**

In `src/brain-execute.js:508-513`, the welcome flow already has `interestingness` in sent_pool. Verify it's there — it should already be included since `getTopPicks` adds it. No change needed if already present.

**Step 5: Run tests**

Run: `npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/brain-execute.js src/events.js
git commit -m "feat: add interestingness scores to trace sent_pool"
```

---

### Task 2: Add `reasoning` field to LLM compose response schema

**Files:**
- Modify: `src/brain-llm.js:196-200` (brain system prompt compose rules — JSON return spec)
- Modify: `src/brain-llm.js:348-351` (BRAIN_COMPOSE_SYSTEM — JSON return spec)
- Modify: `src/brain-llm.js:353-368` (BRAIN_COMPOSE_SCHEMA)
- Modify: `src/brain-llm.js:396-398` (WELCOME_COMPOSE_SYSTEM — JSON return spec)

**Step 1: Add reasoning to BRAIN_COMPOSE_SCHEMA**

In `src/brain-llm.js:353-368`, add `reasoning` to the schema:

```js
const BRAIN_COMPOSE_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    sms_text: { type: 'string' },
    picks: { type: 'array', items: {
      type: 'object',
      properties: {
        rank: { type: 'integer' },
        event_id: { type: 'string' },
        why: { type: 'string' },
      },
      required: ['rank', 'event_id', 'why'],
    }},
  },
  required: ['reasoning', 'sms_text', 'picks'],
};
```

**Step 2: Add reasoning instruction to BRAIN_COMPOSE_SYSTEM**

In `src/brain-llm.js:348-351`, update the JSON return spec at the end of `BRAIN_COMPOSE_SYSTEM`:

Change:
```
Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.
```

To:
```
Return JSON: { "reasoning": "2-3 sentences on why you chose these picks over the others in the pool. What made the winners stand out? What did you skip and why?", "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.
```

**Step 3: Add reasoning instruction to the brain system prompt**

In `src/brain-llm.js:196-200`, same change to the `buildBrainSystemPrompt` return spec:

Change:
```
Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.
```

To:
```
Return JSON: { "reasoning": "2-3 sentences on why you chose these picks over the others in the pool. What made the winners stand out? What did you skip and why?", "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.
```

**Step 4: Add reasoning instruction to WELCOME_COMPOSE_SYSTEM**

In `src/brain-llm.js:396-398`, same change:

Change:
```
Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id", "why": "short reason"}] }
```

To:
```
Return JSON: { "reasoning": "2-3 sentences on why you chose these 3 over the others. What made the winners stand out? What did you skip and why?", "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id", "why": "short reason"}] }
```

**Step 5: Run tests**

Run: `npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/brain-llm.js
git commit -m "feat: add reasoning field to LLM compose response schema"
```

---

### Task 3: Capture reasoning in traces

**Files:**
- Modify: `src/traces.js:56` (add `reasoning` to composition init)
- Modify: `src/agent-brain.js` (capture reasoning from compose results)
- Modify: `src/brain-llm.js` (pass reasoning through from parsed response)

**Step 1: Add reasoning field to trace composition init**

In `src/traces.js:56`, add `reasoning: null`:

```js
composition: { raw_response: null, latency_ms: 0, picks: null, not_picked_reason: null, neighborhood_used: null, reasoning: null },
```

**Step 2: Pass reasoning through in continueWithResults**

In `src/brain-llm.js`, in the `continueWithResults` function (~line 275-284), add `reasoning` to the return object:

```js
return {
  sms_text: sms,
  picks: reconcilePicks(sms, parsed.picks || []),
  reasoning: parsed.reasoning || null,
  _raw: result.text,
  _usage: result.usage,
  _provider: result.provider,
};
```

**Step 3: Pass reasoning through in brainCompose**

In `src/brain-llm.js`, in `brainCompose` (~line 462-464 and ~470-472), add `reasoning` to both return paths:

```js
return { sms_text: sms, picks: reconcilePicks(sms, parsed.picks || []), reasoning: parsed.reasoning || null, _raw: result.text, _usage: result.usage, _provider: result.provider };
```

**Step 4: Pass reasoning through in welcomeCompose**

In `src/brain-llm.js`, in `welcomeCompose` (~line 500-501 and ~507-508), add `reasoning` to both return paths:

```js
return { sms_text: sms, picks: parsed.picks || [], reasoning: parsed.reasoning || null, _raw: result.text, _usage: result.usage, _provider: result.provider };
```

**Step 5: Capture reasoning on trace in agent-brain.js**

In `src/agent-brain.js`, after each `continueWithResults` call, capture reasoning. There are three places:

1. Search events path (~line 355): After `const composeResult = await continueWithResults(...)`:
   ```js
   trace.composition.reasoning = composeResult.reasoning || null;
   ```

2. More path (~line 178): After `const composeResult = await continueWithResults(...)`:
   ```js
   trace.composition.reasoning = composeResult.reasoning || null;
   ```

3. Details path (~line 316): After `const composeResult = await continueWithResults(...)`:
   ```js
   trace.composition.reasoning = composeResult.reasoning || null;
   ```

Also capture from brainCompose fallbacks — there are several. Search for `brainCompose(` calls in agent-brain.js and brain-execute.js:

4. In `src/brain-execute.js:executeSearchEvents` (~line 407):
   ```js
   trace.composition.reasoning = result.reasoning || null;
   ```

5. In `src/agent-brain.js` more-brainCompose fallback (~line 228):
   ```js
   trace.composition.reasoning = composed.reasoning || null;
   ```

6. Welcome path in `src/brain-execute.js:handleWelcome` (~line 522):
   ```js
   trace.composition.reasoning = result.reasoning || null;
   ```

**Step 6: Run tests**

Run: `npm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/traces.js src/agent-brain.js src/brain-llm.js src/brain-execute.js
git commit -m "feat: capture LLM pick reasoning in traces"
```

---

### Task 4: Surface reasoning and scores in eval-ui trace detail

**Files:**
- Modify: `src/eval-ui.html` (trace detail panel)

**Step 1: Add reasoning display to trace detail panel**

In `src/eval-ui.html`, find the picks section rendering (~line 1455-1494). After the picks table, before the not-picked section, add a reasoning block:

```js
// Reasoning
const reasoningEl = document.getElementById('td-reasoning');
const reasoningSection = document.getElementById('td-reasoning-section');
const reasoning = t.composition?.reasoning;
if (reasoning) {
  reasoningSection.style.display = 'block';
  reasoningEl.textContent = reasoning;
} else {
  reasoningSection.style.display = 'none';
}
```

Add the corresponding HTML section near the picks section in the trace detail panel (~line 668):

```html
<div id="td-reasoning-section" style="display:none">
  <h4>Pick Reasoning</h4>
  <p id="td-reasoning" style="color:#ccc; font-style:italic; white-space:pre-wrap;"></p>
</div>
```

**Step 2: Add interestingness score column to not-picked table**

In `src/eval-ui.html:1505-1519`, update the not-picked table to include interestingness and source_vibe:

Change the table header:
```html
<thead><tr><th>Name</th><th>Venue</th><th>Time</th><th>Category</th><th>Vibe</th><th>Score</th><th>Match</th></tr></thead>
```

Add vibe and score columns to each row:
```js
const vibe = e.source_vibe || '';
const score = e.interestingness != null ? e.interestingness : '';
return `<tr>
  <td>${esc(e.name || e.id)}</td>
  <td>${esc(e.venue_name || '')}</td>
  <td>${esc(e.start_time_local || '')}</td>
  <td>${esc(e.category || '')}</td>
  <td>${esc(vibe)}</td>
  <td>${score}</td>
  <td>${matchHtml}</td>
</tr>`;
```

**Step 3: Add interestingness to picks table too**

In `src/eval-ui.html:1467-1484`, add score column to picks table:

Header: add `<th>Score</th>` after `<th>Why</th>`.

Row: add score lookup:
```js
const score = poolEvt?.interestingness != null ? poolEvt.interestingness : '';
// Add <td>${score}</td> after the why column
```

**Step 4: Sort not-picked table by interestingness descending**

Before rendering, sort the `notPicked` array:
```js
const notPicked = sentPool.filter(e => !pickedIds.has(e.id))
  .sort((a, b) => (b.interestingness ?? -99) - (a.interestingness ?? -99));
```

This makes it immediately obvious which high-scoring events the LLM skipped.

**Step 5: Test manually**

Run: `npm run dev` (or `PULSE_TEST_MODE=true node src/server.js`)
Send a test message, then check the eval-ui trace detail to verify:
- Reasoning text appears below picks
- Interestingness scores show in picks and not-picked tables
- Not-picked sorted by score descending

**Step 6: Commit**

```bash
git add src/eval-ui.html
git commit -m "feat: show pick reasoning + interestingness scores in eval-ui"
```

---

### Task 5: Add pool exclusion tracking to traces

**Files:**
- Modify: `src/brain-execute.js:buildSearchPool` (~line 310-350)
- Modify: `src/traces.js:56` (add exclusions field)

**Step 1: Add exclusions field to trace init**

In `src/traces.js:56`, add `exclusions` to the events section:

```js
events: { cache_size: 0, candidates_count: 0, sent_to_claude: 0, candidate_ids: [], sent_ids: [], getEvents_ms: null, exclusions: null },
```

**Step 2: Track exclusion reasons in buildSearchPool**

In `src/brain-execute.js:buildSearchPool`, after the tagged pool is built (~line 334-347), add exclusion tracking:

```js
// Track why events were excluded from the pool
const poolIds = new Set(events.map(e => e.id));
const exclusions = {
  total_candidates: curated.length,
  sent_to_llm: events.length,
  excluded_count: curated.length - events.length,
  by_reason: {},
};

if (activeFilters.time_after) {
  const timeExcluded = curated.filter(e => failsTimeGate(e, activeFilters.time_after) && !poolIds.has(e.id));
  if (timeExcluded.length > 0) exclusions.by_reason.time_gate = timeExcluded.length;
}
if (activeFilters.category || activeFilters.categories) {
  const catMissed = curated.filter(e => !poolIds.has(e.id) && eventMatchesFilters(e, activeFilters) === false);
  if (catMissed.length > 0) exclusions.by_reason.category_mismatch = catMissed.length;
}
const poolCap = curated.length - events.length - Object.values(exclusions.by_reason).reduce((a, b) => a + b, 0);
if (poolCap > 0) exclusions.by_reason.pool_cap = poolCap;

trace.events.exclusions = exclusions;
```

Note: Import `failsTimeGate` and `eventMatchesFilters` at the top of brain-execute.js — `eventMatchesFilters` is already imported from pipeline.js (line 9). `failsTimeGate` needs to be added to the import.

**Step 3: Run tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/brain-execute.js src/traces.js
git commit -m "feat: track pool exclusion reasons in traces"
```

---

### Task 6: Surface exclusion stats in eval-ui

**Files:**
- Modify: `src/eval-ui.html`

**Step 1: Add exclusion summary to trace detail**

In `src/eval-ui.html`, in the trace detail rendering function, after the pool_meta display, add exclusion stats:

```js
// Exclusions
const exclusions = ev.exclusions;
const exclusionEl = document.getElementById('td-exclusions');
const exclusionSection = document.getElementById('td-exclusions-section');
if (exclusions && exclusions.excluded_count > 0) {
  exclusionSection.style.display = 'block';
  const reasons = Object.entries(exclusions.by_reason || {})
    .map(([reason, count]) => `${reason.replace(/_/g, ' ')}: ${count}`)
    .join(', ');
  exclusionEl.textContent = `${exclusions.total_candidates} candidates -> ${exclusions.sent_to_llm} sent to LLM (${exclusions.excluded_count} excluded: ${reasons})`;
} else {
  exclusionSection.style.display = 'none';
}
```

Add HTML:
```html
<div id="td-exclusions-section" style="display:none">
  <h4>Pool Funnel</h4>
  <p id="td-exclusions" style="color:#ccc;"></p>
</div>
```

**Step 2: Test manually**

Same as Task 4 Step 5. Verify exclusion stats show in trace detail when filters cause exclusions.

**Step 3: Commit**

```bash
git add src/eval-ui.html
git commit -m "feat: show pool exclusion stats in eval-ui trace detail"
```
