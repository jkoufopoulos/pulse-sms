# Agent Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 400-line manual orchestrator with a true agent loop where the LLM calls tools, gets results, and decides what to do next.

**Architecture:** New `runAgentLoop` in `src/llm.js` handles the multi-turn tool calling cycle for both Gemini and Anthropic. New `src/agent-loop.js` provides `executeTool` (delegates to existing pure functions) and `handleAgentRequest` (the ~30-line orchestrator). The old `handleAgentBrainRequest`, welcome flow, and separate compose paths are deleted.

**Tech Stack:** Gemini 2.5 Flash Lite (primary), Claude Haiku 4.5 (fallback), existing llm.js provider abstraction.

**Design doc:** `docs/plans/2026-03-07-agent-loop-design.md`

---

### Task 1: Add `runAgentLoop` to llm.js

**Files:**
- Modify: `src/llm.js` (add new function after `continueChat`, ~line 376)
- Test: `test/unit/agent-brain.test.js` (won't break — no changes to existing functions)

**Step 1: Write the `runAgentLoop` function**

Add to `src/llm.js` before `module.exports`:

```javascript
/**
 * Run a multi-turn agent loop: LLM calls tools, we execute them,
 * feed results back, repeat until LLM responds with text or max iterations.
 *
 * @param {string} model - Model name
 * @param {string} systemPrompt - System instruction
 * @param {string} message - User message
 * @param {Array} tools - Neutral-format tool definitions
 * @param {Function} executeTool - async (toolName, params) => resultObject
 * @param {object} options - { maxIterations, timeout }
 * @returns {{ text: string, toolCalls: Array<{name, params, result}>, totalUsage: object, provider: string }}
 */
async function runAgentLoop(model, systemPrompt, message, tools, executeTool, options = {}) {
  const { maxIterations = 3, timeout = 15000 } = options;
  const provider = getProvider(model);
  const loopStart = Date.now();
  const toolCalls = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  function addUsage(usage) {
    if (!usage) return;
    totalUsage.input_tokens += usage.input_tokens || 0;
    totalUsage.output_tokens += usage.output_tokens || 0;
  }

  function remainingTimeout() {
    const elapsed = Date.now() - loopStart;
    const remaining = timeout - elapsed;
    if (remaining <= 0) throw new Error('Agent loop timed out');
    return remaining;
  }

  if (provider === 'gemini') {
    const genAI = getGeminiClient();
    if (!genAI) throw new Error('GEMINI_API_KEY not set');

    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      safetySettings: GEMINI_SAFETY,
      tools: toGeminiTools(tools),
      generationConfig: { maxOutputTokens: 1024, temperature: 0 },
    });

    const chat = geminiModel.startChat();

    // First turn: send user message
    let result = await withTimeout(chat.sendMessage(message), remainingTimeout(), `agentLoop(${model})`);
    let response = result.response;
    addUsage(extractGeminiUsage(response));

    for (let i = 0; i < maxIterations; i++) {
      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const fnCall = parts.find(p => p.functionCall);

      if (!fnCall?.functionCall) {
        // No tool call — LLM is done, return text
        const textPart = parts.find(p => p.text);
        return { text: textPart?.text || '', toolCalls, totalUsage, provider };
      }

      // Execute the tool
      const toolName = fnCall.functionCall.name;
      const toolParams = fnCall.functionCall.args || {};
      const toolResult = await executeTool(toolName, toolParams);
      toolCalls.push({ name: toolName, params: toolParams, result: toolResult });

      // Send result back
      result = await withTimeout(
        chat.sendMessage([{ functionResponse: { name: toolName, response: toolResult } }]),
        remainingTimeout(), `agentLoop(${model}) turn ${i + 2}`
      );
      response = result.response;
      addUsage(extractGeminiUsage(response));
    }

    // Hit max iterations — extract whatever text we have
    const finalParts = response.candidates?.[0]?.content?.parts || [];
    const finalText = finalParts.find(p => p.text);
    return { text: finalText?.text || '', toolCalls, totalUsage, provider };
  }

  if (provider === 'anthropic') {
    const client = getAnthropicClient();
    const messages = [{ role: 'user', content: message }];

    for (let i = 0; i <= maxIterations; i++) {
      const response = await withTimeout(
        client.messages.create({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          tools: toAnthropicTools(tools),
          messages,
        }, { timeout: remainingTimeout() }),
        remainingTimeout() + 2000, `agentLoop(${model}) turn ${i + 1}`
      );

      addUsage(response.usage);

      const toolBlock = response.content.find(b => b.type === 'tool_use');

      if (!toolBlock) {
        // No tool call — return text
        const textBlock = response.content.find(b => b.type === 'text');
        return { text: textBlock?.text || '', toolCalls, totalUsage, provider };
      }

      // Execute the tool
      const toolResult = await executeTool(toolBlock.name, toolBlock.input || {});
      toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: toolResult });

      // Append assistant response + tool result for next turn
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: JSON.stringify(toolResult) }],
      });
    }

    // Hit max iterations
    return { text: '', toolCalls, totalUsage, provider };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
```

**Step 2: Export the new function**

In `src/llm.js`, add `runAgentLoop` to the `module.exports` object.

**Step 3: Run tests to verify nothing broke**

Run: `npm test 2>&1 | tail -5`
Expected: Same pass count as before (894 passed, 1 failed — the API key failure).

**Step 4: Commit**

```bash
git add src/llm.js
git commit -m "feat: add runAgentLoop to llm.js — multi-turn tool calling loop"
```

---

### Task 2: Create `src/agent-loop.js` — the new orchestrator

**Files:**
- Create: `src/agent-loop.js`
- Read (reference only): `src/brain-execute.js` (for `buildSearchPool`, `executeMore`, `executeDetails`)
- Read (reference only): `src/brain-llm.js` (for `buildBrainSystemPrompt`, `BRAIN_TOOLS`, `serializePoolForContinuation`)

This is the core of the refactor. The new file has three parts:
1. `executeTool` — callback for `runAgentLoop`, delegates to existing pure functions
2. `saveSessionFromToolCalls` — post-loop session save based on what tools were called
3. `handleAgentRequest` — the ~30-line orchestrator that replaces `handleAgentBrainRequest`

**Step 1: Write `src/agent-loop.js`**

```javascript
/**
 * agent-loop.js — True agent loop orchestrator.
 *
 * Replaces the 400-line switch statement in agent-brain.js.
 * The LLM calls tools, gets results, and decides what to do next.
 */

const { runAgentLoop } = require('./llm');
const { MODELS } = require('./model-config');
const { buildSearchPool, executeMore, executeDetails, validatePicks, resolveDateRange } = require('./brain-execute');
const { BRAIN_TOOLS, buildBrainSystemPrompt, serializePoolForContinuation } = require('./brain-llm');
const { buildEventMap, saveResponseFrame, buildExhaustionMessage, sendPickUrls } = require('./pipeline');
const { sendSMS, maskPhone } = require('./twilio');
const { recordAICost } = require('./traces');
const { getSession, setSession, addToHistory } = require('./session');
const { trackAICost } = require('./request-guard');
const { updateProfile } = require('./preference-profile');
const { smartTruncate, injectMissingPrices } = require('./formatters');
const { sendRuntimeAlert } = require('./alerts');
const { getAdjacentNeighborhoods, getNycDateString } = require('./geo');
const { scoreInterestingness } = require('./events');

/**
 * Execute a tool call from the agent loop.
 * Returns structured data that gets fed back to the LLM.
 */
async function executeTool(toolName, params, session, phone, trace) {
  if (toolName === 'respond') {
    // respond tool — the message IS the SMS. Return confirmation to the LLM.
    return { ok: true, intent: params.intent };
  }

  if (toolName === 'search_events') {
    if (params.intent === 'more') {
      const moreResult = executeMore(session);

      if (moreResult.noContext) {
        return { match_count: 0, message: 'No prior search to continue from.' };
      }
      if (moreResult.exhausted) {
        const adjacentHoods = moreResult.neighborhood
          ? getAdjacentNeighborhoods(moreResult.neighborhood, 4)
          : [];
        return {
          match_count: 0,
          exhausted: true,
          neighborhood: moreResult.neighborhood,
          nearby_neighborhoods: adjacentHoods.filter(
            h => !(session?.visitedHoods || []).includes(h)
          ),
        };
      }

      // Serialize events for the LLM
      const todayNyc = getNycDateString(0);
      const tomorrowNyc = getNycDateString(1);
      return {
        neighborhood: moreResult.neighborhood || 'NYC',
        match_count: moreResult.events.length,
        is_last_batch: moreResult.isLastBatch || false,
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
        _moreResult: moreResult, // internal — not sent to LLM, used for session save
      };
    }

    if (params.intent === 'details') {
      const detailsResult = executeDetails(params.pick_reference, session);

      if (detailsResult.noPicks) {
        return { match_count: 0, message: 'No picks loaded to get details for.' };
      }
      if (detailsResult.stalePicks) {
        return { match_count: 0, message: 'Pick list is stale. Ask for a new search first.' };
      }
      if (!detailsResult.found) {
        return { match_count: 0, message: `Couldn't match "${params.pick_reference}" to a pick.` };
      }

      const event = detailsResult.event;
      return {
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
        _detailsResult: detailsResult, // internal
      };
    }

    // Regular search (new_search, refine, pivot)
    const poolResult = await buildSearchPool(params, session, phone, trace);

    if (poolResult.zeroMatch) {
      return {
        match_count: 0,
        neighborhood: poolResult.zeroMatch.activeFilters?.neighborhood || params.neighborhood || 'unknown',
        nearby_neighborhoods: params.neighborhood
          ? getAdjacentNeighborhoods(params.neighborhood, 3)
          : [],
        active_filters: poolResult.zeroMatch.activeFilters,
      };
    }

    // Serialize the pool for the LLM
    const serialized = serializePoolForContinuation(poolResult);

    // Attach internal data for session save (stripped before sending to LLM)
    serialized._poolResult = poolResult;
    return serialized;
  }

  return { error: `Unknown tool: ${toolName}` };
}

/**
 * Strip internal fields (prefixed with _) before sending tool results to the LLM.
 */
function sanitizeForLLM(result) {
  if (!result || typeof result !== 'object') return result;
  const clean = {};
  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith('_')) clean[key] = value;
  }
  return clean;
}

/**
 * Save session state based on what tool calls happened during the loop.
 */
function saveSessionFromToolCalls(phone, session, toolCalls, smsText) {
  if (!toolCalls || toolCalls.length === 0) return;

  // Find the last search_events call (that's the one that produced the response)
  const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search_events');
  if (!lastSearch) {
    // Only respond calls — preserve existing session
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: session?.lastEvents || {},
      neighborhood: session?.lastNeighborhood || null,
      borough: session?.lastBorough || null,
      filters: session?.lastFilters || null,
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      lastResponseHadPicks: false,
    });
    return;
  }

  const result = lastSearch.result;
  const params = lastSearch.params;

  if (params.intent === 'details') {
    // Details — don't change picks/neighborhood, just record the interaction
    return;
  }

  if (params.intent === 'more') {
    const moreResult = result._moreResult;
    if (!moreResult || moreResult.exhausted || moreResult.noContext) {
      // Exhausted or no context — save minimal frame
      saveResponseFrame(phone, {
        mode: 'more',
        picks: session?.lastPicks || [],
        prevSession: session,
        eventMap: session?.lastEvents || {},
        neighborhood: moreResult?.neighborhood || session?.lastNeighborhood,
        filters: moreResult?.activeFilters || session?.lastFilters || {},
        offeredIds: moreResult?.events?.map(e => e.id) || [],
      });
      return;
    }

    // Successful more — extract picks from SMS text and save
    const eventMap = buildEventMap(moreResult.events);
    const picks = extractPicksFromSms(smsText, moreResult.events);
    saveResponseFrame(phone, {
      mode: 'more',
      picks,
      prevSession: session,
      eventMap: session?.lastEvents || eventMap,
      neighborhood: moreResult.neighborhood,
      filters: moreResult.activeFilters || {},
      offeredIds: moreResult.events.map(e => e.id),
    });
    return;
  }

  // Regular search (new_search, refine, pivot)
  const poolResult = result._poolResult;
  if (!poolResult) {
    // Zero match — save minimal frame
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: session?.lastEvents || {},
      neighborhood: params.neighborhood || session?.lastNeighborhood,
      filters: result.active_filters || {},
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      lastResponseHadPicks: false,
    });
    return;
  }

  const eventMap = buildEventMap(poolResult.curated);
  for (const e of poolResult.pool) eventMap[e.id] = e;
  const picks = extractPicksFromSms(smsText, [...poolResult.curated, ...poolResult.pool]);

  saveResponseFrame(phone, {
    picks,
    eventMap,
    neighborhood: poolResult.hood,
    borough: poolResult.borough,
    filters: poolResult.activeFilters,
    offeredIds: picks.map(p => p.event_id),
    visitedHoods: [...new Set([
      ...(session?.visitedHoods || []),
      poolResult.hood || poolResult.borough || 'citywide',
    ])],
    pending: poolResult.suggestedHood
      ? { neighborhood: poolResult.suggestedHood, filters: poolResult.activeFilters }
      : null,
  });

  updateProfile(phone, {
    neighborhood: poolResult.hood,
    filters: poolResult.activeFilters,
    responseType: 'event_picks',
  }).catch(err => console.error('profile update failed:', err.message));
}

/**
 * Extract pick references from SMS text by matching event names/venues against pool.
 * The LLM wrote the SMS as plain text — we need to figure out which events it mentioned.
 */
function extractPicksFromSms(smsText, events) {
  if (!smsText || !events || events.length === 0) return [];

  const smsLower = smsText.toLowerCase();
  const picks = [];
  let rank = 1;

  for (const event of events) {
    const nameMatch = event.name && smsLower.includes(event.name.toLowerCase().slice(0, 30));
    const venueMatch = event.venue_name && smsLower.includes(event.venue_name.toLowerCase());
    if (nameMatch || venueMatch) {
      picks.push({ rank: rank++, event_id: event.id, why: 'mentioned in SMS' });
    }
  }

  return picks;
}

/**
 * Derive the response intent from the tool calls that happened.
 */
function deriveIntent(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return 'conversational';
  const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search_events');
  if (!lastSearch) {
    const lastRespond = [...toolCalls].reverse().find(tc => tc.name === 'respond');
    return lastRespond?.params?.intent || 'conversational';
  }
  if (lastSearch.params.intent === 'details') return 'details';
  if (lastSearch.params.intent === 'more') return 'more';
  return 'events';
}

// --- Main orchestrator ---

async function handleAgentRequest(phone, message, session, trace, finalizeTrace) {
  const masked = maskPhone(phone);

  // Set up session + history
  if (!getSession(phone)) setSession(phone, {});
  addToHistory(phone, 'user', message);

  const systemPrompt = buildBrainSystemPrompt(session);

  try {
    // Wrap executeTool to sanitize results before they go to the LLM
    const executeAndTrack = async (toolName, params) => {
      const result = await executeTool(toolName, params, session, phone, trace);
      // Return sanitized version to LLM (no _ prefixed fields)
      return sanitizeForLLM(result);
    };

    // Keep raw results for session save
    const rawResults = [];
    const executeAndTrackWithRaw = async (toolName, params) => {
      const result = await executeTool(toolName, params, session, phone, trace);
      rawResults.push({ name: toolName, params, result });
      return sanitizeForLLM(result);
    };

    const loopResult = await runAgentLoop(
      MODELS.brain, systemPrompt, message, BRAIN_TOOLS,
      executeAndTrackWithRaw,
      { maxIterations: 3, timeout: 12000 }
    );

    // Record costs
    recordAICost(trace, 'brain', loopResult.totalUsage, loopResult.provider);
    trackAICost(phone, loopResult.totalUsage, loopResult.provider);

    // Trace data
    trace.brain_provider = loopResult.provider;
    trace.brain_tool_calls = loopResult.toolCalls.map(tc => ({ name: tc.name, params: tc.params }));
    trace.routing.pre_routed = false;
    trace.routing.provider = loopResult.provider;

    // Determine SMS text
    let smsText;
    const lastRespond = [...rawResults].reverse().find(tc => tc.name === 'respond');
    if (lastRespond) {
      // respond tool — SMS is in the tool params
      smsText = lastRespond.params.message;
    } else {
      // search_events path — SMS is the final text output
      smsText = loopResult.text;
    }

    smsText = smartTruncate(smsText || "Tell me what you're in the mood for — drop a neighborhood or a vibe.");

    // Record tool calls in structured history
    for (const tc of rawResults) {
      addToHistory(phone, 'tool_call', '', { name: tc.name, params: tc.params });
    }

    // Save session from tool calls
    saveSessionFromToolCalls(phone, session, rawResults, smsText);

    // Post-processing: inject price if LLM omitted it
    const lastSearch = [...rawResults].reverse().find(tc => tc.name === 'search_events');
    if (lastSearch?.result?._poolResult) {
      const poolResult = lastSearch.result._poolResult;
      const eventMap = buildEventMap(poolResult.curated || []);
      for (const e of (poolResult.pool || [])) eventMap[e.id] = e;
      const picks = extractPicksFromSms(smsText, [...(poolResult.curated || []), ...(poolResult.pool || [])]);
      if (picks.length > 0) {
        smsText = injectMissingPrices(smsText, picks, eventMap);
      }
    }

    const intent = deriveIntent(rawResults);
    await sendSMS(phone, smsText);

    // Send pick URLs for details
    if (intent === 'details' && lastSearch?.result?._detailsResult) {
      const dr = lastSearch.result._detailsResult;
      await sendPickUrls(phone, [dr.pick], { [dr.event.id]: dr.event });
    }

    finalizeTrace(smsText, intent);

  } catch (err) {
    console.error('Agent loop error:', err.message);
    trace.brain_error = err.message;

    // Try fallback model
    if (err.message && !err.message.includes('fallback')) {
      try {
        console.warn(`Agent loop ${MODELS.brain} failed, trying ${MODELS.fallback}: ${err.message}`);
        const fallbackResult = await runAgentLoop(
          MODELS.fallback, systemPrompt, message, BRAIN_TOOLS,
          async (toolName, params) => sanitizeForLLM(await executeTool(toolName, params, session, phone, trace)),
          { maxIterations: 2, timeout: 12000 }
        );

        recordAICost(trace, 'brain_fallback', fallbackResult.totalUsage, fallbackResult.provider);
        trackAICost(phone, fallbackResult.totalUsage, fallbackResult.provider);

        const lastRespond = [...fallbackResult.toolCalls].reverse().find(tc => tc.name === 'respond');
        let smsText = lastRespond ? lastRespond.params.message : fallbackResult.text;
        smsText = smartTruncate(smsText || "Tell me what you're in the mood for!");

        await sendSMS(phone, smsText);
        finalizeTrace(smsText, deriveIntent(fallbackResult.toolCalls));
        return trace.id;
      } catch (err2) {
        console.error('Fallback also failed:', err2.message);
        trace.brain_error += ` fallback: ${err2.message}`;
      }
    }

    const sms = "Pulse hit a snag — try again in a sec!";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'error');

    sendRuntimeAlert('agent_loop_error', {
      error: err.message,
      phone_masked: masked,
      message: message.slice(0, 80),
    });
  }

  return trace.id;
}

module.exports = {
  handleAgentRequest,
  executeTool,
  sanitizeForLLM,
  saveSessionFromToolCalls,
  extractPicksFromSms,
  deriveIntent,
};
```

**Step 2: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: Same pass count (new file has no test-breaking side effects — it's not imported anywhere yet).

**Step 3: Commit**

```bash
git add src/agent-loop.js
git commit -m "feat: add agent-loop.js — true agent loop orchestrator"
```

---

### Task 3: Write unit tests for agent-loop.js pure functions

**Files:**
- Create: `test/unit/agent-loop.test.js`
- Modify: `test/run-all.js` (add require for new test file)

**Step 1: Write tests for `sanitizeForLLM`, `extractPicksFromSms`, `deriveIntent`**

```javascript
const { check } = require('../helpers');
const { sanitizeForLLM, extractPicksFromSms, deriveIntent } = require('../../src/agent-loop');

// ---- sanitizeForLLM ----
console.log('\nsanitizeForLLM:');

check('strips _ prefixed keys', JSON.stringify(sanitizeForLLM({ foo: 1, _bar: 2 })) === '{"foo":1}');
check('passes through clean objects', JSON.stringify(sanitizeForLLM({ a: 1, b: 2 })) === '{"a":1,"b":2}');
check('handles null', sanitizeForLLM(null) === null);
check('handles undefined', sanitizeForLLM(undefined) === undefined);

// ---- extractPicksFromSms ----
console.log('\nextractPicksFromSms:');

const testEvents = [
  { id: 'e1', name: 'Jazz Night at Blue Note', venue_name: 'Blue Note' },
  { id: 'e2', name: 'Comedy Hour', venue_name: 'Tiny Cupboard' },
  { id: 'e3', name: 'Art Opening', venue_name: 'Pioneer Works' },
];

const sms1 = 'Check out Jazz Night at Blue Note and Comedy Hour at Tiny Cupboard tonight!';
const picks1 = extractPicksFromSms(sms1, testEvents);
check('finds 2 events in SMS', picks1.length === 2);
check('first pick is e1', picks1[0].event_id === 'e1');
check('second pick is e2', picks1[1].event_id === 'e2');
check('ranks are sequential', picks1[0].rank === 1 && picks1[1].rank === 2);

check('empty SMS returns empty', extractPicksFromSms('', testEvents).length === 0);
check('null SMS returns empty', extractPicksFromSms(null, testEvents).length === 0);
check('no matching events returns empty', extractPicksFromSms('Nothing here', testEvents).length === 0);

// ---- deriveIntent ----
console.log('\nderiveIntent:');

check('no tool calls → conversational', deriveIntent([]) === 'conversational');
check('null → conversational', deriveIntent(null) === 'conversational');

check('respond → its intent', deriveIntent([
  { name: 'respond', params: { intent: 'greeting' } }
]) === 'greeting');

check('search new_search → events', deriveIntent([
  { name: 'search_events', params: { intent: 'new_search' } }
]) === 'events');

check('search details → details', deriveIntent([
  { name: 'search_events', params: { intent: 'details' } }
]) === 'details');

check('search more → more', deriveIntent([
  { name: 'search_events', params: { intent: 'more' } }
]) === 'more');

check('multi-call: last search wins', deriveIntent([
  { name: 'search_events', params: { intent: 'new_search' } },
  { name: 'search_events', params: { intent: 'refine' } },
]) === 'events');
```

**Step 2: Add to test runner**

In `test/run-all.js`, add `require('./unit/agent-loop.test');` after the existing test requires.

**Step 3: Run tests**

Run: `npm test 2>&1 | tail -10`
Expected: All new tests pass, total count increases.

**Step 4: Commit**

```bash
git add test/unit/agent-loop.test.js test/run-all.js
git commit -m "test: unit tests for agent-loop.js pure functions"
```

---

### Task 4: Wire agent-loop.js into handler.js

**Files:**
- Modify: `src/handler.js:200-257` (replace `handleMessageAI`)
- Modify: `src/handler.js:174-198` (update `dispatchPreRouterIntent` to remove welcome references)

**Step 1: Update `handleMessageAI` to use the new agent loop**

Replace the `handleMessageAI` function in `src/handler.js`. Key changes:
- Import `handleAgentRequest` from `./agent-loop` instead of `handleAgentBrainRequest` from `./agent-brain`
- Remove the `isFirstMessage` / welcome bypass — everything goes through the agent
- Keep `checkMechanical` for help + TCPA (these are $0 mechanical shortcuts, per P6)

```javascript
async function handleMessageAI(phone, message) {
  const traceStart = Date.now();
  const masked = maskPhone(phone);
  let session = getSession(phone);
  const trace = startTrace(masked, message);

  if (session) {
    trace.session_before = {
      lastNeighborhood: session.lastNeighborhood || null,
      lastPicks: (session.lastPicks || []).map(p => ({ event_id: p.event_id })),
    };
  }

  function finalizeTrace(smsText, intent) {
    if (smsText) addToHistory(phone, 'assistant', smsText);
    trace.output_sms = smsText || null;
    trace.output_sms_length = smsText ? smsText.length : 0;
    trace.output_intent = intent || trace.routing.result?.intent || null;
    trace.total_latency_ms = Date.now() - traceStart;
    saveTrace(trace);

    const SLOW_THRESHOLD_MS = 10000;
    if (trace.total_latency_ms > SLOW_THRESHOLD_MS) {
      const breakdown = [
        `route: ${trace.routing.latency_ms}ms`,
        trace.events.getEvents_ms != null ? `events: ${trace.events.getEvents_ms}ms` : null,
        `compose: ${trace.composition.latency_ms}ms`,
        `total: ${trace.total_latency_ms}ms`,
      ].filter(Boolean).join(' | ');
      console.warn(`[SLOW] ${(trace.total_latency_ms / 1000).toFixed(1)}s | ${breakdown} | intent=${trace.output_intent} | msg="${trace.input_message.slice(0, 40)}"`);
    }
  }

  const { checkMechanical } = require('./agent-brain');

  // Mechanical pre-check: help + TCPA — $0 AI cost
  const mechanical = checkMechanical(message, session);
  if (mechanical) {
    if (!getSession(phone)) setSession(phone, {});
    addToHistory(phone, 'user', message);

    trace.routing.pre_routed = true;
    trace.routing.result = { intent: mechanical.intent, confidence: 1.0 };
    trace.routing.latency_ms = 0;
    trace.brain_tool = null;
    trace.brain_provider = 'mechanical';

    const route = { ...mechanical };
    const ctx = { phone, message, masked, session, trace, route, finalizeTrace, trackAICost: (usage, provider) => trackAICost(phone, usage, provider), recordAICost };
    await dispatchPreRouterIntent(route, ctx);
    return trace.id;
  }

  // Agent loop handles everything else
  const { handleAgentRequest } = require('./agent-loop');
  return handleAgentRequest(phone, message, session, trace, finalizeTrace);
}
```

**Step 2: Update `dispatchPreRouterIntent` — remove welcome/referral dependency on handleWelcome**

The referral path currently calls `handleWelcome`. Since we're deleting that, referrals should go through the agent loop too. Simplify to just send the message through the agent with a referral note in session:

```javascript
async function dispatchPreRouterIntent(route, ctx) {
  const { phone, session, trace, finalizeTrace } = ctx;

  if (route.intent === 'referral') {
    const referral = lookupReferralCode(route.referralCode);
    if (referral) recordAttribution(phone, route.referralCode);
    // Let the agent loop handle the welcome — fall through
    const { handleAgentRequest } = require('./agent-loop');
    return handleAgentRequest(phone, ctx.message, session, trace, finalizeTrace);
  }

  if (route.intent === 'help') return handleHelp(ctx);
}
```

**Step 3: Run tests**

Run: `npm test 2>&1 | tail -10`
Expected: All existing tests pass. The integration tests that mock the LLM will need API keys to fully work, but pure function tests should pass.

**Step 4: Commit**

```bash
git add src/handler.js
git commit -m "feat: wire agent-loop into handler.js, remove welcome bypass"
```

---

### Task 5: Simplify the system prompt

**Files:**
- Modify: `src/brain-llm.js:97-171` (`buildBrainSystemPrompt`)

**Step 1: Rewrite `buildBrainSystemPrompt`**

The prompt should be minimal — identity, domain hint, voice, format, curation. Let the model handle routing from tool descriptions.

```javascript
function buildBrainSystemPrompt(session) {
  const sessionContext = session
    ? [
      session.lastNeighborhood ? `Current neighborhood: ${session.lastNeighborhood}` : null,
      session.lastFilters && Object.values(session.lastFilters).some(Boolean)
        ? `Active filters: ${JSON.stringify(session.lastFilters)}`
        : null,
      session.lastPicks?.length
        ? `Last picks shown: ${session.lastPicks.map(p => {
          const evt = session.lastEvents?.[p.event_id];
          return evt ? `"${evt.name}" at ${evt.venue_name || 'unknown venue'}` : p.event_id;
        }).join(', ')}`
        : null,
      session.pendingNearby
        ? `Pending suggestion: "${session.pendingNearby}" (user was asked if they want picks there)`
        : null,
    ].filter(Boolean).join('\n')
    : 'No prior session.';

  const historyBlock = session?.conversationHistory?.length > 0
    ? '\nRecent conversation:\n' + session.conversationHistory.slice(-10).map(h => {
      if (h.role === 'user') return `User: "${h.content.slice(0, 150)}"`;
      if (h.role === 'tool_call' && h.meta) {
        const params = Object.entries(h.meta.params || {})
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(', ');
        return `> ${h.meta.name}(${params})`;
      }
      if (h.role === 'tool_result' && h.meta) {
        if (h.meta.match_count === 0) return '> No matches found';
        const picks = (h.meta.picks || []).map(p => `${p.name} (${p.category})`).join(', ');
        return `> ${h.meta.match_count} matches${h.meta.neighborhood ? ' in ' + h.meta.neighborhood : ''}${picks ? '. Showed: ' + picks : ''}`;
      }
      if (h.role === 'assistant') return `Pulse: "${h.content.slice(0, 150)}"`;
      return null;
    }).filter(Boolean).join('\n')
    : '';

  return `You are Pulse, an NYC nightlife and events SMS bot. You text like a plugged-in friend — warm, opinionated, concise.

A bare neighborhood name (e.g. "bushwick", "LES") means "show me events there" — call search_events.
If search returns zero results, you can try again with broader filters or nearby neighborhoods.

SESSION CONTEXT:
${sessionContext}${historyBlock}

SMS FORMAT:
- Each pick on its own line: Event Name — Venue, Neighborhood, time (price)
- EVERY pick MUST include: event name, venue name, start time, and price.
- Say "tonight" for today evening, "today at [time]" for afternoon. "tomorrow" for tomorrow.
- [NEARBY] events: mention the actual neighborhood. If ALL nearby, lead with "Not much in [hood] tonight, but nearby..."
- Under 480 characters total. No URLs.
- For details: write a rich description with venue, time, price. No URL (sent separately).

${curationTasteBlock(CURATION_DIVERSITY_DEFAULT)}`;
}
```

**Step 2: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: Same pass count.

**Step 3: Commit**

```bash
git add src/brain-llm.js
git commit -m "refactor: simplify brain system prompt — remove routing rules, keep voice + format"
```

---

### Task 6: Delete dead code

**Files:**
- Modify: `src/agent-brain.js` — remove `handleAgentBrainRequest`, `isFirstMessage`, welcome flow. Keep re-exports of pure functions (`checkMechanical`, `executeMore`, `executeDetails`, etc.)
- Modify: `src/brain-llm.js` — remove `continueWithResults`, `brainCompose`, `welcomeCompose`, `BRAIN_COMPOSE_SYSTEM`, `WELCOME_COMPOSE_SYSTEM`, `serializePoolForContinuation`, `reconcilePicks`
- Modify: `src/brain-execute.js` — remove `handleWelcome`, `executeSearchEvents`, `executeRespond`, `formatWelcomePick`, `welcomeTimeLabel`, `WELCOME_EMOJI`
- Modify: `src/model-config.js` — remove `compose` and `details` model roles (no longer separate LLM calls)

**Step 1: Gut `agent-brain.js`**

Keep only: `checkMechanical` and re-exports of pure functions from `brain-execute.js` that are used by the new `agent-loop.js` and tests.

```javascript
/**
 * Agent Brain — Mechanical pre-check (help + TCPA).
 * The agent loop in agent-loop.js handles everything else.
 */

const { OPT_OUT_KEYWORDS } = require('./request-guard');
const { executeMore, executeDetails } = require('./brain-execute');

function checkMechanical(message, session) {
  const lower = message.toLowerCase().trim();
  if (/^(help|\?)$/i.test(lower)) return { intent: 'help' };
  if (OPT_OUT_KEYWORDS.test(lower)) return null;
  return null;
}

module.exports = {
  checkMechanical,
  // Re-exports for tests
  executeMore,
  executeDetails,
};
```

**Step 2: Clean `brain-llm.js` exports**

Remove: `continueWithResults`, `brainCompose`, `welcomeCompose`, `BRAIN_COMPOSE_SYSTEM`, `WELCOME_COMPOSE_SYSTEM`, `serializePoolForContinuation`, `reconcilePicks` and their function bodies.

Keep: `BRAIN_TOOLS`, `buildBrainSystemPrompt`, `callAgentBrain` (still used? — check), `stripCodeFences`, `BRAIN_COMPOSE_SCHEMA`, curation taste blocks.

Actually, `callAgentBrain` is no longer used — the agent loop calls `runAgentLoop` directly. Remove it too. Keep `stripCodeFences` if used elsewhere.

Check what `agent-loop.js` imports from `brain-llm.js`: `BRAIN_TOOLS`, `buildBrainSystemPrompt`, `serializePoolForContinuation`. Keep those three plus `stripCodeFences`.

**Step 3: Clean `brain-execute.js`**

Remove: `handleWelcome`, `executeSearchEvents`, `executeRespond`, `formatWelcomePick`, `welcomeTimeLabel`, `WELCOME_EMOJI`, and the `brainCompose`/`welcomeCompose` import.

Keep: `resolveDateRange`, `executeMore`, `executeDetails`, `validatePicks`, `buildSearchPool`.

**Step 4: Clean `model-config.js`**

Remove `compose` and `details` roles — the agent loop only uses `brain` and `fallback`.

```javascript
const MODELS = {
  brain:    process.env.PULSE_MODEL_BRAIN    || 'gemini-2.5-flash-lite',
  extract:  process.env.PULSE_MODEL_EXTRACT  || 'claude-haiku-4-5-20251001',
  fallback: process.env.PULSE_MODEL_FALLBACK || 'claude-haiku-4-5-20251001',
};
```

Note: `extract` stays — it's used by `ai.js` for scrape-time event extraction, not the SMS pipeline.

**Step 5: Run tests**

Run: `npm test 2>&1 | tail -10`
Expected: All tests pass. The `agent-brain.test.js` tests for `checkMechanical`, `executeMore`, `executeDetails` should still pass since those functions are re-exported.

**Step 6: Commit**

```bash
git add src/agent-brain.js src/brain-llm.js src/brain-execute.js src/model-config.js
git commit -m "refactor: delete dead code — welcome flow, brainCompose, continueWithResults, 400-line switch"
```

---

### Task 7: Update CLAUDE.md and ROADMAP.md

**Files:**
- Modify: `CLAUDE.md` — update architecture diagram, module table, conversation flow
- Modify: `ROADMAP.md` — mark agent loop as completed work

**Step 1: Update CLAUDE.md**

Key changes:
- Architecture diagram: remove brainCompose/welcomeCompose/continueWithResults boxes, show the agent loop
- Module table: add `agent-loop.js`, update `agent-brain.js` description (now just checkMechanical), update `brain-llm.js` (now just tools + prompt), update `brain-execute.js` (pure tool implementations)
- Conversation flow: describe the agent loop instead of the step-by-step routing
- Model config: remove `compose` and `details` roles

**Step 2: Update ROADMAP.md**

Add to Completed Work: "Agent loop — replaced 400-line orchestrator with true multi-turn agent loop (2026-03-07)"

**Step 3: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: update architecture docs for agent loop"
```

---

### Task 8: Run evals and verify on Railway

**Files:** None modified — this is verification only.

**Step 1: Run smoke tests locally**

Run: `npm test`
Expected: All pass (894+).

**Step 2: Deploy to Railway**

Run: `railway up`
Wait ~3 minutes for build.

**Step 3: Run code evals (structural)**

Run: `node scripts/run-scenario-evals.js --url https://web-production-c8fdb.up.railway.app`
Expected: Code eval pass rate holds (no regressions in char limit, pick format, intent detection).

**Step 4: Manual smoke test on simulator**

Test these messages on the simulator:
- "hey" — should get a conversational welcome (NOT hardcoded event picks)
- "what are you?" — should get a conversational explanation
- "bushwick" — should get event picks
- "2" — should get details
- "more" — should get more picks
- "jazz in bushwick" with no results — should see the model handle it naturally (suggest nearby, broaden, etc.)

**Step 5: Commit any fixes**

If evals or manual testing surface issues, fix and commit.
