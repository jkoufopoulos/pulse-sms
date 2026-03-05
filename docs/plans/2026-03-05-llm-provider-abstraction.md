# LLM Provider Abstraction — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make all LLM touchpoints swappable between Gemini and Anthropic via config — change a model name string, provider switches automatically.

**Architecture:** A thin adapter layer (`src/llm.js`) with 3 functions that detect provider from model name prefix and route to the correct SDK. A centralized config (`src/model-config.js`) replaces all hardcoded model strings. Existing `brain-llm.js` and `ai.js` call through `llm.js` instead of raw SDK calls.

**Tech Stack:** `@google/generative-ai`, `@anthropic-ai/sdk` (both already installed)

---

### Task 1: Create model-config.js — single source of truth for all model names

**Files:**
- Create: `src/model-config.js`
- Test: `test/unit/model-config.test.js`

**Step 1: Write the failing test**

```js
// test/unit/model-config.test.js
const { check } = require('../helpers');

console.log('\nmodel-config:');

// Save and clear env vars for clean test
const savedEnv = {};
['PULSE_MODEL_BRAIN', 'PULSE_MODEL_COMPOSE', 'PULSE_MODEL_EXTRACT', 'PULSE_MODEL_DETAILS', 'PULSE_MODEL_FALLBACK'].forEach(k => {
  savedEnv[k] = process.env[k];
  delete process.env[k];
});

// Re-require to pick up clean env
delete require.cache[require.resolve('../../src/model-config')];
const { MODELS, getProvider } = require('../../src/model-config');

// Defaults
check('brain defaults to gemini-2.5-flash-lite', MODELS.brain === 'gemini-2.5-flash-lite');
check('compose defaults to gemini-2.5-flash-lite', MODELS.compose === 'gemini-2.5-flash-lite');
check('extract defaults to gemini-2.5-flash', MODELS.extract === 'gemini-2.5-flash');
check('details defaults to gemini-2.5-flash', MODELS.details === 'gemini-2.5-flash');
check('fallback defaults to claude-haiku-4-5-20251001', MODELS.fallback === 'claude-haiku-4-5-20251001');

// Provider detection
check('gemini-2.5-flash → gemini', getProvider('gemini-2.5-flash') === 'gemini');
check('gemini-2.5-flash-lite → gemini', getProvider('gemini-2.5-flash-lite') === 'gemini');
check('claude-haiku-4-5-20251001 → anthropic', getProvider('claude-haiku-4-5-20251001') === 'anthropic');
check('claude-sonnet-4-20250514 → anthropic', getProvider('claude-sonnet-4-20250514') === 'anthropic');

// Restore env
Object.entries(savedEnv).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; else delete process.env[k]; });
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/model-config.test.js`
Expected: FAIL with "Cannot find module '../../src/model-config'"

**Step 3: Write minimal implementation**

```js
// src/model-config.js
/**
 * model-config.js — Single source of truth for all LLM model choices.
 *
 * Change a model name here (or via env var) and the provider switches automatically.
 * Provider is detected from the model name prefix: "gemini-*" → Gemini, "claude-*" → Anthropic.
 */

const MODELS = {
  brain:    process.env.PULSE_MODEL_BRAIN    || 'gemini-2.5-flash-lite',
  compose:  process.env.PULSE_MODEL_COMPOSE  || 'gemini-2.5-flash-lite',
  extract:  process.env.PULSE_MODEL_EXTRACT  || 'gemini-2.5-flash',
  details:  process.env.PULSE_MODEL_DETAILS  || 'gemini-2.5-flash',
  fallback: process.env.PULSE_MODEL_FALLBACK || 'claude-haiku-4-5-20251001',
};

function getProvider(modelName) {
  if (modelName.startsWith('gemini-')) return 'gemini';
  if (modelName.startsWith('claude-')) return 'anthropic';
  throw new Error(`Unknown provider for model: ${modelName}`);
}

module.exports = { MODELS, getProvider };
```

**Step 4: Run test to verify it passes**

Run: `node test/unit/model-config.test.js`
Expected: All checks PASS

**Step 5: Commit**

```bash
git add src/model-config.js test/unit/model-config.test.js
git commit -m "feat: add model-config.js — centralized LLM model config"
```

---

### Task 2: Create llm.js — provider-agnostic LLM interface

This is the core abstraction. Three functions:
- `generate(model, systemPrompt, userPrompt, options)` — single-turn text/JSON generation (extraction, details, brainCompose)
- `callWithTools(model, systemPrompt, message, tools, options)` — single-turn tool calling (agent brain)
- `continueChat(chatSession, toolName, toolResult)` — multi-turn continuation (send tool results back, get SMS)

The `tools` parameter uses a **neutral format** — translated to Gemini/Anthropic format internally.

**Files:**
- Create: `src/llm.js`
- Test: `test/unit/llm.test.js`

**Step 1: Write the failing test**

Tests verify the interface shape and provider detection routing. We mock the SDK calls to avoid real API calls.

```js
// test/unit/llm.test.js
const { check } = require('../helpers');

console.log('\nllm:');

const { getProvider } = require('../../src/model-config');

// Provider detection (smoke test — detailed tests in model-config.test.js)
check('gemini model → gemini provider', getProvider('gemini-2.5-flash-lite') === 'gemini');
check('claude model → anthropic provider', getProvider('claude-haiku-4-5-20251001') === 'anthropic');

// Tool format conversion
const { toGeminiTools, toAnthropicTools } = require('../../src/llm');

const neutralTools = [
  {
    name: 'search_events',
    description: 'Search for events',
    parameters: {
      type: 'object',
      properties: {
        neighborhood: { type: 'string', description: 'NYC hood' },
        intent: { type: 'string', enum: ['new_search', 'refine'] },
      },
      required: ['intent'],
    },
  },
  {
    name: 'respond',
    description: 'Respond conversationally',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'SMS text' },
      },
      required: ['message'],
    },
  },
];

// Gemini format: array of { functionDeclarations: [...] }
const gemini = toGeminiTools(neutralTools);
check('toGeminiTools returns array with functionDeclarations', gemini[0]?.functionDeclarations?.length === 2);
check('gemini tool name preserved', gemini[0].functionDeclarations[0].name === 'search_events');
check('gemini uses OBJECT type', gemini[0].functionDeclarations[0].parameters.type === 'OBJECT');
check('gemini uses STRING type', gemini[0].functionDeclarations[0].parameters.properties.neighborhood.type === 'STRING');

// Anthropic format: array of { name, description, input_schema }
const anthropic = toAnthropicTools(neutralTools);
check('toAnthropicTools returns array of tool objects', anthropic.length === 2);
check('anthropic tool has name', anthropic[0].name === 'search_events');
check('anthropic tool has input_schema', anthropic[0].input_schema.type === 'object');
check('anthropic preserves properties', anthropic[0].input_schema.properties.neighborhood.type === 'string');
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/llm.test.js`
Expected: FAIL with "Cannot find module '../../src/llm'"

**Step 3: Write implementation**

```js
// src/llm.js
/**
 * llm.js — Provider-agnostic LLM interface.
 *
 * Three functions:
 * - generate()       — single-turn text/JSON generation
 * - callWithTools()  — single-turn tool calling, returns { tool, params, chat }
 * - continueChat()   — multi-turn: send tool result, get text response
 *
 * Provider (Gemini vs Anthropic) is auto-detected from model name prefix.
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { getProvider } = require('./model-config');
const { smartTruncate } = require('./formatters');

const GEMINI_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

// --- Clients (lazy singletons) ---

let geminiClient = null;
function getGeminiClient() {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return geminiClient;
}

let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// --- Timeout helper ---

function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// --- Tool format conversion ---

/** Convert neutral tool format to Gemini's functionDeclarations format. */
function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: convertSchemaToGemini(t.parameters),
    })),
  }];
}

/** Convert neutral tool format to Anthropic's tool format. */
function toAnthropicTools(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Convert JSON Schema types to Gemini uppercase types, recursively. */
function convertSchemaToGemini(schema) {
  if (!schema) return schema;
  const result = { ...schema };
  if (result.type) result.type = result.type.toUpperCase();
  if (result.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      result.properties[key] = convertSchemaToGemini(val);
    }
  }
  if (result.items) {
    result.items = convertSchemaToGemini(result.items);
  }
  return result;
}

// --- generate() — single-turn text/JSON generation ---

async function generate(model, systemPrompt, userPrompt, options = {}) {
  const { maxTokens = 4096, temperature = 0, json = false, jsonSchema, timeout = 30_000 } = options;
  const provider = getProvider(model);

  if (provider === 'gemini') {
    const genAI = getGeminiClient();
    if (!genAI) throw new Error('GEMINI_API_KEY not set');
    const genConfig = { maxOutputTokens: maxTokens, temperature };
    if (json) {
      genConfig.responseMimeType = 'application/json';
      if (jsonSchema) genConfig.responseSchema = jsonSchema;
    }
    const gemModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      safetySettings: GEMINI_SAFETY,
      generationConfig: genConfig,
    });
    const result = await withTimeout(
      gemModel.generateContent({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }] }),
      timeout, 'generate'
    );
    const response = result.response;
    checkGeminiFinish(response, 'generate');
    const usageMetadata = response.usageMetadata;
    return {
      text: response.text() || '',
      usage: usageMetadata ? { input_tokens: usageMetadata.promptTokenCount || 0, output_tokens: usageMetadata.candidatesTokenCount || 0 } : null,
      provider: 'gemini',
    };
  }

  // Anthropic
  const client = getAnthropicClient();
  const response = await withTimeout(client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt + (json ? '\n\nReturn ONLY valid JSON, no other text.' : ''),
    messages: [{ role: 'user', content: userPrompt }],
  }, { timeout }), timeout + 2000, 'generate');
  return {
    text: response.content?.[0]?.text || '',
    usage: response.usage || null,
    provider: 'anthropic',
  };
}

// --- callWithTools() — single-turn tool calling ---

async function callWithTools(model, systemPrompt, message, tools, options = {}) {
  const { maxTokens = 1024, temperature = 0, timeout = 10_000 } = options;
  const provider = getProvider(model);

  if (provider === 'gemini') {
    const genAI = getGeminiClient();
    if (!genAI) throw new Error('GEMINI_API_KEY not set');
    const gemModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      safetySettings: GEMINI_SAFETY,
      tools: toGeminiTools(tools),
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    });
    const chat = gemModel.startChat();
    const result = await withTimeout(chat.sendMessage(message), timeout, 'callWithTools');
    const response = result.response;
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;

    if (finishReason && finishReason !== 'STOP') {
      if (finishReason === 'SAFETY') throw new Error('Blocked by safety filter');
      if (finishReason === 'MALFORMED_FUNCTION_CALL' || finishReason === 'MAX_TOKENS') {
        throw new Error(`Gemini ${finishReason}`);
      }
    }

    const parts = candidate?.content?.parts || [];
    const fnCall = parts.find(p => p.functionCall);
    if (!fnCall?.functionCall) {
      const textPart = parts.find(p => p.text);
      if (textPart?.text) {
        return { tool: null, params: {}, text: smartTruncate(textPart.text), usage: extractGeminiUsage(response), provider: 'gemini', chat: { _type: 'gemini', _chat: chat } };
      }
      throw new Error('Gemini returned no tool call and no text');
    }

    return {
      tool: fnCall.functionCall.name,
      params: fnCall.functionCall.args || {},
      text: null,
      usage: extractGeminiUsage(response),
      provider: 'gemini',
      chat: { _type: 'gemini', _chat: chat },
    };
  }

  // Anthropic
  const client = getAnthropicClient();
  const response = await withTimeout(client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: toAnthropicTools(tools),
    messages: [{ role: 'user', content: message }],
  }, { timeout }), timeout + 2000, 'callWithTools');

  const toolBlock = response.content.find(b => b.type === 'tool_use');
  if (!toolBlock) {
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      return { tool: null, params: {}, text: smartTruncate(textBlock.text), usage: response.usage || null, provider: 'anthropic', chat: { _type: 'anthropic', _messages: [{ role: 'user', content: message }], _response: response } };
    }
    throw new Error('Anthropic returned no tool call and no text');
  }

  return {
    tool: toolBlock.name,
    params: toolBlock.input || {},
    text: null,
    usage: response.usage || null,
    provider: 'anthropic',
    chat: { _type: 'anthropic', _messages: [{ role: 'user', content: message }], _response: response, _toolBlock: toolBlock },
  };
}

// --- continueChat() — multi-turn tool result continuation ---

async function continueChat(chatSession, toolName, toolResult, options = {}) {
  const { timeout = 10_000 } = options;

  if (chatSession._type === 'gemini') {
    const result = await withTimeout(
      chatSession._chat.sendMessage([{
        functionResponse: { name: toolName, response: toolResult },
      }]),
      timeout, 'continueChat'
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
    // Build the continuation messages: assistant tool_use + user tool_result
    const assistantContent = chatSession._response.content;
    const messages = [
      ...chatSession._messages,
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: chatSession._toolBlock.id, content: JSON.stringify(toolResult) }] },
    ];
    const response = await withTimeout(client.messages.create({
      model: chatSession._model || chatSession._response.model,
      max_tokens: 1024,
      system: chatSession._system || '',
      messages,
    }, { timeout }), timeout + 2000, 'continueChat');

    return {
      text: response.content?.[0]?.text || '',
      usage: response.usage || null,
      provider: 'anthropic',
    };
  }

  throw new Error(`Unknown chat session type: ${chatSession._type}`);
}

// --- Helpers ---

function extractGeminiUsage(response) {
  const u = response.usageMetadata;
  return u ? { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 } : null;
}

function checkGeminiFinish(response, label) {
  const reason = response.candidates?.[0]?.finishReason;
  if (reason && reason !== 'STOP') {
    if (reason === 'SAFETY' || reason === 'MAX_TOKENS') {
      throw new Error(`Gemini ${label}: ${reason}`);
    }
  }
}

module.exports = {
  generate, callWithTools, continueChat,
  toGeminiTools, toAnthropicTools, convertSchemaToGemini,
  withTimeout, getGeminiClient, getAnthropicClient,
  GEMINI_SAFETY, extractGeminiUsage,
};
```

**Step 4: Run test to verify it passes**

Run: `node test/unit/llm.test.js`
Expected: All checks PASS

**Step 5: Commit**

```bash
git add src/llm.js test/unit/llm.test.js
git commit -m "feat: add llm.js — provider-agnostic LLM interface"
```

---

### Task 3: Define tools in neutral format

Currently `BRAIN_TOOLS` in `brain-llm.js` is in Gemini's `functionDeclarations` format, and `anthropicTools` is a separate copy in Anthropic format. Replace both with one neutral definition.

**Files:**
- Modify: `src/brain-llm.js:34-93` (replace `BRAIN_TOOLS` with neutral format)
- Modify: `src/brain-llm.js:328-358` (delete `anthropicTools` — use conversion from neutral)

**Step 1: Write the failing test**

Add to `test/unit/llm.test.js`:

```js
// Neutral BRAIN_TOOLS should be importable
const { BRAIN_TOOLS } = require('../../src/brain-llm');
check('BRAIN_TOOLS is array', Array.isArray(BRAIN_TOOLS));
check('BRAIN_TOOLS has search_events', BRAIN_TOOLS.some(t => t.name === 'search_events'));
check('BRAIN_TOOLS has respond', BRAIN_TOOLS.some(t => t.name === 'respond'));
// Neutral format uses lowercase types
const searchTool = BRAIN_TOOLS.find(t => t.name === 'search_events');
check('neutral format uses lowercase type', searchTool.parameters.type === 'object');
check('neutral format has intent in required', searchTool.parameters.required.includes('intent'));
```

**Step 2: Run test to verify it fails**

Run: `node test/unit/llm.test.js`
Expected: FAIL — `BRAIN_TOOLS` is currently Gemini format (uppercase types, wrapped in `functionDeclarations`)

**Step 3: Rewrite BRAIN_TOOLS in neutral format**

In `src/brain-llm.js`, replace the current `BRAIN_TOOLS` (lines 34-93) with:

```js
const BRAIN_TOOLS = [
  {
    name: 'search_events',
    description: 'Search for event recommendations. Use when the user wants to see events, asks about a neighborhood, mentions a category, or requests any kind of activity.',
    parameters: {
      type: 'object',
      properties: {
        neighborhood: { type: 'string', description: 'NYC neighborhood name, or empty string for citywide', nullable: true },
        category: {
          type: 'string', description: 'Primary event category filter. Use for single-category requests.',
          nullable: true,
          enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater',
            'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'],
        },
        categories: {
          type: 'array', description: 'Multiple category filters — use when user wants more than one type. Only use this OR category, not both.',
          nullable: true,
          items: {
            type: 'string',
            enum: ['comedy', 'jazz', 'live_music', 'dj', 'trivia', 'film', 'theater',
              'art', 'dance', 'community', 'food_drink', 'spoken_word', 'classical', 'nightlife'],
          },
        },
        free_only: { type: 'boolean', description: 'Only show free events' },
        time_after: { type: 'string', description: 'Only events after this time, HH:MM 24hr format (e.g. "22:00")', nullable: true },
        date_range: {
          type: 'string', description: 'Date scope for the search',
          nullable: true,
          enum: ['today', 'tomorrow', 'this_weekend', 'this_week', 'next_week'],
        },
        intent: {
          type: 'string', description: 'What the user is doing: new_search, refine, pivot, more, details',
          enum: ['new_search', 'refine', 'pivot', 'more', 'details'],
        },
        pick_reference: {
          type: 'string',
          description: 'How the user referenced a previously shown pick. Only used with intent: "details".',
          nullable: true,
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'respond',
    description: 'Respond conversationally when no event search is needed. Use for greetings, thanks, farewells, off-topic chat, or when the user needs clarification.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'SMS response text, max 480 chars. ALWAYS end with a redirect to events.' },
        intent: {
          type: 'string',
          enum: ['greeting', 'thanks', 'farewell', 'off_topic', 'clarify', 'acknowledge'],
        },
      },
      required: ['message', 'intent'],
    },
  },
];
```

Delete the duplicate `anthropicTools` definition inside `callAgentBrainAnthropic` (lines 328-358) — it will use `toAnthropicTools(BRAIN_TOOLS)` instead.

**Step 4: Run test to verify it passes**

Run: `node test/unit/llm.test.js`
Expected: All checks PASS

**Step 5: Commit**

```bash
git add src/brain-llm.js test/unit/llm.test.js
git commit -m "refactor: convert BRAIN_TOOLS to neutral format, delete duplicate anthropicTools"
```

---

### Task 4: Wire brain-llm.js to use llm.js for callAgentBrain

Replace the raw Gemini SDK calls in `callAgentBrain` and `callAgentBrainAnthropic` with `callWithTools()` from `llm.js`. The fallback logic stays — primary model fails → fallback model.

**Files:**
- Modify: `src/brain-llm.js:230-311` (`callAgentBrain`) — replace with `callWithTools(MODELS.brain, ...)`
- Modify: `src/brain-llm.js:322-393` (`callAgentBrainAnthropic`) — delete, replaced by fallback to `callWithTools(MODELS.fallback, ...)`
- Modify: `src/brain-llm.js:400-434` (`continueWithResults`) — replace with `continueChat()` from llm.js

**Step 1: Rewrite callAgentBrain**

```js
const { callWithTools: llmCallWithTools, continueChat: llmContinueChat } = require('./llm');
const { MODELS } = require('./model-config');

async function callAgentBrain(message, session, phone, trace) {
  const systemPrompt = buildBrainSystemPrompt(session);
  const brainStart = Date.now();

  try {
    const result = await llmCallWithTools(MODELS.brain, systemPrompt, message, BRAIN_TOOLS, { timeout: 10_000 });

    if (!result.tool) {
      // No tool call — text-only response
      return {
        tool: 'respond',
        params: { message: result.text, intent: 'clarify' },
        usage: result.usage,
        provider: result.provider,
        latency_ms: Date.now() - brainStart,
        chat: result.chat,
      };
    }

    return {
      tool: result.tool,
      params: result.params,
      usage: result.usage,
      provider: result.provider,
      latency_ms: Date.now() - brainStart,
      chat: result.chat,
    };
  } catch (err) {
    console.warn(`Agent brain ${MODELS.brain} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    trace.brain_error = `${MODELS.brain}: ${err.message}`;

    try {
      const result = await llmCallWithTools(MODELS.fallback, systemPrompt, message, BRAIN_TOOLS, { timeout: 10_000 });

      if (!result.tool) {
        return {
          tool: 'respond',
          params: { message: result.text, intent: 'clarify' },
          usage: result.usage,
          provider: result.provider,
          latency_ms: Date.now() - brainStart,
          chat: result.chat,
        };
      }

      return {
        tool: result.tool,
        params: result.params,
        usage: result.usage,
        provider: result.provider,
        latency_ms: Date.now() - brainStart,
        chat: result.chat,
      };
    } catch (err2) {
      throw new Error(`Both ${MODELS.brain} and ${MODELS.fallback} failed: ${err2.message}`);
    }
  }
}
```

**Step 2: Rewrite continueWithResults**

```js
async function continueWithResults(chat, eventData, trace) {
  const composeStart = Date.now();

  try {
    const result = await llmContinueChat(chat, 'search_events', eventData, { timeout: 10_000 });
    trace.composition.latency_ms = Date.now() - composeStart;

    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);

    return {
      sms_text: sms,
      picks: reconcilePicks(sms, parsed.picks || []),
      _raw: result.text,
      _usage: result.usage,
      _provider: result.provider,
    };
  } catch (err) {
    console.warn('continueWithResults failed:', err.message);
    throw err;
  }
}
```

**Step 3: Delete callAgentBrainAnthropic**

Remove the entire function (old lines 322-393). It's now handled by the fallback path in `callAgentBrain`.

**Step 4: Store system prompt in chat session for Anthropic continuation**

In `llm.js` `callWithTools`, for Anthropic, add `_system: systemPrompt` and `_model: model` to the chat session object so `continueChat` can use them. Update the Anthropic branch of `callWithTools`:

```js
chat: { _type: 'anthropic', _model: model, _system: systemPrompt, _messages: [{ role: 'user', content: message }], _response: response, _toolBlock: toolBlock },
```

**Step 5: Run tests**

Run: `npm test`
Expected: All existing tests pass

**Step 6: Commit**

```bash
git add src/brain-llm.js src/llm.js
git commit -m "refactor: wire callAgentBrain + continueWithResults through llm.js"
```

---

### Task 5: Wire brain-llm.js — brainCompose and welcomeCompose through llm.js

Replace raw Gemini/Anthropic SDK calls in `brainCompose` (lines 570-648) and `welcomeCompose` (lines 654-715) with `generate()` from `llm.js`.

**Files:**
- Modify: `src/brain-llm.js:570-648` (`brainCompose`)
- Modify: `src/brain-llm.js:654-715` (`welcomeCompose`)

**Step 1: Rewrite brainCompose**

```js
const { generate: llmGenerate } = require('./llm');

async function brainCompose(events, options = {}) {
  // ... (event list building stays the same — lines 571-601) ...

  try {
    const result = await llmGenerate(MODELS.compose, BRAIN_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 1024, temperature: 0.6, json: true, jsonSchema: BRAIN_COMPOSE_SCHEMA, timeout: 10_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: reconcilePicks(sms, parsed.picks || []), _raw: result.text, _usage: result.usage, _provider: result.provider };
  } catch (err) {
    console.warn(`brainCompose ${MODELS.compose} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    const result = await llmGenerate(MODELS.fallback, BRAIN_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 512, temperature: 0.6, json: true, timeout: 12_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: reconcilePicks(sms, parsed.picks || []), _raw: result.text, _usage: result.usage, _provider: result.provider };
  }
}
```

**Step 2: Rewrite welcomeCompose** (same pattern)

```js
async function welcomeCompose(events) {
  // ... (event lines building stays the same — lines 656-667) ...

  try {
    const result = await llmGenerate(MODELS.compose, WELCOME_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 1024, temperature: 0.7, json: true, jsonSchema: BRAIN_COMPOSE_SCHEMA, timeout: 10_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: parsed.picks || [], _raw: result.text, _usage: result.usage, _provider: result.provider };
  } catch (err) {
    console.warn(`welcomeCompose ${MODELS.compose} failed, falling back to ${MODELS.fallback}: ${err.message}`);
    const result = await llmGenerate(MODELS.fallback, WELCOME_COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 512, temperature: 0.7, json: true, timeout: 12_000,
    });
    const parsed = JSON.parse(stripCodeFences(result.text));
    const sms = smartTruncate(parsed.sms_text);
    return { sms_text: sms, picks: parsed.picks || [], _raw: result.text, _usage: result.usage, _provider: result.provider };
  }
}
```

**Step 3: Remove old SDK imports and duplicate helpers**

Remove from `brain-llm.js`:
- `const { GoogleGenerativeAI, ... } = require('@google/generative-ai');` (line 5)
- `getGeminiClient()` function (lines 15-23)
- `GEMINI_SAFETY` constant (lines 25-30)
- `extractGeminiUsage()` function (lines 313-319)
- `withTimeout()` function (lines 223-228)

These all live in `llm.js` now. Re-export from `llm.js` if needed by other modules.

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/brain-llm.js
git commit -m "refactor: wire brainCompose + welcomeCompose through llm.js"
```

---

### Task 6: Wire ai.js through llm.js

Replace raw Gemini/Anthropic SDK calls in `extractEvents` and `composeDetails` with `generate()` from `llm.js`.

**Files:**
- Modify: `src/ai.js`

**Step 1: Rewrite extractEvents**

The current function has a complex Gemini → flash-lite fallback → Haiku chain. Simplify to: primary model → fallback model.

```js
const { generate: llmGenerate } = require('./llm');
const { MODELS } = require('./model-config');

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
    : Array.isArray(parsed) ? parsed : [];
  return { events, _usage: usage || null, _provider: provider };
}
```

**Step 2: Rewrite composeDetails**

```js
async function composeDetails(event, pickReason, { pulseUrl, skipGemini } = {}) {
  // ... (URL building stays the same — lines 289-331) ...

  const resolvedModel = skipGemini ? MODELS.fallback : MODELS.details;

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
    smsText = parsed.sms_text || parsed.text || parsed.message || text;
  } catch {
    smsText = text.replace(/^["']|["']$/g, '').trim();
  }

  return { sms_text: smartTruncate(smsText), _raw: text, _usage: usage, _provider: provider };
}
```

**Step 3: Remove old SDK imports and helpers from ai.js**

Remove:
- `const Anthropic = require('@anthropic-ai/sdk');` (line 1)
- `const { GoogleGenerativeAI, ... }` (line 2)
- `getClient()` (lines 7-10)
- `withTimeout()` (lines 12-17)
- `getGeminiClient()` (lines 19-27)
- `MODELS` (lines 29-32) — now in model-config.js
- `GEMINI_FALLBACK`, `isQuotaError`, `checkGeminiFinish`, `GEMINI_SAFETY` (lines 34-57)
- `extractWithGemini()` (lines 63-86)
- `detailsWithGemini()` (lines 91-114)

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/ai.js
git commit -m "refactor: wire extractEvents + composeDetails through llm.js"
```

---

### Task 7: Clean up exports and update agent-brain.js imports

`agent-brain.js` re-exports many things from `brain-llm.js` that no longer exist there (like `GEMINI_SAFETY`, `getGeminiClient`, `withTimeout`, `extractGeminiUsage`). Update imports.

**Files:**
- Modify: `src/agent-brain.js:24-30` (update imports from brain-llm)
- Modify: `src/brain-llm.js` (update module.exports)

**Step 1: Update agent-brain.js imports**

```js
// Replace lines 24-30
const {
  callAgentBrain, continueWithResults, serializePoolForContinuation,
  brainCompose, welcomeCompose, buildBrainSystemPrompt,
  BRAIN_COMPOSE_SYSTEM, BRAIN_COMPOSE_SCHEMA,
  WELCOME_COMPOSE_SYSTEM, stripCodeFences, reconcilePicks, BRAIN_TOOLS,
} = require('./brain-llm');
```

Remove references to deleted exports: `GEMINI_SAFETY`, `getGeminiClient`, `withTimeout`, `extractGeminiUsage`, `callAgentBrainAnthropic`.

**Step 2: Update brain-llm.js exports**

```js
module.exports = {
  BRAIN_TOOLS,
  buildBrainSystemPrompt,
  callAgentBrain, continueWithResults, serializePoolForContinuation,
  brainCompose, welcomeCompose,
  stripCodeFences, reconcilePicks,
  BRAIN_COMPOSE_SYSTEM, BRAIN_COMPOSE_SCHEMA, WELCOME_COMPOSE_SYSTEM,
};
```

**Step 3: Check for other consumers**

Check if any other file imports the deleted exports. Key ones:
- `brain-execute.js:15` imports `brainCompose, welcomeCompose` — still exported, no change needed.
- `src/evals/` and `scripts/` — may reference old `MODELS` from `ai.js`. If so, update to import from `model-config.js`.

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/agent-brain.js src/brain-llm.js
git commit -m "refactor: clean up exports after llm.js migration"
```

---

### Task 8: Update .env.example and CLAUDE.md

Document the new env vars and config system.

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

**Step 1: Add new env vars to .env.example**

```
# LLM Model Config (all optional — defaults in src/model-config.js)
# Provider auto-detected from prefix: gemini-* → Gemini, claude-* → Anthropic
# PULSE_MODEL_BRAIN=gemini-2.5-flash-lite      # Agent brain (tool calling)
# PULSE_MODEL_COMPOSE=gemini-2.5-flash-lite     # SMS composition (brainCompose, welcomeCompose)
# PULSE_MODEL_EXTRACT=gemini-2.5-flash           # Event extraction (scrape-time)
# PULSE_MODEL_DETAILS=gemini-2.5-flash            # Event detail composition
# PULSE_MODEL_FALLBACK=claude-haiku-4-5-20251001  # Fallback for all roles
```

**Step 2: Update CLAUDE.md**

In the "Env Vars" section, replace the old `PULSE_MODEL_COMPOSE`, `PULSE_MODEL_EXTRACT` entries with the new config. In the architecture section, add `model-config.js` and `llm.js` to the key modules table.

**Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document LLM model config env vars"
```

---

### Task 9: Smoke test — swap brain to Anthropic

End-to-end verification that the abstraction actually works.

**Step 1: Set env var**

```bash
PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001
```

**Step 2: Start test server**

```bash
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001 node src/server.js
```

**Step 3: Send test message**

```bash
curl -X POST http://localhost:3000/api/sms/test -H 'Content-Type: application/json' -d '{"Body": "williamsburg"}'
```

Expected: Valid SMS response with event picks. Trace should show `provider: "anthropic"` for brain, continuation should work via Anthropic tool_result flow.

**Step 4: Test with Gemini default**

```bash
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js
```

Send same request. Expected: Same behavior, `provider: "gemini"`.

**Step 5: Run eval suite**

```bash
PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001 npm run eval:quality
```

Compare scores with Gemini default to validate parity.

---

## Summary of changes

| File | Action | What |
|------|--------|------|
| `src/model-config.js` | Create | Central model config, env var overrides, provider detection |
| `src/llm.js` | Create | Provider-agnostic: generate(), callWithTools(), continueChat() |
| `src/brain-llm.js` | Modify | Wire through llm.js, neutral tool format, delete raw SDK calls |
| `src/ai.js` | Modify | Wire through llm.js, delete raw SDK calls |
| `src/agent-brain.js` | Modify | Update imports |
| `test/unit/model-config.test.js` | Create | Config + provider detection tests |
| `test/unit/llm.test.js` | Create | Tool format conversion tests |
| `.env.example` | Modify | Document new env vars |
| `CLAUDE.md` | Modify | Document new modules |

**After this work:** To switch the entire system to Anthropic, set 4 env vars:
```
PULSE_MODEL_BRAIN=claude-haiku-4-5-20251001
PULSE_MODEL_COMPOSE=claude-haiku-4-5-20251001
PULSE_MODEL_EXTRACT=claude-haiku-4-5-20251001
PULSE_MODEL_DETAILS=claude-haiku-4-5-20251001
```

Or mix and match: brain on Claude, extraction on Gemini, etc.
