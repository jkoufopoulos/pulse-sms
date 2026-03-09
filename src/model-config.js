/**
 * model-config.js — Single source of truth for all LLM model choices.
 *
 * Change a model name here (or via env var) and the provider switches automatically.
 * Provider is detected from the model name prefix: "gemini-*" → Gemini, "claude-*" → Anthropic.
 */

const MODELS = {
  brain:    process.env.PULSE_MODEL_BRAIN    || 'claude-haiku-4-5-20251001', // tool calling + SMS composition
  extract:  process.env.PULSE_MODEL_EXTRACT  || 'claude-haiku-4-5-20251001', // event extraction — Claude excels at structured XML
  details:  process.env.PULSE_MODEL_DETAILS  || 'gemini-2.5-flash',         // detail composition — used by ai.js composeDetails
  fallback: process.env.PULSE_MODEL_FALLBACK || 'gemini-2.5-flash',          // fallback — different provider for resilience
};

function getProvider(modelName) {
  if (modelName.startsWith('gemini-')) return 'gemini';
  if (modelName.startsWith('claude-')) return 'anthropic';
  throw new Error(`Unknown provider for model: ${modelName}`);
}

module.exports = { MODELS, getProvider };
