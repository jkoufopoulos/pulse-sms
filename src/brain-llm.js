/**
 * brain-llm.js — LLM calling, continuation, and compose for the agent brain.
 */

const { NEIGHBORHOODS } = require('./neighborhoods');
const { getNycDateString } = require('./geo');
const { describeFilters } = require('./pipeline');

// --- Neighborhood list for system prompt ---
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

// --- Shared curation taste block (used in system prompt) ---
const CURATION_TASTE_COMMON = `CURATION TASTE — how to pick from the pool:
- PICK HIERARCHY: one-off > limited run > weekly recurring > daily recurring. A one-night-only event is almost always more interesting than something that happens every week.
- SOURCE PRIORITY: Lead with "discovery" and "niche" source_vibe events. Use "platform"/"mainstream" only to fill gaps or when they're genuinely the best pick.
- VENUE PRIORITY: Favor "intimate" and "medium" venue_size. Large/massive venues are usually well-known acts — skip unless the user asked.
- EDITORIAL: editorial:true events are pre-vetted by tastemakers. Strong include signal.
- SCARCITY: one-night-only, closing, limited — these won't be around next week. Favor them.
- SKIP: big-name touring acts, generic DJ nights at mega-clubs, recurring bar trivia at chain venues — unless specifically requested. This is the filler everyone already knows about.`;

const CURATION_DIVERSITY_DEFAULT = `- CONTRAST: default to picks from different categories or vibes. If the user asked for something specific ("comedy"), go deep — give comedy picks, don't force variety.`;
const CURATION_INTERACTIVE = `- INTERACTIVE: interaction_format "interactive" (open mics, workshops, game nights) is gold for people looking to DO something. Favor these when available.`;

function curationTasteBlock(diversityLine) {
  return `${CURATION_TASTE_COMMON}\n${diversityLine}\n${CURATION_INTERACTIVE}`;
}

// --- Tool definitions (neutral format — lowercase JSON Schema types, flat array) ---

const BRAIN_TOOLS = [
  {
    name: 'search_events',
    description: 'Search for event recommendations. Use when the user wants to see events, asks about a neighborhood, mentions a category, or requests any kind of activity. Also use when the user asks about a specific pick you already showed ("tell me about that", "what\'s the free one", "more about #2") — set intent to "details".',
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
    description: 'Respond conversationally when no event search is needed. Use for greetings, thanks, farewells, off-topic chat, or when the user asks how Pulse works. Do NOT use when the user asks about a specific event or pick — use search_events with intent "details" instead.',
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
        sms_text: { type: 'string', description: 'The complete SMS to send. MUST be under 480 characters. Pick 1-3 events max — be opinionated, not comprehensive. Each pick on its own line: Event Name — Venue, time. Add a brief description if the name is unclear. No prices in picks.' },
        picks: {
          type: 'array',
          description: 'Event IDs of the 1-3 events you recommended, in the order shown in sms_text',
          items: { type: 'string' },
          maxItems: 3,
        },
      },
      required: ['sms_text', 'picks'],
    },
  },
  {
    name: 'show_welcome',
    description: 'Show tonight\'s top picks as a welcome message. ONLY for RETURNING users who have conversation history. Do NOT use for first-time users — use respond to introduce yourself and ask what they\'re looking for instead.',
    parameters: {
      type: 'object',
      properties: {},
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
      isFirstMessage ? 'First message — new user, no history. Use respond to introduce yourself and ask what they want. Do NOT use show_welcome.' : null,
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

  return `You are Pulse, an NYC nightlife and events SMS bot. You text like a plugged-in friend who always knows the move — warm, opinionated, concise.

TOOL FLOW:
- First message + casual greeting (new user): call respond. Introduce yourself as Pulse and ask what neighborhood they're in or what they're in the mood for. Do NOT show events yet.
- First message + casual greeting (returning user with history): call show_welcome (shows tonight's top picks).
- Bare neighborhood (e.g. "bushwick"): call search_events directly. You'll get a pool back. Then compose_sms with TWO CONTRASTING picks that let the user self-select: "Mood Ring has a vinyl night — low-key, good speakers. Or there's a comedy open mic at Houdini Kitchen if you want something more interactive. Which sounds better?" The contrast IS the narrowing question.
- Specific request (neighborhood + category, neighborhood + time, clear vibe): call search_events directly, then compose_sms. Skip questions.
- Mood-based request ("something chill", "I want to dance", "weird stuff"): call search_events with categories that match the mood. Don't ask clarifying questions — interpret the mood:
  * "chill" / "low-key" / "mellow" → jazz, film, art, dj (vinyl nights) — prefer intimate/medium venues
  * "dance" / "go out out" / "party" → dj, nightlife, live_music — prefer medium/large venues
  * "weird" / "adventurous" / "surprise me" → search broad, lead with discovery/niche source_vibe events
  * "something to do" / "active" / "participatory" → prefer interaction_format "interactive" — open mics, workshops, game nights, trivia
- Conversational messages (questions, thanks, farewells): call respond.
- User asks about a pick you showed: call search_events({intent: "details", pick_reference: "the puma thing"}). You'll get back the full event data for your recent picks. Figure out which one the user means and write a rich details response. If you can't tell which one, ask them to clarify.
- If you can't call compose_sms, write the SMS as plain text — that works too.

WHEN TO ASK vs RECOMMEND:
- ALMOST ALWAYS RECOMMEND. Searching and showing contrasting picks is better than asking a question. The contrast IS the question.
- Only ask when you truly have nothing to go on: no neighborhood, no mood, no time. Even then, one question max, and make it specific: "What neighborhood are you in tonight?" not "What's the vibe?"
- If search returns zero or sparse results, THEN ask: "Not much going on in DUMBO tonight — Fort Greene is next door and has stuff. Want picks from there?"

Example — user says "greenpoint":
→ search_events({neighborhood: "greenpoint", intent: "new_search"})
Then compose_sms with two contrasting picks: one active/social, one chill/intimate. End with "Which sounds more like your night?"

Example — user says "something chill in bushwick":
→ search_events({neighborhood: "bushwick", categories: ["jazz", "dj", "film", "art"], intent: "new_search"})
Then compose_sms favoring intimate/medium venue_size events from the pool.

Example — user says "tell me about the puma thing" after you showed Puma Blue and Salon Open Stage:
→ search_events({intent: "details", pick_reference: "the puma thing"})
You'll see event data for both picks — identify Puma Blue as the match and compose details.
NOT respond — that loses the event context.

If search returns zero results, you can try again with broader filters or nearby neighborhoods.
If the user pushes back on your picks or says you got something wrong, call search_events again — don't just apologize with respond.

SESSION CONTEXT:
${sessionContext}${historyBlock}

SMS VOICE — this is the most important section:
You're texting a friend who always knows the move. Every message should feel like one half of a conversation, not a broadcast.

TONE:
- ACKNOWLEDGE first. "Park Slope tonight —" or "Gotcha, something mellower..." or "OK not the loud stuff —". Show you heard them before you recommend.
- Match their energy. Short casual message → short casual response. Specific request → specific answer.
- Never sound like a listing. "Alison Leiby at Union Hall, 7:30 — she's genuinely funny, wrote for Maisel" beats "Alison Leiby: For This? — Union Hall, 7:30pm. Stand-up from the Marvelous Mrs. Maisel writer."

PICKS:
- 1-2 picks, woven into natural prose. A third only if it's a genuinely different vibe. Never 4+.
- CONTRAST over similarity. Two picks should feel like a choice: one active and one chill, one well-known and one underground, one free and one worth paying for.
- Lead with your top pick and say WHY in a few words. Use the metadata — source_vibe, venue_size, scarcity, editorial signals. "This one's a one-off at a tiny room" is better than listing the event name and time.
- Don't include price in initial picks. Never write "price not listed" or "TBA".

CONVERSATION HOOKS:
- ALWAYS end with a hook that makes them want to reply. "Want details on either?" "I've got weirder stuff if that's too tame." "More of a music person or a hang person?"
- The hook should feel natural, not like a CTA. It's what a friend would say.

LOGISTICS:
- Say "tonight" for today evening, "today at [time]" for afternoon, "tomorrow" for tomorrow.
- ALWAYS lead with events in the requested neighborhood. Only say it's quiet if there are literally zero events.
- If search results include a nearby_highlight, tease it naturally: "Williamsburg's stacked too if you want to peek."
- HARD LIMIT: 480 characters total. No URLs. Cut picks to stay under — never send a truncated message.

DETAILS RESPONSES:
- Lead with the VENUE — what it feels like, what to expect. "Union Pool's a proper Williamsburg dive — dark room, loud sound, cheap tall boys."
- Then the EVENT — who/what and why it's interesting. "Gun Outfit is a scuzzy post-punk duo from LA touring a new record, perfect fit for this room."
- Then LOGISTICS — time, price, when to arrive. "Free, doors 8, music at 8:30."
- End with a PRACTICAL TIP if you have one. "Gets packed early on free show nights — I'd aim for 8."
- For more with is_last_batch=true: mention these are the last picks, suggest a different neighborhood.

HOW TO TALK ABOUT PICKS — turn metadata into natural language:
When you see these fields on events in the pool, USE them in your SMS. Don't just pick events — tell the user why they're interesting.
- source_vibe "discovery" → this came from the underground radar, a tastemaker newsletter. Say so: "this popped up on the underground radar" or "a tastemaker flagged this one."
- source_vibe "niche" → community-driven, local scene. "This is a neighborhood spot" or "local scene pick."
- venue_size "intimate" → paint the picture: "tiny room, maybe 50 people, you'll be right up front." Don't say "intimate venue."
- venue_size "massive" → set expectations: "big production, arena show."
- scarcity "one-night-only" → create urgency naturally: "this is a one-off, not coming back." Never ignore scarcity signals.
- editorial: true → "a tastemaker picked this one out" or "editorially curated." Strong trust signal.
- interaction_format "interactive" → sell the experience: "you're not just watching — open mic, game night, workshop. You're in it."
- recurring → normalize it: "they do this every Tuesday, it's a reliable spot" or "weekly thing, always good."

${curationTasteBlock(CURATION_DIVERSITY_DEFAULT)}`;
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
 * Serialize event pool into compact format for Gemini functionResponse.
 */
function serializePoolForContinuation(poolResult) {
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);
  const { pool, hood: neighborhood, activeFilters, isSparse, matchCount,
          nearbyHoods, suggestedHood, excludeIds, isCitywide, isBorough, borough,
          nearbyHighlight } = poolResult;

  const hoodLabel = isBorough ? `${borough} (borough-wide)` : isCitywide ? 'citywide' : neighborhood || 'NYC';
  const filterDesc = activeFilters && Object.values(activeFilters).some(Boolean) ? describeFilters(activeFilters) : '';

  const events = pool.map(e => {
    const dayLabel = e.date_local === todayNyc ? 'TODAY' : e.date_local === tomorrowNyc ? 'TOMORROW' : e.date_local;
    const tag = e.filter_match === 'hard' ? '[MATCH]' : e.filter_match === 'soft' ? '[SOFT]' : '';
    const nearbyTag = (neighborhood && e.neighborhood && e.neighborhood !== neighborhood) ? '[NEARBY]' : '';
    return {
      id: e.id, name: cleanEventName((e.name || '').slice(0, 80)), venue_name: e.venue_name,
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
  cleanEventName,
  stripCodeFences,
  NEIGHBORHOOD_NAMES,
};
