const { check } = require('../helpers');

// --- Mock LLM at module cache level BEFORE agent-loop loads ---
// We need to intercept require('./llm') so agent-loop gets our mock.
const path = require('path');
const llmPath = require.resolve('../../src/llm');

// Save original and replace with mock
const originalModule = require.cache[llmPath];
let mockGenerateFn = async () => ({ text: '', usage: {}, provider: 'mock' });

// Create mock module that delegates generate to our swappable fn
const mockLlm = {
  ...require('../../src/llm'),
  generate: async (...args) => mockGenerateFn(...args),
};

// Patch the exports object in place so destructured imports pick it up
const llm = require('../../src/llm');
const originalGenerate = llm.generate;

// We need a different approach: patch generate on the llm module exports
// Since agent-loop destructures, we must clear the cache and re-require
delete require.cache[require.resolve('../../src/agent-loop')];
delete require.cache[llmPath];

// Replace llm module with a proxy
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: new Proxy(mockLlm, {
    get(target, prop) {
      if (prop === 'generate') return (...args) => mockGenerateFn(...args);
      return target[prop];
    }
  }),
};

const { rewriteIfTooLong, SMS_CHAR_LIMIT } = require('../../src/agent-loop');

function setMockGenerate(text) {
  mockGenerateFn = async () => ({ text, usage: {}, provider: 'mock' });
}

function setMockGenerateError(msg) {
  mockGenerateFn = async () => { throw new Error(msg); };
}

console.log('\nrewriteIfTooLong:');

const SHORT_SMS = 'Bushwick tonight — noise show at Alphaville, vinyl DJ at Mood Ring. Which vibe?';
const LONG_SMS = 'X'.repeat(600);
const VENUE_NAMES = ['Alphaville', 'Mood Ring', 'House of Yes'];
const LONG_WITH_VENUES = `Tonight in Bushwick! First up, Alphaville has a one-off noise show — tiny room, gonna be loud and weird in the best way. If you want something mellower, Mood Ring has a vinyl DJ set, no cover, great sound system. Or if you're feeling wild, House of Yes has an immersive dance party with costumes encouraged. ${'Each of these spots has its own unique vibe and the crowds are always interesting. '.repeat(3)}Which sounds like your night?`;

(async () => {
  // Short SMS passes through unchanged
  setMockGenerate('should not be called');
  const short = await rewriteIfTooLong(SHORT_SMS, { composition: {} });
  check('short SMS (<480) passes through unchanged', short === SHORT_SMS);

  // null/empty passes through
  check('null passes through', (await rewriteIfTooLong(null, { composition: {} })) === null);
  check('empty string passes through', (await rewriteIfTooLong('', { composition: {} })) === '');

  // Long SMS gets rewritten to under 480
  const rewritten = 'Bushwick tonight — noise show at Alphaville, vinyl DJ at Mood Ring. Which vibe?';
  setMockGenerate(rewritten);
  const result = await rewriteIfTooLong(LONG_SMS, { composition: {} });
  check('long SMS gets rewritten', result === rewritten);
  check('rewritten SMS is under 480 chars', result.length <= SMS_CHAR_LIMIT);

  // Rewrite preserves event/venue names
  const rewrittenWithVenues = 'Bushwick — noise show at Alphaville, vinyl DJ at Mood Ring, or dance at House of Yes. Pick one!';
  setMockGenerate(rewrittenWithVenues);
  const venueResult = await rewriteIfTooLong(LONG_WITH_VENUES, { composition: {} });
  for (const venue of VENUE_NAMES) {
    check(`rewrite preserves venue name: ${venue}`, venueResult.includes(venue));
  }

  // Trace records rewrite metadata
  const traceObj = { composition: {} };
  setMockGenerate('Short version here, about 60 characters of valid content ok.');
  await rewriteIfTooLong(LONG_SMS, traceObj);
  check('trace records rewrite from', traceObj.composition.rewrite?.from === 600);
  check('trace records rewrite to', typeof traceObj.composition.rewrite?.to === 'number' && traceObj.composition.rewrite.to < 480);

  // If rewrite still exceeds limit, returns original
  setMockGenerate('Y'.repeat(500));
  const stillLong = await rewriteIfTooLong(LONG_SMS, { composition: {} });
  check('rewrite exceeding limit returns original', stillLong === LONG_SMS);

  // If rewrite is too short (<50 chars), returns original
  setMockGenerate('Too short');
  const tooShort = await rewriteIfTooLong(LONG_SMS, { composition: {} });
  check('rewrite too short returns original', tooShort === LONG_SMS);

  // LLM error falls through gracefully
  setMockGenerateError('API timeout');
  const errorResult = await rewriteIfTooLong(LONG_SMS, { composition: {} });
  check('LLM error returns original SMS', errorResult === LONG_SMS);

  // SMS_CHAR_LIMIT is 480
  check('SMS_CHAR_LIMIT is 480', SMS_CHAR_LIMIT === 480);

  // Restore module cache
  delete require.cache[llmPath];
  delete require.cache[require.resolve('../../src/agent-loop')];
})();
