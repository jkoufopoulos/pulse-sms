/**
 * Agent Brain — LLM-powered intent routing via Gemini Flash tool calling.
 *
 * Replaces the regex pre-router for everything except truly mechanical shortcuts
 * (bare numbers, "more", "help"). The brain understands user intent via tool
 * calling and returns structured params that drive deterministic event execution.
 *
 * Gated behind PULSE_AGENT_BRAIN=true for A/B testing.
 *
 * Architecture:
 *   1. checkMechanical() — $0, handles help/numbers/more
 *   2. callAgentBrain() — Gemini Flash tool call (~$0.0002)
 *   3. Tool execution — deterministic event fetch + filter + pool build ($0)
 *   4. Compose SMS — reuse existing compose path (~$0.0002)
 *   5. saveResponseFrame + sendSMS
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { extractNeighborhood, NEIGHBORHOODS, BOROUGHS, detectBorough } = require('./neighborhoods');
const { getAdjacentNeighborhoods } = require('./pre-router');
const { getEvents, getEventsForBorough, getEventsCitywide, getCacheStatus } = require('./events');
const { filterKidsEvents } = require('./curation');
const { buildTaggedPool, buildEventMap, saveResponseFrame, mergeFilters, buildZeroMatchResponse, describeFilters } = require('./pipeline');
const { sendSMS, maskPhone } = require('./twilio');
const { startTrace, saveTrace, recordAICost } = require('./traces');
const { getSession, setSession, addToHistory } = require('./session');
const { trackAICost } = require('./request-guard');
const { handleHelp, handleDetails, handleMore } = require('./intent-handlers');
const { updateProfile } = require('./preference-profile');
const { getNycDateString } = require('./geo');
const { smartTruncate } = require('./formatters');
const { OPT_OUT_KEYWORDS } = require('./request-guard');
const { sendRuntimeAlert } = require('./alerts');

// --- Neighborhood list for system prompt ---
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

// --- Gemini client ---
let geminiClient = null;
function getGeminiClient() {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return geminiClient;
}

const GEMINI_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

// --- Tool definitions (Gemini function calling format) ---

const BRAIN_TOOLS = [
  {
    functionDeclarations: [{
      name: 'search_events',
      description: 'Search for event recommendations. Use when the user wants to see events, asks about a neighborhood, mentions a category, or requests any kind of activity.',
      parameters: {
        type: 'OBJECT',
        properties: {
          neighborhood: { type: 'STRING', description: 'NYC neighborhood name, or empty string for citywide', nullable: true },
          category: {
            type: 'STRING', description: 'Primary event category filter. Use for single-category requests.',
            nullable: true,
            enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater',
              'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'],
          },
          categories: {
            type: 'ARRAY', description: 'Multiple category filters — use when user wants more than one type (e.g. "music and trivia", "comedy or art"). Events matching ANY category are included. Only use this OR category, not both.',
            nullable: true,
            items: {
              type: 'STRING',
              enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater',
                'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'],
            },
          },
          free_only: { type: 'BOOLEAN', description: 'Only show free events' },
          time_after: { type: 'STRING', description: 'Only events after this time, HH:MM 24hr format (e.g. "22:00")', nullable: true },
          date_range: {
            type: 'STRING', description: 'Date scope for the search',
            nullable: true,
            enum: ['today', 'tomorrow', 'this_weekend', 'this_week', 'next_week'],
          },
          intent: {
            type: 'STRING', description: 'What the user is doing: new_search (first request or starting over), refine (adding/tightening a filter), pivot (changing topic/category)',
            enum: ['new_search', 'refine', 'pivot'],
          },
        },
        required: ['intent'],
      },
    }, {
      name: 'get_details',
      description: 'Get details about a previously shown event pick. Use when the user sends a number referencing a pick list, or asks about a specific event from the list.',
      parameters: {
        type: 'OBJECT',
        properties: {
          pick_number: { type: 'INTEGER', description: 'Pick number 1-5 from the last shown list' },
        },
        required: ['pick_number'],
      },
    }, {
      name: 'respond',
      description: 'Respond conversationally when no event search is needed. Use for greetings, thanks, farewells, off-topic chat, or when the user needs clarification.',
      parameters: {
        type: 'OBJECT',
        properties: {
          message: { type: 'STRING', description: 'SMS response text, max 480 chars. Be warm, brief. ALWAYS end with a redirect to events (e.g. "Drop a neighborhood or tell me what you are in the mood for!" or "Text me a neighborhood to get started!")' },
          intent: {
            type: 'STRING',
            enum: ['greeting', 'thanks', 'farewell', 'off_topic', 'clarify', 'acknowledge'],
          },
        },
        required: ['message', 'intent'],
      },
    }],
  },
];

// --- System prompt for the brain ---

function buildBrainSystemPrompt(session) {
  const sessionContext = session
    ? [
      session.lastNeighborhood ? `Current neighborhood: ${session.lastNeighborhood}` : null,
      session.lastFilters && Object.values(session.lastFilters).some(Boolean)
        ? `Active filters: ${JSON.stringify(session.lastFilters)}`
        : null,
      session.lastPicks?.length
        ? `Last picks shown: ${session.lastPicks.map((p, i) => {
          const evt = session.lastEvents?.[p.event_id];
          return evt ? `#${i + 1} "${evt.name}"` : `#${i + 1}`;
        }).join(', ')}`
        : null,
      session.pendingNearby
        ? `Pending suggestion: "${session.pendingNearby}" (user was asked if they want picks there)`
        : null,
    ].filter(Boolean).join('\n')
    : 'No prior session.';

  const historyBlock = session?.conversationHistory?.length > 0
    ? '\nRecent conversation:\n' + session.conversationHistory.slice(-6).map(h =>
      `${h.role === 'user' ? 'User' : 'Bestie'}: ${h.content.slice(0, 120)}`
    ).join('\n')
    : '';

  return `You are the routing brain for Bestie, an NYC nightlife SMS bot.
Your ONLY job: understand what the user wants and call the right tool with the right parameters.
Do NOT write event recommendations — just route to the right tool.

CRITICAL RULE: When a user mentions ANY neighborhood name, borough name, or NYC location — ALWAYS call search_events. A bare neighborhood name like "williamsburg" or "LES" means "show me events there." This is the most common message type.

TOOLS:
- search_events: User wants events. Call this when the user mentions a neighborhood, borough, category, time, or anything event-related. When in doubt, prefer search_events over respond.
- get_details: User sent a number (1-5) referencing a pick list, or asked for details about a specific event.
- respond: ONLY for pure conversational messages with zero event intent: greetings ("hey"), thanks ("thanks!"), farewells ("bye"), or clearly off-topic questions. Write a brief warm SMS (max 480 chars).

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
- "comedy or art stuff in greenpoint" → search_events(neighborhood: "Greenpoint", categories: ["comedy", "art"], intent: "new_search")
- "trivia or art stuff in greenpoint" → search_events(neighborhood: "Greenpoint", categories: ["trivia", "art"], intent: "new_search")
- "jazz and comedy this weekend" → search_events(categories: ["live_music", "comedy"], date_range: "this_weekend", intent: "new_search")
- "something fun and free tonight" → search_events(free_only: true, date_range: "today", intent: "new_search")
- "how about comedy" → search_events(category: "comedy", intent: "refine")
- "later in the week" → search_events(date_range: "this_week", intent: "refine")
- "how about williamsburg" (with existing comedy filter) → search_events(neighborhood: "Williamsburg", intent: "refine") — keeps comedy filter!
- "try bushwick" (with existing categories) → search_events(neighborhood: "Bushwick", intent: "refine") — keeps existing categories!
- "actually trivia in greenpoint" → search_events(neighborhood: "Greenpoint", category: "trivia", intent: "pivot")
- "forget the comedy" → search_events(intent: "pivot")
- "2" → get_details(pick_number: 2)
- "tell me about number 3" → get_details(pick_number: 3)
- "thanks!" → respond(message: "Enjoy your night! Text me anytime 🌙", intent: "thanks")
- "hey" → respond(message: "Hey! Drop a neighborhood or tell me what you're in the mood for.", intent: "greeting")
- "yes" / "yeah" / "sure" (with pending suggestion) → search_events with the suggested neighborhood

MULTI-CATEGORY: When the user mentions 2+ categories ("music and trivia", "comedy or art"), use the categories array. For single categories, use the category field. Do not use both.

INTENT RULES for search_events:
- "new_search": First message with no prior session context, or user explicitly starting over
- "refine": Adding/changing a filter while keeping others. Includes neighborhood switches ("how about williamsburg", "try bushwick") — these should KEEP existing category/time filters. Also "also free", "after 10pm".
- "pivot": Explicitly changing what they're looking for ("forget the comedy", "actually trivia instead"). Only clears filters when user is abandoning their previous interest.
- When switching neighborhoods, prefer "refine" so categories/time filters persist
- When switching categories/topics, prefer "pivot" so stale filters are cleared

NEIGHBORHOOD RESOLUTION:
- Valid neighborhoods: ${NEIGHBORHOOD_NAMES.slice(0, 15).join(', ')}, and ${NEIGHBORHOOD_NAMES.length - 15} more.
- Common aliases: LES = Lower East Side, UES = Upper East Side, UWS = Upper West Side, EV = East Village, WV = West Village, HK = Hell's Kitchen, wburg = Williamsburg
- Borough names (Brooklyn, Queens, Manhattan, Bronx) → pass as neighborhood, system handles borough-level serving
- If user doesn't mention a location, leave neighborhood empty to inherit from session

DATE RANGE:
- "tonight" / "today" → "today"
- "tomorrow" → "tomorrow"
- "this weekend" / "saturday" → "this_weekend"
- "this week" / "later in the week" / "next few days" → "this_week"
- "next week" → "next_week"

SESSION CONTEXT:
${sessionContext}${historyBlock}`;
}

// --- Mechanical pre-check ---

function checkMechanical(message, session) {
  const lower = message.toLowerCase().trim();

  // Help
  if (/^(help|\?)$/i.test(lower)) return { intent: 'help' };

  // TCPA (belt-and-suspenders — request-guard already handles this)
  if (OPT_OUT_KEYWORDS.test(lower)) return null;

  // Bare numbers → details (only if picks loaded and last response had picks)
  if (/^[1-5]$/.test(lower) && session?.lastPicks?.length && session?.lastResponseHadPicks !== false) {
    return { intent: 'details', pick: parseInt(lower), event_reference: lower };
  }

  // "more" / "what else" → more picks (only if session has context)
  if (/^(more|show me more|what else|anything else|next)$/i.test(lower) && session?.lastPicks?.length) {
    return { intent: 'more' };
  }

  return null; // → agent brain
}

// --- Date range resolution ---

function resolveDateRange(value) {
  if (!value) return null;
  const todayNyc = getNycDateString(0);

  switch (value) {
    case 'today':
      return { start: todayNyc, end: todayNyc };
    case 'tomorrow': {
      const tmrw = getNycDateString(1);
      return { start: tmrw, end: tmrw };
    }
    case 'this_weekend': {
      // Find next Saturday
      const now = new Date();
      const nycDay = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
        .format(now).slice(0, 3) === 'Sat' ? 0 :
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
          .format(now).slice(0, 3) === 'Sun' ? 0 : -1);
      // Simpler: use day-of-week offset
      const dayParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(now);
      const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const currentDay = dayMap[dayParts] ?? 0;
      // If it's already Saturday or Sunday, weekend starts today
      if (currentDay === 6) {
        return { start: todayNyc, end: getNycDateString(1) };
      }
      if (currentDay === 0) {
        return { start: todayNyc, end: todayNyc };
      }
      // Friday — include today through Sunday
      if (currentDay === 5) {
        return { start: todayNyc, end: getNycDateString(2) };
      }
      const daysToSat = 6 - currentDay;
      return { start: getNycDateString(daysToSat), end: getNycDateString(daysToSat + 1) };
    }
    case 'this_week': {
      // Today through Sunday
      const dayParts2 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date());
      const dayMap2 = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const currentDay2 = dayMap2[dayParts2] ?? 0;
      const daysToSunday = currentDay2 === 0 ? 0 : 7 - currentDay2;
      return { start: todayNyc, end: getNycDateString(daysToSunday) };
    }
    case 'next_week': {
      const dayParts3 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date());
      const dayMap3 = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const currentDay3 = dayMap3[dayParts3] ?? 0;
      const daysToNextMon = currentDay3 === 0 ? 1 : 8 - currentDay3;
      return { start: getNycDateString(daysToNextMon), end: getNycDateString(daysToNextMon + 6) };
    }
    default:
      return null;
  }
}

// --- Call the agent brain (Gemini Flash with tool calling) ---

function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

async function callAgentBrain(message, session, phone, trace) {
  const systemPrompt = buildBrainSystemPrompt(session);
  const brainStart = Date.now();

  const genAI = getGeminiClient();
  if (!genAI) {
    throw new Error('GEMINI_API_KEY not set — agent brain requires Gemini');
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    tools: BRAIN_TOOLS,
    generationConfig: {
      maxOutputTokens: 256,
      temperature: 0,
    },
  });

  let result;
  try {
    result = await withTimeout(
      model.generateContent({ contents: [{ role: 'user', parts: [{ text: message }] }] }),
      10_000, 'callAgentBrain'
    );
  } catch (err) {
    // Fallback to Anthropic if Gemini fails
    console.warn(`Agent brain Gemini failed, falling back to Anthropic: ${err.message}`);
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
    // MALFORMED_FUNCTION_CALL or other non-STOP reasons — fall back to Anthropic
    if (finishReason === 'MALFORMED_FUNCTION_CALL' || finishReason === 'MAX_TOKENS') {
      console.warn(`Agent brain Gemini ${finishReason}, falling back to Anthropic`);
      return callAgentBrainAnthropic(message, session, phone, trace, brainStart);
    }
  }

  // Extract function call from response
  const parts = candidate?.content?.parts || [];
  const fnCall = parts.find(p => p.functionCall);
  if (!fnCall?.functionCall) {
    // No tool call — try to extract text response as conversational
    const textPart = parts.find(p => p.text);
    if (textPart?.text) {
      return {
        tool: 'respond',
        params: { message: smartTruncate(textPart.text), intent: 'clarify' },
        usage: extractGeminiUsage(response),
        provider: 'gemini',
        latency_ms: Date.now() - brainStart,
      };
    }
    // No tool call and no text — fall back to Anthropic
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
  };
}

function extractGeminiUsage(response) {
  const usageMetadata = response.usageMetadata;
  return usageMetadata ? {
    input_tokens: usageMetadata.promptTokenCount || 0,
    output_tokens: usageMetadata.candidatesTokenCount || 0,
  } : null;
}

// --- Anthropic fallback for brain ---

async function callAgentBrainAnthropic(message, session, phone, trace, brainStart) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const systemPrompt = buildBrainSystemPrompt(session);

  const anthropicTools = [
    {
      name: 'search_events',
      description: 'Search for event recommendations. Use when the user wants to see events.',
      input_schema: {
        type: 'object',
        properties: {
          neighborhood: { type: 'string', description: 'NYC neighborhood name or null for citywide' },
          category: { type: 'string', enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater', 'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'], description: 'Single category filter' },
          categories: { type: 'array', items: { type: 'string', enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater', 'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'] }, description: 'Multiple categories — use when user wants more than one type' },
          free_only: { type: 'boolean', description: 'Only show free events' },
          time_after: { type: 'string', description: 'Only events after this time, HH:MM 24hr format' },
          date_range: { type: 'string', enum: ['today', 'tomorrow', 'this_weekend', 'this_week', 'next_week'] },
          intent: { type: 'string', enum: ['new_search', 'refine', 'pivot'] },
        },
        required: ['intent'],
      },
    },
    {
      name: 'get_details',
      description: 'Get details about a previously shown event pick.',
      input_schema: {
        type: 'object',
        properties: {
          pick_number: { type: 'integer', description: 'Pick number 1-5' },
        },
        required: ['pick_number'],
      },
    },
    {
      name: 'respond',
      description: 'Respond conversationally when no event search is needed.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'SMS response text, max 480 chars. ALWAYS end with a redirect to events (e.g. "Drop a neighborhood or tell me what you are in the mood for!")' },
          intent: { type: 'string', enum: ['greeting', 'thanks', 'farewell', 'off_topic', 'clarify', 'acknowledge'] },
        },
        required: ['message', 'intent'],
      },
    },
  ];

  const response = await withTimeout(client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: systemPrompt,
    tools: anthropicTools,
    messages: [{ role: 'user', content: message }],
  }, { timeout: 10000 }), 12000, 'callAgentBrainAnthropic');

  const toolBlock = response.content.find(b => b.type === 'tool_use');
  if (!toolBlock) {
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      return {
        tool: 'respond',
        params: { message: smartTruncate(textBlock.text), intent: 'clarify' },
        usage: response.usage || null,
        provider: 'anthropic',
        latency_ms: Date.now() - brainStart,
      };
    }
    throw new Error('Agent brain Anthropic returned no tool call');
  }

  return {
    tool: toolBlock.name,
    params: toolBlock.input || {},
    usage: response.usage || null,
    provider: 'anthropic',
    latency_ms: Date.now() - brainStart,
  };
}

// --- Lightweight compose for brain path ---
// ~400 tokens system prompt vs ~2000+ for unified. No routing, no intent, just write the SMS.

const BRAIN_COMPOSE_SYSTEM = `You are Bestie, an NYC nightlife SMS bot. Write a short, warm SMS recommending events.

FORMAT (MANDATORY — always use numbered picks):
Line 1: Short intro (e.g. "Tonight in East Village:")
Then numbered events:
1) Event Name at Venue — your take. Time, price
2) Event Name at Venue — your take. Time, price
3) Event Name at Venue — your take. Time, price
Last line: "Reply 1-N for details, MORE for extra picks, or FREE for free events"

RULES:
- Pick 1-3 best events from the provided list. Prefer [MATCH] events first, then others.
- Prefer TODAY over tomorrow. Prefer soonest events.
- EVERY pick MUST include: event name, venue name, your opinionated take, start time, and price ("$20", "free", "cover")
- Label TODAY as "tonight", TOMORROW as "tomorrow", further out by day name
- [NEARBY] events are from adjacent neighborhoods — you MUST label each with its actual neighborhood in parentheses, e.g. "at Venue (Fort Greene)". If ALL picks are [NEARBY], lead with "Not much in [hood] tonight, but nearby:"
- If SPARSE, be honest about slim pickings but still show what's available
- Under 480 characters total. No URLs.
- Voice: friend texting. Opinionated, concise, warm.

Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST match the numbered events in sms_text.`;

const BRAIN_COMPOSE_SCHEMA = {
  type: 'object',
  properties: {
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
  required: ['sms_text', 'picks'],
};

/**
 * Strip markdown code fences from LLM JSON responses.
 */
function stripCodeFences(text) {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Lightweight compose — Gemini Flash with minimal prompt, Anthropic fallback.
 * Returns { sms_text, picks, _raw, _usage, _provider }
 */
async function brainCompose(events, options = {}) {
  const { neighborhood, isSparse, isCitywide, isBorough, borough, nearbyHoods,
          suggestedNeighborhood, matchCount, excludeIds, activeFilters } = options;
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);

  // Build compact event list
  const eventListStr = events.map(e => {
    const dayLabel = e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local;
    const tag = e.filter_match === 'hard' ? '[MATCH] ' : e.filter_match === 'soft' ? '[SOFT] ' : '';
    const nearbyTag = (neighborhood && e.neighborhood && e.neighborhood !== neighborhood) ? '[NEARBY] ' : '';
    return `${tag}${nearbyTag}${JSON.stringify({
      id: e.id, name: (e.name || '').slice(0, 80), venue_name: e.venue_name,
      neighborhood: e.neighborhood, day: dayLabel, start_time_local: e.start_time_local,
      is_free: e.is_free, price_display: e.price_display, category: e.category,
      short_detail: (e.short_detail || e.description_short || '').slice(0, 100),
    })}`;
  }).join('\n');

  const hoodLabel = isBorough ? `${borough} (borough-wide)` : isCitywide ? 'citywide' : neighborhood || 'NYC';
  const filterDesc = activeFilters && Object.values(activeFilters).some(Boolean) ? describeFilters(activeFilters) : '';
  const sparseNote = isSparse ? `\nSPARSE: Few matches. Suggest nearby: ${(nearbyHoods || []).join(', ')}` : '';
  const excludeNote = excludeIds?.length > 0 ? `\nEXCLUDED (already shown): ${excludeIds.join(', ')}` : '';
  const suggestNote = suggestedNeighborhood ? `\nSuggest ${suggestedNeighborhood} as nearby alternative.` : '';

  const userPrompt = `Neighborhood: ${hoodLabel}${filterDesc ? `\nFilter: ${filterDesc}` : ''}\nMATCH count: ${matchCount}${sparseNote}${excludeNote}${suggestNote}\n\nEVENTS (${events.length}):\n${eventListStr}`;

  // Try Gemini Flash first
  const genAI = getGeminiClient();
  if (genAI) {
    try {
      // Use flash-lite for compose — minimal thinking, much faster for simple generation
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
        systemInstruction: BRAIN_COMPOSE_SYSTEM,
        safetySettings: GEMINI_SAFETY,
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.6,
          responseMimeType: 'application/json',
          responseSchema: BRAIN_COMPOSE_SCHEMA,
        },
      });
      const result = await withTimeout(
        model.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
        10_000, 'brainCompose'
      );
      const text = result.response.text();
      const usage = { input_tokens: result.response.usageMetadata?.promptTokenCount || 0,
                      output_tokens: result.response.usageMetadata?.candidatesTokenCount || 0 };
      const parsed = JSON.parse(stripCodeFences(text));
      return { sms_text: smartTruncate(parsed.sms_text), picks: parsed.picks || [], _raw: text, _usage: usage, _provider: 'gemini' };
    } catch (err) {
      console.warn('brainCompose Gemini failed, falling back to Anthropic:', err.message);
    }
  }

  // Anthropic fallback
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await withTimeout(client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: BRAIN_COMPOSE_SYSTEM + '\n\nReturn ONLY valid JSON, no other text.',
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 10000 }), 12000, 'brainCompose-anthropic');
  const raw = response.content?.[0]?.text || '';
  const usage = response.usage || {};
  const parsed = JSON.parse(stripCodeFences(raw));
  return { sms_text: smartTruncate(parsed.sms_text), picks: parsed.picks || [], _raw: raw, _usage: usage, _provider: 'anthropic' };
}

// --- Tool execution: search_events ---

async function executeSearchEvents(params, session, phone, trace) {
  // 1. Resolve neighborhood from brain params or session
  let hood = null;
  let borough = null;
  let isBorough = false;
  let isCitywide = false;

  if (params.neighborhood) {
    // Try to resolve as neighborhood first
    hood = extractNeighborhood(params.neighborhood);
    if (!hood) {
      // Try as borough
      const boroughResult = detectBorough(params.neighborhood);
      if (boroughResult) {
        isBorough = true;
        borough = boroughResult.borough;
      }
    }
  }

  // Fall back to session neighborhood if brain didn't specify one
  if (!hood && !borough && !isCitywide) {
    if (params.intent === 'new_search' && !params.neighborhood) {
      // New search with no neighborhood — citywide
      isCitywide = true;
    } else {
      hood = session?.lastNeighborhood || null;
      if (!hood) {
        const lastBorough = session?.lastBorough;
        if (lastBorough) {
          isBorough = true;
          borough = lastBorough;
        } else {
          isCitywide = true;
        }
      }
    }
  }

  // 2. Build filters from tool params
  const toolFilters = {};
  if (params.categories && Array.isArray(params.categories) && params.categories.length > 0) {
    // Multi-category: store as array for OR matching in buildTaggedPool
    toolFilters.categories = params.categories;
  } else if (params.category) {
    toolFilters.category = params.category;
  }
  if (params.free_only) toolFilters.free_only = true;
  if (params.time_after && /^\d{2}:\d{2}$/.test(params.time_after)) toolFilters.time_after = params.time_after;
  if (params.date_range) toolFilters.date_range = resolveDateRange(params.date_range);

  // 3. Merge or replace based on intent
  let activeFilters;
  if (params.intent === 'pivot' || params.intent === 'new_search') {
    activeFilters = toolFilters;
  } else {
    // refine — compound with existing
    activeFilters = mergeFilters(session?.lastFilters, toolFilters);
  }

  // 4. Fetch events
  let events = [];
  let curated = [];
  const eventsStart = Date.now();

  if (hood) {
    const raw = await getEvents(hood, { dateRange: activeFilters.date_range });
    curated = filterKidsEvents(raw);
  } else if (isBorough && borough) {
    const raw = await getEventsForBorough(borough, { dateRange: activeFilters.date_range, filters: activeFilters });
    curated = filterKidsEvents(raw);
  } else {
    isCitywide = true;
    const raw = await getEventsCitywide({ dateRange: activeFilters.date_range, filters: activeFilters });
    curated = filterKidsEvents(raw);
  }

  trace.events.getEvents_ms = Date.now() - eventsStart;
  trace.events.cache_size = getCacheStatus().cache_size;
  trace.events.candidates_count = curated.length;
  trace.events.candidate_ids = curated.map(e => e.id);

  // 5. Build tagged pool
  const taggedResult = buildTaggedPool(curated, activeFilters, { citywide: isCitywide || isBorough });
  events = taggedResult.pool;
  const { matchCount, hardCount, softCount, isSparse } = taggedResult;

  trace.events.sent_to_claude = events.length;
  trace.events.sent_ids = events.map(e => e.id);
  trace.events.sent_pool = events.map(e => ({
    id: e.id, name: e.name, venue_name: e.venue_name, neighborhood: e.neighborhood,
    category: e.category, start_time_local: e.start_time_local, date_local: e.date_local,
    is_free: e.is_free, price_display: e.price_display, source_name: e.source_name,
    filter_match: e.filter_match, ticket_url: e.ticket_url || null,
  }));
  trace.events.pool_meta = { matchCount, hardCount, softCount, isSparse };

  // 6. Zero match → deterministic response
  const nearbyHoods = hood ? getAdjacentNeighborhoods(hood, 3) : [];
  if (matchCount === 0 && Object.values(activeFilters).some(Boolean)) {
    const zeroResp = buildZeroMatchResponse(hood, activeFilters, nearbyHoods);
    trace.composition.latency_ms = 0;
    trace.composition.zero_match_bypass = true;
    trace.composition.zero_match_source = zeroResp.source;
    trace.composition.active_filters = activeFilters;
    trace.composition.neighborhood_used = hood;

    const eventMap = buildEventMap(curated);
    saveResponseFrame(phone, {
      picks: session?.lastPicks || [],
      eventMap: Object.keys(eventMap).length > 0 ? eventMap : (session?.lastEvents || {}),
      neighborhood: hood,
      borough,
      filters: Object.values(activeFilters).some(Boolean) ? activeFilters : null,
      offeredIds: session?.allOfferedIds || [],
      visitedHoods: session?.visitedHoods || [],
      pending: zeroResp.suggestedHood ? { neighborhood: zeroResp.suggestedHood, filters: activeFilters } : null,
      lastResponseHadPicks: false,
    });
    setSession(phone, { lastZeroMatch: true });

    return { sms: zeroResp.message, intent: 'events', picks: [], activeFilters };
  }

  // 7. Compose SMS from pool via lightweight brain compose
  const prevPickIds = (session?.allPicks || session?.lastPicks || []).map(p => p.event_id);
  const prevOfferedIds = session?.allOfferedIds || [];
  const excludeIds = [...new Set([...prevPickIds, ...prevOfferedIds])];
  const suggestedHood = (isSparse || matchCount === 0) && nearbyHoods.length > 0 ? nearbyHoods[0] : null;

  const composeStart = Date.now();
  const result = await brainCompose(events, {
    neighborhood: hood,
    nearbyHoods,
    activeFilters,
    isSparse,
    isCitywide,
    isBorough,
    borough,
    matchCount,
    excludeIds,
    suggestedNeighborhood: suggestedHood,
  });
  trace.composition.latency_ms = Date.now() - composeStart;
  trace.composition.raw_response = result._raw || null;
  trace.composition.active_filters = activeFilters;
  trace.composition.neighborhood_used = hood;

  recordAICost(trace, 'compose', result._usage, result._provider);
  trackAICost(phone, result._usage, result._provider);

  // Validate picks
  const eventMap = buildEventMap(curated);
  for (const e of events) eventMap[e.id] = e;
  const validPicks = (result.picks || []).filter(p => eventMap[p.event_id]);

  trace.composition.picks = validPicks.map(p => {
    const evt = eventMap[p.event_id];
    return {
      ...p,
      date_local: evt?.date_local || null,
      event_name: evt?.name || null,
      venue_name: evt?.venue_name || null,
      neighborhood: evt?.neighborhood || null,
      category: evt?.category || null,
      is_free: evt?.is_free ?? null,
      price_display: evt?.price_display || null,
      start_time_local: evt?.start_time_local || null,
    };
  });

  // 8. Save session — tool params become the state (P1: code owns state)
  saveResponseFrame(phone, {
    picks: validPicks,
    eventMap,
    neighborhood: hood,
    borough,
    filters: activeFilters,
    offeredIds: validPicks.map(p => p.event_id),
    visitedHoods: [...new Set([...(session?.visitedHoods || []), hood || borough || 'citywide'])],
    pending: suggestedHood ? { neighborhood: suggestedHood, filters: activeFilters } : null,
  });

  updateProfile(phone, { neighborhood: hood, filters: activeFilters, responseType: 'event_picks' })
    .catch(err => console.error('profile update failed:', err.message));

  return {
    sms: result.sms_text,
    intent: validPicks.length > 0 ? 'events' : 'conversational',
    picks: validPicks,
    activeFilters,
  };
}

// --- Tool execution: get_details ---

async function executeGetDetails(params, session, phone, trace) {
  // Reuse existing handleDetails by building a ctx-like object
  const route = {
    intent: 'details',
    event_reference: String(params.pick_number),
  };

  // Return info so handleAgentBrainRequest can dispatch
  return { dispatchMechanical: true, route };
}

// --- Tool execution: respond ---

async function executeRespond(params, session, phone, trace) {
  const sms = smartTruncate(params.message || "Hey! Tell me a neighborhood or what you're in the mood for.");

  // Preserve existing session state
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

  // Map brain intents to valid system intents (greeting/thanks/farewell/etc → conversational)
  return { sms, intent: 'conversational' };
}

// --- Main orchestrator ---

async function handleAgentBrainRequest(phone, message, session, trace, finalizeTrace) {
  const masked = maskPhone(phone);

  // Snapshot history BEFORE adding current message
  const history = session?.conversationHistory || [];
  if (!getSession(phone)) setSession(phone, {});
  addToHistory(phone, 'user', message);

  try {
    // Call the brain
    const brainResult = await callAgentBrain(message, session, phone, trace);

    // Record brain trace data
    trace.brain_tool = brainResult.tool;
    trace.brain_params = brainResult.params;
    trace.brain_latency_ms = brainResult.latency_ms;
    trace.brain_provider = brainResult.provider;
    trace.routing.pre_routed = false;
    trace.routing.latency_ms = brainResult.latency_ms;
    trace.routing.provider = brainResult.provider;
    // Populate model_routing for eval compatibility
    trace.routing.model_routing = {
      score: 0,
      tier: 'brain',
      model: brainResult.provider === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-4.5',
    };

    recordAICost(trace, 'brain', brainResult.usage, brainResult.provider);
    trackAICost(phone, brainResult.usage, brainResult.provider);

    console.log(`Agent brain: tool=${brainResult.tool}, params=${JSON.stringify(brainResult.params)}, provider=${brainResult.provider}, ${brainResult.latency_ms}ms`);

    // Execute the tool
    let execResult;

    if (brainResult.tool === 'search_events') {
      execResult = await executeSearchEvents(brainResult.params, session, phone, trace);
    } else if (brainResult.tool === 'get_details') {
      execResult = await executeGetDetails(brainResult.params, session, phone, trace);

      if (execResult.dispatchMechanical) {
        // Dispatch to existing handleDetails
        const ctx = {
          phone, message, masked, session, trace,
          route: execResult.route,
          finalizeTrace,
          trackAICost: (usage, provider) => trackAICost(phone, usage, provider),
          recordAICost,
        };
        await handleDetails(ctx);
        return trace.id;
      }
    } else if (brainResult.tool === 'respond') {
      execResult = await executeRespond(brainResult.params, session, phone, trace);
    } else {
      // Unknown tool — treat as conversational
      execResult = { sms: "Having a moment — try again!", intent: 'conversational' };
    }

    // Send SMS and finalize
    await sendSMS(phone, execResult.sms);
    finalizeTrace(execResult.sms, execResult.intent);

  } catch (err) {
    console.error('Agent brain error:', err.message);
    trace.brain_error = err.message;

    // Send a friendly error message
    const sms = "Bestie hit a snag — try again in a sec!";
    await sendSMS(phone, sms);
    finalizeTrace(sms, 'error');

    sendRuntimeAlert('agent_brain_error', {
      error: err.message,
      phone_masked: masked,
      message: message.slice(0, 80),
    });
  }

  return trace.id;
}

module.exports = { checkMechanical, callAgentBrain, handleAgentBrainRequest, resolveDateRange };
