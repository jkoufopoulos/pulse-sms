# Refactored Architecture Sketch

Concrete code for the "Anthropic way" — unified search, conversation-as-state, one-iteration loop. Migration path is 4 independent steps, each shippable alone.

---

## Step 1: Unified search tool (replaces search_events + search_places + compose_sms)

### Tool definition

```javascript
const BRAIN_TOOLS_V2 = [
  {
    name: 'search',
    description: 'Search for things to do in NYC — events, bars, restaurants, or all of the above. Returns a curated pool ranked by interestingness. Write your SMS as plain text after seeing results.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what the user wants. Examples: "bars in williamsburg", "live music tonight", "something chill in bushwick", "dinner and a show in LES"',
        },
        neighborhood: { type: 'string', nullable: true, description: 'NYC neighborhood name' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['events', 'bars', 'restaurants'] },
          description: 'What to search for. Defaults to all relevant types based on query.',
        },
        filters: {
          type: 'object',
          nullable: true,
          description: 'Structured filters to narrow results',
          properties: {
            categories: { type: 'array', items: { type: 'string' }, nullable: true },
            free_only: { type: 'boolean' },
            time_after: { type: 'string', description: 'HH:MM 24hr', nullable: true },
            date_range: { type: 'string', enum: ['today', 'tomorrow', 'this_weekend', 'this_week'], nullable: true },
            vibe: { type: 'string', nullable: true },
          },
        },
        intent: {
          type: 'string',
          enum: ['discover', 'more', 'details'],
          description: 'discover = new or refined search. more = show more from same search. details = get details about a specific result.',
        },
        reference: {
          type: 'string', nullable: true,
          description: 'How user referenced a previous result ("2", "the bar one", "Elsewhere"). Only with intent: details.',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'respond',
    description: 'Reply conversationally when no search is needed. Greetings, thanks, farewells, off-topic.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'SMS text, max 480 chars.' },
        intent: { type: 'string', enum: ['greeting', 'thanks', 'farewell', 'off_topic', 'clarify'] },
      },
      required: ['message', 'intent'],
    },
  },
];
```

**What changed**: 5 tools → 2. `search` replaces `search_events`, `search_places`, `compose_sms`, and `show_welcome`. The model writes SMS as plain text after seeing search results (no compose_sms round-trip). `respond` stays for pure conversation.

### Tool execution

```javascript
async function executeSearchTool(params, conversationHistory) {
  const { intent, reference, neighborhood, types, filters, query } = params;

  // --- Details ---
  if (intent === 'details') {
    // Extract last search results from conversation history
    const lastResults = extractLastResults(conversationHistory);
    if (!lastResults) {
      return { not_found: true, message: "I don't have any picks loaded — tell me what you're looking for!" };
    }
    // Return full data for the referenced item(s)
    return resolveDetails(lastResults, reference);
  }

  // --- More ---
  if (intent === 'more') {
    const lastResults = extractLastResults(conversationHistory);
    if (!lastResults) {
      return { no_context: true, message: "Tell me what you're in the mood for!" };
    }
    return executeMoreFromHistory(lastResults, conversationHistory);
  }

  // --- Discover (new search, refine, pivot — all collapsed) ---
  const resolvedHood = neighborhood || extractNeighborhoodFromHistory(conversationHistory);
  const searchTypes = types || inferTypesFromQuery(query);

  const results = {};

  // Fire searches in parallel
  const promises = [];

  if (searchTypes.includes('events')) {
    promises.push(
      buildSearchPool({ neighborhood: resolvedHood, ...filters })
        .then(pool => { results.events = pool; })
    );
  }

  if (searchTypes.includes('bars') || searchTypes.includes('restaurants')) {
    const placeType = searchTypes.includes('bars') ? 'bar' : 'restaurant';
    promises.push(
      searchPlaces(resolvedHood, placeType, { vibe: filters?.vibe })
        .then(places => { results.places = places; })
    );
  }

  await Promise.all(promises);

  // Unified serialization — model sees one pool with type tags
  return serializeUnifiedResults(results, resolvedHood, filters);
}

/**
 * Infer search types from natural language query.
 * "best bars" → ['bars']. "what's happening" → ['events']. "dinner and a show" → ['restaurants', 'events'].
 */
function inferTypesFromQuery(query) {
  if (!query) return ['events'];
  const q = query.toLowerCase();

  const hasFood = /\b(eat|dinner|restaurant|food|brunch|lunch)\b/.test(q);
  const hasDrink = /\b(bar|bars|drink|cocktail|beer|wine|dive)\b/.test(q);
  const hasEvents = /\b(event|show|music|comedy|tonight|happening|going on)\b/.test(q);

  const types = [];
  if (hasFood) types.push('restaurants');
  if (hasDrink) types.push('bars');
  if (hasEvents || types.length === 0) types.push('events');
  return types;
}
```

### Unified result format (what the model sees)

```javascript
function serializeUnifiedResults(results, neighborhood, filters) {
  const items = [];

  // Events — pre-ranked by curation logic (source_vibe, scarcity, venue_size)
  if (results.events?.pool?.length) {
    for (const e of results.events.pool.slice(0, 12)) {
      items.push({
        type: 'event',
        id: e.id,
        name: cleanEventName(e.name),
        venue: e.venue_name,
        neighborhood: e.neighborhood,
        time: e.start_time_local,
        category: e.category,
        price: e.is_free ? 'Free' : e.price_display || null,
        detail: (e.short_detail || '').slice(0, 60),
        // Curation signals — pre-computed, model trusts the ranking
        recommended: e._rank <= 2,
        why: e._rank <= 2 ? buildRecommendationReason(e) : undefined,
        scarcity: e.scarcity || undefined,
        vibe: e.source_vibe || undefined,
        venue_size: e.venue_size || undefined,
      });
    }
  }

  // Places — pre-ranked by interestingness score
  if (results.places?.length) {
    for (const p of results.places.slice(0, 6)) {
      items.push({
        type: p.place_type, // 'bar' or 'restaurant'
        id: p.place_id,
        name: p.name,
        neighborhood: p.neighborhood,
        price: ['Free', '$', '$$', '$$$', '$$$$'][p.price_level] || null,
        rating: p.rating,
        summary: (p.editorial_summary || '').slice(0, 80) || undefined,
        features: [
          p.outdoor_seating && 'patio',
          p.good_for_groups && 'groups',
          p.live_music && 'live music',
          p.serves_cocktails && 'cocktails',
        ].filter(Boolean).join(', ') || undefined,
        maps_url: p.google_maps_url, // available for details
      });
    }
  }

  return {
    neighborhood: neighborhood || 'NYC',
    count: items.length,
    items,
    // Exhaustion / zero match signals
    exhausted: items.length === 0 ? true : undefined,
    suggested_neighborhood: results.events?.suggestedHood || undefined,
  };
}

/**
 * Pre-compute WHY an event is recommended so the model doesn't have to
 * interpret raw metadata. This replaces the 20 curation rules in the prompt.
 */
function buildRecommendationReason(event) {
  const reasons = [];
  if (event.scarcity === 'one-night-only') reasons.push('one-off, won\'t be back');
  if (event.source_vibe === 'discovery') reasons.push('underground radar pick');
  if (event.source_vibe === 'niche') reasons.push('local scene');
  if (event.editorial_signal) reasons.push('tastemaker-curated');
  if (event.venue_size === 'intimate') reasons.push('tiny room');
  if (event.interaction_format === 'interactive') reasons.push('participatory');
  return reasons.join(', ') || 'strong pick';
}
```

**Key insight**: Curation rules move from the system prompt into `buildRecommendationReason` and the ranking logic. The model sees `recommended: true, why: "one-off, underground radar pick, tiny room"` instead of reading 20 bullet points about how to interpret `source_vibe` and `venue_size`. Same editorial output, zero prompt tokens.

---

## Step 2: Conversation-as-state (replaces 15-field session)

### New session shape

```javascript
// Before: 15+ fields
{
  lastPicks, allPicks, allOfferedIds, lastEvents, lastNeighborhood,
  lastFilters, lastBorough, visitedHoods, pendingNearby, pendingFilters,
  pendingMessage, lastResponseHadPicks, lastPlaces, lastPlaceMap,
  lastResultType, conversationHistory, timestamp
}

// After: 3 fields
{
  messages: [          // Full conversation (replaces conversationHistory)
    { role: 'user', content: 'williamsburg' },
    { role: 'tool_call', name: 'search', params: {...} },
    { role: 'tool_result', name: 'search', content: {...} },   // full result
    { role: 'assistant', content: 'Williamsburg tonight —...' },
    { role: 'user', content: '2' },
    // ...
  ],
  offeredIds: ['e1', 'e2', 'e3'],  // dedup across "more" requests
  timestamp: Date.now(),
}
```

### How state is derived (not stored)

```javascript
/**
 * Extract last search results from conversation history.
 * Replaces: lastPicks, lastEvents, lastPlaces, lastPlaceMap, lastResultType,
 *           lastResponseHadPicks, lastNeighborhood, lastFilters
 */
function extractLastResults(messages) {
  // Walk backwards to find last tool_result from 'search'
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'tool_result' && msg.name === 'search') {
      return msg.content; // { items: [...], neighborhood, count }
    }
  }
  return null;
}

/**
 * Get the neighborhood context from conversation.
 * Replaces: lastNeighborhood
 */
function extractNeighborhoodFromHistory(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'tool_call' && msg.name === 'search' && msg.params?.neighborhood) {
      return msg.params.neighborhood;
    }
  }
  return null;
}

/**
 * Get all previously shown item IDs for "more" dedup.
 * Replaces: allOfferedIds, allPicks, visitedHoods
 */
function getShownIds(messages) {
  const ids = new Set();
  for (const msg of messages) {
    if (msg.role === 'tool_result' && msg.name === 'search') {
      for (const item of (msg.content?.items || [])) {
        ids.add(item.id);
      }
    }
  }
  return ids;
}
```

### Session save (the whole thing)

```javascript
// Before: saveResponseFrame with 15 params, setResponseState replacing 15 fields
// After:
function saveMessage(phone, role, content, meta) {
  const session = getSession(phone) || { messages: [], offeredIds: [], timestamp: 0 };
  session.messages.push({ role, ...meta, content });

  // Accumulate offered IDs from search results
  if (role === 'tool_result' && meta?.name === 'search') {
    for (const item of (content?.items || [])) {
      if (!session.offeredIds.includes(item.id)) {
        session.offeredIds.push(item.id);
      }
    }
  }

  // Trim to last 20 messages (~10 exchanges) to bound token cost
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  session.timestamp = Date.now();
  sessions.set(phone, session);
  scheduleDiskWrite();
}
```

**What disappeared**: `saveResponseFrame`, `setResponseState`, `saveSessionFromToolCalls` (170 lines), `extractPicksFromSms` (fuzzy matching), all mutual exclusion logic (places clearing events, events clearing places). The conversation history IS the state. No fields to sync. No fields to forget to clear.

### Token cost of full messages vs truncated snippets

```
Current:  10 turns × 300 chars truncated ≈ 750 tokens
Proposed: 10 turns × full messages       ≈ 2,500 tokens (user msgs ~50 tok, tool results ~150 tok, SMS ~100 tok each)

Delta: +1,750 tokens at turn 10 = +$0.000175 per request (Gemini Flash)
```

But you save ~2,000 tokens on the smaller system prompt and ~1,200 on eliminating the compose_sms iteration. Net savings even at conversation end.

---

## Step 3: Slim system prompt

### Before: ~2,900 tokens

75 neighborhood names, routing tables, 20 curation rules, tool flow decision trees, SMS voice guidelines (12 bullet points), details format rules, place curation rules.

### After: ~800 tokens

```javascript
function buildBrainSystemPromptV2(messages) {
  const nycNow = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric'
  });

  const isFirstMessage = !messages?.length;

  return `You are Pulse, an NYC nightlife SMS bot. You text like a plugged-in friend — warm, opinionated, max 480 chars.

TIME: ${nycNow}
${isFirstMessage ? 'NEW USER: Introduce yourself and ask what neighborhood they\'re in.\n' : ''}
RULES:
- Search first, ask later. Contrasting picks > clarifying questions.
- 1-2 picks. Lead with WHY it's good, not just name/time. Trust the "recommended" and "why" fields from search results.
- Events and places can mix naturally: "Grab a drink at [bar] then catch [show] around the corner."
- For details: lead with what the venue FEELS like, then the event, then logistics (time, price, address).
- After details, send the Google Maps URL or ticket URL as a separate message.
- "more" = show different results from same search. "2" or a name = details about that pick.
- Under 480 chars. No URLs in the main SMS. No prices in initial picks.
- Write SMS as plain text after search results. Do NOT call compose_sms.`;
}
```

**What moved out of the prompt**:
- Neighborhood list → the `search` tool resolves neighborhoods internally
- Routing rules (events vs places) → `inferTypesFromQuery` in tool execution
- Curation rules (20 bullet points) → `buildRecommendationReason` on each result item
- Tool flow decision tree → 2 tools with clear descriptions, model figures it out
- Voice details (12 bullets) → 3 sentences + the model's trained behavior

---

## Step 4: Simplified agent loop

### Before: handleAgentRequest (180 lines)

```
runAgentLoop → determine SMS (compose_sms > respond > text > template fallback)
→ rewriteIfTooLong → saveSessionFromToolCalls (200 lines, 6 branches)
→ price injection → sendSMS → sendPickUrls (event URLs) → place URL sending
```

### After: ~60 lines

```javascript
async function handleAgentRequest(phone, message, session, trace, finalizeTrace) {
  if (!session) session = { messages: [], offeredIds: [], timestamp: Date.now() };

  // Append user message
  saveMessage(phone, 'user', message);

  const systemPrompt = buildBrainSystemPromptV2(session.messages);

  const rawResults = [];
  const executeAndTrack = async (toolName, params) => {
    const result = await executeToolV2(toolName, params, session.messages);
    rawResults.push({ name: toolName, params, result });
    saveMessage(phone, 'tool_call', null, { name: toolName, params });
    saveMessage(phone, 'tool_result', result, { name: toolName });
    return sanitizeForLLM(result);
  };

  const loopResult = await runAgentLoop(
    MODELS.brain, systemPrompt, message, BRAIN_TOOLS_V2,
    executeAndTrack,
    { maxIterations: 3, timeout: 12000, stopTools: ['respond'] }
  );

  // SMS: respond.params.message or plain text from model
  const lastRespond = rawResults.reverse().find(r => r.name === 'respond');
  let smsText = lastRespond?.params?.message || loopResult.text;
  smsText = smsText || "Tell me what you're in the mood for — drop a neighborhood or a vibe.";
  smsText = smartTruncate(smsText);

  // Send SMS
  await sendSMS(phone, smsText);
  saveMessage(phone, 'assistant', smsText);

  // Send URLs for details (event ticket or Google Maps)
  const lastSearch = rawResults.find(r => r.name === 'search');
  if (lastSearch?.params?.intent === 'details') {
    const items = lastSearch.result?.items || [];
    const mentioned = findMentionedItems(smsText, items);
    for (const item of mentioned.slice(0, 1)) {
      const url = item.maps_url || item.ticket_url || item.source_url;
      if (url) await sendSMS(phone, url);
    }
  }

  finalizeTrace(smsText, deriveIntent(rawResults));
}
```

**What disappeared**:
- `saveSessionFromToolCalls` (170 lines, 6 branches) → `saveMessage` (10 lines, always runs)
- `validateComposeSms` → gone (no compose_sms tool)
- `rewriteIfTooLong` → only `smartTruncate` remains (model writes short text naturally with 480-char instruction)
- Price injection → gone (prices in tool results, model includes if relevant)
- `extractPicksFromSms` → `findMentionedItems` only used for URL sending, not session state
- Template fallback SMS → gone (model always writes text)
- Mutual exclusion logic → gone (no place/event state to sync)

---

## Migration path (4 independent steps)

Each step is shippable and testable alone. No big bang rewrite.

### Step 1: Drop compose_sms (smallest change, biggest latency win)

- Remove `compose_sms` from `BRAIN_TOOLS`
- Remove from `stopTools` in agent loop
- Remove `validateComposeSms`
- Remove price injection (model sees prices in pool already)
- Model writes SMS as plain text (already the fallback path)
- `extractPicksFromSms` still used for session save (unchanged)

**Risk**: Low. This path already works (it's the current fallback).
**Win**: -1 LLM iteration per search = ~500ms latency, ~30% cost reduction.

### Step 2: Merge search_events + search_places into `search`

- New `search` tool with `types` param
- `executeSearchTool` fires both in parallel when types = ['events', 'bars']
- Unified result format with `type` field on each item
- Keep old session save logic (derive picks from results)

**Risk**: Medium. Need to test that model correctly uses unified tool for all cases.
**Win**: "Dinner and a show" in 1 iteration. Simpler prompt routing.

### Step 3: Conversation-as-state

- Session becomes `{ messages, offeredIds, timestamp }`
- `saveMessage` replaces `saveResponseFrame` + `setResponseState`
- Tool results stored in conversation history
- `extractLastResults` derives state from history
- Delete: `saveResponseFrame`, `setResponseState`, `saveSessionFromToolCalls`

**Risk**: Higher. Full rewrite of session management. Need to verify "more" dedup and details still work.
**Win**: Delete ~250 lines. Adding new entity types = zero session changes.

### Step 4: Slim the system prompt

- Move curation rules into `buildRecommendationReason`
- Move routing logic into `inferTypesFromQuery`
- Prompt goes from ~2,900 to ~800 tokens
- Add `recommended: true, why: "..."` to search results

**Risk**: Medium. Model behavior changes when prompt shrinks. Need eval runs.
**Win**: -2,100 input tokens/request. Better model compliance (fewer rules = fewer ignored).

---

## Cost comparison at each step

All numbers for a typical 5-message conversation (Gemini 2.5 Flash pricing).

| Step | Cost/conversation | Latency/search | Lines deleted |
|------|-------------------|----------------|---------------|
| Current | $0.0030 | 2-3s (2 iterations) | — |
| After Step 1 (drop compose_sms) | $0.0021 (-30%) | 1.5-2s (1 iteration) | ~60 |
| After Step 2 (unified search) | $0.0019 (-37%) | 1.5-2s | ~40 |
| After Step 3 (conversation-as-state) | $0.0020 (-33%) | 1.5-2s | ~250 |
| After Step 4 (slim prompt) | $0.0016 (-47%) | 1.5-2s | ~30 |
| **All steps** | **$0.0016 (-47%)** | **1-1.5s (-50%)** | **~380** |

Step 3 is slightly more expensive than Step 2 because full conversation history costs more tokens than truncated snippets, but Step 4 recovers that by shrinking the prompt.

The big win isn't the $0.0014/conversation savings — it's that the next feature (transit directions, reservations, weather) is one function in `executeSearchTool` instead of 4 files and 3 session fields.
