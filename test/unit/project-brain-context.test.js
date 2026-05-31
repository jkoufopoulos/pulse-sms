// Tests for projectBrainContext / buildStateBlock / projectRecentTurns
// — the lean prompt projection path gated by PULSE_BRAIN_PROJECT=true.

const {
  projectRecentTurns,
  buildStateBlock,
  projectBrainContext,
  buildBrainSystemPromptLean,
  buildBrainSystemPrompt,
} = require('../../src/brain-llm');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); passed++; }
  else { console.log(`  FAIL ${name}`); failed++; }
}

// ---------------------------------------------------------------------------
console.log('\nprojectRecentTurns:');
// ---------------------------------------------------------------------------

check('empty history → []', projectRecentTurns([]).length === 0);
check('null history → []', projectRecentTurns(null).length === 0);
check('undefined history → []', projectRecentTurns(undefined).length === 0);
check('tailTurns=0 → []',
  projectRecentTurns([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }], 0).length === 0);

// Strip tool_call and search_summary noise
const noisyHistory = [
  { role: 'user', content: 'bushwick' },
  { role: 'tool_call', meta: { name: 'search', params: { neighborhood: 'bushwick' } } },
  { role: 'search_summary', meta: { match_count: 3, neighborhood: 'bushwick' } },
  { role: 'assistant', content: 'Two picks: 1) Union Pool 2) Trash Bar' },
];
const stripped = projectRecentTurns(noisyHistory, 2);
check('strips tool_call entries', !stripped.some(m => m.content.includes('search(')));
check('strips search_summary entries', !stripped.some(m => /match_count|\[3 events/.test(m.content)));
check('keeps user + assistant turns', stripped.length === 2);
check('first is user', stripped[0].role === 'user');
check('last is assistant', stripped[stripped.length - 1].role === 'assistant');
check('preserves user content', stripped[0].content === 'bushwick');
check('preserves assistant content', stripped[1].content.includes('Union Pool'));

// tail slicing on a longer history
const longHistory = [
  { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3' },
];
const tail2 = projectRecentTurns(longHistory, 2);
check('tailTurns=2 returns 4 messages', tail2.length === 4);
check('tailTurns=2 starts at u2', tail2[0].content === 'u2');
check('tailTurns=2 ends at a3', tail2[3].content === 'a3');

const tail1 = projectRecentTurns(longHistory, 1);
check('tailTurns=1 returns 2 messages', tail1.length === 2);
check('tailTurns=1 starts at u3', tail1[0].content === 'u3');
check('tailTurns=1 ends at a3', tail1[1].content === 'a3');

// Trailing user (assistant response not yet stored)
const userTrailing = [
  { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2-unanswered' },
];
const trimmed = projectRecentTurns(userTrailing, 2);
check('trims trailing user-only', trimmed[trimmed.length - 1].role === 'assistant');
check('trimmed length = 2', trimmed.length === 2);

// Adjacent same-role users (history truncation can produce this)
const doubledUsers = [
  { role: 'user', content: 'u1' },
  { role: 'user', content: 'u1-followup' },
  { role: 'assistant', content: 'a1' },
];
const dmerged = projectRecentTurns(doubledUsers, 2);
check('merges consecutive users into one turn', dmerged.length === 2);
check('merged content joins both user messages', dmerged[0].content.includes('u1') && dmerged[0].content.includes('u1-followup'));
check('alternation preserved', dmerged[0].role === 'user' && dmerged[1].role === 'assistant');

// ---------------------------------------------------------------------------
console.log('\nbuildStateBlock:');
// ---------------------------------------------------------------------------

check('null session → "No prior session."', buildStateBlock(null) === 'No prior session.');
check('undefined session → "No prior session."', buildStateBlock(undefined) === 'No prior session.');

const freshSession = { conversationHistory: [] };
check('fresh session → first-message indicator',
  buildStateBlock(freshSession).startsWith('First message'));

const fullSession = {
  conversationHistory: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }],
  lastNeighborhood: 'Bushwick',
  lastBorough: 'Brooklyn',
  lastFilters: { categories: ['comedy'], free_only: true, time_after: '22:00' },
  lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: {
    e1: { name: 'Union Pool standup', venue_name: 'Union Pool', category: 'comedy' },
    e2: { name: 'Trash Bar open mic', venue_name: 'Trash Bar', category: 'comedy' },
  },
  visitedHoods: ['LES', 'Bushwick'],
};
const block = buildStateBlock(fullSession);
check('renders neighborhood', block.includes('neighborhood: Bushwick'));
check('renders borough', block.includes('borough: Brooklyn'));
check('renders categories filter', block.includes('categories=comedy'));
check('renders free_only filter', /\bfree_only\b/.test(block));
check('renders time_after filter', block.includes('after=22:00'));
check('renders pick #1', block.includes('1) Union Pool standup @ Union Pool'));
check('renders pick #2', block.includes('2) Trash Bar open mic @ Trash Bar'));
check('renders already_explored', block.includes('already_explored: LES, Bushwick'));
check('does NOT include legacy prose "Current neighborhood:"',
  !block.includes('Current neighborhood:'));
check('does NOT include legacy "Active filters:" JSON dump',
  !block.includes('Active filters:'));

const placesSession = {
  conversationHistory: [{ role: 'user', content: 'hi' }],
  lastNeighborhood: 'LES',
  lastResultType: 'places',
  lastPlaces: [{ place_id: 'p1' }, { place_id: 'p2' }],
  lastPlaceMap: { p1: { name: "Mona's" }, p2: { name: 'Nublu' } },
};
const placeBlock = buildStateBlock(placesSession);
check('places: includes last_result_type marker', placeBlock.includes('last_result_type: places'));
check('places: renders place #1', placeBlock.includes("1) Mona's"));
check('places: renders place #2', placeBlock.includes('2) Nublu'));

const richSession = {
  conversationHistory: [{ role: 'user', content: 'hi' }],
  lastNeighborhood: 'Bushwick',
  allPicks: [
    { event_id: 'e1' }, { event_id: 'e2' }, { event_id: 'e3' }, { event_id: 'e4' }, { event_id: 'e5' },
  ],
  lastEvents: {
    e1: { category: 'comedy' }, e2: { category: 'jazz' }, e3: { category: 'comedy' },
    e4: { category: 'film' }, e5: { category: 'jazz' },
  },
};
const richBlock = buildStateBlock(richSession);
check('renders prior_interests when allPicks >= 5', richBlock.includes('prior_interests:'));
check('prior_interests is deduped',
  richBlock.includes('comedy') && richBlock.includes('jazz') && richBlock.includes('film'));

const thinSession = {
  conversationHistory: [{ role: 'user', content: 'hi' }],
  lastNeighborhood: 'Bushwick',
  allPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: { e1: { category: 'comedy' }, e2: { category: 'jazz' } },
};
check('does NOT render prior_interests when allPicks < 5',
  !buildStateBlock(thinSession).includes('prior_interests:'));

// ---------------------------------------------------------------------------
console.log('\nprojectBrainContext:');
// ---------------------------------------------------------------------------

const ctx = projectBrainContext(fullSession, { tailTurns: 2 });
check('returns systemPrompt string', typeof ctx.systemPrompt === 'string');
check('returns messages array', Array.isArray(ctx.messages));
check('systemPrompt is non-trivial (full prompt body)', ctx.systemPrompt.length > 1000);
check('systemPrompt embeds state block', ctx.systemPrompt.includes('neighborhood: Bushwick'));
check('systemPrompt does NOT embed legacy session prose',
  !ctx.systemPrompt.includes('Current neighborhood:'));
check('messages tail starts with user', ctx.messages[0]?.role === 'user');
check('messages tail ends with assistant', ctx.messages[ctx.messages.length - 1]?.role === 'assistant');

const defaultCtx = projectBrainContext(fullSession);
check('default tailTurns=2 (4 messages from 2 exchanges)', defaultCtx.messages.length === 2);

const haikuCtx = projectBrainContext(fullSession, { tailTurns: 1 });
check('tailTurns=1 returns 2 messages (1 exchange)', haikuCtx.messages.length === 2);

// ---------------------------------------------------------------------------
console.log('\nLegacy buildBrainSystemPrompt unchanged (regression guard):');
// ---------------------------------------------------------------------------

const legacy = buildBrainSystemPrompt(fullSession);
check('legacy still renders "Current neighborhood:"',
  legacy.includes('Current neighborhood: Bushwick'));
check('legacy still renders "Active filters:" JSON dump',
  legacy.includes('Active filters:'));
check('legacy still renders pick names in prose form',
  legacy.includes('"Union Pool standup" at Union Pool'));

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
