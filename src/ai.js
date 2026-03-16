const { generate: llmGenerate } = require('./llm');
const { MODELS } = require('./model-config');
const { EXTRACTION_PROMPT, YUTORI_EXTRACTION_PROMPT } = require('./prompts');


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
 * Extract events from a Yutori Scout email using Claude Sonnet.
 * Used as fallback when deterministic parsers (trivia, structured) return 0 results.
 */
async function extractYutoriEvents(preprocessedText, filename) {
  const model = process.env.PULSE_MODEL_YUTORI_EXTRACT || 'claude-sonnet-4-6';
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  const emailDate = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

  const userPrompt = `<source>
source_name: yutori
filename: ${filename}
email_date: ${emailDate}
</source>

<text>
${preprocessedText}
</text>

Extract all events into the JSON format specified in your instructions.`;

  let text, usage, provider;

  try {
    const result = await llmGenerate(model, YUTORI_EXTRACTION_PROMPT, userPrompt, {
      maxTokens: 8192, temperature: 0, json: true, timeout: 90_000,
    });
    text = result.text; usage = result.usage; provider = result.provider;
  } catch (err) {
    console.warn(`extractYutoriEvents ${model} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    const result = await llmGenerate(MODELS.fallback, YUTORI_EXTRACTION_PROMPT, userPrompt, {
      maxTokens: 8192, temperature: 0, json: true, timeout: 90_000,
    });
    text = result.text; usage = result.usage; provider = result.provider;
  }

  const parsed = parseJsonFromResponse(text);
  if (!parsed) {
    console.error(`extractYutoriEvents (${provider}): no valid JSON in response`);
    return { events: [], _usage: usage || null, _provider: provider };
  }

  const events = Array.isArray(parsed.events) ? parsed.events : Array.isArray(parsed) ? parsed : [];
  return { events, _usage: usage || null, _provider: provider };
}

module.exports = { extractEvents, extractYutoriEvents, parseJsonFromResponse };
