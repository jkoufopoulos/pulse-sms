/**
 * brain-llm.js — LLM calling, continuation, and compose for the agent brain.
 */

const { NEIGHBORHOODS } = require('./neighborhoods');
const { getNycDateString } = require('./geo');
const { describeFilters } = require('./pipeline');
const { smartTruncate } = require('./formatters');
const { callWithTools: llmCallWithTools, continueChat: llmContinueChat, generate: llmGenerate } = require('./llm');
const { MODELS } = require('./model-config');

// --- Neighborhood list for system prompt ---
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

// --- Shared curation taste block (used in 3 prompts) ---
const CURATION_TASTE_COMMON = `CURATION TASTE — how to pick from the pool:
- You're the friend who always knows the weird, perfect thing. Not the friend who Googles "things to do in NYC."
- PICK HIERARCHY: one-off > limited run > weekly recurring > daily recurring. A one-night-only event is almost always more interesting than something that happens every week.
- SOURCE SIGNAL: source_vibe tells you how the event was discovered. "discovery" = editorial pick from a tastemaker. "niche" = focused community venue. "platform" = aggregator listing. "mainstream" = commercial. Lead with discovery/niche. Use platform/mainstream only to fill gaps.
- VENUE SIGNAL: venue_size "intimate" or "medium" = more personal, worth highlighting. "large"/"massive" = probably a well-known act the user already knows about.
- SKIP THESE unless the user specifically asked: big-name touring acts, generic DJ nights at mega-clubs, recurring bar trivia at chain venues. These are the filler — everyone already knows about them.`;

const CURATION_DIVERSITY_DEFAULT = `- DIVERSITY: default to 3 different categories. But if the user asked for something specific ("comedy"), go deep — give 3 comedy picks, don't force an art show in there.`;
const CURATION_DIVERSITY_WELCOME = `- DIVERSITY: pick 3 different categories. The welcome message is a first impression — show range.`;
const CURATION_INTERACTIVE = `- INTERACTIVE BONUS: interaction_format "interactive" (open mics, workshops, game nights) is gold for people looking to actually DO something, not just watch. Favor these when available.`;

function curationTasteBlock(diversityLine) {
  return `${CURATION_TASTE_COMMON}\n${diversityLine}\n${CURATION_INTERACTIVE}`;
}

// --- Tool definitions (neutral format — lowercase JSON Schema types, flat array) ---

const BRAIN_TOOLS = [
  {
    name: 'search_events',
    description: 'Search for event recommendations. Use when the user wants to see events, asks about a neighborhood, mentions a category, or requests any kind of activity.',
    parameters: {
      type: 'object',
      properties: {
        neighborhood: { type: 'string', description: 'NYC neighborhood name, or empty string for citywide', nullable: true },
        category: {
          type: 'string', description: 'Primary event category filter. Use for single-category requests.',
          nullable: true,
          enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater',
            'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'],
        },
        categories: {
          type: 'array', description: 'Multiple category filters — use when user wants more than one type (e.g. "music and trivia", "comedy or art"). Events matching ANY category are included. Only use this OR category, not both.',
          nullable: true,
          items: {
            type: 'string',
            enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater',
              'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'],
          },
        },
        free_only: { type: 'boolean', description: 'Only show free events' },
        time_after: { type: 'string', description: 'Only events after this time, HH:MM 24hr format (e.g. "22:00")', nullable: true },
        date_range: {
          type: 'string', description: 'Date scope for the search',
          nullable: true,
          enum: ['today', 'tomorrow', 'this_weekend', 'this_week', 'next_week'],
        },
        intent: {
          type: 'string', description: 'What the user is doing: new_search (first request or starting over), refine (adding/tightening a filter), pivot (changing topic/category), more (show additional picks from same search), details (get details about a specific pick)',
          enum: ['new_search', 'refine', 'pivot', 'more', 'details'],
        },
        pick_reference: {
          type: 'string',
          description: 'How the user referenced a previously shown pick. Can be a number ("2"), event name ("the comedy one"), or venue name ("Elsewhere"). Only used with intent: "details".',
          nullable: true,
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'respond',
    description: 'Respond conversationally when no event search is needed. Use for greetings, thanks, farewells, off-topic chat, or when the user needs clarification.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'SMS response text, max 480 chars. Be warm, brief. ALWAYS end with a redirect to events (e.g. "Drop a neighborhood or tell me what you are in the mood for!" or "Text me a neighborhood to get started!")' },
        intent: {
          type: 'string',
          enum: ['greeting', 'thanks', 'farewell', 'off_topic', 'clarify', 'acknowledge'],
        },
      },
      required: ['message', 'intent'],
    },
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
      session.allPicks?.length
        ? `User's prior pick categories: ${[...new Set(session.allPicks.map(p => {
          const evt = session.lastEvents?.[p.event_id];
          return evt?.category;
        }).filter(Boolean))].join(', ')}`
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
- "bushwick" → search_events(neighborhood: "Bushwick", intent: "new_search")
- "comedy or art stuff in greenpoint" → search_events(neighborhood: "Greenpoint", categories: ["comedy", "art"], intent: "new_search")
- "how about comedy" (with session) → search_events(category: "comedy", intent: "refine")
- "try bushwick" (with existing categories) → search_events(neighborhood: "Bushwick", intent: "refine")
- "forget the comedy" → search_events(intent: "pivot")
- "more" / "what else" → search_events(intent: "more")
- "2" → search_events(intent: "details", pick_reference: "2")
- "tell me about the comedy one" → search_events(intent: "details", pick_reference: "the comedy one")
- "yes" / "yeah" (with pending suggestion) → search_events with the suggested neighborhood
- "thanks!" → respond(intent: "thanks")

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
${curationTasteBlock(CURATION_DIVERSITY_DEFAULT)}

- EVERY pick MUST include: event name, venue name, your opinionated take, start time, and price ("$20", "free", "cover")
- Label TODAY events: say "tonight" for evening/late (6pm+), "today at [time]" for afternoon. TOMORROW → "tomorrow". Further out → day name.
- [NEARBY] events: mention the actual neighborhood naturally (e.g. "over in Fort Greene")
- If ALL picks are [NEARBY], lead with "Not much in [hood] tonight, but nearby..."
- If SPARSE, be honest about slim pickings but still show what's available
- Under 480 characters total. No URLs.
- Voice: friend texting. Opinionated, concise, warm.
- CONNECT your SMS to what the user originally asked.
- For DETAILS responses: write a rich, opinionated detail message including venue, time, price, description, and URL. Under 480 chars.
- For MORE responses with is_last_batch=true: mention these are the last picks and suggest trying a different neighborhood if suggestions are provided. Do NOT say "reply MORE".

Return JSON: { "reasoning": "2-3 sentences on why you chose these picks over the others in the pool. What made the winners stand out? What did you skip and why?", "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.`;
}

// --- Call the agent brain (tool calling via llm.js) ---

async function callAgentBrain(message, session, phone, trace) {
  const systemPrompt = buildBrainSystemPrompt(session);
  const brainStart = Date.now();

  try {
    const result = await llmCallWithTools(MODELS.brain, systemPrompt, message, BRAIN_TOOLS, { timeout: 10_000 });

    if (!result.tool) {
      return {
        tool: 'respond',
        params: { message: result.text, intent: 'clarify' },
        usage: result.usage,
        provider: result.provider,
        latency_ms: Date.now() - brainStart,
        chat: result.chat,
      };
    }

    return {
      tool: result.tool,
      params: result.params,
      usage: result.usage,
      provider: result.provider,
      latency_ms: Date.now() - brainStart,
      chat: result.chat,
    };
  } catch (err) {
    console.warn(`Agent brain ${MODELS.brain} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    trace.brain_error = `${MODELS.brain}: ${err.message}`;

    try {
      const result = await llmCallWithTools(MODELS.fallback, systemPrompt, message, BRAIN_TOOLS, { timeout: 10_000 });

      if (!result.tool) {
        return {
          tool: 'respond',
          params: { message: result.text, intent: 'clarify' },
          usage: result.usage,
          provider: result.provider,
          latency_ms: Date.now() - brainStart,
          chat: result.chat,
        };
      }

      return {
        tool: result.tool,
        params: result.params,
        usage: result.usage,
        provider: result.provider,
        latency_ms: Date.now() - brainStart,
        chat: result.chat,
      };
    } catch (err2) {
      throw new Error(`Both ${MODELS.brain} and ${MODELS.fallback} failed: ${err2.message}`);
    }
  }
}

/**
 * Continue the chat session with search_events results via llm.js.
 * Sends tool result back → model writes SMS in the same context.
 * Returns { sms_text, picks, _raw, _usage, _provider }
 */
async function continueWithResults(chat, eventData, trace) {
  const composeStart = Date.now();

  try {
    const result = await llmContinueChat(chat, 'search_events', eventData, { timeout: 10_000 });
    trace.composition.latency_ms = Date.now() - composeStart;

    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);

    return {
      sms_text: sms,
      picks: reconcilePicks(sms, parsed.picks || []),
      reasoning: parsed.reasoning || null,
      _raw: result.text,
      _usage: result.usage,
      _provider: result.provider,
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
${curationTasteBlock(CURATION_DIVERSITY_DEFAULT)}

- EVERY pick MUST include: event name, venue name, your opinionated take, start time, and price ("$20", "free", "cover")
- Label TODAY events: say "tonight" for evening/late (6pm+), "today at [time]" for afternoon. TOMORROW → "tomorrow". Further out → day name.
- [NEARBY] events: mention the actual neighborhood naturally. If ALL picks are [NEARBY], lead with "Not much in [hood] tonight, but nearby..."
- If SPARSE, be honest about slim pickings but still show what's available
- Under 480 characters total. No URLs.
- Voice: friend texting. Opinionated, concise, warm.

Return JSON: { "reasoning": "2-3 sentences on why you chose these picks over the others in the pool. What made the winners stand out? What did you skip and why?", "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id from the event", "why": "short reason"}] }
The picks array MUST reference events mentioned in sms_text.`;

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

${curationTasteBlock(CURATION_DIVERSITY_WELCOME)}

RULES:
- Pick exactly 3 events from the provided list. They are pre-ranked by interestingness — respect the ranking but you may reorder slightly for narrative flow.
- Each pick MUST include: event name, venue name, neighborhood in parentheses, time, and price ("$20", "free", "cover").
- Make each pick sound like a tip from a friend who just found out about it. Opinionated, vivid, concise.
- Label TODAY events as "tonight", TOMORROW as "tomorrow".
- Under 480 characters total. No URLs.
- Do NOT change the intro line or the CTA line — use them exactly as specified above.

Return JSON: { "reasoning": "2-3 sentences on why you chose these 3 over the others. What made the winners stand out? What did you skip and why?", "sms_text": "the full SMS", "picks": [{"rank": 1, "event_id": "id", "why": "short reason"}] }`;

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
 * Lightweight compose via llm.js, with fallback.
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

  try {
    const result = await llmGenerate(MODELS.compose, BRAIN_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 1024, temperature: 0.6, json: true, jsonSchema: BRAIN_COMPOSE_SCHEMA, timeout: 10_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: reconcilePicks(sms, parsed.picks || []), reasoning: parsed.reasoning || null, _raw: result.text, _usage: result.usage, _provider: result.provider };
  } catch (err) {
    console.warn(`brainCompose ${MODELS.compose} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    const result = await llmGenerate(MODELS.fallback, BRAIN_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 512, temperature: 0.6, json: true, timeout: 12_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: reconcilePicks(sms, parsed.picks || []), reasoning: parsed.reasoning || null, _raw: result.text, _usage: result.usage, _provider: result.provider };
  }
}

/**
 * Compose a welcome message from interestingness-ranked events.
 * Uses the same primary -> fallback pattern as brainCompose.
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

  try {
    const result = await llmGenerate(MODELS.compose, WELCOME_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 1024, temperature: 0.7, json: true, jsonSchema: BRAIN_COMPOSE_SCHEMA, timeout: 10_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: parsed.picks || [], reasoning: parsed.reasoning || null, _raw: result.text, _usage: result.usage, _provider: result.provider };
  } catch (err) {
    console.warn(`welcomeCompose ${MODELS.compose} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    const result = await llmGenerate(MODELS.fallback, WELCOME_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 512, temperature: 0.7, json: true, timeout: 12_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: parsed.picks || [], reasoning: parsed.reasoning || null, _raw: result.text, _usage: result.usage, _provider: result.provider };
  }
}

module.exports = {
  BRAIN_TOOLS,
  buildBrainSystemPrompt,
  callAgentBrain, continueWithResults, serializePoolForContinuation,
  brainCompose, welcomeCompose,
  stripCodeFences, reconcilePicks,
  BRAIN_COMPOSE_SYSTEM, BRAIN_COMPOSE_SCHEMA, WELCOME_COMPOSE_SYSTEM,
};
