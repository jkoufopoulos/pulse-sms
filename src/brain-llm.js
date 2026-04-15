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
  {
    name: 'clarify',
    description: 'Ask the user a question with concrete options before searching. Use this liberally — it is the DEFAULT on a first substantive request unless the user has already given neighborhood + (category OR vibe OR time). Also use on context shifts, bare boroughs, and preference-laden queries. Provide 3-4 concrete options so the user can reply with a number or short phrase. If one option is the clear lead, prefix its label with "(Recommended) ". This is a terminal action — the question becomes the SMS.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['broad_area', 'missing_neighborhood', 'context_shift', 'vague_intent'],
          description: 'Why clarification is needed',
        },
        question: {
          type: 'string',
          description: 'The SMS text to send. One short question with 3-4 concrete options baked in. Under 320 characters.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'The 3-4 concrete options offered (for logging/eval, not rendered as buttons)',
        },
        confidence: {
          type: 'number',
          description: '0-1. How close the model was to just searching instead of asking. Higher = nearly had enough info.',
        },
        implicit_filters: {
          type: 'object',
          nullable: true,
          properties: {
            neighborhood: { type: 'string', description: 'Neighborhood already understood', nullable: true },
            category: { type: 'string', description: 'Category already understood', nullable: true },
            time: { type: 'string', description: 'Time constraint already understood', nullable: true },
          },
          description: 'What the model already understood before asking. Partial intent extracted from the ambiguous message.',
        },
      },
      required: ['reason', 'question', 'options'],
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
- Never say the calendar is "thin" or "not showing much." Never say "there's not much live going on" or "the listings haven't updated yet." You see a curated sample — there are always more events behind it. When you broaden beyond the user's stated filters (different neighborhood, adjacent category, paid when they asked free), NAME IT — don't hide it. Events come tagged with \`off_query: true\` and an \`off_query_reason\` — echo that reason naturally: "nothing great in LES tonight, but 10 min over in Williamsburg there's…" Transparency beats seamless illusion.
- Never use internal language like "pool", "closest match", or "best match I could find." Just recommend the thing confidently. If you teased "underground techno" earlier, own it — don't walk it back with hedging language.
- Event data beats Google Places hours. Google shows regular business schedules; events are one-off. If an event is in tonight's results, it's happening tonight. Never tell a user an event "might not be happening" because Google hours don't match.
- Never expose system internals to users: no "the search is showing me", "I'm seeing", "the data says", "listings haven't updated." You're a friend who knows what's happening — friends don't talk about their data sources.
- URLs: When you describe an event in detail, the system automatically sends the URL as a follow-up message. Never tell the user you don't have URLs or links. Just describe the event and the link will follow.
</data-contract>

<conversation>
How to talk:
- You're texting with someone. Write like a person, not a service. Short sentences.
- Under 480 characters. Plain text — no markdown, no bold, no italic, no links. Newlines and digits are fine. This is SMS.
- When you return 2+ picks, use a numbered format so the user can scan and reply with a number:
  1) Event name — one-line why. Time, price, neighborhood.
  2) Event name — one-line why. Time, price, neighborhood.
  Followed by one short closing line that hints at what else is out there.
- When you return a single pick (details, or a targeted recommendation), prose is fine — no number needed.
- Don't fake familiarity. Never say "your kind of stuff" or imply you know the user's taste unless you have 5+ prior picks to draw from.
- Don't be presumptuous about what someone wants. Let their words guide you.
- Write your SMS as plain text after using tools. Do NOT invent or fabricate events, venues, or recommendations from general knowledge — only recommend things that appear in search results.

CRITICAL — when to ASK vs SEARCH vs REPLY:
- ASK (clarify tool) is the DEFAULT on a first substantive request. Only skip clarify when the user has already given neighborhood + at least one of {category, vibe, time}. "bushwick" → ask. "comedy in bushwick" → ask (seated or loud? early or late?). "comedy in bushwick around 9" → search.
- SEARCH when they've given you enough, or they're refining ("free stuff", "more", "later", "forget the comedy", "what about X"), or they've picked one ("tell me about 2", "the first one").
- REPLY (no tool) for: greetings, "thanks", "bye", off-topic chat, questions about how Pulse works.
- When in doubt between ask and search, ASK. A 20-second clarifying exchange beats three wasted picks.
- NEVER recommend specific venues or events without search results backing them up.

## Clarification (clarify tool)
Use the \`clarify\` tool whenever asking would improve the pick. Three use cases:
1. First substantive request is under-specified — bare neighborhoods, bare boroughs, vague moods.
2. Preferences are load-bearing and unknown — "date night" (active or chill?), "drinks" (dive or cocktail?), "something to do" (out-of-apt or low-key?).
3. Context shifts — user pivots and prior filters may not carry.

Each clarify call provides 3-4 concrete options in the \`options\` array. If one option is the clear lead based on what little you know, prefix its label with "(Recommended) ". The \`question\` field is the SMS text — phrase it as one short question with the options baked in as numbered lines:

Example question: "What kind of night are you after?\n1) (Recommended) Something loud and social\n2) A quiet cocktail spot\n3) Live music\n4) Surprise me"

Extract \`implicit_filters\` for anything you already understood (neighborhood, time, category). These persist.

Never write a clarifying question as plain text. If you need to ask, use the tool.

When you DO search (user had enough specificity, or answered a clarify, or is refining):
- Read the results. Each pick has \`recommended: true\` and a \`diversity_role\` (primary, contrast, wildcard) — the top picks are chosen for breadth, not just rank. Use all of them.
- Give 2-3 picks that contrast — different vibes, different energy levels. The contrast IS the invitation. The user self-selects by reacting.
- Each pick needs a reason — WHY this tonight. Pull from \`short_detail\`, \`why\`, \`venue_profile\`. "One-night-only" or "director Q&A after" or "tiny room, always packs out" — not just name + time.
- Use numbered format (1), 2)) so the user can reply with a number.
- If any pick has \`off_query: true\`, echo the \`off_query_reason\` in your line — "nothing in LES tonight, but 10 min over in Williamsburg…" Don't hide broadening.
- End with a self-aware check-in that hints at what else is out there: "I've also got comedy and late-night dance stuff if neither hits." Show you looked at the full range.

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
Bare neighborhood → clarify first (not search):
User: "bushwick"
[calls clarify tool with question: "What's the vibe tonight in Bushwick?\n1) (Recommended) Comedy or a show\n2) DJ / dance floor\n3) Chill drinks\n4) Surprise me" and options: ["Comedy or a show", "DJ / dance floor", "Chill drinks", "Surprise me"]]

Category but no time/vibe → clarify (don't assume):
User: "comedy in bushwick"
[calls clarify with question: "Got it — what kind of comedy night?\n1) Seated show with a lineup\n2) Loud bar comedy\n3) Open mic / wild card\n4) Either, surprise me"]

Enough specificity → search (numbered picks, with off-query honesty):
User: "comedy in bushwick around 9"
SMS:
Two that stand out:
1) Union Pool standup (9 PM, free) — tiny back room, no cover, lineup is a mix of headliners testing material.
2) Trash Bar open mic (10 PM, $5) — chaotic energy, bring a thick skin. Different feel but close by.
Nothing free after 11 in Bushwick tonight — want me to check Williamsburg?

Off-query broadening — name it:
User: "free jazz in LES tonight"
SMS:
Nothing free in LES for jazz tonight, but worth a 10-min walk:
1) Nublu on Ave C (9 PM, free) — technically East Village, but the room is a LES crowd. Rotating jazz jam.
2) Mona's on Ave B (10 PM, free) — Monday jazz jam, intimate, packs out fast.
I can also look at paid shows in LES if you'd rather stay local.

User reacts to a pick:
User: "tell me about 1"
SMS: Nublu is a narrow room on Ave C, great for getting close to the players. Jam kicks off around 9, no cover, cocktails are $15-ish. Rotating musicians — never the same twice. Get there by 9:15 for a spot near the stage. You going?

Context shift (drop prior filters):
User: [was searching jazz]
User: "what about for a date tomorrow"
[calls clarify — context shift, no activity specified. Does NOT carry jazz filter.]
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
 * Build a recommended slice that spans categories and vibes rather than
 * returning the top-N by rank (which tends toward clones). Given a pool
 * already sorted by quality, walk it greedily and keep an item if it
 * introduces a category OR venue_size/interaction_format not yet seen in
 * the slice. Fall back to pure rank order once breadth targets are met.
 *
 * Returns a Set of event IDs marked as recommended, plus a diversity_role
 * map: the first item is 'primary', the next two are 'contrast', anything
 * beyond that is 'wildcard'.
 */
function diversifyPool(pool, { targetSize = 5, minCategories = 3 } = {}) {
  if (!pool?.length) return { recommendedIds: new Set(), roleMap: {} };

  const recommendedIds = new Set();
  const roleMap = {};
  const seenCategories = new Set();
  const seenVibes = new Set();

  // First pass: greedy breadth — pick items that add a new category/vibe dimension.
  for (const e of pool) {
    if (recommendedIds.size >= targetSize) break;
    const cat = e.category || 'unknown';
    const vibe = e.venue_size || e.interaction_format || 'unknown';
    const addsCategory = !seenCategories.has(cat);
    const addsVibe = !seenVibes.has(vibe);
    if (recommendedIds.size === 0 || addsCategory || addsVibe) {
      recommendedIds.add(e.id);
      seenCategories.add(cat);
      seenVibes.add(vibe);
    }
  }

  // Second pass: if still under target and we have minCategories, fill by rank.
  if (recommendedIds.size < targetSize && seenCategories.size >= minCategories) {
    for (const e of pool) {
      if (recommendedIds.size >= targetSize) break;
      recommendedIds.add(e.id);
    }
  }

  // Assign roles in pool order (rank-first, not diversify-order).
  let rankIndex = 0;
  for (const e of pool) {
    if (!recommendedIds.has(e.id)) continue;
    if (rankIndex === 0) roleMap[e.id] = 'primary';
    else if (rankIndex <= 2) roleMap[e.id] = 'contrast';
    else roleMap[e.id] = 'wildcard';
    rankIndex++;
  }

  return { recommendedIds, roleMap };
}

/**
 * Describe why an event falls outside the user's stated filters. Returns
 * undefined when the event matches cleanly, a short human-readable phrase
 * otherwise (for the model to echo to the user).
 */
function buildOffQueryReason(e, neighborhood, activeFilters) {
  const reasons = [];
  if (neighborhood && e.neighborhood && e.neighborhood !== neighborhood) {
    reasons.push(`in ${e.neighborhood}, not ${neighborhood}`);
  }
  if (activeFilters?.categories?.length && e.category && !activeFilters.categories.includes(e.category)) {
    reasons.push(`${e.category}, not ${activeFilters.categories.join('/')}`);
  }
  if (activeFilters?.free_only && !e.is_free) {
    reasons.push('not free');
  }
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

/**
 * Serialize event pool into compact format for LLM.
 * Recommended slice is chosen for breadth (category/vibe diversity), not
 * just rank. Off-query picks are tagged so the model can name the broadening.
 */
function serializePoolForContinuation(poolResult) {
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);
  const { pool, hood: neighborhood, activeFilters, isSparse, matchCount,
          nearbyHoods, suggestedHood, excludeIds, isCitywide, isBorough, borough,
          nearbyHighlight } = poolResult;

  const hoodLabel = isBorough ? `${borough} (borough-wide)` : isCitywide ? 'citywide' : neighborhood || 'NYC';
  const filterDesc = activeFilters && Object.values(activeFilters).some(Boolean) ? describeFilters(activeFilters) : '';

  const { recommendedIds, roleMap } = diversifyPool(pool);

  const events = pool.map((e) => {
    const dayLabel = e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local;
    const tag = e.filter_match === 'hard' ? '[MATCH]' : e.filter_match === 'soft' ? '[SOFT]' : '';
    const nearbyTag = (neighborhood && e.neighborhood && e.neighborhood !== neighborhood) ? '[NEARBY]' : '';
    const why = buildRecommendationReason(e);
    const isRecommended = recommendedIds.has(e.id);
    const offQueryReason = buildOffQueryReason(e, neighborhood, activeFilters);
    return {
      id: e.id, name: cleanEventName((e.name || '').slice(0, 80)), venue_name: e.venue_name,
      neighborhood: e.neighborhood, day: dayLabel, start_time_local: e.start_time_local, end_time_local: e.end_time_local || undefined,
      is_free: e.is_free, price_display: e.price_display, category: e.category,
      short_detail: (e.short_detail || e.description_short || '').slice(0, 200),
      recurring: e.is_recurring ? e.recurrence_label : undefined,
      venue_size: e.venue_size || undefined,
      interaction_format: e.interaction_format || undefined,
      recommended: isRecommended ? true : undefined,
      diversity_role: isRecommended ? roleMap[e.id] : undefined,
      why: isRecommended ? why : undefined,
      off_query: offQueryReason ? true : undefined,
      off_query_reason: offQueryReason,
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
  buildOffQueryReason,
  diversifyPool,
  cleanEventName,
  stripCodeFences,
  NEIGHBORHOOD_NAMES,
};
