# Single-Turn Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge routing + compose into one Gemini generation so the agent that understands the user's message is the same one that writes the SMS.

**Architecture:** Replace the two-call flow (callAgentBrain → brainCompose) with a single Gemini chat session using multi-turn tool calling. User message → functionCall: search_events → execute tool → functionResponse(events) → same session writes SMS. brainCompose kept only for handleMore.

**Tech Stack:** Gemini 2.5 Flash Lite SDK (`@google/generative-ai`), Anthropic Haiku fallback, existing pipeline.js deterministic functions.

---

### Task 1: Merge compose instructions into brain system prompt

**Files:**
- Modify: `src/agent-brain.js:124-210` (buildBrainSystemPrompt)
- Modify: `src/agent-brain.js:538-560` (BRAIN_COMPOSE_SYSTEM — reference only, don't delete yet)

**Step 1: Edit buildBrainSystemPrompt to include compose instructions**

Add a new section at the end of the system prompt (after the SESSION CONTEXT block) that tells the model how to write SMS after receiving event results. Merge the key rules from BRAIN_COMPOSE_SYSTEM:

```javascript
// At the end of buildBrainSystemPrompt, after the SESSION CONTEXT line, add:

AFTER TOOL EXECUTION:
When you call search_events and receive event results back, write the SMS response directly.

FORMAT (MANDATORY — always use numbered picks):
Line 1: Short intro (e.g. "Tonight in East Village:")
Then numbered events:
1) Event Name at Venue — your take. Time, price
2) Event Name at Venue — your take. Time, price
3) Event Name at Venue — your take. Time, price
Last line: "Reply 1-N for details, MORE for extra picks, or FREE for free events"

COMPOSE RULES:
- Pick 1-3 best events from the provided list. Prefer [MATCH] events first, then others.
- Prefer TODAY over tomorrow. Prefer soonest events.
- Favor discovery: big concerts/touring acts are the default — everyone already knows about them. Unless the user asked for music/concerts/shows, deprioritize them. Lead with source_vibe:"discovery" events, intimate venues, interesting one-offs. When you see interaction_format:"interactive" + recurring, mention it naturally ("every Tuesday, great for becoming a regular").
- EVERY pick MUST include: event name, venue name, your opinionated take, start time, and price ("$20", "free", "cover")
- Label TODAY as "tonight", TOMORROW as "tomorrow", further out by day name
- [NEARBY] events are from adjacent neighborhoods — label each with its actual neighborhood in parentheses
- If SPARSE, be honest about slim pickings but still show what's available
- Under 480 characters total. No URLs.
- Voice: friend texting. Opinionated, concise, warm.
- CONNECT your SMS to what the user originally asked. If they said "something weird and lowkey", reflect that vibe in your picks and language. This is why you're writing the SMS — you understood the request.

Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST match the numbered events in sms_text.
```

Also update the opening instruction from "Do NOT write event recommendations — just route to the right tool" to: "Your job: understand what the user wants, call the right tool, and — when you get event results back — write a warm SMS with picks."

**Step 2: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All tests pass (system prompt is not unit tested, but no regressions)

**Step 3: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: merge compose instructions into brain system prompt for single-turn agent"
```

---

### Task 2: Modify callAgentBrain to return chat session

**Files:**
- Modify: `src/agent-brain.js:365-443` (callAgentBrain)

**Step 1: Refactor callAgentBrain to use startChat and return the chat object**

Currently `callAgentBrain` uses `model.generateContent()` which is stateless. Change to `model.startChat()` + `chat.sendMessage()` which returns a chat session that can be continued.

The key change: instead of returning `{tool, params, usage, provider, latency_ms}`, return `{tool, params, usage, provider, latency_ms, chat}` where `chat` is the Gemini chat session object.

```javascript
async function callAgentBrain(message, session, phone, trace) {
  const systemPrompt = buildBrainSystemPrompt(session);
  const brainStart = Date.now();

  const genAI = getGeminiClient();
  if (!genAI) {
    throw new Error('GEMINI_API_KEY not set — agent brain requires Gemini');
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    tools: BRAIN_TOOLS,
    generationConfig: {
      maxOutputTokens: 256,
      temperature: 0,
    },
  });

  // Use chat session so we can continue after tool execution
  const chat = model.startChat();

  let result;
  try {
    result = await withTimeout(
      chat.sendMessage(message),
      10_000, 'callAgentBrain'
    );
  } catch (err) {
    console.warn(`Agent brain Gemini failed, falling back to Anthropic: ${err.message}`);
    trace.brain_error = `gemini: ${err.message}`;
    return callAgentBrainAnthropic(message, session, phone, trace, brainStart);
  }

  const response = result.response;
  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.warn(`Agent brain finishReason=${finishReason}`);
    if (finishReason === 'SAFETY') {
      throw new Error(`Agent brain blocked by safety filter`);
    }
    if (finishReason === 'MALFORMED_FUNCTION_CALL' || finishReason === 'MAX_TOKENS') {
      console.warn(`Agent brain Gemini ${finishReason}, falling back to Anthropic`);
      return callAgentBrainAnthropic(message, session, phone, trace, brainStart);
    }
  }

  const parts = candidate?.content?.parts || [];
  const fnCall = parts.find(p => p.functionCall);
  if (!fnCall?.functionCall) {
    const textPart = parts.find(p => p.text);
    if (textPart?.text) {
      return {
        tool: 'respond',
        params: { message: smartTruncate(textPart.text), intent: 'clarify' },
        usage: extractGeminiUsage(response),
        provider: 'gemini',
        latency_ms: Date.now() - brainStart,
        chat: null, // No continuation needed for respond
      };
    }
    console.warn('Agent brain Gemini returned no tool call, falling back to Anthropic');
    return callAgentBrainAnthropic(message, session, phone, trace, brainStart);
  }

  const { name, args } = fnCall.functionCall;
  const usage = extractGeminiUsage(response);

  return {
    tool: name,
    params: args || {},
    usage,
    provider: 'gemini',
    latency_ms: Date.now() - brainStart,
    chat, // Pass chat session for continuation
  };
}
```

**Step 2: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass. chat field is additive — existing callers ignore it.

**Step 3: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: return Gemini chat session from callAgentBrain for continuation"
```

---

### Task 3: Create continueWithResults function

**Files:**
- Modify: `src/agent-brain.js` (add new function after callAgentBrain, ~line 443)

**Step 1: Write the continueWithResults function**

This function takes the chat session + event pool data, sends a `functionResponse` back to the same Gemini session, and gets the SMS + picks JSON back. Uses `responseMimeType: 'application/json'` with `responseSchema` on the continuation to ensure structured output.

```javascript
/**
 * Continue the Gemini chat session with search_events results.
 * Sends functionResponse → model writes SMS in the same context.
 * Returns { sms_text, picks, usage, provider }
 */
async function continueWithResults(chat, eventData, trace) {
  const composeStart = Date.now();

  try {
    // Send function response back to the chat session
    const result = await withTimeout(
      chat.sendMessage([{
        functionResponse: {
          name: 'search_events',
          response: { events: eventData },
        },
      }]),
      10_000, 'continueWithResults'
    );

    const response = result.response;
    const text = response.text();
    const usage = extractGeminiUsage(response);

    trace.composition.latency_ms = Date.now() - composeStart;

    // Parse JSON response
    const parsed = JSON.parse(stripCodeFences(text));
    const sms = smartTruncate(parsed.sms_text);

    return {
      sms_text: sms,
      picks: reconcilePicks(sms, parsed.picks || []),
      _raw: text,
      _usage: usage,
      _provider: 'gemini',
    };
  } catch (err) {
    console.warn('continueWithResults failed:', err.message);
    throw err; // Let caller handle fallback
  }
}
```

**Important:** The Gemini SDK's `chat.sendMessage` with a `functionResponse` part continues the conversation. The model sees the original user message + its own function call + the results, then generates the SMS. This is confirmed by [Gemini function calling docs](https://ai.google.dev/gemini-api/docs/function-calling).

**Step 2: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass. New function not called yet.

**Step 3: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: add continueWithResults for single-turn Gemini chat continuation"
```

---

### Task 4: Split executeSearchEvents — return pool without composing

**Files:**
- Modify: `src/agent-brain.js:826-1022` (executeSearchEvents)

**Step 1: Extract pool-building into a separate function**

Split executeSearchEvents into two parts:
1. `buildSearchPool(params, session, phone, trace)` — steps 1-6 (resolve neighborhood, build filters, fetch events, build tagged pool, handle zero match). Returns the pool + metadata needed for composition.
2. `executeSearchEvents(params, session, phone, trace)` — calls buildSearchPool, then calls brainCompose (kept for handleMore compatibility and as fallback).

```javascript
/**
 * Build the event pool for a search_events call.
 * Does NOT compose — returns pool + metadata for the caller to compose.
 * Used by single-turn flow (continueWithResults) and legacy flow (brainCompose).
 */
async function buildSearchPool(params, session, phone, trace) {
  // Steps 1-6 from current executeSearchEvents (lines 826-948)
  // ... (all the neighborhood resolution, filter building, event fetching, tagged pool, zero match)

  // Returns:
  return {
    pool: events,           // tagged event pool
    curated,                // full curated list (for eventMap)
    activeFilters,
    hood, borough, isBorough, isCitywide,
    matchCount, hardCount, softCount, isSparse,
    nearbyHoods,
    suggestedHood,
    excludeIds,
    zeroMatch: null,        // or { sms, intent, picks, activeFilters } if zero match
  };
}
```

Then `executeSearchEvents` becomes:
```javascript
async function executeSearchEvents(params, session, phone, trace) {
  const poolResult = await buildSearchPool(params, session, phone, trace);

  // Zero match → return immediately
  if (poolResult.zeroMatch) return poolResult.zeroMatch;

  // Compose via brainCompose (legacy path — kept for handleMore and fallback)
  const composeStart = Date.now();
  const result = await brainCompose(poolResult.pool, {
    neighborhood: poolResult.hood,
    nearbyHoods: poolResult.nearbyHoods,
    activeFilters: poolResult.activeFilters,
    isSparse: poolResult.isSparse,
    isCitywide: poolResult.isCitywide,
    isBorough: poolResult.isBorough,
    borough: poolResult.borough,
    matchCount: poolResult.matchCount,
    excludeIds: poolResult.excludeIds,
    suggestedNeighborhood: poolResult.suggestedHood,
  });
  trace.composition.latency_ms = Date.now() - composeStart;
  // ... rest of steps 7-8 (validate picks, save session, etc.)
}
```

**Step 2: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass. This is a refactor — same behavior, just split into two functions.

**Step 3: Commit**

```bash
git add src/agent-brain.js
git commit -m "refactor: extract buildSearchPool from executeSearchEvents for single-turn flow"
```

---

### Task 5: Wire single-turn flow into handleAgentBrainRequest

**Files:**
- Modify: `src/agent-brain.js:1124-1228` (handleAgentBrainRequest)

**Step 1: Update the search_events branch to use single-turn flow**

In `handleAgentBrainRequest`, when brainResult.tool === 'search_events' AND brainResult.chat is available (Gemini path), use the single-turn flow:

```javascript
if (brainResult.tool === 'search_events') {
  const poolResult = await buildSearchPool(brainResult.params, session, phone, trace);

  if (poolResult.zeroMatch) {
    execResult = poolResult.zeroMatch;
  } else if (brainResult.chat) {
    // Single-turn: continue same Gemini session with event results
    try {
      const eventData = serializePoolForContinuation(poolResult);
      const composeResult = await continueWithResults(brainResult.chat, eventData, trace);

      // Record cost
      recordAICost(trace, 'compose', composeResult._usage, composeResult._provider);
      trackAICost(phone, composeResult._usage, composeResult._provider);
      trace.composition.raw_response = composeResult._raw || null;
      trace.composition.active_filters = poolResult.activeFilters;
      trace.composition.neighborhood_used = poolResult.hood;

      // Validate picks + save session
      const eventMap = buildEventMap(poolResult.curated);
      for (const e of poolResult.pool) eventMap[e.id] = e;
      const allEvents = [...poolResult.curated, ...poolResult.pool.filter(e => !eventMap[e.id])];
      const validPicks = validatePicks(composeResult.picks, allEvents);

      // trace picks
      trace.composition.picks = validPicks.map(p => {
        const evt = eventMap[p.event_id];
        return { ...p, date_local: evt?.date_local || null, event_name: evt?.name || null,
          venue_name: evt?.venue_name || null, neighborhood: evt?.neighborhood || null,
          category: evt?.category || null, is_free: evt?.is_free ?? null,
          price_display: evt?.price_display || null, start_time_local: evt?.start_time_local || null,
          source_vibe: evt?.source_vibe || null };
      });

      saveResponseFrame(phone, {
        picks: validPicks, eventMap,
        neighborhood: poolResult.hood, borough: poolResult.borough,
        filters: poolResult.activeFilters,
        offeredIds: validPicks.map(p => p.event_id),
        visitedHoods: [...new Set([...(session?.visitedHoods || []), poolResult.hood || poolResult.borough || 'citywide'])],
        pending: poolResult.suggestedHood ? { neighborhood: poolResult.suggestedHood, filters: poolResult.activeFilters } : null,
      });

      updateProfile(phone, { neighborhood: poolResult.hood, filters: poolResult.activeFilters, responseType: 'event_picks' })
        .catch(err => console.error('profile update failed:', err.message));

      execResult = {
        sms: composeResult.sms_text,
        intent: validPicks.length > 0 ? 'events' : 'conversational',
        picks: validPicks,
        activeFilters: poolResult.activeFilters,
        eventMap,
      };
    } catch (err) {
      // Fallback to standalone brainCompose if continuation fails
      console.warn('Single-turn continuation failed, falling back to brainCompose:', err.message);
      trace.brain_error = (trace.brain_error || '') + ` continuation: ${err.message}`;
      execResult = await executeSearchEvents(brainResult.params, session, phone, trace);
    }
  } else {
    // Anthropic path or no chat — use legacy brainCompose
    execResult = await executeSearchEvents(brainResult.params, session, phone, trace);
  }
}
```

**Step 2: Write serializePoolForContinuation helper**

```javascript
/**
 * Serialize event pool into compact format for Gemini functionResponse.
 * Same format as brainCompose's event list, but as structured data.
 */
function serializePoolForContinuation(poolResult) {
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);
  const { pool, hood: neighborhood, activeFilters, isSparse, matchCount,
          nearbyHoods, suggestedHood, excludeIds, isCitywide, isBorough, borough } = poolResult;

  const hoodLabel = isBorough ? `${borough} (borough-wide)` : isCitywide ? 'citywide' : neighborhood || 'NYC';
  const filterDesc = activeFilters && Object.values(activeFilters).some(Boolean) ? describeFilters(activeFilters) : '';

  const events = pool.map(e => {
    const dayLabel = e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local;
    const tag = e.filter_match === 'hard' ? '[MATCH]' : e.filter_match === 'soft' ? '[SOFT]' : '';
    const nearbyTag = (neighborhood && e.neighborhood && e.neighborhood !== neighborhood) ? '[NEARBY]' : '';
    return {
      id: e.id, name: (e.name || '').slice(0, 80), venue_name: e.venue_name,
      neighborhood: e.neighborhood, day: dayLabel, start_time_local: e.start_time_local,
      is_free: e.is_free, price_display: e.price_display, category: e.category,
      short_detail: (e.short_detail || e.description_short || '').slice(0, 100),
      recurring: e.is_recurring ? e.recurrence_label : undefined,
      venue_size: e.venue_size || undefined,
      interaction_format: e.interaction_format || undefined,
      source_vibe: e.source_vibe || undefined,
      tags: [tag, nearbyTag].filter(Boolean).join(' ') || undefined,
    };
  });

  return {
    neighborhood: hoodLabel,
    filter: filterDesc || undefined,
    match_count: matchCount,
    sparse: isSparse || undefined,
    nearby_hoods: isSparse ? nearbyHoods : undefined,
    suggested_neighborhood: suggestedHood || undefined,
    exclude_ids: excludeIds?.length > 0 ? excludeIds : undefined,
    events,
  };
}
```

**Step 3: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: wire single-turn flow — Gemini continues same session after search_events"
```

---

### Task 6: Update Gemini model config for continuation

**Files:**
- Modify: `src/agent-brain.js` (callAgentBrain model config)

**Step 1: Increase maxOutputTokens for the brain model**

The brain model now needs to generate both a tool call AND (in the continuation) a full SMS JSON response. The initial call still uses 256 tokens (tool calls are small), but the continuation needs more. The Gemini SDK uses the model config from `startChat`, so we need to increase `maxOutputTokens` to 1024 to accommodate the SMS JSON response.

```javascript
// In callAgentBrain, update generationConfig:
generationConfig: {
  maxOutputTokens: 1024, // was 256 — continuation needs room for SMS JSON
  temperature: 0,
},
```

**Step 2: Run tests**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && npm test`
Expected: All pass.

**Step 3: Commit**

```bash
git add src/agent-brain.js
git commit -m "feat: increase brain maxOutputTokens to 1024 for single-turn continuation"
```

---

### Task 7: Run evals and verify

**Step 1: Start local server with agent brain enabled**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_AGENT_BRAIN=true node src/server.js`

Wait for "cache loaded" and server ready.

**Step 2: Run scenario evals locally**

Run: `node scripts/run-scenario-evals.js --pipeline agent_brain --concurrency 3`

Check:
- Code eval pass rate ≥ 99% (baseline: 99.87%)
- No new failures in 480-char compliance
- No new failures in filter accuracy
- search_events tool calls still work correctly

**Step 3: Run regression evals**

Run: `node scripts/run-regression-evals.js --pipeline agent_brain`

Check pass rate ≥ baseline.

**Step 4: Spot-check SMS quality**

Send 3-5 test messages through `/api/sms/test` and compare output quality:
- `"something weird and lowkey in bushwick"` — SMS should reflect "weird and lowkey" vibe
- `"free comedy tonight"` — SMS should reflect "free" + "comedy" + "tonight"
- `"jazz"` → then `"how about williamsburg"` — SMS should show jazz continues in Williamsburg

Compare the tone/specificity to the current two-call flow. The single-turn SMS should feel more connected to the user's original words.

**Step 5: Commit eval results if new baseline**

```bash
git add -A
git commit -m "chore: Phase 2 eval verification — single-turn agent"
```

---

### Task 8: Deploy and verify on Railway

**Step 1: Deploy**

Run: `cd /Users/justinkoufopoulos/Projects/pulse-sms && railway up`

Wait 2-3 minutes for build+deploy.

**Step 2: Run evals against Railway**

Run: `node scripts/run-scenario-evals.js --pipeline agent_brain --url https://web-production-c8fdb.up.railway.app --concurrency 3`

Verify pass rate matches local.

**Step 3: Update ROADMAP.md**

Mark Phase 2 as done:
```
**Phase 2: Single-Turn Agent** -- **Done (2026-03-05)**

Merged routing + compose into a single Gemini chat session. The agent that understands user intent writes the SMS in the same generation via multi-turn tool calling. brainCompose kept for handleMore. Fallback: brainCompose on continuation failure, Anthropic on Gemini failure.
```

**Step 4: Commit roadmap update**

```bash
git add ROADMAP.md
git commit -m "docs: mark Phase 2 single-turn agent as complete"
```
