/**
 * llm.js — Provider-agnostic LLM interface.
 *
 * Four main functions:
 *   generate()      — Single-turn text/JSON generation
 *   callWithTools() — Single-turn tool calling
 *   continueChat()  — Multi-turn continuation (send tool result back)
 *   runAgentLoop()  — Multi-turn agent loop (tool calling + execution + repeat)
 *
 * Callers pass tools in neutral format (lowercase JSON Schema types).
 * This module converts to provider-specific formats automatically.
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { getProvider } = require('./model-config');
const { smartTruncate } = require('./formatters');

// --- Agent loop constants ---

// Tools that are safe to run concurrently (no state mutation)
const READ_ONLY_TOOLS = new Set(['search', 'lookup_venue']);

/**
 * Safety net: ensure every tool_use block has a matching tool_result.
 * Generates synthetic is_error results for any orphaned tool_use blocks.
 * Prevents Anthropic API rejection: "tool_use ids found without tool_result blocks"
 */
function ensureToolResultPairing(toolBlocks, toolResults) {
  const resultIds = new Set(toolResults.map(r => r.tool_use_id));
  for (const tb of toolBlocks) {
    if (!resultIds.has(tb.id)) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: JSON.stringify({ error: 'Tool execution was skipped or aborted' }),
        is_error: true,
      });
    }
  }
  return toolResults;
}

// --- String sanitization ---

/**
 * Strip lone surrogates from a string to prevent invalid JSON errors.
 * Scraped event data sometimes contains broken emoji/Unicode.
 */
function stripLoneSurrogates(str) {
  if (typeof str !== 'string') return str;
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate — keep only if followed by low surrogate
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += str[i] + str[i + 1];
        i++; // skip the low surrogate
      }
      // else: lone high surrogate, skip it
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Lone low surrogate, skip it
    } else {
      result += str[i];
    }
  }
  return result;
}

/**
 * Recursively sanitize all strings in an object/array to remove lone surrogates.
 */
function sanitizeUnicode(obj) {
  if (typeof obj === 'string') return stripLoneSurrogates(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeUnicode);
  if (obj && typeof obj === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      clean[k] = sanitizeUnicode(v);
    }
    return clean;
  }
  return obj;
}

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

/**
 * Convert neutral tools to Anthropic format with prompt caching.
 * Marks the last tool with cache_control so Anthropic caches the entire
 * static prefix (system prompt + all tool definitions).
 */
function toAnthropicToolsCached(neutralTools) {
  return neutralTools.map((tool, i) => {
    const converted = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    };
    if (i === neutralTools.length - 1) {
      converted.cache_control = { type: 'ephemeral' };
    }
    return converted;
  });
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
  console.log(`[llm] generate model=${model} provider=${provider}`);
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
  console.log(`[llm] callWithTools model=${model} provider=${provider}`);
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
    const cachedSystem = [{ type: 'text', text: systemPrompt }];
    const cachedTools = toAnthropicToolsCached(tools);

    const response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: maxTokens,
        system: cachedSystem,
        tools: cachedTools,
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
          _system: cachedSystem,
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
          content: JSON.stringify(sanitizeUnicode(toolResult)),
        }],
      },
    ];

    // _system is already in cached array format from callWithTools
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

/**
 * Run a multi-turn agent loop: LLM calls tools, we execute them,
 * feed results back, repeat until LLM responds with text or max iterations.
 *
 * @param {string} model - Model name
 * @param {string} systemPrompt - System instruction
 * @param {string} message - User message
 * @param {Array} tools - Neutral-format tool definitions
 * @param {Function} executeTool - async (toolName, params) => resultObject
 * @param {object} options - { maxIterations, timeout }
 * @returns {{ text: string, toolCalls: Array<{name, params, result}>, totalUsage: object, provider: string }}
 */
async function runAgentLoop(model, systemPrompt, message, tools, executeTool, options = {}) {
  const { maxIterations = 3, timeout = 15000, stopTools = [], priorMessages = [] } = options;
  const provider = getProvider(model);
  console.log(`[agent-loop] model=${model} provider=${provider}`);
  const loopStart = Date.now();
  const toolCalls = [];
  const iterations = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  function addUsage(usage) {
    if (!usage) return;
    totalUsage.input_tokens += usage.input_tokens || 0;
    totalUsage.output_tokens += usage.output_tokens || 0;
  }

  function remainingTimeout() {
    const elapsed = Date.now() - loopStart;
    const remaining = timeout - elapsed;
    if (remaining <= 0) throw new Error('Agent loop timed out');
    return remaining;
  }

  if (provider === 'gemini') {
    const genAI = getGeminiClient();
    if (!genAI) throw new Error('GEMINI_API_KEY not set');

    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      safetySettings: GEMINI_SAFETY,
      tools: toGeminiTools(tools),
      generationConfig: { maxOutputTokens: 1024, temperature: 0 },
    });

    const chat = geminiModel.startChat({
      history: priorMessages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    });

    // First turn: send user message
    let result = await withTimeout(chat.sendMessage(message), remainingTimeout(), `agentLoop(${model})`);
    let response = result.response;
    addUsage(extractGeminiUsage(response));

    for (let i = 0; i < maxIterations; i++) {
      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const fnCalls = parts.filter(p => p.functionCall);

      if (fnCalls.length === 0) {
        // No tool call — LLM is done, return text
        const textPart = parts.find(p => p.text);
        return { text: textPart?.text || '', toolCalls, totalUsage, provider, elapsed_ms: Date.now() - loopStart, iterations };
      }

      // Execute all tool calls — read-only tools run concurrently, errors become content
      const iterStart = Date.now();
      const functionResponses = [];
      const allReadOnly = fnCalls.every(fc => READ_ONLY_TOOLS.has(fc.functionCall.name));

      if (allReadOnly && fnCalls.length > 1) {
        const settled = await Promise.allSettled(
          fnCalls.map(async (fnCall) => {
            const toolName = fnCall.functionCall.name;
            const toolParams = fnCall.functionCall.args || {};
            const toolResult = await executeTool(toolName, toolParams);
            return { toolName, toolParams, toolResult };
          })
        );
        for (let idx = 0; idx < settled.length; idx++) {
          const s = settled[idx];
          const toolName = fnCalls[idx].functionCall.name;
          const toolParams = fnCalls[idx].functionCall.args || {};
          if (s.status === 'fulfilled') {
            toolCalls.push({ name: s.value.toolName, params: s.value.toolParams, result: s.value.toolResult });
            functionResponses.push({ functionResponse: { name: s.value.toolName, response: s.value.toolResult } });
          } else {
            console.error(`[agentLoop] Tool ${toolName} failed: ${s.reason?.message}`);
            const errorResult = { error: s.reason?.message || 'Unknown error' };
            toolCalls.push({ name: toolName, params: toolParams, result: errorResult, is_error: true });
            functionResponses.push({ functionResponse: { name: toolName, response: errorResult } });
          }
        }
      } else {
        for (const fnCall of fnCalls) {
          const toolName = fnCall.functionCall.name;
          const toolParams = fnCall.functionCall.args || {};
          try {
            const toolResult = await executeTool(toolName, toolParams);
            toolCalls.push({ name: toolName, params: toolParams, result: toolResult });
            functionResponses.push({ functionResponse: { name: toolName, response: toolResult } });
          } catch (err) {
            console.error(`[agentLoop] Tool ${toolName} failed: ${err.message}`);
            const errorResult = { error: err.message };
            toolCalls.push({ name: toolName, params: toolParams, result: errorResult, is_error: true });
            functionResponses.push({ functionResponse: { name: toolName, response: errorResult } });
          }
        }
      }

      // Stop early if any tool is a terminal tool
      const hitStop = fnCalls.some(fc => stopTools.includes(fc.functionCall.name));
      if (hitStop) {
        iterations.push({ tool: fnCalls.map(fc => fc.functionCall.name).join('+'), ms: Date.now() - iterStart });
        return { text: '', toolCalls, totalUsage, provider, elapsed_ms: Date.now() - loopStart, iterations };
      }

      // Send all results back
      result = await withTimeout(
        chat.sendMessage(functionResponses),
        remainingTimeout(), `agentLoop(${model}) turn ${i + 2}`
      );
      response = result.response;
      addUsage(extractGeminiUsage(response));

      // Handle MALFORMED_FUNCTION_CALL — model tried to call a tool but generated bad JSON
      if (response.candidates?.[0]?.finishReason === 'MALFORMED_FUNCTION_CALL') {
        console.warn(`[agentLoop] MALFORMED_FUNCTION_CALL on turn ${i + 2}`);
        iterations.push({ tool: fnCalls.map(fc => fc.functionCall.name).join('+'), ms: Date.now() - iterStart });
        return { text: '', toolCalls, totalUsage, provider, malformedCall: true, elapsed_ms: Date.now() - loopStart, iterations };
      }

      iterations.push({ tool: fnCalls.map(fc => fc.functionCall.name).join('+'), ms: Date.now() - iterStart });
    }

    // Hit max iterations — extract whatever text we have
    const finalParts = response.candidates?.[0]?.content?.parts || [];
    const finalText = finalParts.find(p => p.text);
    return { text: finalText?.text || '', toolCalls, totalUsage, provider, elapsed_ms: Date.now() - loopStart, iterations };
  }

  if (provider === 'anthropic') {
    const client = getAnthropicClient();
    const cachedSystem = [{ type: 'text', text: systemPrompt }];
    const cachedTools = toAnthropicToolsCached(tools);
    const messages = [
      ...priorMessages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    for (let i = 0; i <= maxIterations; i++) {
      const response = await withTimeout(
        client.messages.create({
          model,
          max_tokens: 1024,
          system: cachedSystem,
          tools: cachedTools,
          messages,
        }, { timeout: remainingTimeout() }),
        remainingTimeout() + 2000, `agentLoop(${model}) turn ${i + 1}`
      );

      addUsage(response.usage);

      // Track cache performance
      if (response.usage) {
        if (response.usage.cache_creation_input_tokens) {
          totalUsage.cache_creation_input_tokens = (totalUsage.cache_creation_input_tokens || 0) + response.usage.cache_creation_input_tokens;
        }
        if (response.usage.cache_read_input_tokens) {
          totalUsage.cache_read_input_tokens = (totalUsage.cache_read_input_tokens || 0) + response.usage.cache_read_input_tokens;
        }
      }

      const toolBlocks = response.content.filter(b => b.type === 'tool_use');

      if (toolBlocks.length === 0) {
        // No tool call — return text
        const textBlock = response.content.find(b => b.type === 'text');
        return { text: textBlock?.text || '', toolCalls, totalUsage, provider, elapsed_ms: Date.now() - loopStart, iterations };
      }

      // Execute tool calls — read-only tools run concurrently, errors become content
      const iterStart = Date.now();
      let toolResults = [];
      const allReadOnly = toolBlocks.every(tb => READ_ONLY_TOOLS.has(tb.name));

      if (allReadOnly && toolBlocks.length > 1) {
        const settled = await Promise.allSettled(
          toolBlocks.map(async (toolBlock) => {
            const toolResult = await executeTool(toolBlock.name, toolBlock.input || {});
            return { toolBlock, toolResult };
          })
        );
        for (let idx = 0; idx < settled.length; idx++) {
          const s = settled[idx];
          const toolBlock = toolBlocks[idx];
          if (s.status === 'fulfilled') {
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: s.value.toolResult });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(sanitizeUnicode(s.value.toolResult)),
            });
          } else {
            console.error(`[agentLoop] Tool ${toolBlock.name} failed: ${s.reason?.message}`);
            const errorResult = { error: s.reason?.message || 'Unknown error' };
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: errorResult, is_error: true });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(errorResult),
              is_error: true,
            });
          }
        }
      } else {
        for (const toolBlock of toolBlocks) {
          try {
            const toolResult = await executeTool(toolBlock.name, toolBlock.input || {});
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: toolResult });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(sanitizeUnicode(toolResult)),
            });
          } catch (err) {
            console.error(`[agentLoop] Tool ${toolBlock.name} failed: ${err.message}`);
            const errorResult = { error: err.message };
            toolCalls.push({ name: toolBlock.name, params: toolBlock.input || {}, result: errorResult, is_error: true });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(errorResult),
              is_error: true,
            });
          }
        }
      }

      // Safety net: ensure every tool_use has a matching tool_result
      ensureToolResultPairing(toolBlocks, toolResults);

      // Stop early if any tool is a terminal tool
      const hitStop = toolBlocks.some(tb => stopTools.includes(tb.name));
      if (hitStop) {
        iterations.push({ tool: toolBlocks.map(tb => tb.name).join('+'), ms: Date.now() - iterStart });
        return { text: '', toolCalls, totalUsage, provider, elapsed_ms: Date.now() - loopStart, iterations };
      }

      // Append assistant response + ALL tool results for next turn
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      iterations.push({ tool: toolBlocks.map(tb => tb.name).join('+'), ms: Date.now() - iterStart });
    }

    // Hit max iterations
    return { text: '', toolCalls, totalUsage, provider, elapsed_ms: Date.now() - loopStart, iterations };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = {
  // Main functions
  generate,
  callWithTools,
  continueChat,
  runAgentLoop,

  // Tool format converters
  toGeminiTools,
  toAnthropicTools,
  toAnthropicToolsCached,
  convertSchemaToGemini,

  // Utilities
  withTimeout,
  getGeminiClient,
  getAnthropicClient,
  GEMINI_SAFETY,
  extractGeminiUsage,
};
