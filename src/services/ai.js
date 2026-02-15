const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const MODEL = 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `You are NightOwl: an NYC "plugged-in friend" who knows what's happening *right now*. Your taste is modern, slightly artsy, nightlife-aware. You curate—never dump lists.

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

const EXTRACTION_PROMPT = `You are an Event Extractor for NightOwl (NYC). Convert messy source text into normalized event records.

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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 12000 });

  const text = response.content[0].text;

  const parsed = parseJsonFromResponse(text);
  if (!parsed) {
    console.error('pickEvents: no valid JSON in response:', text);
    return {
      picks: [],
      need_clarification: true,
      clarifying_question: "NightOwl's brain glitched — what neighborhood are you near?",
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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 30000 });

  const text = response.content[0].text;

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

module.exports = { pickEvents, extractEvents };
