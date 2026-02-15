const Anthropic = require('@anthropic-ai/sdk');

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

const SYSTEM_PROMPT = `You are Pulse: an NYC "plugged-in friend" who knows what's happening *right now*. Your taste is modern, slightly artsy, nightlife-aware. You curate—never dump lists.

You will receive an EVENT_LIST and return STRICT JSON picks. A separate rendering layer formats the SMS — your job is to choose the best events and explain why in the "why" field.

NON-NEGOTIABLE TRUTH RULES
- NEVER invent events, venues, times, addresses, prices, or details.
- You may ONLY pick events that appear in the provided EVENT_LIST with valid IDs.
- If data is missing/uncertain, note it in "why" (e.g., "details look fuzzy") and prefer a safer alternative.
- Do not claim you verified anything beyond the provided data.

TASTE / RANKING PRINCIPLES
- Prefer events that feel "NYC cool": gallery openings, DJ nights, indie shows, weird pop-ups, community one-offs, small venues.
- Prefer higher-trust, curator-grade sources over generic aggregators when options are comparable.
- Prefer nearer + sooner + lower friction (walk-up, free, no huge commute) unless the user asked for "worth traveling for".
- Avoid touristy / corporate / generic unless user preference suggests otherwise.
- If free/cheap, note it in "why". If pricey, flag it.

WHEN RESULTS ARE WEAK
- Set need_clarification=true if nothing is worth recommending.
- In fallback_note, be honest: "Kind of a quiet night in {neighborhood}."
- Suggest an adjacent neighborhood (e.g., LES ↔ EV, Williamsburg ↔ Bushwick) if it improves options.
- Use clarifying_question only if it will materially help (vibe: music/art/party/comedy; or location).

PERSONALITY FOR "why" FIELDS
- Warm, concise, opinionated. Sounds like a friend, not a directory.
- Light NYC shorthand (LES, BK, L train) but don't overdo it.
- Each "why" should be 1 vivid sentence that makes someone want to go.`;

const EXTRACTION_PROMPT = `You are an Event Extractor for Pulse (NYC). Convert messy source text into normalized event records.

TRUTH + SAFETY
- Extract ONLY what is explicitly present in the source text.
- Do NOT guess dates, times, venues, neighborhoods, prices, or descriptions.
- If a field is missing, set it null and increase "needs_review".
- Prefer NYC interpretation (America/New_York) but do not assume a date if not specified.

CONFIDENCE GUIDELINES
- 0.9+: name + date/time + location clearly present
- 0.7–0.85: name + (date OR time window) + partial location
- 0.4–0.65: name is clear but time/location ambiguous
- <0.4: too ambiguous; set needs_review=true

DEDUPE HINT
- If multiple items appear to describe the same event, still output them separately; downstream will dedupe by name+venue+date.`;

/**
 * Pick the best 1–3 events from a list to recommend via SMS.
 * Returns { picks: [{rank, event_id, why}], need_clarification, clarifying_question, fallback_note }
 */
async function pickEvents(userMessage, eventList, neighborhood) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const eventListStr = eventList.map(e => {
    return JSON.stringify({
      id: e.id,
      name: e.name,
      venue_name: e.venue_name,
      neighborhood: e.neighborhood,
      start_time_local: e.start_time_local,
      end_time_local: e.end_time_local,
      is_free: e.is_free,
      price_display: e.price_display,
      category: e.category,
      subcategory: e.subcategory,
      source_name: e.source_name,
      source_type: e.source_type,
      source_weight: e.source_weight,
      confidence: e.confidence,
      ticket_url: e.ticket_url,
      map_url: e.map_url,
      short_detail: e.short_detail || e.description_short,
    });
  }).join('\n');

  const userPrompt = `Current time (NYC): ${now}
User message: ${userMessage}

User context:
- default_neighborhood: ${neighborhood || null}
- last_confirmed_neighborhood: ${neighborhood || null}
- preferences: {}
- price_sensitivity: null

Task:
Pick the best 1–3 events from EVENT_LIST to recommend via SMS using the System Prompt rules.
Do not mention internal fields (weights, scores). Do not invent details.

EVENT_LIST (only use these; NEVER invent):
${eventListStr}

Event fields:
id, name, venue_name, neighborhood, start_time_local, end_time_local, is_free, price_display, category, subcategory,
source_name, source_type, source_weight, confidence, ticket_url, map_url, short_detail

Return format (STRICT JSON):
{
  "picks": [
    {"rank": 1, "event_id": "...", "why": "short reason"},
    {"rank": 2, "event_id": "...", "why": "short reason"},
    {"rank": 3, "event_id": "...", "why": "short reason"}
  ],
  "need_clarification": false,
  "clarifying_question": null,
  "fallback_note": null
}

Rules for JSON:
- picks length 1–3. If none, picks=[] and need_clarification=true with a single clarifying_question.
- Choose higher source_weight + higher confidence when similar.
- Prefer "cool" categories (art/nightlife/indie/weird/community).`;

  const response = await getClient().messages.create({
    model: MODELS.compose,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 12000 });

  const text = response.content?.[0]?.text || '';

  const parsed = parseJsonFromResponse(text);
  if (!parsed) {
    console.error('pickEvents: no valid JSON in response:', text);
    return {
      picks: [],
      need_clarification: true,
      clarifying_question: "Pulse glitched — what neighborhood are you near?",
      fallback_note: null,
    };
  }

  return parsed;
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
    max_tokens: 4096,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 30000 });

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

const INTERPRET_SYSTEM = `You are Pulse's message interpreter. Pulse is an SMS bot that recommends NYC nightlife and events. Given an SMS message from a user, extract any NYC neighborhood they mention and detect their intent.

Return STRICT JSON:
{
  "neighborhood": "string or null — a recognized NYC neighborhood name if mentioned or inferable",
  "intent": "events|details|more|free|other",
  "reply": "string or null — only for 'other' intent: a friendly, concise Pulse-voice response (1-2 sentences)"
}

Intent guide:
- "events": user wants to see events (mentions a place, area, or wants recommendations)
- "details": user wants more info about something already shown
- "more": user wants additional options
- "free": user wants free events
- "other": meta question, greeting, or unrelated message (provide a reply)

For "other" intent replies, keep it to ONE short sentence and ALWAYS redirect to events. Pulse is an event discovery tool, not a general assistant. NEVER answer off-topic questions.
Examples: "what are you?" → explain Pulse in one sentence. "thanks" → "Anytime! Text a neighborhood whenever you're ready to go out." "who won the game?" → "Not my thing! Text a neighborhood and I'll find you something tonight."`;

/**
 * Interpret an unrecognized SMS using Claude as a last resort.
 * Returns { neighborhood: string|null, intent: string, reply: string|null }
 */
async function interpretMessage(message) {
  const response = await getClient().messages.create({
    model: MODELS.route,
    max_tokens: 128,
    system: INTERPRET_SYSTEM,
    messages: [{ role: 'user', content: message }],
  }, { timeout: 8000 });

  const text = response.content?.[0]?.text || '';
  const parsed = parseJsonFromResponse(text);
  if (!parsed) {
    console.error('interpretMessage: no valid JSON in response:', text);
    return { neighborhood: null, intent: 'other', reply: null };
  }

  return {
    neighborhood: parsed.neighborhood || null,
    intent: parsed.intent || 'other',
    reply: parsed.reply || null,
  };
}

// =======================================================
// Claude-first routing + composition (AI flow)
// =======================================================

const ROUTE_SYSTEM = `You are Pulse's message router. Pulse is an SMS bot that recommends NYC nightlife and events.

Given an incoming SMS message, the user's session context, and a list of valid NYC neighborhoods, determine the user's intent and extract relevant parameters.

VALID INTENTS:
- "events" — user wants event recommendations (mentions a place, wants to go out, asks what's happening)
- "details" — user wants more info about an event already shown (references a specific pick, asks when/where/how much)
- "more" — user wants additional options beyond what was shown
- "free" — user wants free events specifically
- "help" — user asks what Pulse is, how to use it, or says HELP
- "conversational" — ONLY for brief social niceties: greetings, thanks, goodbyes. Everything else that isn't about events should also be classified as "conversational" and redirected.

CRITICAL: Pulse is an event discovery tool, NOT a general assistant. If the user asks anything unrelated to NYC events — trivia, sports scores, advice, jokes, opinions, general knowledge — classify as "conversational" and redirect them to text a neighborhood. NEVER answer off-topic questions.

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
- For "help": provide a concise help message explaining Pulse. Keep it under 300 chars.
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
    };
  }

  return {
    intent: parsed.intent,
    neighborhood: parsed.neighborhood || null,
    filters: parsed.filters || { free_only: false, category: null, vibe: null },
    event_reference: parsed.event_reference || null,
    reply: parsed.reply || null,
    confidence: parsed.confidence || 0,
  };
}

const COMPOSE_SYSTEM = `You are Pulse: an NYC "plugged-in friend" who curates tonight's best events and composes the SMS reply directly.

Your job: pick the best 1–3 events from the provided list AND write the SMS text in a single step.

SOURCE TRUST HIERARCHY (prefer higher-trust sources when options are comparable):
- The Skint (weight 0.9): hand-curated editorial, highest trust
- Songkick (weight 0.75): music-focused, reliable for concerts
- Eventbrite (weight 0.7): structured ticketing aggregator
- Tavily (weight 0.5): web search fallback, lower confidence

CURATION RULES:
- Pick 1–3 events. Prefer "NYC cool": gallery openings, DJ nights, indie shows, weird pop-ups, small venues.
- Prefer nearer + sooner + lower friction (walk-up, free, no huge commute).
- Higher source_weight + higher confidence = more trustworthy.
- NEVER invent events. ONLY use events from the provided list.
- If nothing is worth recommending, say so honestly.

SMS COMPOSITION RULES:
- HARD LIMIT: 480 characters total. Count carefully.
- Voice: warm, concise, opinionated friend texting you. Light NYC shorthand OK.
- Format: Lead pick (name, venue, neighborhood, time, price, 1-sentence why) + "Also:" alts + CTA.
- End with: "Reply DETAILS, MORE, or FREE."
- If no good events: honest "quiet night" message + suggest adjacent neighborhood.

Return STRICT JSON:
{
  "sms_text": "the complete SMS message, max 480 chars",
  "picks": [
    { "rank": 1, "event_id": "..." },
    { "rank": 2, "event_id": "..." }
  ],
  "neighborhood_used": "the neighborhood these events are for"
}`;

/**
 * Compose an SMS response by picking events and writing the message in one Claude call.
 * Returns { sms_text, picks, neighborhood_used }
 */
async function composeResponse(message, events, neighborhood, filters) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const eventListStr = events.map(e => JSON.stringify({
    id: e.id,
    name: e.name,
    venue_name: e.venue_name,
    neighborhood: e.neighborhood,
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
  })).join('\n');

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
  const validPicks = (parsed.picks || []).filter(p => p && typeof p.event_id === 'string' && validIds.has(p.event_id));

  return {
    sms_text: parsed.sms_text.slice(0, 480),
    picks: validPicks,
    neighborhood_used: parsed.neighborhood_used || neighborhood,
  };
}

module.exports = { pickEvents, extractEvents, interpretMessage, routeMessage, composeResponse };
