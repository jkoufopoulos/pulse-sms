const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { getEventDate, getNycDateString } = require('./geo');
const { EXTRACTION_PROMPT, DETAILS_SYSTEM } = require('./prompts');
const { buildUnifiedPrompt } = require('./skills/build-compose-prompt');
const { smartTruncate, isSearchUrl } = require('./formatters');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
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

const MODELS = {
  compose: process.env.PULSE_MODEL_COMPOSE || 'gemini-2.5-flash',
  extract: process.env.PULSE_MODEL_EXTRACT || 'gemini-2.5-flash',
};

// Safety settings for all Gemini calls — block dangerous content but allow normal event text
const GEMINI_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];


/**
 * Unified respond via Google Gemini Flash.
 */
async function unifiedWithGemini(systemPrompt, userPrompt) {
  const genAI = getGeminiClient();
  const gemModel = genAI.getGenerativeModel({
    model: MODELS.compose,
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.5,
      topP: 0.9,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['event_picks', 'conversational', 'ask_neighborhood'] },
          sms_text: { type: 'string' },
          picks: { type: 'array', items: {
            type: 'object',
            properties: {
              rank: { type: 'integer' },
              event_id: { type: 'string' },
              why: { type: 'string' },
            },
            required: ['rank', 'event_id', 'why'],
          }},
          clear_filters: { type: 'boolean' },
        },
        required: ['type', 'sms_text', 'picks', 'clear_filters'],
      },
    },
  });

  const result = await withTimeout(
    gemModel.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
    15_000, 'unifiedWithGemini'
  );
  const response = result.response;
  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.warn(`unifiedWithGemini: finishReason=${finishReason}, tokens=${response.usageMetadata?.candidatesTokenCount}`);
  }
  const text = response.text() || '';
  const usageMetadata = response.usageMetadata;
  const usage = usageMetadata ? {
    input_tokens: usageMetadata.promptTokenCount || 0,
    output_tokens: usageMetadata.candidatesTokenCount || 0,
  } : null;

  return { text, usage, provider: 'gemini' };
}

/**
 * Extract events via Google Gemini Flash.
 */
async function extractWithGemini(systemPrompt, userPrompt) {
  const genAI = getGeminiClient();
  const gemModel = genAI.getGenerativeModel({
    model: MODELS.extract,
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    generationConfig: { maxOutputTokens: 4096, temperature: 0, responseMimeType: 'application/json' },
  });

  const result = await withTimeout(
    gemModel.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
    90_000, 'extractWithGemini'
  );
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
 * Compose details via Google Gemini Flash (plain text, not JSON).
 */
async function detailsWithGemini(systemPrompt, userPrompt) {
  const genAI = getGeminiClient();
  const gemModel = genAI.getGenerativeModel({
    model: MODELS.compose,
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    generationConfig: { maxOutputTokens: 1024, temperature: 0.8 },
  });

  const result = await withTimeout(
    gemModel.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
    15_000, 'detailsWithGemini'
  );
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
  let text, usage, provider;
  if (resolvedModel.startsWith('gemini-') && getGeminiClient()) {
    try {
      const result = await extractWithGemini(EXTRACTION_PROMPT, userPrompt);
      text = result.text; usage = result.usage; provider = 'gemini';
    } catch (err) {
      console.warn(`Gemini extractEvents failed, falling back to Anthropic: ${err.message}`);
      const timeout = sourceName === 'yutori' ? 90000 : 60000;
      const response = await getClient().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        system: EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }, { timeout, maxRetries: 0 });
      text = response.content?.[0]?.text || '';
      provider = 'anthropic';
    }
  } else {
    const timeout = sourceName === 'yutori' ? 90000 : 60000;
    const response = await getClient().messages.create({
      model: resolvedModel,
      max_tokens: 8192,
      system: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }, { timeout, maxRetries: 0 });
    text = response.content?.[0]?.text || '';
    provider = 'anthropic';
  }

  const parsed = parseJsonFromResponse(text);
  if (!parsed) {
    console.error(`extractEvents (${provider}): no valid JSON in response:`, text);
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
async function composeDetails(event, pickReason, { bestieUrl } = {}) {
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
  if (bestieUrl) bestUrl = bestieUrl;

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

  let text, usage, provider;
  if (MODELS.compose.startsWith('gemini-') && getGeminiClient()) {
    try {
      const result = await detailsWithGemini(DETAILS_SYSTEM, userPrompt);
      text = result.text; usage = result.usage; provider = 'gemini';
    } catch (err) {
      console.warn(`Gemini composeDetails failed, falling back to Anthropic: ${err.message}`);
      const response = await withTimeout(getClient().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: DETAILS_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      }, { timeout: 8000 }), 10000, 'composeDetails');
      text = response.content?.[0]?.text || '';
      usage = response.usage || null;
      provider = 'anthropic';
    }
  } else {
    const response = await withTimeout(getClient().messages.create({
      model: MODELS.compose,
      max_tokens: 256,
      system: DETAILS_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }, { timeout: 8000 }), 10000, 'composeDetails');
    text = response.content?.[0]?.text || '';
    usage = response.usage || null;
    provider = 'anthropic';
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

/**
 * Unified LLM call for pre-router misses.
 * Replaces routeMessage() + handler dispatch + composeResponse() with a single call
 * that sees the full picture (message, session, events, history) and returns the SMS directly.
 *
 * Returns { type, sms_text, picks, clear_filters }
 */
async function unifiedRespond(message, { session, events, neighborhood, nearbyHoods, conversationHistory, currentTime, validNeighborhoods, activeFilters, isSparse, isCitywide, matchCount, hardCount, softCount, excludeIds, suggestedNeighborhood, userHoodAlias } = {}) {
  const now = currentTime || new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);

  // Build event list string with [MATCH] tags for filter-matched events
  const hasActiveFilter = activeFilters && Object.values(activeFilters).some(Boolean);
  const filterLabel = hasActiveFilter
    ? Object.entries(activeFilters).filter(([,v]) => v).map(([k,v]) => `${k}=${v}`).join(', ')
    : 'none';

  let eventListStr = '';
  if (events && events.length > 0) {
    eventListStr = events.map(e => {
      const eventDate = getEventDate(e);
      const dayLabel = eventDate === todayNyc ? 'TODAY' : eventDate === tomorrowNyc ? 'TOMORROW' : eventDate;
      const tag = e.filter_match === 'hard' ? '[MATCH] '
                : e.filter_match === 'soft' ? '[SOFT] '
                : '';
      const nearbyTag = (neighborhood && e.neighborhood && e.neighborhood !== neighborhood) ? '[NEARBY] ' : '';
      return tag + nearbyTag + JSON.stringify({
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
        extraction_confidence: e.extraction_confidence,
        ticket_url: e.ticket_url,
      });
    }).join('\n');
  }

  // Build session context
  const sessionContext = session
    ? `Last neighborhood: ${session.lastNeighborhood || 'none'}. Last picks: ${(session.lastPicks || []).map((p, i) => {
        const evt = session.lastEvents?.[p.event_id];
        return evt ? `#${i + 1} "${evt.name}"` : `#${i + 1}`;
      }).join(', ') || 'none'}.${session.lastFilters && Object.values(session.lastFilters).some(Boolean) ? ` Active filters: ${JSON.stringify(session.lastFilters)}.` : ''}${session.pendingNearby ? ` Pending suggestion: "${session.pendingNearby}" (user was asked if they want picks there).` : ''}${session.pendingFilters ? ` Pending filters: ${JSON.stringify(session.pendingFilters)}.` : ''}${session.pendingMessage ? ` Original request: "${session.pendingMessage}".` : ''}`
    : 'No prior session.';

  const historyBlock = conversationHistory?.length > 0
    ? '\nCONVERSATION HISTORY:\n' + conversationHistory.map(h =>
        `${h.role === 'user' ? 'User' : 'Bestie'}: ${h.content}`
      ).join('\n') + '\n'
    : '';

  const nearbyBlock = nearbyHoods?.length > 0
    ? `\nNearby neighborhoods: ${nearbyHoods.join(', ')}`
    : '';

  const validNeighborhoodsBlock = validNeighborhoods?.length > 0
    ? `\nVALID_NEIGHBORHOODS: ${validNeighborhoods.join(', ')}`
    : '';

  const filterContextBlock = hasActiveFilter
    ? `\nACTIVE_FILTER: ${filterLabel}\nHARD_MATCH: ${hardCount || 0}\nSOFT_MATCH: ${softCount || 0} of ${events?.length || 0} events\nSPARSE: ${isSparse ? 'true — few matches, acknowledge honestly' : 'false'}`
    : '';

  const excludeNote = excludeIds && excludeIds.length > 0
    ? `\nEXCLUDED (already shown to user — do NOT pick these): ${excludeIds.join(', ')}`
    : '';

  const aliasNote = userHoodAlias ? ` (user said "${userHoodAlias}" — this is a known alias for ${neighborhood}, serve events normally)` : '';
  const neighborhoodDisplay = isCitywide
    ? 'citywide — serve best events across all NYC neighborhoods. Label each pick with its neighborhood.'
    : (neighborhood || 'not specified') + aliasNote;
  const userPrompt = `Current time (NYC): ${now}
<user_message>${message}</user_message>
Session context: ${sessionContext}
Neighborhood: ${neighborhoodDisplay}
${historyBlock}${nearbyBlock}${validNeighborhoodsBlock}${filterContextBlock}${excludeNote}
${eventListStr ? `EVENT_LIST (${events.length} events):\n${eventListStr}` : 'No events available for this area.'}

Respond now.`;

  // Build system prompt with dynamic skills
  const skillOptions = {
    requestedNeighborhood: neighborhood,
    userMessage: message,
    hasConversationHistory: conversationHistory?.length > 0,
    nearbyNeighborhoods: nearbyHoods,
    suggestedNeighborhood: suggestedNeighborhood || null,
    matchCount: matchCount,
    poolSize: events?.length || 0,
    isFree: activeFilters?.free_only,
    hasActiveCategory: activeFilters?.category && (hardCount > 0 || softCount > 0),
  };
  const systemPrompt = buildUnifiedPrompt(events || [], skillOptions);

  let text, usage, provider;
  if (MODELS.compose.startsWith('gemini-') && getGeminiClient()) {
    try {
      const result = await unifiedWithGemini(systemPrompt, userPrompt);
      text = result.text; usage = result.usage; provider = 'gemini';
    } catch (err) {
      console.warn(`Gemini unifiedRespond failed, falling back to Anthropic: ${err.message}`);
      const response = await withTimeout(getClient().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }, { timeout: 12000 }), 15000, 'unifiedRespond');
      text = response.content?.[0]?.text || '';
      usage = response.usage || null;
      provider = 'anthropic';
    }
  } else {
    const response = await withTimeout(getClient().messages.create({
      model: MODELS.compose,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }, { timeout: 12000 }), 15000, 'unifiedRespond');
    text = response.content?.[0]?.text || '';
    usage = response.usage || null;
    provider = 'anthropic';
  }

  const parsed = parseJsonFromResponse(text);

  if (!parsed || !parsed.sms_text || typeof parsed.sms_text !== 'string') {
    console.error('unifiedRespond: invalid response:', text);
    return {
      type: 'conversational',
      sms_text: "Having a moment — try again in a sec!",
      picks: [],
      clear_filters: false,
      _raw: text,
      _usage: usage,
      _provider: provider || 'anthropic',
    };
  }

  // Validate picks against provided events
  let validPicks = [];
  if (parsed.picks && parsed.picks.length > 0 && events && events.length > 0) {
    const validIds = new Set(events.map(e => e.id));
    validPicks = parsed.picks.filter(p => p && typeof p.event_id === 'string' && validIds.has(p.event_id));

    // Fallback: name matching (same as composeResponse)
    if (validPicks.length === 0 && parsed.picks.length > 0) {
      console.warn(`unifiedRespond: ${parsed.picks.length} picks had invalid IDs, attempting name match`);
      const nameToId = new Map(events.map(e => [(e.name || '').toLowerCase(), e.id]));
      validPicks = parsed.picks.map(p => {
        if (p && validIds.has(p.event_id)) return p;
        for (const [name, id] of nameToId) {
          if (name && p.event_id && name.includes(p.event_id.toLowerCase())) return { ...p, event_id: id };
        }
        return null;
      }).filter(Boolean);
      if (validPicks.length === 0) {
        const smsLower = parsed.sms_text.toLowerCase();
        validPicks = events.filter(e => {
          const name = (e.name || '').toLowerCase();
          return name.length >= 3 && smsLower.includes(name);
        }).slice(0, 3).map((e, i) => ({ rank: i + 1, event_id: e.id }));
        if (validPicks.length > 0) {
          console.warn(`unifiedRespond: [RECOVERED] ${validPicks.length} picks via full-name sms_text matching`);
        }
      }
    }
  }

  return {
    type: parsed.type || (validPicks.length > 0 ? 'event_picks' : 'conversational'),
    sms_text: smartTruncate(parsed.sms_text),
    picks: validPicks,
    clear_filters: parsed.clear_filters === true,
    _raw: text,
    _usage: usage,
    _provider: provider,
  };
}

module.exports = { composeDetails, extractEvents, unifiedRespond, parseJsonFromResponse };
