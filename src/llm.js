/**
 * llm.js — Provider-agnostic LLM interface.
 *
 * Three main functions:
 *   generate()      — Single-turn text/JSON generation
 *   callWithTools() — Single-turn tool calling
 *   continueChat()  — Multi-turn continuation (send tool result back)
 *
 * Callers pass tools in neutral format (lowercase JSON Schema types).
 * This module converts to provider-specific formats automatically.
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { getProvider } = require('./model-config');
const { smartTruncate } = require('./formatters');

// --- Lazy singleton clients ---

let _geminiClient = null;
function getGeminiClient() {
  if (!_geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    _geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return _geminiClient;
}

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropicClient = new Anthropic();
  }
  return _anthropicClient;
}

// --- Gemini safety settings ---

const GEMINI_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

// --- Timeout helper ---

function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// --- Tool format converters ---

/**
 * Recursively uppercase all `type` fields for Gemini (e.g. "string" → "STRING").
 */
function convertSchemaToGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else if (key === 'properties' && typeof value === 'object') {
      out.properties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        out.properties[propName] = convertSchemaToGemini(propSchema);
      }
    } else if (key === 'items' && typeof value === 'object') {
      out.items = convertSchemaToGemini(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Convert neutral tools to Gemini format.
 * Wraps in { functionDeclarations: [...] } and uppercases type fields.
 */
function toGeminiTools(neutralTools) {
  return [{
    functionDeclarations: neutralTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: convertSchemaToGemini(tool.parameters),
    })),
  }];
}

/**
 * Convert neutral tools to Anthropic format.
 * Anthropic uses { name, description, input_schema } with lowercase types (no conversion needed).
 */
function toAnthropicTools(neutralTools) {
  return neutralTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

// --- Usage extraction ---

function extractGeminiUsage(response) {
  const meta = response.usageMetadata;
  return meta ? {
    input_tokens: meta.promptTokenCount || 0,
    output_tokens: meta.candidatesTokenCount || 0,
  } : null;
}

// --- Main functions ---

/**
 * Single-turn text/JSON generation.
 *
 * @param {string} model - Model name (e.g. "gemini-2.5-flash", "claude-haiku-4-5-20251001")
 * @param {string} systemPrompt - System instruction
 * @param {string} userPrompt - User message
 * @param {object} options - { maxTokens, temperature, json, jsonSchema, timeout }
 * @returns {{ text: string, usage: object, provider: string }}
 */
async function generate(model, systemPrompt, userPrompt, options = {}) {
  const provider = getProvider(model);
  const { maxTokens = 1024, temperature = 0, json = false, jsonSchema, timeout = 15000 } = options;

  if (provider === 'gemini') {
    const genAI = getGeminiClient();
    if (!genAI) throw new Error('GEMINI_API_KEY not set');

    const generationConfig = { maxOutputTokens: maxTokens, temperature };
    if (json) {
      generationConfig.responseMimeType = 'application/json';
      if (jsonSchema) generationConfig.responseSchema = jsonSchema;
    }

    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      safetySettings: GEMINI_SAFETY,
      generationConfig,
    });

    const result = await withTimeout(
      geminiModel.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
      timeout, `generate(${model})`
    );

    return {
      text: result.response.text(),
      usage: extractGeminiUsage(result.response),
      provider: 'gemini',
    };
  }

  if (provider === 'anthropic') {
    const client = getAnthropicClient();

    const response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }, { timeout }),
      timeout + 2000, `generate(${model})`
    );

    const text = response.content?.[0]?.text || '';
    return {
      text,
      usage: response.usage || null,
      provider: 'anthropic',
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Single-turn tool calling.
 *
 * @param {string} model - Model name
 * @param {string} systemPrompt - System instruction
 * @param {string} message - User message
 * @param {Array} tools - Neutral-format tools (JSON Schema, lowercase types)
 * @param {object} options - { maxTokens, temperature, timeout }
 * @returns {{ tool: string|null, params: object, text: string|null, usage: object, provider: string, chat: object|null }}
 */
async function callWithTools(model, systemPrompt, message, tools, options = {}) {
  const provider = getProvider(model);
  const { maxTokens = 1024, temperature = 0, timeout = 10000 } = options;

  if (provider === 'gemini') {
    const genAI = getGeminiClient();
    if (!genAI) throw new Error('GEMINI_API_KEY not set');

    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      safetySettings: GEMINI_SAFETY,
      tools: toGeminiTools(tools),
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    });

    const chat = geminiModel.startChat();
    const result = await withTimeout(chat.sendMessage(message), timeout, `callWithTools(${model})`);

    const response = result.response;
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;

    if (finishReason && finishReason !== 'STOP') {
      if (finishReason === 'SAFETY') {
        throw new Error(`callWithTools blocked by safety filter`);
      }
      if (finishReason === 'MALFORMED_FUNCTION_CALL' || finishReason === 'MAX_TOKENS') {
        throw new Error(`Gemini callWithTools: ${finishReason}`);
      }
    }

    const parts = candidate?.content?.parts || [];
    const fnCall = parts.find(p => p.functionCall);
    const usage = extractGeminiUsage(response);

    if (fnCall?.functionCall) {
      return {
        tool: fnCall.functionCall.name,
        params: fnCall.functionCall.args || {},
        text: null,
        usage,
        provider: 'gemini',
        chat: { _type: 'gemini', _chat: chat },
      };
    }

    // No tool call — return text
    const textPart = parts.find(p => p.text);
    return {
      tool: null,
      params: {},
      text: textPart?.text || null,
      usage,
      provider: 'gemini',
      chat: null,
    };
  }

  if (provider === 'anthropic') {
    const client = getAnthropicClient();

    const response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: toAnthropicTools(tools),
        messages: [{ role: 'user', content: message }],
      }, { timeout }),
      timeout + 2000, `callWithTools(${model})`
    );

    const toolBlock = response.content.find(b => b.type === 'tool_use');
    const usage = response.usage || null;

    if (toolBlock) {
      return {
        tool: toolBlock.name,
        params: toolBlock.input || {},
        text: null,
        usage,
        provider: 'anthropic',
        chat: {
          _type: 'anthropic',
          _model: model,
          _system: systemPrompt,
          _messages: [{ role: 'user', content: message }],
          _response: response,
          _toolBlock: toolBlock,
        },
      };
    }

    // No tool call — return text
    const textBlock = response.content.find(b => b.type === 'text');
    return {
      tool: null,
      params: {},
      text: textBlock?.text || null,
      usage,
      provider: 'anthropic',
      chat: null,
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Multi-turn continuation — send tool result back to the model.
 *
 * @param {object} chatSession - Chat session from callWithTools (has _type field)
 * @param {string} toolName - Name of the tool that was called
 * @param {object} toolResult - Result data to send back
 * @param {object} options - { timeout }
 * @returns {{ text: string, usage: object, provider: string }}
 */
async function continueChat(chatSession, toolName, toolResult, options = {}) {
  const { timeout = 10000 } = options;

  if (!chatSession || !chatSession._type) {
    throw new Error('Invalid chat session');
  }

  if (chatSession._type === 'gemini') {
    const result = await withTimeout(
      chatSession._chat.sendMessage([{
        functionResponse: {
          name: toolName,
          response: toolResult,
        },
      }]),
      timeout, 'continueChat(gemini)'
    );

    const response = result.response;
    return {
      text: response.text(),
      usage: extractGeminiUsage(response),
      provider: 'gemini',
    };
  }

  if (chatSession._type === 'anthropic') {
    const client = getAnthropicClient();

    // Build continuation messages: assistant content (from original) + user tool_result
    const messages = [
      ...chatSession._messages,
      { role: 'assistant', content: chatSession._response.content },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: chatSession._toolBlock.id,
          content: JSON.stringify(toolResult),
        }],
      },
    ];

    const response = await withTimeout(
      client.messages.create({
        model: chatSession._model,
        max_tokens: 1024,
        system: chatSession._system,
        messages,
      }, { timeout }),
      timeout + 2000, 'continueChat(anthropic)'
    );

    const textBlock = response.content.find(b => b.type === 'text');
    return {
      text: textBlock?.text || '',
      usage: response.usage || null,
      provider: 'anthropic',
    };
  }

  throw new Error(`Unknown chat session type: ${chatSession._type}`);
}

module.exports = {
  // Main functions
  generate,
  callWithTools,
  continueChat,

  // Tool format converters
  toGeminiTools,
  toAnthropicTools,
  convertSchemaToGemini,

  // Utilities
  withTimeout,
  getGeminiClient,
  getAnthropicClient,
  GEMINI_SAFETY,
  extractGeminiUsage,
};
