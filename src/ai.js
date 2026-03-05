const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { EXTRACTION_PROMPT, DETAILS_SYSTEM } = require('./prompts');
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

// Gemini fallback chain: flash → flash-lite → Haiku
// On quota/rate-limit errors (429), try the next Gemini model before falling to Anthropic.
const GEMINI_FALLBACK = 'gemini-2.5-flash-lite';
function isQuotaError(err) {
  return err.message && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('Too Many Requests'));
}

// Safety settings for all Gemini calls — block dangerous content but allow normal event text
function checkGeminiFinish(response, label) {
  const reason = response.candidates?.[0]?.finishReason;
  if (reason && reason !== 'STOP') {
    console.warn(`${label}: finishReason=${reason}`);
    if (reason === 'SAFETY' || reason === 'MAX_TOKENS') {
      throw new Error(`Gemini ${label}: ${reason}`);
    }
  }
}

const GEMINI_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];


/**
 * Extract events via Google Gemini Flash.
 */
async function extractWithGemini(systemPrompt, userPrompt, modelName) {
  const genAI = getGeminiClient();
  const gemModel = genAI.getGenerativeModel({
    model: modelName || MODELS.extract,
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    generationConfig: { maxOutputTokens: 4096, temperature: 0, responseMimeType: 'application/json' },
  });

  const result = await withTimeout(
    gemModel.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
    90_000, 'extractWithGemini'
  );
  const response = result.response;
  checkGeminiFinish(response, 'extractWithGemini');
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
async function detailsWithGemini(systemPrompt, userPrompt, modelName) {
  const genAI = getGeminiClient();
  const gemModel = genAI.getGenerativeModel({
    model: modelName || MODELS.compose,
    systemInstruction: systemPrompt,
    safetySettings: GEMINI_SAFETY,
    generationConfig: { maxOutputTokens: 1024, temperature: 0.8 },
  });

  const result = await withTimeout(
    gemModel.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
    15_000, 'detailsWithGemini'
  );
  const response = result.response;
  checkGeminiFinish(response, 'detailsWithGemini');
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
      if (isQuotaError(err) && resolvedModel !== GEMINI_FALLBACK) {
        try {
          console.warn(`Gemini ${resolvedModel} extractEvents quota hit, trying ${GEMINI_FALLBACK}`);
          const result = await extractWithGemini(EXTRACTION_PROMPT, userPrompt, GEMINI_FALLBACK);
          text = result.text; usage = result.usage; provider = 'gemini';
        } catch (err2) {
          console.warn(`Gemini fallback extractEvents also failed, falling back to Anthropic: ${err2.message}`);
          const timeout = sourceName === 'yutori' ? 90000 : 60000;
          const response = await getClient().messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 8192, system: EXTRACTION_PROMPT, messages: [{ role: 'user', content: userPrompt }] }, { timeout, maxRetries: 0 });
          text = response.content?.[0]?.text || '';
          usage = response.usage || null;
          provider = 'anthropic';
        }
      } else {
        console.warn(`Gemini extractEvents failed, falling back to Anthropic: ${err.message}`);
        const timeout = sourceName === 'yutori' ? 90000 : 60000;
        const response = await getClient().messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 8192, system: EXTRACTION_PROMPT, messages: [{ role: 'user', content: userPrompt }] }, { timeout, maxRetries: 0 });
        text = response.content?.[0]?.text || '';
        usage = response.usage || null;
        provider = 'anthropic';
      }
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
    usage = response.usage || null;
    provider = 'anthropic';
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
      if (isQuotaError(err) && MODELS.compose !== GEMINI_FALLBACK) {
        try {
          console.warn(`Gemini ${MODELS.compose} composeDetails quota hit, trying ${GEMINI_FALLBACK}`);
          const result = await detailsWithGemini(DETAILS_SYSTEM, userPrompt, GEMINI_FALLBACK);
          text = result.text; usage = result.usage; provider = 'gemini';
        } catch (err2) {
          console.warn(`Gemini fallback composeDetails also failed, falling back to Anthropic: ${err2.message}`);
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

module.exports = { composeDetails, extractEvents, parseJsonFromResponse };
