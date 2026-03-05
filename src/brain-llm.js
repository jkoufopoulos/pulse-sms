/**
 * brain-llm.js — LLM calling, continuation, and compose for the agent brain.
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { NEIGHBORHOODS } = require('./neighborhoods');
const { getNycDateString } = require('./geo');
const { describeFilters } = require('./pipeline');
const { smartTruncate } = require('./formatters');

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
            type: 'STRING', description: 'What the user is doing: new_search (first request or starting over), refine (adding/tightening a filter), pivot (changing topic/category), more (show additional picks from same search), details (get details about a specific pick)',
            enum: ['new_search', 'refine', 'pivot', 'more', 'details'],
          },
          pick_reference: {
            type: 'STRING',
            description: 'How the user referenced a previously shown pick. Can be a number ("2"), event name ("the comedy one"), or venue name ("Elsewhere"). Only used with intent: "details".',
            nullable: true,
          },
        },
        required: ['intent'],
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

  return `You are the routing brain for Pulse, an NYC nightlife SMS bot.
Your job: understand what the user wants, call the right tool, and — when you receive event results back — write a warm, opinionated SMS with picks.

CRITICAL RULE: When a user mentions ANY neighborhood name, borough name, or NYC location — ALWAYS call search_events. A bare neighborhood name like "williamsburg" or "LES" means "show me events there." This is the most common message type.

TOOLS:
- search_events: User wants events OR wants to interact with previously shown events. Call this for: neighborhoods, categories, time filters, "more" / "what else", detail requests (numbers, event names, "tell me about..."), and anything event-related. When in doubt, prefer search_events over respond.
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
- "how about comedy" → search_events(category: "comedy", intent: "refine")
- "later in the week" → search_events(date_range: "this_week", intent: "refine")
- "try bushwick" (with existing categories) → search_events(neighborhood: "Bushwick", intent: "refine")
- "actually trivia in greenpoint" → search_events(neighborhood: "Greenpoint", category: "trivia", intent: "pivot")
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

MULTI-CATEGORY: When the user mentions 2+ categories ("music and trivia", "comedy or art"), use the categories array. For single categories, use the category field. Do not use both.

INTENT RULES for search_events:
- "new_search": First message with no prior session context, or user explicitly starting over
- "refine": Adding/changing a filter while keeping others. Includes neighborhood switches. Also "also free", "after 10pm".
- "pivot": Explicitly changing what they're looking for ("forget the comedy", "actually trivia instead")
- "more": User wants more picks from the same search ("more", "what else", "next", "keep going", "anything else")
- "details": User is asking about a specific event from the last batch. Set pick_reference to however they referenced it ("2", "the comedy one", "Tiny Cupboard", "tell me about the DJ set")
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
${sessionContext}${historyBlock}

AFTER TOOL EXECUTION:
When you call search_events and receive event results back, write the SMS response directly as JSON.

COMPOSE RULES:
- Write natural, conversational prose — NOT a numbered list. Weave 1-3 picks into a warm message like a friend texting.
- Example: "Tiny Cupboard's got a free open mic tonight at 8, and there's a killer jazz quartet at Blue Note at 9:30 ($20). Or if you want something weird, there's an immersive art thing in Bushwick at 10. Any of these sound good?"
- Prefer TODAY over tomorrow. Prefer soonest events.
- Favor discovery: big concerts/touring acts are the default — everyone already knows about them. Unless the user asked for music/concerts/shows, deprioritize them. Lead with source_vibe:"discovery" events, intimate venues, interesting one-offs. When you see interaction_format:"interactive" + recurring, mention it naturally ("every Tuesday, great for becoming a regular").
- EVERY pick MUST include: event name, venue name, your opinionated take, start time, and price ("$20", "free", "cover")
- Label TODAY as "tonight", TOMORROW as "tomorrow", further out by day name
- [NEARBY] events: mention the actual neighborhood naturally (e.g. "over in Fort Greene")
- If ALL picks are [NEARBY], lead with "Not much in [hood] tonight, but nearby..."
- If SPARSE, be honest about slim pickings but still show what's available
- Under 480 characters total. No URLs.
- Voice: friend texting. Opinionated, concise, warm.
- CONNECT your SMS to what the user originally asked.
- For DETAILS responses: write a rich, opinionated detail message including venue, time, price, description, and URL. Under 480 chars.
- For MORE responses with is_last_batch=true: mention these are the last picks and suggest trying a different neighborhood if suggestions are provided. Do NOT say "reply MORE".

Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.`;
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
    model: 'gemini-2.5-flash-lite',
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    tools: BRAIN_TOOLS,
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0,
    },
  });

  const chat = model.startChat();
  let result;
  try {
    result = await withTimeout(
      chat.sendMessage(message),
      10_000, 'callAgentBrain'
    );
  } catch (err) {
    // Fallback to Anthropic if Gemini fails
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
        chat: null,
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
    chat,
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
          intent: { type: 'string', enum: ['new_search', 'refine', 'pivot', 'more', 'details'] },
          pick_reference: { type: 'string', description: 'Reference to a previously shown pick (number, name, or venue). Used with intent: details.' },
        },
        required: ['intent'],
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
        chat: null,
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
    chat: null,
  };
}

/**
 * Continue the Gemini chat session with search_events results.
 * Sends functionResponse → model writes SMS in the same context.
 * Returns { sms_text, picks, _raw, _usage, _provider }
 */
async function continueWithResults(chat, eventData, trace) {
  const composeStart = Date.now();

  try {
    const result = await withTimeout(
      chat.sendMessage([{
        functionResponse: {
          name: 'search_events',
          response: eventData,
        },
      }]),
      10_000, 'continueWithResults'
    );

    const response = result.response;
    const text = response.text();
    const usage = extractGeminiUsage(response);

    trace.composition.latency_ms = Date.now() - composeStart;

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
    throw err;
  }
}

/**
 * Serialize event pool into compact format for Gemini functionResponse.
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

// --- Lightweight compose for brain path ---
// ~400 tokens system prompt vs ~2000+ for unified. No routing, no intent, just write the SMS.

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

const WELCOME_COMPOSE_SYSTEM = `You are Pulse, an NYC nightlife and events SMS bot. Compose a WELCOME message for a brand-new user.

FORMAT (MANDATORY):
Line 1: "I'm Pulse \u2014 your plugged-in friend for NYC. Tell me what you're into tonight, just ask. Here's a few things on my radar:"
Blank line
Then 3 numbered picks with emoji category markers:
1) [emoji] Event description \u2014 time, price
2) [emoji] Event description \u2014 time, price
3) [emoji] Event description \u2014 time, price
Blank line
Last line: "Any of those sound good? Or tell me a vibe, a neighborhood, whatever."

EMOJI MAP:
comedy/theater: \ud83c\udfad
live_music/jazz/dj/nightlife: \ud83c\udfb5
art: \ud83c\udfa8
film: \ud83c\udfac
community/trivia/food_drink: \ud83c\udf89
other: \u2728

RULES:
- Pick exactly 3 events from the provided list. They are pre-ranked by interestingness \u2014 respect the ranking but you may reorder slightly for narrative flow.
- Each pick MUST include: event name, venue name, neighborhood in parentheses, time, and price ("$20", "free", "cover").
- Make each pick sound like a tip from a friend who just found out about it. Opinionated, vivid, concise.
- Label TODAY events as "tonight", TOMORROW as "tomorrow".
- Under 480 characters total. No URLs.
- Do NOT change the intro line or the CTA line \u2014 use them exactly as specified above.

Return JSON: { "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id", "why": "short reason"}] }`;

/**
 * Strip markdown code fences from LLM JSON responses.
 */
function stripCodeFences(text) {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * After smartTruncate, some numbered picks may have been cut off.
 * Reconcile the picks array to match what actually appears in the SMS.
 */
function reconcilePicks(smsText, picks) {
  if (!picks || picks.length === 0) return picks;
  // Count how many numbered picks (e.g. "1)", "2)") appear in the truncated SMS
  const visibleCount = (smsText.match(/^\d\)/gm) || []).length;
  if (visibleCount > 0 && visibleCount < picks.length) {
    return picks.slice(0, visibleCount);
  }
  return picks;
}

/**
 * Lightweight compose — Gemini Flash with minimal prompt, Anthropic fallback.
 * Returns { sms_text, picks, _raw, _usage, _provider }
 */
async function brainCompose(events, options = {}) {
  const { neighborhood, isSparse, isCitywide, isBorough, borough, nearbyHoods,
          suggestedNeighborhood, matchCount, excludeIds, activeFilters,
          isLastBatch, exhaustionMessage } = options;
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
      recurring: e.is_recurring ? e.recurrence_label : undefined,
      venue_size: e.venue_size || undefined,
      interaction_format: e.interaction_format || undefined,
      source_vibe: e.source_vibe || undefined,
    })}`;
  }).join('\n');

  const hoodLabel = isBorough ? `${borough} (borough-wide)` : isCitywide ? 'citywide' : neighborhood || 'NYC';
  const filterDesc = activeFilters && Object.values(activeFilters).some(Boolean) ? describeFilters(activeFilters) : '';
  const sparseNote = isSparse ? `\nSPARSE: Few matches. Suggest nearby: ${(nearbyHoods || []).join(', ')}` : '';
  const excludeNote = excludeIds?.length > 0 ? `\nEXCLUDED (already shown): ${excludeIds.join(', ')}` : '';
  const suggestNote = suggestedNeighborhood ? `\nSuggest ${suggestedNeighborhood} as nearby alternative.` : '';

  const lastBatchNote = isLastBatch ? `\nLAST BATCH: These are the final picks. Do NOT say "Reply MORE". Instead end with: "${exhaustionMessage || 'That\'s everything I\'ve got!'}"` : '';
  const userPrompt = `Neighborhood: ${hoodLabel}${filterDesc ? `\nFilter: ${filterDesc}` : ''}\nMATCH count: ${matchCount}${sparseNote}${excludeNote}${suggestNote}${lastBatchNote}\n\nEVENTS (${events.length}):\n${eventListStr}`;

  // Try Gemini Flash first (skip if caller knows Gemini is down)
  const genAI = options.skipGemini ? null : getGeminiClient();
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
      const sms = smartTruncate(parsed.sms_text);
      return { sms_text: sms, picks: reconcilePicks(sms, parsed.picks || []), _raw: text, _usage: usage, _provider: 'gemini' };
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
  const sms = smartTruncate(parsed.sms_text);
  return { sms_text: sms, picks: reconcilePicks(sms, parsed.picks || []), _raw: raw, _usage: usage, _provider: 'anthropic' };
}

/**
 * Compose a welcome message from interestingness-ranked events.
 * Uses the same Gemini -> Anthropic fallback as brainCompose.
 */
async function welcomeCompose(events) {
  const todayNyc = getNycDateString(0);
  const eventLines = events.slice(0, 6).map((e, i) => {
    const day = e.date_local === todayNyc ? 'TODAY' : 'TOMORROW';
    const time = e.start_time_local
      ? new Date(e.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
      : 'evening';
    const price = e.is_free ? 'Free' : (e.price_display || 'check price');
    const vibe = e.source_vibe ? `[${e.source_vibe}]` : '';
    const venue = e.venue_size ? `[${e.venue_size}]` : '';
    return `${i + 1}. [${day}] ${e.name} at ${e.venue_name || 'TBA'} (${e.neighborhood || 'NYC'}) \u2014 ${time}, ${price} | ${e.category} ${vibe} ${venue} | id:${e.id}`;
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
      const usage = {
        input_tokens: result.response.usageMetadata?.promptTokenCount || 0,
        output_tokens: result.response.usageMetadata?.candidatesTokenCount || 0,
      };
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

module.exports = {
  getGeminiClient, GEMINI_SAFETY, BRAIN_TOOLS,
  buildBrainSystemPrompt,
  withTimeout,
  callAgentBrain, callAgentBrainAnthropic, extractGeminiUsage,
  continueWithResults, serializePoolForContinuation,
  brainCompose, welcomeCompose,
  stripCodeFences, reconcilePicks,
  BRAIN_COMPOSE_SYSTEM, BRAIN_COMPOSE_SCHEMA, WELCOME_COMPOSE_SYSTEM,
};
