/**
 * brain-llm.js — LLM calling, continuation, and compose for the agent brain.
 */

const { NEIGHBORHOODS } = require('./neighborhoods');
const { getNycDateString } = require('./geo');
const { describeFilters } = require('./pipeline');

// --- Neighborhood list for system prompt ---
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

// --- Shared curation taste block (used in 3 prompts) ---
const CURATION_TASTE_COMMON = `CURATION TASTE — how to pick from the pool:
- You're the friend who always knows the weird, perfect thing. Not the friend who Googles "things to do in NYC."
- PICK HIERARCHY: one-off > limited run > weekly recurring > daily recurring. A one-night-only event is almost always more interesting than something that happens every week.
- SOURCE SIGNAL: source_vibe tells you how the event was discovered. "discovery" = editorial pick from a tastemaker. "niche" = focused community venue. "platform" = aggregator listing. "mainstream" = commercial. Lead with discovery/niche. Use platform/mainstream only to fill gaps.
- VENUE SIGNAL: venue_size "intimate" or "medium" = more personal, worth highlighting. "large"/"massive" = probably a well-known act the user already knows about.
- SKIP THESE unless the user specifically asked: big-name touring acts, generic DJ nights at mega-clubs, recurring bar trivia at chain venues. These are the filler — everyone already knows about them.
- EDITORIAL SIGNAL: editorial:true means the source editor highlighted this as a pick. These are pre-vetted by tastemakers — strong signal to include.
- SCARCITY: scarcity:"one-night-only" or "closing" or "limited" means this event won't be around next week. Urgency makes a pick feel valuable — favor these.`;

const CURATION_DIVERSITY_DEFAULT = `- DIVERSITY: default to 3 different categories. But if the user asked for something specific ("comedy"), go deep — give 3 comedy picks, don't force an art show in there.`;
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
  {
    name: 'compose_sms',
    description: 'Write the final SMS after seeing search results. Call this after search_events returns events. Do NOT call after respond — use respond for conversational messages.',
    parameters: {
      type: 'object',
      properties: {
        sms_text: { type: 'string', description: 'SMS text to send, max 480 chars. Each pick on its own line: Event Name — Venue, time (price)' },
        picks: {
          type: 'array',
          description: 'Event IDs of events you recommended, in the order shown in sms_text',
          items: { type: 'string' },
        },
      },
      required: ['sms_text', 'picks'],
    },
  },
  {
    name: 'show_welcome',
    description: 'Show tonight\'s top picks as a welcome message. ONLY call this when the SESSION CONTEXT says "First message — new session" AND the user sent a casual greeting (hey, hi, yo, hello, what\'s up, etc). Do NOT use for returning users, specific requests, questions, or abuse.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// --- System prompt for the brain ---

function buildBrainSystemPrompt(session) {
  const isFirstMessage = !session?.conversationHistory?.length && !session?.lastNeighborhood;
  const sessionContext = session
    ? [
      isFirstMessage ? 'First message — new session. Use show_welcome for casual greetings.' : null,
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

  return `You are Pulse, an NYC nightlife and events SMS bot. You text like a plugged-in friend — warm, opinionated, concise.

TOOL FLOW:
- First message + casual greeting: call show_welcome (shows tonight's top picks).
- Conversational messages (questions, thanks, farewells): call respond.
- Event requests: call search_events, then call compose_sms with your SMS text and the picked event IDs.
- If you can't call compose_sms, write the SMS as plain text — that works too.

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
- For more with is_last_batch=true: mention these are the last picks, suggest a different neighborhood.

${curationTasteBlock(CURATION_DIVERSITY_DEFAULT)}`;
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
      editorial: e.editorial_signal || undefined,
      scarcity: e.scarcity || undefined,
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


/**
 * Strip markdown code fences from LLM JSON responses.
 */
function stripCodeFences(text) {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}


module.exports = {
  BRAIN_TOOLS,
  buildBrainSystemPrompt,
  serializePoolForContinuation,
  stripCodeFences,
  NEIGHBORHOOD_NAMES,
};
