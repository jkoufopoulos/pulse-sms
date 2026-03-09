const { check } = require('../helpers');

console.log('\nmodel-config:');

// Save and clear env vars for clean test
const savedEnv = {};
['PULSE_MODEL_BRAIN', 'PULSE_MODEL_EXTRACT', 'PULSE_MODEL_DETAILS', 'PULSE_MODEL_FALLBACK'].forEach(k => {
  savedEnv[k] = process.env[k];
  delete process.env[k];
});

// Re-require to pick up clean env
delete require.cache[require.resolve('../../src/model-config')];
const { MODELS, getProvider } = require('../../src/model-config');

// Defaults — verify they match what's in model-config.js
check('brain defaults to claude-haiku-4-5-20251001', MODELS.brain === 'claude-haiku-4-5-20251001');
check('extract defaults to claude-haiku-4-5-20251001', MODELS.extract === 'claude-haiku-4-5-20251001');
check('details defaults to gemini-2.5-flash', MODELS.details === 'gemini-2.5-flash');
check('fallback defaults to gemini-2.5-flash', MODELS.fallback === 'gemini-2.5-flash');

// Provider detection
check('gemini-2.5-flash → gemini', getProvider('gemini-2.5-flash') === 'gemini');
check('gemini-2.5-flash-lite → gemini', getProvider('gemini-2.5-flash-lite') === 'gemini');
check('claude-haiku-4-5-20251001 → anthropic', getProvider('claude-haiku-4-5-20251001') === 'anthropic');
check('claude-sonnet-4-20250514 → anthropic', getProvider('claude-sonnet-4-20250514') === 'anthropic');

// Unknown provider throws
let threw = false;
try { getProvider('gpt-4'); } catch { threw = true; }
check('unknown model throws', threw);

// Restore env
Object.entries(savedEnv).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; else delete process.env[k]; });
