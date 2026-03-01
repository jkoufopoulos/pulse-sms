const { check } = require('../helpers');
const { scoreComplexity, routeModel } = require('../../src/model-router');

console.log('\nscoreComplexity:');

// Simple neighborhood request — low score
check('simple hood → low score', scoreComplexity({
  message: 'williamsburg',
  session: { lastNeighborhood: 'Williamsburg' },
  matchCount: 0, hardCount: 0, softCount: 0,
  isSparse: false, hood: 'Williamsburg',
  activeFilters: {}, events: Array(10).fill({}),
  conversationHistory: [], isCitywide: false,
}) < 40);

// Zero matches + compound filters → high score
check('zero matches + compound filters → high score', scoreComplexity({
  message: 'free outdoor jazz near the park tonight',
  session: { lastNeighborhood: 'Prospect Heights' },
  matchCount: 0, hardCount: 0, softCount: 0,
  isSparse: false, hood: 'Prospect Heights',
  activeFilters: { free_only: true, category: 'live_music', subcategory: 'jazz' },
  events: Array(10).fill({}),
  conversationHistory: [{ role: 'user', content: 'hi' }],
  isCitywide: false,
}) >= 40);

// Active filters with zero hard + zero soft → +30
check('active filter + zero matches → +30 base', (() => {
  const score = scoreComplexity({
    message: 'ok',
    session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo',
    activeFilters: { category: 'comedy' },
    events: Array(10).fill({}),
    conversationHistory: [], isCitywide: false,
  });
  return score >= 30;
})());

// Active filters with zero hard but has soft → +15
check('zero hard + soft matches → +15 base', (() => {
  const score = scoreComplexity({
    message: 'ok',
    session: { lastNeighborhood: 'SoHo' },
    matchCount: 3, hardCount: 0, softCount: 3,
    isSparse: false, hood: 'SoHo',
    activeFilters: { category: 'comedy' },
    events: Array(10).fill({}),
    conversationHistory: [], isCitywide: false,
  });
  return score >= 15 && score < 30;
})());

// isSparse → +10
check('isSparse adds 10', (() => {
  const base = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 2, hardCount: 2, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: { category: 'comedy' },
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  const withSparse = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 2, hardCount: 2, softCount: 0,
    isSparse: true, hood: 'SoHo', activeFilters: { category: 'comedy' },
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  return withSparse - base === 10;
})());

// No events at all → +25
check('no events → +25', (() => {
  const score = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: [], conversationHistory: [], isCitywide: false,
  });
  return score >= 25;
})());

// Small pool < 5 → +10
check('small pool < 5 → +10', (() => {
  const base = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  const small = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(4).fill({}), conversationHistory: [], isCitywide: false,
  });
  return small - base === 10;
})());

// Deep conversation (8+ turns) → +10
check('deep conversation → +10', (() => {
  const base = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  const deep = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}),
    conversationHistory: Array(8).fill({ role: 'user', content: 'x' }),
    isCitywide: false,
  });
  return deep - base === 10;
})());

// Long message > 80 → +10
check('long message → +10', (() => {
  const short = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  const long = scoreComplexity({
    message: 'x'.repeat(81), session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  return long - short === 10;
})());

// Score caps at 100
check('score caps at 100', (() => {
  const score = scoreComplexity({
    message: 'x'.repeat(100),
    session: {},
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: true,
    hood: null,
    activeFilters: { free_only: true, category: 'comedy', time_after: '22:00' },
    events: [],
    conversationHistory: Array(10).fill({ role: 'user', content: 'x' }),
    isCitywide: false,
  });
  return score === 100;
})());

// Empty/missing fields don't crash
check('empty ctx → no crash', (() => {
  try {
    const score = scoreComplexity({});
    return typeof score === 'number' && score >= 0;
  } catch { return false; }
})());

check('no args → no crash', (() => {
  try {
    const score = scoreComplexity({});
    return typeof score === 'number';
  } catch { return false; }
})());

// ---- routeModel ----
console.log('\nrouteModel:');

// Simple → Flash
check('simple request → Flash', (() => {
  const result = routeModel({
    message: 'williamsburg',
    session: { lastNeighborhood: 'Williamsburg' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'Williamsburg',
    activeFilters: {}, events: Array(10).fill({}),
    conversationHistory: [], isCitywide: false,
    budgetUsedPct: 0,
  });
  return result.tier === 'flash' && result.model === 'gemini-2.5-flash';
})());

// Complex → Haiku
check('complex request → Haiku', (() => {
  const result = routeModel({
    message: 'free outdoor jazz near the park tonight',
    session: {},
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: null,
    activeFilters: { free_only: true, category: 'live_music', subcategory: 'jazz' },
    events: [], conversationHistory: Array(5).fill({ role: 'user', content: 'x' }),
    isCitywide: false, budgetUsedPct: 0,
  });
  return result.tier === 'haiku' && result.model === 'claude-haiku-4-5-20251001';
})());

// Budget downgrade at 70%+
check('budget downgrade → Flash even when complex', (() => {
  const result = routeModel({
    message: 'free outdoor jazz near the park tonight',
    session: {},
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: null,
    activeFilters: { free_only: true, category: 'live_music', subcategory: 'jazz' },
    events: [], conversationHistory: Array(5).fill({ role: 'user', content: 'x' }),
    isCitywide: false, budgetUsedPct: 0.75,
  });
  return result.tier === 'flash' && result.reason.includes('downgraded');
})());

// Budget at exactly 70% does NOT downgrade (only >70%)
check('budget at 70% → no downgrade', (() => {
  const result = routeModel({
    message: 'free outdoor jazz near the park tonight',
    session: {},
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: null,
    activeFilters: { free_only: true, category: 'live_music', subcategory: 'jazz' },
    events: [], conversationHistory: Array(5).fill({ role: 'user', content: 'x' }),
    isCitywide: false, budgetUsedPct: 0.70,
  });
  return result.tier === 'haiku';
})());

// PULSE_MODEL_OVERRIDE
check('PULSE_MODEL_OVERRIDE forces model', (() => {
  // Save and set env
  const orig = process.env.PULSE_MODEL_OVERRIDE;
  process.env.PULSE_MODEL_OVERRIDE = 'gemini-2.5-flash';
  // Re-require to pick up env change
  delete require.cache[require.resolve('../../src/model-router')];
  const { routeModel: rm } = require('../../src/model-router');
  const result = rm({
    message: 'free outdoor jazz near the park tonight',
    session: {},
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: null,
    activeFilters: { free_only: true, category: 'live_music', subcategory: 'jazz' },
    events: [], conversationHistory: Array(5).fill({ role: 'user', content: 'x' }),
    isCitywide: false, budgetUsedPct: 0,
  });
  // Restore
  if (orig === undefined) delete process.env.PULSE_MODEL_OVERRIDE;
  else process.env.PULSE_MODEL_OVERRIDE = orig;
  delete require.cache[require.resolve('../../src/model-router')];
  return result.tier === 'override' && result.model === 'gemini-2.5-flash';
})());

// Return shape
check('routeModel returns all fields', (() => {
  const result = routeModel({
    message: 'les', session: {}, matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'Lower East Side', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  return typeof result.model === 'string' &&
    typeof result.provider === 'string' &&
    typeof result.tier === 'string' &&
    typeof result.score === 'number' &&
    typeof result.reason === 'string';
})());

// First message bonus
check('first message (no lastNeighborhood) → +5', (() => {
  const withLast = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  const noLast = scoreComplexity({
    message: 'ok', session: {},
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  return noLast - withLast === 5;
})());

// Citywide bonus
check('citywide → +5', (() => {
  const base = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: false,
  });
  const cw = scoreComplexity({
    message: 'ok', session: { lastNeighborhood: 'SoHo' },
    matchCount: 0, hardCount: 0, softCount: 0,
    isSparse: false, hood: 'SoHo', activeFilters: {},
    events: Array(10).fill({}), conversationHistory: [], isCitywide: true,
  });
  return cw - base === 5;
})());
