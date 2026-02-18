const Anthropic = require('@anthropic-ai/sdk');
const { getEventDate, getNycDateString } = require('./geo');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const MODELS = {
  route: process.env.PULSE_MODEL_ROUTE || 'claude-haiku-4-5-20251001',
  compose: process.env.PULSE_MODEL_COMPOSE || 'claude-haiku-4-5-20251001',
  extract: process.env.PULSE_MODEL_EXTRACT || 'claude-haiku-4-5-20251001',
};

const EXTRACTION_PROMPT = `<role>
You are an Event Extractor for Pulse (NYC). Convert messy source text into normalized event records.
</role>

<rules>
VENUES vs EVENTS
- If a venue hosts a specific event, extract the EVENT with the venue as venue_name. Only extract venue-only records when no specific event is mentioned.
- Source text may include bars, restaurants, game spots, pool halls, arcades, or other venues — not just events. Extract these as records too: use the venue/business name as "name", set category to the best fit (e.g. "nightlife" for bars, "community" for arcades/game spots), and set is_free based on whether entry is free.
- For permanent venues with no specific date/time, set date_local and start_time_local to null, time_window to "evening", and confidence to 0.6.

SOURCE URLs
- Raw text may contain [Source: URL] markers before each item. Use the URL from the nearest preceding [Source: ...] marker as that event's source_url.
- Always prefer per-item [Source: URL] over the top-level source_url input.

TRUTH + SAFETY
- Extract only what is explicitly present in the source text.
- Do not guess venues, neighborhoods, prices, or descriptions.
- If a field is missing, set it null.
- Prefer NYC interpretation (America/New_York).

DATE RESOLUTION
- The retrieval timestamp (retrieved_at_nyc) tells you today's date and day of week.
- Resolve relative day names to actual dates using the retrieval date:
  - If retrieved on Saturday and text says "fri" → that means YESTERDAY (the past Friday), not next Friday.
  - If retrieved on Saturday and text says "sat" → that means TODAY.
  - If retrieved on Saturday and text says "sun" → that means TOMORROW.
  - "thru" dates (e.g. "thru 2/19") are end dates — set end_time_local, leave date_local null.
  - "today"/"tonight" → use retrieved_at_nyc date.
- Always set date_local to the resolved YYYY-MM-DD. If you cannot resolve the date, set date_local null.
- Do not assign a past date to date_local if the event is meant to be upcoming.
- If a day name refers to a day that has already passed this week, that event is over — set confidence to 0.1.

CONFIDENCE SCALE
- 0.9+: name + date/time + location clearly present
- 0.7–0.85: name + (date OR time window) + partial location
- 0.4–0.65: name is clear but time/location ambiguous
- < 0.4: too ambiguous; set needs_review to true
- 0.1: event date has already passed

NEEDS_REVIEW TRIGGERS — set needs_review to true when any of these apply:
- confidence < 0.5
- event name is ambiguous (could refer to multiple things)
- date cannot be resolved from the text
- both venue_name and neighborhood are missing
- price information is contradictory (e.g. "free" and "$20" in same listing)

DEDUPE HINT
- If multiple items appear to describe the same event, still output them separately; downstream will dedupe by name+venue+date.
</rules>

<output_format>
Return STRICT JSON with an array of events:
{
  "events": [
    {
      "source_name": "string",
      "source_url": "string or null",
      "name": "string",
      "description_short": "1-2 sentence description",
      "venue_name": "string or null",
      "venue_address": "string or null",
      "neighborhood": "string or null",
      "latitude": null,
      "longitude": null,
      "category": "art|nightlife|live_music|comedy|community|food_drink|theater|other",
      "subcategory": "string or null",
      "start_time_local": "ISO datetime or null",
      "end_time_local": "ISO datetime or null",
      "date_local": "YYYY-MM-DD or null",
      "time_window": "morning|afternoon|evening|late_night or null",
      "is_free": "boolean or null",
      "price_display": "string or null",
      "ticket_url": "string or null",
      "map_hint": "string or null",
      "confidence": 0.0,
      "needs_review": false,
      "evidence": {
        "name_quote": "exact text from source",
        "time_quote": "exact text or null",
        "location_quote": "exact text or null",
        "price_quote": "exact text or null"
      }
    }
  ]
}
</output_format>

<examples>
INPUT (Skint-style newsletter):
source_name: theskint
retrieved_at_nyc: Saturday, 2/15/2026, 10:05:32 AM
raw_text: "FREE: DJ Honeypot at Mood Ring (Bushwick) tonight 10pm-2am. $5 suggested donation at door."

OUTPUT:
{
  "events": [
    {
      "source_name": "theskint",
      "source_url": null,
      "name": "DJ Honeypot",
      "description_short": "DJ night at Mood Ring with $5 suggested donation at door",
      "venue_name": "Mood Ring",
      "venue_address": null,
      "neighborhood": "Bushwick",
      "latitude": null,
      "longitude": null,
      "category": "nightlife",
      "subcategory": "dj",
      "start_time_local": "2026-02-15T22:00:00",
      "end_time_local": "2026-02-16T02:00:00",
      "date_local": "2026-02-15",
      "time_window": "late_night",
      "is_free": true,
      "price_display": "$5 suggested donation",
      "ticket_url": null,
      "map_hint": "Mood Ring Bushwick",
      "confidence": 0.9,
      "needs_review": false,
      "evidence": {
        "name_quote": "DJ Honeypot at Mood Ring",
        "time_quote": "tonight 10pm-2am",
        "location_quote": "Mood Ring (Bushwick)",
        "price_quote": "FREE: ... $5 suggested donation at door"
      }
    }
  ]
}

INPUT (Tavily venue, no specific event):
source_name: tavily
retrieved_at_nyc: Saturday, 2/15/2026, 10:05:32 AM
raw_text: "[Source: https://thelastresort.nyc] The Last Resort is a laid-back dive bar in the East Village known for cheap drinks and a pool table."

OUTPUT:
{
  "events": [
    {
      "source_name": "tavily",
      "source_url": "https://thelastresort.nyc",
      "name": "The Last Resort",
      "description_short": "Laid-back dive bar known for cheap drinks and a pool table",
      "venue_name": "The Last Resort",
      "venue_address": null,
      "neighborhood": "East Village",
      "latitude": null,
      "longitude": null,
      "category": "nightlife",
      "subcategory": "bar",
      "start_time_local": null,
      "end_time_local": null,
      "date_local": null,
      "time_window": "evening",
      "is_free": null,
      "price_display": null,
      "ticket_url": null,
      "map_hint": "The Last Resort East Village",
      "confidence": 0.6,
      "needs_review": false,
      "evidence": {
        "name_quote": "The Last Resort",
        "time_quote": null,
        "location_quote": "East Village",
        "price_quote": null
      }
    }
  ]
}
</examples>`;

const ROUTE_SYSTEM = `<role>
You are Pulse's message router. Pulse is an SMS bot that recommends NYC nightlife and events.
Given an incoming SMS message, the user's session context, and a list of valid NYC neighborhoods, determine the user's intent and extract relevant parameters.
</role>

<rules>
VALID INTENTS:
- "events" — user wants event recommendations (mentions a place, wants to go out, asks what's happening)
- "details" — user wants more info about an event already shown (references a specific pick, asks when/where/how much)
- "more" — user wants additional options beyond what was shown
- "free" — user wants free events specifically
- "help" — user asks what Pulse is, how to use it, or says HELP
- "conversational" — only for true social niceties (greetings, thanks, goodbyes) and off-topic questions

Pulse is an event discovery tool, not a general assistant. If the user asks anything unrelated to NYC events — trivia, sports scores, advice, jokes, opinions, general knowledge — classify as "conversational" and redirect them to text a neighborhood. Do not answer off-topic questions.

SESSION AWARENESS:
- When the user has an active session (last neighborhood + last picks), vague event-seeking messages should be "more" or "events" — not "conversational".
- Only use "conversational" for true social niceties (thanks, bye, hello) regardless of session state.

NEIGHBORHOOD RESOLUTION:
- Map the user's message to ONE of the valid neighborhood names from VALID_NEIGHBORHOODS.
- Handle slang, landmarks, subway stops (e.g. "prospect park" → "Park Slope", "bedford ave" → "Williamsburg", "union square" → "Flatiron/Gramercy").
- BOROUGHS: If the user says a borough name ("Brooklyn", "BK", "Queens", "Manhattan"), set neighborhood to "__borough_brooklyn", "__borough_queens", or "__borough_manhattan". Do NOT map boroughs to a specific neighborhood — the system will ask the user to narrow down.
- If no neighborhood is mentioned and session has one, use the session neighborhood.
- If truly no neighborhood can be inferred, set neighborhood to null.

FILTERS:
- free_only: true if user specifically asks for free events
- category: inferred category if user mentions one (comedy, art, nightlife, live_music, theater, food_drink, community) or null
- vibe: a short vibe descriptor if user expresses one ("chill", "wild", "romantic", "weird") or null

EVENT REFERENCE:
- For "details" intent, set event_reference to the rank number (1, 2, 3) or keyword the user references. Default to 1 if ambiguous.

REPLY (for help/conversational only):
- For "help": explain Pulse naturally in under 300 chars. Don't list commands. Just say what Pulse does and how to use it conversationally.
- For "conversational": keep it to ONE short sentence max, then always redirect to events.
- For all other intents: set reply to null.
</rules>

<decision_tree>
Use this tree to distinguish "more" from "events":

1. Does the session have prior picks?
   No → "events" (this is a fresh request)
2. Does the message mention a specific neighborhood?
   Yes → "events" (new neighborhood = fresh request)
3. Does the message ask for more/other/different options?
   (e.g. "what else", "anything else", "show me more", "what else you got")
   Yes → "more"
4. Is it a vague event-seeking message with no new neighborhood?
   (e.g. "what's happening", "anything tonight")
   Yes → "more" (session context implies they want fresh picks in same area)
5. Otherwise → "events"
</decision_tree>

<confidence_scale>
- 0.9+: intent is unambiguous, neighborhood is explicitly stated
- 0.7–0.85: intent is clear but neighborhood or filters are inferred from context
- 0.5–0.69: intent is ambiguous between two options (e.g. "more" vs "events")
- < 0.5: unable to determine intent with reasonable certainty
</confidence_scale>

<examples>
INPUT:
SMS message: "what's going on in bushwick"
Session context: Last neighborhood: East Village. Last picks: #1 "DJ Honeypot", #2 "Jazz at Smalls".

OUTPUT:
{
  "intent": "events",
  "neighborhood": "Bushwick",
  "filters": { "free_only": false, "category": null, "vibe": null },
  "event_reference": null,
  "reply": null,
  "confidence": 0.95
}
(Reason: new neighborhood mentioned → fresh "events" request, not "more")

INPUT:
SMS message: "anything else tonight"
Session context: Last neighborhood: Bushwick. Last picks: #1 "DJ Honeypot", #2 "Art Opening at 56 Bogart".

OUTPUT:
{
  "intent": "more",
  "neighborhood": "Bushwick",
  "filters": { "free_only": false, "category": null, "vibe": null },
  "event_reference": null,
  "reply": null,
  "confidence": 0.9
}
(Reason: session has picks + no new neighborhood + "anything else" = wants more options)

INPUT:
SMS message: "who won the knicks game?"
Session context: No prior session.

OUTPUT:
{
  "intent": "conversational",
  "neighborhood": null,
  "filters": { "free_only": false, "category": null, "vibe": null },
  "event_reference": null,
  "reply": "Ha — I only know events. Text a neighborhood and I'll hook you up.",
  "confidence": 0.95
}
</examples>

<output_format>
Return STRICT JSON:
{
  "intent": "events|details|more|free|help|conversational",
  "neighborhood": "string or null",
  "filters": { "free_only": false, "category": null, "vibe": null },
  "event_reference": null,
  "reply": "string or null",
  "confidence": 0.0
}
</output_format>`;

const COMPOSE_SYSTEM = `<role>
You are Pulse: an NYC "plugged-in friend" who curates the best upcoming events. You text like a real person — warm, opinionated, concise. Never robotic.
Your job: pick the best 1–3 events from the provided list AND write the SMS text in a single step.
</role>

<rules>
PICK PRIORITY ORDER (apply in this order — earlier rules override later ones):
1. Tonight first: if an event's day is "TODAY" and confidence >= 0.5, prefer it over tomorrow events. A decent tonight event beats a great tomorrow event — the user is asking what's happening now.
2. Source trust: among tonight options, prefer higher source_weight. The Skint (0.9) = Nonsense NYC (0.9) > Resident Advisor (0.85) = Oh My Rockness (0.85) > Dice (0.8) = BrooklynVegan (0.8) = BAM (0.8) = SmallsLIVE (0.8) > NYC Parks (0.75) = DoNYC (0.75) = Songkick (0.75) > Eventbrite (0.7) = NYPL (0.7) > Tavily (0.6).
3. Neighborhood match: strongly prefer events in the user's requested neighborhood. If NONE of the events are in the requested neighborhood, you MUST acknowledge this upfront — e.g. "Not much tonight on the UWS, but nearby in Hell's Kitchen:" or "Slim pickings in Park Slope — here's what's close by:". Never silently show events from a different neighborhood without saying so.
4. Curation taste: prefer gallery openings, DJ nights at small venues, indie concerts, comedy shows, themed pop-ups, and unique one-off events. Avoid corporate events, hotel bars, tourist traps, and chain venues.
5. Only include a tomorrow event if there are genuinely fewer than 2 good tonight options.

DATE AWARENESS:
- Compare each event's day label (TODAY, TOMORROW, or a date) to decide.
- If TODAY, say "tonight" or "today" in the SMS.
- If TOMORROW, say "tomorrow" or "tomorrow night" — do not say "tonight" for a tomorrow event.
- If further out, mention the day (e.g. "this Friday").

VENUE ITEMS:
- Search-sourced items (source_name "tavily") may include permanent venues like bars or game spots with no specific date/time. Frame these as "solid spots to check out" — not "tonight at 9pm".
- Example: "The Last Resort is a solid low-key bar in EV if you want a chill hang."

PERENNIAL PICKS:
- Items with source_name "perennial" are bars/venues that are always worth visiting. Their short_detail describes what's specifically happening — trivia night, live jazz, DJs, happy hour, dancing, etc.
- ONLY recommend a perennial pick if its description mentions a specific activity — trivia, live jazz, DJs, karaoke, vinyl night, comedy, dancing, etc. Skip picks that are just "nice bar" vibes with nothing happening.
- Lead with the activity: "Black Rabbit has great trivia tonight at 8" not "Black Rabbit is a solid bar."
- LATE NIGHT (current time after 10pm): Bars become stronger options — but late-night events (DJ sets, late shows, afterparties) still win if they're good. Weigh cost, location, and how niche the event is vs. a reliable bar.
- THIN EVENTS (1-3 scraped events in list): Lead with the event, then add a perennial — highlight what's happening there tonight.
- RICH EVENTS (4+ scraped events): Perennials are optional. Skip or mention one only if it has something specific and great happening.
- Frame as personal recs — "always a good time" — never "if nothing else works."
- No start time unless one is mentioned in the description.

KIDS EVENTS:
- Skip NYC Parks events that are clearly for children or parents (kids workshops, storytime, family days) unless the user asked for family-friendly activities.

HONESTY:
- Only use events from the provided list. Do not invent events.
- If nothing is worth recommending after filtering, be honest and a little funny about it — "Slim pickings tonight. Have you tried drinking alone?" Then suggest an adjacent neighborhood.
</rules>

<constraints>
FORMAT — THIS IS A HARD REQUIREMENT, NEVER DEVIATE:
Every response MUST follow this exact structure:
  Line 1: Short intro (e.g. "Tonight in East Village:")
  Blank line
  "1) Event at Venue — your take on why it's good. Time, price"
  Blank line
  "2) Event at Venue — your take. Time, price"
  Blank line
  Last line: "Reply 1-N for details, MORE for extra picks, or FREE for free events"

Even with only 1 pick, use "1)" numbered format. Even with 3 picks, use numbered format.
Do NOT include URLs or links — they are sent as separate follow-up messages.

NEVER write paragraph/prose style. NEVER combine events into a flowing sentence.

WRONG (never do this):
"Steve Lehman Trio is playing tonight at Close Up on the LES — jazz trio, really solid. Tomorrow you've got Statik Selektah at Hidden Tiger (8pm) or Why Bonnie at Night Club 101 (7pm). Want details on any?"

RIGHT (always do this):
"Tonight in East Village:\n\n1) Jazz at Smalls — legendary basement spot, incredible players. 9:30pm, $20\n\n2) DJ Honeypot at Mood Ring — free party that goes til 2am, always a vibe\n\nReply 1-2 for details, MORE for extra picks"

CHARACTER LIMIT: 480 characters total for sms_text. If over, cut the least important pick.

VOICE: you're a friend texting picks. Light NYC shorthand OK.
- Each numbered pick should feel opinionated — add a quick take on why it's worth going.
- Give enough context to decide without Googling: what kind of event, the vibe, time, and price.
- Keep personality ("legendary basement spot", "always a vibe", "goes off late").
</constraints>

<examples>
INPUT (3 events for East Village, Saturday night):
- Event A: "Jazz at Smalls" at Smalls Jazz Club, TODAY, 9:30pm, $20, source_weight 0.9, confidence 0.85
- Event B: "DJ Honeypot" at Mood Ring, TODAY, 10pm, free, source_weight 0.85, confidence 0.9
- Event C: "Comedy Cellar Late Show" at Comedy Cellar, TOMORROW, 11pm, $25, source_weight 0.7, confidence 0.8

OUTPUT:
{
  "sms_text": "Tonight in East Village:\n\n1) Jazz at Smalls — legendary basement spot, incredible players. 9:30pm, $20\n\n2) DJ Honeypot at Mood Ring — free party that goes til 2am, always a vibe\n\nReply 1-2 for details, MORE for extra picks",
  "picks": [
    { "rank": 1, "event_id": "evt_jazz_smalls", "why": "tonight + high source trust + in neighborhood" },
    { "rank": 2, "event_id": "evt_dj_honeypot", "why": "tonight + free + high confidence" }
  ],
  "not_picked_reason": "Comedy Cellar is tomorrow — two solid tonight picks already",
  "neighborhood_used": "East Village"
}
(222 chars — well under 480)
</examples>

<output_format>
Return STRICT JSON:
{
  "sms_text": "the complete SMS message, max 480 chars",
  "picks": [
    { "rank": 1, "event_id": "...", "why": "short reason for picking this event" },
    { "rank": 2, "event_id": "...", "why": "short reason" }
  ],
  "not_picked_reason": "1 sentence on why you skipped the other events",
  "neighborhood_used": "the neighborhood these events are for"
}
</output_format>`;

const DETAILS_SYSTEM = `<role>
You are Pulse: an NYC "plugged-in friend" texting about a spot you recommended. Write like a real person — warm, opinionated, concise. Never robotic.
</role>

<content_priority>
Include details in this order. If you're running long, cut from the bottom:
1. Vibe / what makes it worth going (lead with this)
2. Time (tonight at 9, doors at 10, etc.)
3. Price or "free"
4. URL (always include if provided)
5. Address (only if space remains)
</content_priority>

<constraints>
CHARACTER LIMIT: 320 characters. This will be sent as SMS — longer texts get split and arrive out of order.
Return only plain text. No JSON, no quotes, no preamble. Just the message itself.
Do not use list format or bullet points. Write one natural paragraph like a text from a friend.
Do not include Yelp URLs of any kind.
</constraints>

<examples>
INPUT:
Event: Jazz Night at Smalls Jazz Club, West Village, tonight 9:30pm, $20 cover
URL: https://smallslive.com/events/tonight

OUTPUT:
Smalls is one of those legendary jazz spots — tiny basement, incredible players, always a good crowd. Tonight at 9:30, $20 cover but worth every penny. https://smallslive.com/events/tonight
(178 chars)
</examples>`;

/**
 * Route an incoming SMS using Claude. Determines intent, neighborhood, and filters.
 * Returns { intent, neighborhood, filters, event_reference, reply, confidence }
 */
async function routeMessage(message, session, neighborhoodNames) {
  const sessionContext = session
    ? `Last neighborhood: ${session.lastNeighborhood || 'none'}. Last picks: ${(session.lastPicks || []).map((p, i) => {
        const evt = session.lastEvents?.[p.event_id];
        return evt ? `#${i + 1} "${evt.name}"` : `#${i + 1}`;
      }).join(', ') || 'none'}.`
    : 'No prior session.';

  const userPrompt = `SMS message: "${message}"

Session context: ${sessionContext}

VALID_NEIGHBORHOODS: ${neighborhoodNames.join(', ')}`;

  const response = await getClient().messages.create({
    model: MODELS.route,
    max_tokens: 256,
    system: ROUTE_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 8000 });

  const text = response.content?.[0]?.text || '';
  const parsed = parseJsonFromResponse(text);

  if (!parsed || !parsed.intent) {
    console.error('routeMessage: invalid response:', text);
    return {
      intent: 'conversational',
      neighborhood: null,
      filters: { free_only: false, category: null, vibe: null },
      event_reference: null,
      reply: "Sorry, I didn't catch that. Text a neighborhood to see tonight's picks, or HELP for commands.",
      confidence: 0,
      _raw: text,
    };
  }

  return {
    intent: parsed.intent,
    neighborhood: parsed.neighborhood || null,
    filters: parsed.filters || { free_only: false, category: null, vibe: null },
    event_reference: parsed.event_reference || null,
    reply: parsed.reply || null,
    confidence: parsed.confidence || 0,
    _raw: text,
  };
}

/**
 * Compose an SMS response by picking events and writing the message in one Claude call.
 * Returns { sms_text, picks, neighborhood_used }
 */
async function composeResponse(message, events, neighborhood, filters, { excludeIds, extraContext, model } = {}) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);

  const eventListStr = events.map(e => {
    const eventDate = getEventDate(e);
    const dayLabel = eventDate === todayNyc ? 'TODAY' : eventDate === tomorrowNyc ? 'TOMORROW' : eventDate;
    return JSON.stringify({
      id: e.id,
      name: e.name && e.name.length > 80 ? e.name.slice(0, 77) + '...' : e.name,
      venue_name: e.venue_name,
      neighborhood: e.neighborhood,
      date_local: eventDate,
      day: dayLabel,
      start_time_local: e.start_time_local,
      end_time_local: e.end_time_local,
      is_free: e.is_free,
      price_display: e.price_display,
      category: e.category,
      short_detail: e.short_detail || e.description_short,
      source_name: e.source_name,
      source_weight: e.source_weight,
      confidence: e.confidence,
      ticket_url: e.ticket_url,
    });
  }).join('\n');

  const excludeNote = excludeIds && excludeIds.length > 0
    ? `\nEXCLUDED (already shown to user — do NOT pick these): ${excludeIds.join(', ')}`
    : '';

  const extraNote = extraContext || '';

  const userPrompt = `Current time (NYC): ${now}
User message: "${message}"
Neighborhood: ${neighborhood || 'not specified'}
User preferences: category=${filters?.category || 'any'}, vibe=${filters?.vibe || 'any'}, free_only=${filters?.free_only ? 'yes' : 'no'}
${excludeNote}${extraNote}
EVENT_LIST:
${eventListStr}

Compose the SMS now.`;

  const response = await getClient().messages.create({
    model: model || MODELS.compose,
    max_tokens: 512,
    system: COMPOSE_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 12000 });

  const text = response.content?.[0]?.text || '';
  const parsed = parseJsonFromResponse(text);

  if (!parsed || !parsed.sms_text || typeof parsed.sms_text !== 'string') {
    console.error('composeResponse: invalid response:', text);
    return {
      sms_text: "Having a moment — try again in a sec!",
      picks: [],
      neighborhood_used: neighborhood,
    };
  }

  const validIds = new Set(events.map(e => e.id));
  const rawPicks = parsed.picks || [];
  let validPicks = rawPicks.filter(p => p && typeof p.event_id === 'string' && validIds.has(p.event_id));

  // Fallback: if Claude hallucinated IDs, try matching by event name
  if (validPicks.length === 0 && rawPicks.length > 0) {
    console.warn(`composeResponse: ${rawPicks.length} picks had invalid IDs, attempting name match`);
    const nameToId = new Map(events.map(e => [(e.name || '').toLowerCase(), e.id]));
    validPicks = rawPicks.map(p => {
      if (p && validIds.has(p.event_id)) return p;
      // Try to find event by name substring in the sms_text or pick fields
      for (const [name, id] of nameToId) {
        if (name && p.event_id && name.includes(p.event_id.toLowerCase())) return { ...p, event_id: id };
      }
      return null;
    }).filter(Boolean);
    // Last resort: match events whose full name appears in sms_text
    if (validPicks.length === 0) {
      const smsLower = parsed.sms_text.toLowerCase();
      validPicks = events.filter(e => {
        const name = (e.name || '').toLowerCase();
        return name.length >= 3 && smsLower.includes(name);
      }).slice(0, 3).map((e, i) => ({ rank: i + 1, event_id: e.id }));
      if (validPicks.length > 0) {
        console.warn(`composeResponse: [RECOVERED] ${validPicks.length} picks via full-name sms_text matching (IDs: ${validPicks.map(p => p.event_id).join(', ')})`);
      }
    }
  }

  // Sanitize neighborhood_used — Claude sometimes adds parenthetical notes
  // e.g. "East Village (with nearby Flatiron)" → "East Village"
  // Also rejects hallucinated neighborhoods (e.g. "Fort Greene") not in our system
  let neighborhoodUsed = parsed.neighborhood_used || neighborhood;
  if (neighborhoodUsed) {
    const cleaned = neighborhoodUsed.replace(/\s*\(.*\)$/, '').trim();
    const validNeighborhoods = Object.keys(require('./neighborhoods').NEIGHBORHOODS);
    if (validNeighborhoods.includes(cleaned)) {
      neighborhoodUsed = cleaned;
    } else {
      neighborhoodUsed = neighborhood; // fall back to requested neighborhood
    }
  }

  return {
    sms_text: require('./formatters').smartTruncate(parsed.sms_text),
    picks: validPicks,
    not_picked_reason: parsed.not_picked_reason || null,
    neighborhood_used: neighborhoodUsed,
    _raw: text,
  };
}

/**
 * Extract normalized events from raw text (The Skint HTML content, Tavily snippets, etc.)
 * Returns { events: [...] }
 */
async function extractEvents(rawText, sourceName, sourceUrl, { model } = {}) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const userPrompt = `<source>
source_name: ${sourceName}
source_url: ${sourceUrl}
retrieved_at_nyc: ${now}
</source>

<raw_text>
${rawText}
</raw_text>

Extract all events and venues into the JSON format specified in your instructions.`;

  const response = await getClient().messages.create({
    model: model || MODELS.extract,
    max_tokens: 8192,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 15000 });

  const text = response.content?.[0]?.text || '';

  const parsed = parseJsonFromResponse(text);
  if (!parsed) {
    console.error('extractEvents: no valid JSON in response:', text);
    return { events: [] };
  }

  return parsed;
}

/**
 * Extract and parse the first valid JSON object from a Claude response.
 * Handles markdown code fences and avoids the greedy-regex trap.
 */
function parseJsonFromResponse(text) {
  // Try to find JSON inside code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Claude often puts literal newlines inside JSON strings (especially sms_text).
      // Fix by escaping raw newlines inside string values.
      try {
        return JSON.parse(fixJsonNewlines(fenceMatch[1].trim()));
      } catch { /* fall through */ }
    }
  }

  // Find the first { and match its closing } by counting braces (not greedy lastIndexOf)
  const start = text.indexOf('{');
  if (start === -1) return null;

  // Walk forward counting braces to find the balanced closing }, respecting string literals
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          try {
            return JSON.parse(fixJsonNewlines(candidate));
          } catch { return null; }
        }
      }
    }
  }

  return null;
}

/**
 * Fix raw newlines inside JSON string values that make JSON.parse fail.
 * Walks character-by-character, only escaping newlines inside quoted strings.
 */
function fixJsonNewlines(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (ch === '\n' && inString) {
      result += '\\n';
      continue;
    }
    if (ch === '\r' && inString) {
      continue; // skip carriage returns
    }
    result += ch;
  }
  return result;
}

/**
 * Compose a conversational details response about a specific venue/event.
 * Used when user asks for more info on a pick (e.g. "what is last resort").
 * Returns { sms_text }
 */
async function composeDetails(event, pickReason) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Build a Google Maps URL as fallback
  const venueName = event.venue_name || event.name || '';
  const hood = event.neighborhood || '';
  const mapsQuery = encodeURIComponent(`${venueName} ${hood} NYC`.trim());
  const mapsUrl = `https://www.google.com/maps/search/${mapsQuery}`;

  // Pick the best URL: ticket_url > source_url > Google Maps
  // But NEVER use search pages (Yelp search, Google search, etc.)
  let bestUrl = null;
  for (const url of [event.ticket_url, event.source_url]) {
    if (url && !isSearchUrl(url)) {
      bestUrl = url;
      break;
    }
  }
  if (!bestUrl) bestUrl = mapsUrl;

  const eventData = {
    name: event.name,
    venue_name: event.venue_name,
    neighborhood: event.neighborhood,
    category: event.category,
    description: event.description_short || event.short_detail,
    start_time_local: event.start_time_local,
    end_time_local: event.end_time_local,
    is_free: event.is_free,
    price_display: event.price_display,
    venue_address: event.venue_address,
    best_url: bestUrl,
  };

  const userPrompt = `Current time (NYC): ${now}

<event>
${JSON.stringify(eventData, null, 2)}
</event>

Why you recommended it: ${pickReason || 'solid pick for the neighborhood'}

Write the details text. Include this URL: ${bestUrl}`;

  const response = await getClient().messages.create({
    model: MODELS.compose,
    max_tokens: 256,
    system: DETAILS_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 8000 });

  const text = response.content?.[0]?.text || '';

  // Claude might return JSON or plain text — handle both
  let smsText;
  try {
    const parsed = JSON.parse(text);
    console.warn('composeDetails: Claude returned JSON despite plain-text instruction');
    smsText = parsed.sms_text || parsed.text || parsed.message || text;
  } catch {
    // Plain text response — use directly, strip any leading/trailing quotes
    smsText = text.replace(/^["']|["']$/g, '').trim();
  }

  return { sms_text: require('./formatters').smartTruncate(smsText), _raw: text };
}

/**
 * Check if a URL is a search/directory page rather than a direct venue/event link.
 */
function isSearchUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    // Yelp search pages
    if (u.hostname.includes('yelp.com') && u.pathname.startsWith('/search')) return true;
    // Google search pages
    if (u.hostname.includes('google.com') && (u.pathname === '/search' || u.pathname.startsWith('/search'))) return true;
    // Generic search query indicators
    if (u.searchParams.has('find_desc') || u.searchParams.has('q') && u.pathname.includes('search')) return true;
    return false;
  } catch {
    return false;
  }
}

module.exports = { routeMessage, composeResponse, composeDetails, extractEvents, isSearchUrl };
