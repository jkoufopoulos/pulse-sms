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
