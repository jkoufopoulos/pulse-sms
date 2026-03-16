/**
 * brain-llm.js — LLM calling, continuation, and compose for the agent brain.
 */

const { NEIGHBORHOODS } = require('./neighborhoods');
const { getNycDateString } = require('./geo');
const { describeFilters } = require('./pipeline');

// --- Neighborhood list for system prompt ---
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

// Curation taste constants kept for potential external use
const CURATION_TASTE_COMMON = '';
const CURATION_DIVERSITY_DEFAULT = '';
const CURATION_INTERACTIVE = '';

// --- Tool definitions (neutral format — lowercase JSON Schema types, flat array) ---

const BRAIN_TOOLS = [
  {
    name: 'search',
    description: 'Search for things to do in NYC — events, bars, restaurants, or all of the above. Returns a curated pool. Write your SMS as plain text after seeing results. Also use for details ("tell me about that", "more about #2") and more picks ("more").',
    parameters: {
      type: 'object',
      properties: {
        neighborhood: { type: 'string', description: 'NYC neighborhood name, or omit for citywide', nullable: true },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['events', 'bars', 'restaurants'] },
          description: 'What to search for. Defaults to events if omitted. Use multiple for mixed requests like "dinner and a show".',
          nullable: true,
        },
        filters: {
          type: 'object', nullable: true,
          properties: {
            categories: {
              type: 'array', nullable: true,
              items: {
                type: 'string',
                enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater',
                  'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'],
              },
              description: 'Event category filters. Events matching ANY category are included.',
            },
            free_only: { type: 'boolean', description: 'Only show free events' },
            time_after: { type: 'string', description: 'Only events after this time, HH:MM 24hr format (e.g. "22:00")', nullable: true },
            date_range: {
              type: 'string', description: 'Date scope for the search',
              nullable: true,
              enum: ['today', 'tomorrow', 'this_weekend', 'this_week', 'next_week'],
            },
            vibe: {
              type: 'string', nullable: true,
              enum: ['dive', 'cocktail', 'wine', 'rooftop', 'date_night',
                     'group_friendly', 'outdoor', 'live_music', 'casual', 'upscale'],
              description: 'Vibe filter for bars/restaurants',
            },
          },
        },
        intent: {
          type: 'string',
          enum: ['discover', 'more', 'details'],
          description: 'discover = new or refined search, more = additional picks from same pool, details = info about a specific pick',
        },
        reference: {
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
    description: 'Respond conversationally when no search is needed. Use for greetings, thanks, farewells, off-topic chat, or when the user asks how Pulse works. Do NOT use when the user asks about a specific pick — use search with intent "details" instead.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'SMS response text, max 480 chars. Be warm, brief. For greetings and off-topic, end with a redirect to events. For thanks/farewells, just be warm and close — do NOT redirect or ask what they want next.' },
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
  const isFirstMessage = !session?.conversationHistory?.length && !session?.lastNeighborhood;
  const nycNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric' });
  const sessionContext = session
    ? [
      `Current time in NYC: ${nycNow}`,
      isFirstMessage ? 'First message — new user, no history. Use respond to introduce yourself and ask what they want.' : null,
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
      session.lastResultType === 'places' && session.lastPlaces?.length
        ? `Last result: PLACES. Shown: ${session.lastPlaces.map(p => {
            const place = session.lastPlaceMap?.[p.place_id];
            return place ? `"${place.name}"` : p.place_id;
          }).join(', ')}. Use search with intent "details" or "more" for follow-ups.`
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
      if (h.role === 'search_summary' && h.meta) {
        const rt = h.meta.result_type === 'places' ? 'places' : 'events';
        return `> Found ${h.meta.match_count || 0} ${rt}${h.meta.neighborhood ? ' in ' + h.meta.neighborhood : ''}`;
      }
      if (h.role === 'assistant') return `Pulse: "${h.content.slice(0, 150)}"`;
      return null;
    }).filter(Boolean).join('\n')
    : '';

  return `You are Pulse, an NYC nightlife SMS bot. You text like a plugged-in friend — warm, opinionated, max 480 chars.

TIME: ${nycNow}
NEIGHBORHOODS: ${NEIGHBORHOOD_NAMES.join(', ')}

RULES:
- Search first, ask later. Contrasting picks > clarifying questions. Only ask when you truly have nothing to go on.
- 1-2 picks, woven into natural prose. Lead with WHY it's good — trust "recommended" and "why" from results.
- Events and places mix naturally: "Grab a drink at [bar] then catch [show] around the corner."
- Mood mapping: "chill" → jazz/film/art, "dance" → dj/nightlife, "weird" → search broad, "bars"/"dinner" → types: ["bars"]/["restaurants"].
- For details: venue feel first ("dark room, loud sound, cheap tall boys"), then event, then logistics (time, price, when to arrive). Use venue_profile if present.
- "more" = different results, "2" or name = details. After details, the system sends URLs automatically.
- Under 480 chars. No URLs in SMS. No prices in initial picks. Never write "price not listed".
- Write SMS as plain text after search results. End with a natural hook ("Want details?" "More of a music person?").
- New user greeting: call respond, introduce yourself, ask what they want. Returning user: call search({intent: "discover"}).

SESSION CONTEXT:
${sessionContext}${historyBlock}
${session?._proactivePrompt ? `\nPROACTIVE OPT-IN: This user hasn't opted into proactive recommendations yet. At the end of your picks response, append on a new line:\n"PS — Want me to text you when something great comes up? Reply NOTIFY to opt in."\nOnly add this to responses that include event picks, not to detail responses or conversation.` : ''}

EXAMPLES:

User: "bushwick"
→ search({neighborhood: "bushwick", intent: "discover"})
SMS: "Bushwick tonight — there's a one-off noise show at Alphaville, tiny room, gonna be loud and weird in the best way. Or Mood Ring has a vinyl DJ set if you want something mellower. Which sounds more like your night?"

User: "tell me more about the vinyl thing"
→ search({intent: "details", reference: "the vinyl thing"})
SMS: "Mood Ring is one of those places that looks like nothing from outside but has this perfect dark room with a great sound system. Tonight's a local DJ spinning funk and soul on vinyl, no cover. Starts at 9, but it doesn't really fill up til 10:30."

User: "best bars in williamsburg"
→ search({neighborhood: "williamsburg", types: ["bars"], intent: "discover"})
SMS: "Williamsburg bars — The Commodore's a proper neighborhood spot, fried chicken and cheap tall boys, always a scene. Or Maison Premiere if you want the opposite — oysters, craft cocktails, feels like old New Orleans. Which vibe?"`;
}


/**
 * Strip promotional prefixes/suffixes from event names so the model
 * writes naturally instead of copying ALL-CAPS marketing labels.
 * The is_free field already carries free status — no need in the name.
 */
function cleanEventName(name) {
  if (!name) return name;
  return name
    // Leading labels: "FREE SHOW!", "Free Show:", "SOLD OUT -", etc.
    .replace(/^(?:FREE\s*SHOW[!:]?\s*[-–—:]?\s*|SOLD\s*OUT[!:]?\s*[-–—:]?\s*)/i, '')
    // Trailing labels: "(SOLD OUT)", "SOLD OUT", "(Free!)"
    .replace(/\s*\(?\s*SOLD\s*OUT\s*\)?\s*$/i, '')
    // "Frantic! Free Show" → "Frantic!" (trailing "Free Show")
    .replace(/\s+Free\s+Show\s*$/i, '')
    .trim();
}

/**
 * Build a natural language reason for why an event is interesting.
 * Converts metadata signals into a short phrase the model can trust and echo.
 */
function buildRecommendationReason(e) {
  const parts = [];
  if (e.scarcity === 'one-night-only') parts.push('one-off, won\'t happen again');
  else if (e.scarcity) parts.push(e.scarcity);
  if (e.editorial_signal) parts.push('tastemaker pick');
  if (e.source_vibe === 'discovery') parts.push('underground radar');
  else if (e.source_vibe === 'niche') parts.push('local scene');
  if (e.venue_size === 'intimate') parts.push('tiny room');
  else if (e.venue_size === 'massive') parts.push('big production');
  if (e.interaction_format === 'interactive') parts.push('you\'re in it, not just watching');
  if (e.is_free) parts.push('free');
  return parts.join(', ') || undefined;
}

/**
 * Serialize event pool into compact format for LLM.
 * Top items are annotated with recommended:true and a why field.
 */
function serializePoolForContinuation(poolResult) {
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);
  const { pool, hood: neighborhood, activeFilters, isSparse, matchCount,
          nearbyHoods, suggestedHood, excludeIds, isCitywide, isBorough, borough,
          nearbyHighlight } = poolResult;

  const hoodLabel = isBorough ? `${borough} (borough-wide)` : isCitywide ? 'citywide' : neighborhood || 'NYC';
  const filterDesc = activeFilters && Object.values(activeFilters).some(Boolean) ? describeFilters(activeFilters) : '';

  const events = pool.map((e, i) => {
    const dayLabel = e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local;
    const tag = e.filter_match === 'hard' ? '[MATCH]' : e.filter_match === 'soft' ? '[SOFT]' : '';
    const nearbyTag = (neighborhood && e.neighborhood && e.neighborhood !== neighborhood) ? '[NEARBY]' : '';
    const why = buildRecommendationReason(e);
    return {
      id: e.id, name: cleanEventName((e.name || '').slice(0, 80)), venue_name: e.venue_name,
      neighborhood: e.neighborhood, day: dayLabel, start_time_local: e.start_time_local, end_time_local: e.end_time_local || undefined,
      is_free: e.is_free, price_display: e.price_display, category: e.category,
      short_detail: (e.short_detail || e.description_short || '').slice(0, 60),
      recurring: e.is_recurring ? e.recurrence_label : undefined,
      venue_size: e.venue_size || undefined,
      interaction_format: e.interaction_format || undefined,
      recommended: i < 5 ? true : undefined,
      why: i < 5 ? why : undefined,
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
    nearby_highlight: nearbyHighlight || undefined,
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
  buildRecommendationReason,
  cleanEventName,
  stripCodeFences,
  NEIGHBORHOOD_NAMES,
};
