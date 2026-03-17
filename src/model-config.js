/**
 * model-config.js — Single source of truth for all LLM model choices.
 *
 * Change a model name here (or via env var) and the provider switches automatically.
 * Provider is detected from the model name prefix: "gemini-*" → Gemini, "claude-*" → Anthropic.
 */

const MODELS = {
  brain:    process.env.PULSE_MODEL_BRAIN    || 'gemini-2.5-flash',           // tool calling + SMS composition — Gemini stateful chat = system prompt sent once
  extract:  process.env.PULSE_MODEL_EXTRACT  || 'gemini-2.5-flash',          // event extraction — Gemini while Claude rate-limited
  eval:     process.env.PULSE_MODEL_EVAL     || 'gemini-2.5-flash',          // evals and quality scoring
  fallback: process.env.PULSE_MODEL_FALLBACK || 'gemini-2.5-flash',          // fallback — different provider for resilience
};

function getProvider(modelName) {
  if (modelName.startsWith('gemini-')) return 'gemini';
  if (modelName.startsWith('claude-')) return 'anthropic';
  throw new Error(`Unknown provider for model: ${modelName}`);
}

module.exports = { MODELS, getProvider };
