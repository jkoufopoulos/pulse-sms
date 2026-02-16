const Anthropic = require('@anthropic-ai/sdk');
const { getEventDate, getNycDateString } = require('./geo');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const MODELS = {
  route: process.env.PULSE_MODEL_ROUTE || 'claude-sonnet-4-5-20250929',
  compose: process.env.PULSE_MODEL_COMPOSE || 'claude-sonnet-4-5-20250929',
  extract: process.env.PULSE_MODEL_EXTRACT || 'claude-sonnet-4-5-20250929',
};

const EXTRACTION_PROMPT = `You are an Event Extractor for Pulse (NYC). Convert messy source text into normalized event records.

VENUES + PLACES
- Source text may include bars, restaurants, game spots, pool halls, arcades, or other venues — not just events.
- Extract these as records too: use the venue/business name as "name", set category to the best fit (e.g. "nightlife" for bars, "community" for arcades/game spots), and set is_free based on whether entry is free.
- For permanent venues with no specific date/time, set date_local and start_time_local to null, time_window to "evening", and confidence to 0.6.

SOURCE URLs
- Raw text may contain [Source: URL] markers before each item. Use the URL from the nearest preceding [Source: ...] marker as that event's source_url.
- ALWAYS prefer per-item [Source: URL] over the top-level source_url input.

TRUTH + SAFETY
- Extract ONLY what is explicitly present in the source text.
- Do NOT guess venues, neighborhoods, prices, or descriptions.
- If a field is missing, set it null and increase "needs_review".
- Prefer NYC interpretation (America/New_York).

DATE RESOLUTION — CRITICAL
- The retrieval timestamp (retrieved_at_nyc) tells you today's date and day of week.
- Resolve relative day names to actual dates using the retrieval date:
  - If retrieved on Saturday and text says "fri" → that means YESTERDAY (the past Friday), NOT next Friday.
  - If retrieved on Saturday and text says "sat" → that means TODAY.
  - If retrieved on Saturday and text says "sun" → that means TOMORROW.
  - "thru" dates (e.g. "thru 2/19") are end dates — set end_time_local, leave date_local null.
  - "today"/"tonight" → use retrieved_at_nyc date.
- Always set date_local to the resolved YYYY-MM-DD. If you cannot resolve the date, set date_local null.
- NEVER assign a date in the past to date_local if the event is meant to be upcoming.
- If a day name refers to a day that has already passed this week, that event is OVER — set confidence to 0.1.

CONFIDENCE GUIDELINES
- 0.9+: name + date/time + location clearly present
- 0.7–0.85: name + (date OR time window) + partial location
- 0.4–0.65: name is clear but time/location ambiguous
- <0.4: too ambiguous; set needs_review=true
- 0.1: event date has already passed

DEDUPE HINT
- If multiple items appear to describe the same event, still output them separately; downstream will dedupe by name+venue+date.`;

const ROUTE_SYSTEM = `You are Pulse's message router. Pulse is an SMS bot that recommends NYC nightlife and events.

Given an incoming SMS message, the user's session context, and a list of valid NYC neighborhoods, determine the user's intent and extract relevant parameters.

VALID INTENTS:
- "events" — user wants event recommendations (mentions a place, wants to go out, asks what's happening)
- "details" — user wants more info about an event already shown (references a specific pick, asks when/where/how much)
- "more" — user wants additional options beyond what was shown. Includes "what else is going on", "anything else", "show me more", "what else you got", "what's out there". When the session has prior picks, lean "more" for any vague event-seeking message.
- "free" — user wants free events specifically
- "help" — user asks what Pulse is, how to use it, or says HELP
- "conversational" — ONLY for true social niceties: greetings ("hey"), thanks ("thanks"), goodbyes ("bye"). Off-topic questions also get classified here.

CRITICAL: Pulse is an event discovery tool, NOT a general assistant. If the user asks anything unrelated to NYC events — trivia, sports scores, advice, jokes, opinions, general knowledge — classify as "conversational" and redirect them to text a neighborhood. NEVER answer off-topic questions.

SESSION AWARENESS:
- When the user has an active session (last neighborhood + last picks), vague event-seeking messages like "what else is going on", "what's happening", "anything else tonight" should be "more" or "events" — NOT "conversational".
- Only use "conversational" for true social niceties (thanks, bye, hello) regardless of session state.

NEIGHBORHOOD RESOLUTION:
- Map the user's message to ONE of the valid neighborhood names from VALID_NEIGHBORHOODS.
- Handle slang, landmarks, subway stops, boroughs (e.g. "BK" → "Williamsburg", "prospect park" → "Park Slope", "bedford ave" → "Williamsburg").
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
- For "conversational": keep it to ONE short sentence max, then ALWAYS redirect to events. Examples:
  - "thanks" → "Anytime! Text a neighborhood when you're ready to go out."
  - "hello" → "Hey! Text me a neighborhood to get tonight's picks."
  - "who won the knicks game?" → "Ha — I only know events. Text a neighborhood and I'll hook you up."
  - "what's the weather?" → "Not my thing! But text me a neighborhood and I'll find you something fun tonight."
- NEVER provide actual answers to off-topic questions. Always deflect back to events.
- For all other intents: set reply to null.

Return STRICT JSON:
{
  "intent": "events|details|more|free|help|conversational",
  "neighborhood": "string or null",
  "filters": { "free_only": false, "category": null, "vibe": null },
  "event_reference": null,
  "reply": "string or null",
  "confidence": 0.0
}`;

const COMPOSE_SYSTEM = `You are Pulse: an NYC "plugged-in friend" who curates the best upcoming events. You text like a real person — warm, opinionated, concise. Never robotic.

Your job: pick the best 1–3 events from the provided list AND write the SMS text in a single step.

DATE AWARENESS — CRITICAL:
- Compare each event's start_time_local to the current NYC time provided.
- If the event is TODAY, say "tonight" or "today".
- If the event is TOMORROW, say "tomorrow" or "tomorrow night" — NEVER say "tonight" for a tomorrow event.
- If the event is further out, mention the day (e.g. "this Friday").
- ALWAYS fill your picks with tonight's events first. A mediocre tonight event beats a great tomorrow event — the user is asking what's happening NOW.
- Only include a tomorrow event if there are genuinely fewer than 2 good tonight options in the list.

SOURCE TRUST HIERARCHY (prefer higher-trust sources when options are comparable):
- The Skint (weight 0.9): hand-curated editorial, highest trust
- Resident Advisor (weight 0.85): electronic music & nightlife, DJ events
- Dice (weight 0.8): ticketed events, concerts, DJ nights
- Songkick (weight 0.75): music-focused, reliable for concerts
- Eventbrite (weight 0.7): structured ticketing aggregator
- Tavily (weight 0.6): web search results — may include cool spots and venues alongside events

CURATION RULES:
- Pick 1–3 events. Prefer "NYC cool": gallery openings, DJ nights, indie shows, weird pop-ups, small venues.
- Search-sourced items (source_name "tavily") may include permanent venues like bars or game spots with no specific date/time. Frame these as "solid spots to check out" — NOT "tonight at 9pm". Example: "The Last Resort is a solid low-key bar in EV if you want a chill hang."
- STRONGLY prefer events IN the user's requested neighborhood. Only suggest events from other neighborhoods if there's nothing good in theirs.
- When including events from adjacent neighborhoods, mention the actual neighborhood (e.g. "nearby in Wburg" or "worth the walk to LES").
- Higher source_weight + higher confidence = more trustworthy.
- NEVER invent events. ONLY use events from the provided list.
- If nothing is worth recommending, say so honestly.

SMS COMPOSITION RULES:
- HARD LIMIT: 480 characters total. Count carefully.
- Voice: you're a friend texting picks. Light NYC shorthand OK.
- Write naturally. Lead with your top pick (name, venue, time, why it's good), then mention alternatives.
- DO NOT number events. DO NOT use bullet points or lists. Write like a text message.
- DO NOT end with "Reply DETAILS" or any command instructions. Instead, end with a natural prompt that invites conversation, like "Want more info on any of these?" or "Wanna hear about something different?" or just leave it open.
- If no good events: honest "quiet night" note + suggest an adjacent neighborhood naturally.

Return STRICT JSON:
{
  "sms_text": "the complete SMS message, max 480 chars",
  "picks": [
    { "rank": 1, "event_id": "...", "why": "short reason for picking this event" },
    { "rank": 2, "event_id": "...", "why": "short reason" }
  ],
  "not_picked_reason": "1 sentence on why you skipped the other events",
  "neighborhood_used": "the neighborhood these events are for"
}`;

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
async function composeResponse(message, events, neighborhood, filters) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);

  const eventListStr = events.map(e => {
    const eventDate = getEventDate(e);
    const dayLabel = eventDate === todayNyc ? 'TODAY' : eventDate === tomorrowNyc ? 'TOMORROW' : eventDate;
    return JSON.stringify({
      id: e.id,
      name: e.name,
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

  const userPrompt = `Current time (NYC): ${now}
User message: "${message}"
Neighborhood: ${neighborhood || 'not specified'}
User preferences: category=${filters?.category || 'any'}, vibe=${filters?.vibe || 'any'}, free_only=${filters?.free_only ? 'yes' : 'no'}

EVENT_LIST:
${eventListStr}

Compose the SMS now. Remember: 480 char hard limit, end with CTA.`;

  const response = await getClient().messages.create({
    model: MODELS.compose,
    max_tokens: 512,
    system: COMPOSE_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 12000 });

  const text = response.content?.[0]?.text || '';
  const parsed = parseJsonFromResponse(text);

  if (!parsed || !parsed.sms_text) {
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
    // Last resort: just use the first N events that Claude mentioned in sms_text
    if (validPicks.length === 0) {
      validPicks = events.filter(e =>
        parsed.sms_text.toLowerCase().includes((e.name || '').toLowerCase().slice(0, 20))
      ).slice(0, 3).map((e, i) => ({ rank: i + 1, event_id: e.id }));
      if (validPicks.length > 0) {
        console.log(`composeResponse: recovered ${validPicks.length} picks via sms_text name matching`);
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
    sms_text: parsed.sms_text.slice(0, 480),
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
async function extractEvents(rawText, sourceName, sourceUrl) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const userPrompt = `INPUTS
- source_name: ${sourceName}
- source_url: ${sourceUrl}
- retrieved_at_nyc: ${now}
- raw_text:
${rawText}

OUTPUT: STRICT JSON with an array of events
{
  "events": [
    {
      "source_name": "...",
      "source_url": "...",
      "name": "...",
      "description_short": "...",
      "venue_name": null,
      "venue_address": null,
      "neighborhood": null,
      "latitude": null,
      "longitude": null,
      "category": "art|nightlife|live_music|comedy|community|food_drink|theater|other",
      "subcategory": null,
      "start_time_local": null,
      "end_time_local": null,
      "date_local": null,
      "time_window": null,
      "is_free": null,
      "price_display": null,
      "ticket_url": null,
      "map_hint": null,
      "confidence": 0.0,
      "needs_review": false,
      "evidence": {
        "name_quote": "...",
        "time_quote": null,
        "location_quote": null,
        "price_quote": null
      }
    }
  ]
}`;

  const response = await getClient().messages.create({
    model: MODELS.extract,
    max_tokens: 8192,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 60000 });

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
    } catch { /* fall through */ }
  }

  // Find the first { and try progressively larger substrings until valid JSON
  const start = text.indexOf('{');
  if (start === -1) return null;

  // Walk backwards from the end to find the matching closing brace
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch { /* try shorter */ }
  }

  return null;
}

/**
 * Compose a conversational details response about a specific venue/event.
 * Used when user asks for more info on a pick (e.g. "what is last resort").
 * Returns { sms_text }
 */
async function composeDetails(event, pickReason) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

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

The user asked for more info about this place you recommended:
${JSON.stringify(eventData, null, 2)}

Why you recommended it: ${pickReason || 'solid pick for the neighborhood'}

Write a short, conversational SMS (under 320 chars) that:
1. Describes what makes this place worth going to — the vibe, what they're known for, what to expect
2. Include practical info: time, price/free, address if available
3. Include this URL at the end: ${bestUrl}
4. Sound like a friend who's been there, not a directory listing`;

  const response = await getClient().messages.create({
    model: MODELS.compose,
    max_tokens: 256,
    system: `You are Pulse: an NYC "plugged-in friend" texting about a spot you recommended. Write like a real person — warm, opinionated, concise. Never robotic. Never list format. Just a natural text about the place. HARD LIMIT: 320 characters. NEVER include Yelp URLs of any kind.`,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 8000 });

  const text = response.content?.[0]?.text || '';

  // Claude might return JSON or plain text — handle both
  let smsText;
  try {
    const parsed = JSON.parse(text);
    smsText = parsed.sms_text || parsed.text || parsed.message || text;
  } catch {
    // Plain text response — use directly, strip any leading/trailing quotes
    smsText = text.replace(/^["']|["']$/g, '').trim();
  }

  return { sms_text: smsText.slice(0, 480), _raw: text };
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
