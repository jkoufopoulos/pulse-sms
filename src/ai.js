const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getEventDate, getNycDateString } = require('./geo');
const { EXTRACTION_PROMPT, ROUTE_SYSTEM, COMPOSE_SYSTEM, DETAILS_SYSTEM } = require('./prompts');
const { buildComposePrompt } = require('./skills/build-compose-prompt');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

let geminiClient = null;
function getGeminiClient() {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return geminiClient;
}

const ROUTE_PROVIDER = process.env.PULSE_ROUTE_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic');

const MODELS = {
  route: process.env.PULSE_MODEL_ROUTE || 'claude-haiku-4-5-20251001',
  routeGemini: process.env.PULSE_MODEL_ROUTE_GEMINI || 'gemini-2.0-flash',
  compose: process.env.PULSE_MODEL_COMPOSE || 'claude-haiku-4-5-20251001',
  extract: process.env.PULSE_MODEL_EXTRACT || 'claude-haiku-4-5-20251001',
};

/**
 * Build the routing prompt parts (shared by both providers).
 */
function buildRoutePrompt(message, session, neighborhoodNames) {
  const sessionContext = session
    ? `Last neighborhood: ${session.lastNeighborhood || 'none'}. Last picks: ${(session.lastPicks || []).map((p, i) => {
        const evt = session.lastEvents?.[p.event_id];
        return evt ? `#${i + 1} "${evt.name}"` : `#${i + 1}`;
      }).join(', ') || 'none'}.`
    : 'No prior session.';

  const userPrompt = `<user_message>${message}</user_message>

Session context: ${sessionContext}

VALID_NEIGHBORHOODS: ${neighborhoodNames.join(', ')}`;

  return { systemPrompt: ROUTE_SYSTEM, userPrompt };
}

const ROUTE_FALLBACK = {
  intent: 'conversational',
  neighborhood: null,
  filters: { free_only: false, category: null, vibe: null },
  event_reference: null,
  reply: "Sorry, I didn't catch that. Text a neighborhood to see tonight's picks, or HELP for commands.",
  confidence: 0,
};

function parseRouteResult(text) {
  const parsed = parseJsonFromResponse(text);
  if (!parsed || !parsed.intent) return null;
  return {
    intent: parsed.intent,
    neighborhood: parsed.neighborhood || null,
    filters: parsed.filters || { free_only: false, category: null, vibe: null },
    event_reference: parsed.event_reference || null,
    reply: parsed.reply || null,
    confidence: parsed.confidence || 0,
  };
}

/**
 * Route via Anthropic (Claude Haiku).
 */
async function routeWithAnthropic(systemPrompt, userPrompt) {
  const response = await getClient().messages.create({
    model: MODELS.route,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout: 8000 });

  const text = response.content?.[0]?.text || '';
  return { text, usage: response.usage || null, provider: 'anthropic' };
}

/**
 * Route via Google Gemini Flash.
 */
async function routeWithGemini(systemPrompt, userPrompt) {
  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({
    model: MODELS.routeGemini,
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: 256, temperature: 0 },
  });

  const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] });
  const response = result.response;
  const text = response.text() || '';
  const usageMetadata = response.usageMetadata;
  const usage = usageMetadata ? {
    input_tokens: usageMetadata.promptTokenCount || 0,
    output_tokens: usageMetadata.candidatesTokenCount || 0,
  } : null;

  return { text, usage, provider: 'gemini' };
}

/**
 * Route an incoming SMS. Determines intent, neighborhood, and filters.
 * Uses Gemini Flash by default (cheaper), falls back to Anthropic on error.
 */
async function routeMessage(message, session, neighborhoodNames) {
  const { systemPrompt, userPrompt } = buildRoutePrompt(message, session, neighborhoodNames);

  let raw;
  if (ROUTE_PROVIDER === 'gemini' && getGeminiClient()) {
    try {
      raw = await routeWithGemini(systemPrompt, userPrompt);
    } catch (err) {
      console.warn(`Gemini route failed, falling back to Anthropic: ${err.message}`);
      raw = await routeWithAnthropic(systemPrompt, userPrompt);
    }
  } else {
    raw = await routeWithAnthropic(systemPrompt, userPrompt);
  }

  const parsed = parseRouteResult(raw.text);
  if (!parsed) {
    console.error(`routeMessage (${raw.provider}): invalid response:`, raw.text);
    return { ...ROUTE_FALLBACK, _raw: raw.text, _usage: raw.usage, _provider: raw.provider };
  }

  return { ...parsed, _raw: raw.text, _usage: raw.usage, _provider: raw.provider };
}

/**
 * Compose an SMS response by picking events and writing the message in one Claude call.
 * Returns { sms_text, picks, neighborhood_used }
 */
async function composeResponse(message, events, neighborhood, filters, { excludeIds, skills, model } = {}) {
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
      source_tier: e.source_tier || 'secondary',
      ticket_url: e.ticket_url,
    });
  }).join('\n');

  const excludeNote = excludeIds && excludeIds.length > 0
    ? `\nEXCLUDED (already shown to user — do NOT pick these): ${excludeIds.join(', ')}`
    : '';

  const userPrompt = `Current time (NYC): ${now}
<user_message>${message}</user_message>
Neighborhood: ${neighborhood || 'not specified'}
User preferences: category=${filters?.category || 'any'}, vibe=${filters?.vibe || 'any'}, free_only=${filters?.free_only ? 'yes' : 'no'}${filters?.time_after ? `, time_after=${filters.time_after}` : ''}
${excludeNote}
EVENT_LIST:
${eventListStr}

Compose the SMS now.`;

  const systemPrompt = buildComposePrompt(events, { ...skills, requestedNeighborhood: neighborhood });

  const response = await getClient().messages.create({
    model: model || MODELS.compose,
    max_tokens: 512,
    system: systemPrompt,
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
    _usage: response.usage || null,
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

  const timeout = sourceName === 'yutori' ? 60000 : 15000;
  const response = await getClient().messages.create({
    model: model || MODELS.extract,
    max_tokens: 8192,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout });

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

  return { sms_text: require('./formatters').smartTruncate(smsText), _raw: text, _usage: response.usage || null };
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

module.exports = { routeMessage, composeResponse, composeDetails, extractEvents, isSearchUrl, parseJsonFromResponse };
