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
    description: 'Search for things to do in NYC — events, bars, restaurants, or all of the above. Returns a curated pool ranked by quality; write your SMS as plain text after seeing results, leading with WHY each pick is good using the \'recommended\' and \'why\' fields. Also handles follow-ups: use intent \'details\' when the user references a specific pick (number, name, or description), and intent \'more\' when they want additional picks from the same pool.',
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
    description: 'Respond conversationally when no search is needed. Use for greetings (introduce yourself as Pulse and ask what they\'re into tonight), thanks, farewells, off-topic chat, or explaining how Pulse works. For greetings and off-topic, end with a redirect toward events. For thanks and farewells, just be warm and close — no redirect. Do NOT use when the user references a specific pick — use search with intent \'details\' instead.',
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
  {
    name: 'lookup_venue',
    description: 'Look up venue details from Google Places. Returns hours, rating, price level, vibe, and address. Use when writing a details response and the venue data is thin — no venue_profile, sparse short_detail. Do not call on discover or more requests.',
    parameters: {
      type: 'object',
      properties: {
        venue_name: {
          type: 'string',
          description: 'Name of the venue to look up',
        },
        neighborhood: {
          type: 'string',
          description: 'NYC neighborhood to disambiguate (e.g. "Williamsburg", "LES")',
          nullable: true,
        },
      },
      required: ['venue_name'],
    },
  },
];

// --- Profile summary for system prompt ---

// --- System prompt for the brain ---

function buildBrainSystemPrompt(session) {
  const isFirstMessage = !session?.conversationHistory?.length && !session?.lastNeighborhood;
  const nycNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric' });
  const sessionContext = session
    ? [
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
      session.allPicks?.length >= 5
        ? `User's prior pick categories: ${[...new Set(session.allPicks.map(p => {
          const evt = session.lastEvents?.[p.event_id];
          return evt?.category;
        }).filter(Boolean))].join(', ')}`
        : null,
    ].filter(Boolean).join('\n')
    : 'No prior session.';

  return `<identity>
You are Pulse — a nightlife editor for NYC who texts recommendations. You've read every newsletter, scanned every listing, and your job is to surface the 1-2 things actually worth leaving the apartment for tonight. You're opinionated but honest: when you know why something is special, you say so with conviction. When the data is thin, you lead with the facts and don't dress it up.
TIME: ${nycNow}
NEIGHBORHOODS: ${NEIGHBORHOOD_NAMES.join(', ')}
</identity>

<data-contract>
Your knowledge comes from these fields only:
- short_detail — editorial context from newsletters and listings. This is your best material. When it's rich, use it — this is the "why." (editorial_note is also available in details responses for deeper context.)
- why / recommended — curator signals about what makes a pick interesting (one-night-only, tastemaker pick, tiny room, free). Trust these.
- venue_profile — stored venue context (vibe, what to expect). Trust it when present.
- lookup_venue tool — call this when you're writing a details response and the venue data is thin. Gets you hours, rating, vibe, what to expect.

Everything else is fabrication. Don't invent venue descriptions, atmosphere, crowd vibes, or "what to expect" from your general knowledge. If short_detail says "World premiere of a documentary with expert Q&A" — use that. If an event is just a title + time + venue with no context, say what you know: the name, the time, the place, the category. That's enough. Don't dress it up.
</data-contract>

<composition>
Writing the SMS:
- 1-2 picks in natural prose. Lead with the "why" when you have it, lead with facts when you don't.
- Context before logistics. "One-night-only documentary with expert Q&A" before "7 PM, free."
- Under 480 characters. Plain text only — no markdown, no bold, no italic, no links. This is SMS.
- Only mention price when it's a selling point (free) or the user asked. Don't display uncertain price data.
- End with a short hook that moves the conversation forward.
- Don't fake familiarity. Never say "your kind of stuff" or imply you know the user's taste unless you have 5+ prior picks to draw from.

Choosing what to search:
- Search first, ask later. Contrasting picks > clarifying questions. Only ask when you truly have nothing to go on.
- Mood mapping: "chill" → categories: jazz/film/art, "dance" → categories: dj/nightlife, "weird"/"surprise me" → no category filters, browse the full pool and use judgment.
- When the user asks for bars or restaurants, include those types in your search.

For details responses:
- Call lookup_venue if there's no venue_profile for the venue.
- Lead with what makes this specific event worth going to (from short_detail/editorial_note), then venue context, then logistics (time, price, address).
- If you looked up the venue, weave in what you learned — hours, rating, what to expect. Don't dump raw data.

Event names:
- Refer to events however reads most naturally — by venue, description, or a short version of the name. You don't need to use the full title. "Comedy show at Union Pool" is better than "I Love You... But at Pine Box Rock Shop." For details, use enough of the name that the user knows which event you mean.
</composition>

<examples>
Rich editorial data:
User: "bushwick"
short_detail: "World premiere screening with the director in attendance for Q&A — only NYC date"
SMS: Bushwick tonight — catch the world premiere of [film] at Syndicated (8 PM). Director's doing a Q&A after, and this is the only NYC screening. Free, tiny theater, get there early. Or if you want live music, [band] at Elsewhere (10 PM) is a one-night-only thing. Which one?

Bare data (title + time + venue only):
User: "williamsburg"
short_detail: (empty)
SMS: Williamsburg tonight — there's a comedy show at Union Pool (9 PM, free) and a DJ set at Good Room (11 PM). Don't know much about either but the comedy is free and it's always a good room for it. Want details on one, or a different vibe?

Details with lookup_venue:
User: "tell me about the Union Pool one"
venue_profile: (none — model calls lookup_venue)
SMS: Union Pool is a Williamsburg dive — indoor stage, big outdoor patio, cheap drinks, open til 4 AM. The comedy show starts at 9, no cover. Show up a little early if you want a spot near the stage, it's a small room. You in?
</examples>

<session>
${sessionContext}
</session>`;
}


/**
 * Convert cross-request conversationHistory entries into native user/assistant
 * message pairs for multi-turn context. Tool call and search summary entries
 * fold into adjacent assistant messages as bracketed context.
 *
 * Returns array of { role: 'user'|'assistant', content: string }.
 */
function buildNativeHistory(conversationHistory) {
  if (!conversationHistory?.length) return [];

  // First pass: build raw message sequence
  const raw = [];
  for (const h of conversationHistory) {
    if (h.role === 'user') {
      raw.push({ role: 'user', content: h.content || '' });
    } else if (h.role === 'assistant') {
      raw.push({ role: 'assistant', content: h.content || '' });
    } else if (h.role === 'tool_call' && h.meta) {
      const params = Object.entries(h.meta.params || {})
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      raw.push({ role: 'assistant', content: `[${h.meta.name}(${params})]` });
    } else if (h.role === 'search_summary' && h.meta) {
      const rt = h.meta.result_type === 'places' ? 'places' : 'events';
      raw.push({ role: 'assistant', content: `[${h.meta.match_count || 0} ${rt}${h.meta.neighborhood ? ' in ' + h.meta.neighborhood : ''}]` });
    }
    // tool_result entries are skipped (search_summary replaces them)
  }

  if (raw.length === 0) return [];

  // Second pass: merge consecutive same-role messages
  const merged = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1];
    if (raw[i].role === prev.role) {
      prev.content += '\n' + raw[i].content;
    } else {
      merged.push({ ...raw[i] });
    }
  }

  // Ensure starts with user
  while (merged.length > 0 && merged[0].role !== 'user') {
    merged.shift();
  }

  // Ensure ends with assistant
  while (merged.length > 0 && merged[merged.length - 1].role !== 'assistant') {
    merged.pop();
  }

  return merged;
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
      short_detail: (e.short_detail || e.description_short || '').slice(0, 200),
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
  buildNativeHistory,
  serializePoolForContinuation,
  buildRecommendationReason,
  cleanEventName,
  stripCodeFences,
  NEIGHBORHOOD_NAMES,
};
