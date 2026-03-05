const { generate: llmGenerate } = require('./llm');
const { MODELS } = require('./model-config');
const { EXTRACTION_PROMPT, DETAILS_SYSTEM } = require('./prompts');
const { smartTruncate, isSearchUrl } = require('./formatters');


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

  const resolvedModel = model || MODELS.extract;
  const timeout = sourceName === 'yutori' ? 90_000 : 60_000;
  let text, usage, provider;

  try {
    const result = await llmGenerate(resolvedModel, EXTRACTION_PROMPT, userPrompt, {
      maxTokens: 8192, temperature: 0, json: true, timeout,
    });
    text = result.text; usage = result.usage; provider = result.provider;
  } catch (err) {
    console.warn(`extractEvents ${resolvedModel} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    const result = await llmGenerate(MODELS.fallback, EXTRACTION_PROMPT, userPrompt, {
      maxTokens: 8192, temperature: 0, json: true, timeout,
    });
    text = result.text; usage = result.usage; provider = result.provider;
  }

  const parsed = parseJsonFromResponse(text);
  if (!parsed) {
    console.error(`extractEvents (${provider}): no valid JSON in response:`, text);
    return { events: [], _usage: usage || null, _provider: provider };
  }

  const events = Array.isArray(parsed.events) ? parsed.events
    : Array.isArray(parsed.venues) ? parsed.venues
    : Array.isArray(parsed) ? parsed
    : [];
  if (!Array.isArray(parsed.events) && events.length > 0) {
    console.warn(`extractEvents (${provider}): non-standard shape, found ${events.length} events`);
  }
  return { events, _usage: usage || null, _provider: provider };
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
async function composeDetails(event, pickReason, { pulseUrl } = {}) {
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
  if (pulseUrl) bestUrl = pulseUrl;

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

  const resolvedModel = MODELS.details;
  let text, usage, provider;

  try {
    const result = await llmGenerate(resolvedModel, DETAILS_SYSTEM, userPrompt, {
      maxTokens: 1024, temperature: 0.8, timeout: 15_000,
    });
    text = result.text; usage = result.usage; provider = result.provider;
  } catch (err) {
    console.warn(`composeDetails ${resolvedModel} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    const result = await llmGenerate(MODELS.fallback, DETAILS_SYSTEM, userPrompt, {
      maxTokens: 256, timeout: 10_000,
    });
    text = result.text; usage = result.usage; provider = result.provider;
  }

  // Model might return JSON or plain text — handle both
  let smsText;
  try {
    const parsed = JSON.parse(text);
    console.warn(`composeDetails (${provider}): returned JSON despite plain-text instruction`);
    smsText = parsed.sms_text || parsed.text || parsed.message || text;
  } catch {
    // Plain text response — use directly, strip any leading/trailing quotes
    smsText = text.replace(/^["']|["']$/g, '').trim();
  }

  return { sms_text: smartTruncate(smsText), _raw: text, _usage: usage, _provider: provider };
}

module.exports = { composeDetails, extractEvents, parseJsonFromResponse };
