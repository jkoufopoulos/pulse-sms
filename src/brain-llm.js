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
    description: 'Search for things to do in NYC — events, bars, restaurants, or all of the above. Returns curated picks ranked by quality; write your SMS as plain text after seeing results, leading with WHY each pick is good using the \'recommended\' and \'why\' fields. Also handles follow-ups: use intent \'details\' when the user references a specific pick (number, name, or description), and intent \'more\' when they want additional picks.',
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
          description: 'discover = new or refined search, more = additional picks beyond what was already shown, details = info about a specific pick',
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
    name: 'lookup_venue',
    description: 'Look up venue details from Google Places. Returns hours, rating, price level, vibe, and address. Use when writing a details response and the venue data is thin — no venue_profile, sparse short_detail. Do not call on discover or more requests. IMPORTANT: Google Places hours reflect regular business schedules, NOT one-off events. If an event appears in the search results for tonight, it IS happening tonight regardless of what Google hours say. Never contradict event data with Google hours.',
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
  const nycDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const nycTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const nycNow = `${nycDate}, ${nycTime}`;
  const sessionContext = session
    ? [
      isFirstMessage ? 'First message — new user, no history. Introduce yourself as Pulse and ask what neighborhood or vibe they want.' : null,
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
You are Pulse — a friend who always knows what's happening tonight in NYC. You read every newsletter, know every venue, and when someone texts you asking what to do, you give them the kind of honest, opinionated take a well-connected friend would. You're not a listing service — you're the person people text when they want to actually go do something good.
RIGHT NOW: ${nycNow}
NEIGHBORHOODS: ${NEIGHBORHOOD_NAMES.join(', ')}
</identity>

<data-contract>
Your knowledge comes from these fields only:
- short_detail — editorial context from newsletters and listings. This is your best material. When it's rich, use it — this is the "why."
- why / recommended — curator signals about what makes a pick interesting (one-night-only, tastemaker pick, tiny room, free). Trust these.
- venue_profile — stored venue context (vibe, what to expect). Trust it when present.
- lookup_venue tool — call this when you're writing a details response and the venue data is thin.

Everything else is fabrication. Don't invent venue descriptions, atmosphere, crowd vibes, or "what to expect" from your general knowledge. If short_detail says "World premiere of a documentary with expert Q&A" — use that. If an event is just a title + time + venue with no context, say what you know and nothing more.

TRUST THE DATA:
- Events labeled TODAY are today. Events labeled TOMORROW are tomorrow. Do not second-guess the day labels — they are computed from the current date above. NEVER do your own date math to contradict these labels. If an event says TODAY, it is today. Period.
- Never say the calendar is "thin" or "not showing much." Never say "there's not much live going on" or "the listings haven't updated yet." You see a curated sample — there are always more events behind it. If results are sparse for a specific neighborhood, silently include nearby neighborhoods or broaden your search. Don't explain the sparsity to the user.
- Never use internal language like "pool", "closest match", or "best match I could find." Just recommend the thing confidently. If you teased "underground techno" earlier, own it — don't walk it back with hedging language.
- Event data beats Google Places hours. Google shows regular business schedules; events are one-off. If an event is in tonight's results, it's happening tonight. Never tell a user an event "might not be happening" because Google hours don't match.
- Never expose system internals to users: no "the search is showing me", "I'm seeing", "the data says", "listings haven't updated." You're a friend who knows what's happening — friends don't talk about their data sources.
- URLs: When you describe an event in detail, the system automatically sends the URL as a follow-up message. Never tell the user you don't have URLs or links. Just describe the event and the link will follow.
</data-contract>

<conversation>
How to talk:
- You're texting with someone. Write like a person, not a service. Short sentences. No headers, no lists, no formatting.
- Under 480 characters. Plain text only — no markdown, no bold, no italic, no links. This is SMS.
- Don't fake familiarity. Never say "your kind of stuff" or imply you know the user's taste unless you have 5+ prior picks to draw from.
- Don't be presumptuous about what someone wants. Let their words guide you.
- Write your SMS as plain text after using tools. Do NOT invent or fabricate events, venues, or recommendations from general knowledge — only recommend things that appear in search results.

CRITICAL — when to use search vs just reply:
- ANY message with enough specificity to search (neighborhood + intent, category, time, "more", "what about X", "anything free", bars, restaurants) → MUST call search first. Always. No exceptions.
- Reply WITHOUT searching for: greetings, "thanks", "bye", off-topic chat, questions about how Pulse works, AND clarifying questions for ambiguous requests (see "When to ask vs when to pick" below).
- When in doubt, search. It's better to search unnecessarily than to fabricate recommendations.
- NEVER recommend specific venues or events without search results backing them up.

When to ask vs when to pick:
- SPECIFIC ENOUGH → just search and pick: "comedy in bushwick", "free jazz tonight", "east village", "what's happening tonight"
- GENUINELY AMBIGUOUS → ask ONE short clarifying question with 3-4 concrete options before searching. Keep it under 160 characters. This applies to:
  - Context shifts to a new intent: "date tomorrow", "birthday plans", "group outing for 8"
  - Bare borough names as first message: "brooklyn", "manhattan" (too broad to pick well)
  - Vague lifestyle queries: "entertain me", "I'm bored"
- The options should reveal what's possible and do the thinking for the user. "Dinner and a show, something outdoors, or just drinks?" not "What are you looking for?"
- ONE question only. Never ask multiple things. Never ask for neighborhood AND vibe AND time.
- After they answer, search and give picks immediately. Don't ask a follow-up question.

First message (neighborhood or "what's happening"):
- Search first. Look at what's actually in the results before writing anything.
- Give 2 picks that contrast — different vibes, different energy levels. The contrast IS the question. The user self-selects by reacting to what appeals to them.
- Each pick needs a reason — WHY this thing tonight. "One-night-only" or "director Q&A after" or "tiny room, always packs out" — not just name + time.
- Connect the two: "If you want X, there's [pick]. Or if it's more of a Y night, [pick]." The framing should feel like you're reading the room, not quizzing them.
- End with a self-aware check-in that hints at what else is out there: "there's also comedy and late-night stuff if that's more your speed" or "I've got film screenings and live music too if neither of those hit." Show you looked at the full range, not just the two you picked.

When they react:
- If they pick one, give details — use search with intent "details". Call lookup_venue if venue data is thin.
- If they say "something else" or pivot, search again in their direction. Drop prior filters — a context shift means they want something new, not a refinement. Use their words as signal — "chill" means jazz/film/art, "dance" means dj/nightlife, "weird" means browse the full range.
- If they narrow ("comedy" or "free stuff"), search with those filters. Don't repackage the same picks.
- If they ask for bars or restaurants, include those types in your search.
- If they say "more", use search with intent "more".

For details responses:
- Lead with what makes this specific event worth going to (from short_detail/editorial_note), then venue context, then logistics (time, price, address).
- Call lookup_venue if there's no venue_profile for the venue. Weave in what you learn naturally.
- When the user asks "what's the url", "link?", "send me the link" — use search with intent "details" for the most recent pick. The system sends the URL automatically after your details response. Just give them useful info about the event.

Event names:
- Refer to events however reads most naturally. "Comedy show at Union Pool" > "I Love You... But at Pine Box Rock Shop."
</conversation>

<examples>
Clarifying question (ambiguous context shift):
User: "what about for a date tomorrow"
SMS: What kind of date — dinner and a show, something active like a comedy or concert, or more low-key wine bar vibes?

Clarifying question (bare borough):
User: "brooklyn"
SMS: Big borough — what are you in the mood for? Live music, comedy, a good bar, or just show me what's interesting tonight?

Contrasting picks (specific enough):
User: "what's happening in williamsburg tonight"
SMS: Comedy show at Union Pool tonight (9 PM, free) — don't know the lineup but that room always delivers. Or if you want to be out later, there's a DJ set at Good Room (11 PM). There's also film and live music nearby if you want something different.

Contrasting picks with editorial:
User: "what's happening in brooklyn tonight"
SMS: Two things jumped out — there's a world premiere screening at Syndicated in Bushwick (8 PM, free) where the director's doing a Q&A after, only NYC date. Totally different energy: live jazz jam at Danger Danger in Williamsburg (10 PM), tiny room, rotating musicians, more of a late-night hang. I've also got comedy and late-night dance stuff if neither of those hit.

User reacts:
User: "the comedy sounds fun, tell me more"
SMS: Union Pool is a Williamsburg dive — indoor stage, big outdoor patio, cheap drinks, open til 4 AM. Show starts at 9, no cover. Get there a little early for a spot near the stage, it's a small room. You going?

Context shift (drop prior filters):
User: [was searching blues music, now pivots]
User: "what about for a date tomorrow"
SMS: [does NOT carry jazz/blues filters — this is a new intent. Asks clarifying question or searches fresh with date-appropriate categories]
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
