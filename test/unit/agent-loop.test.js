const { check } = require('../helpers');
const { sanitizeForLLM, extractPicksFromSms, deriveIntent, validateComposeSms } = require('../../src/agent-loop');

// ---- sanitizeForLLM ----
console.log('\nsanitizeForLLM:');

check('strips _ prefixed keys', JSON.stringify(sanitizeForLLM({ foo: 1, _bar: 2 })) === '{"foo":1}');
check('passes through clean objects', JSON.stringify(sanitizeForLLM({ a: 1, b: 2 })) === '{"a":1,"b":2}');
check('handles null', sanitizeForLLM(null) === null);
check('handles undefined', sanitizeForLLM(undefined) === undefined);
check('handles arrays (pass through)', Array.isArray(sanitizeForLLM([1, 2, 3])));

// ---- extractPicksFromSms ----
console.log('\nextractPicksFromSms:');

const testEvents = [
  { id: 'e1', name: 'Jazz Night at Blue Note', venue_name: 'Blue Note' },
  { id: 'e2', name: 'Comedy Hour', venue_name: 'Tiny Cupboard' },
  { id: 'e3', name: 'Art Opening', venue_name: 'Pioneer Works' },
];

const sms1 = 'Check out Jazz Night at Blue Note and Comedy Hour at Tiny Cupboard tonight!';
const picks1 = extractPicksFromSms(sms1, testEvents);
check('finds 2 events in SMS', picks1.length === 2);
check('first pick is e1', picks1[0].event_id === 'e1');
check('second pick is e2', picks1[1].event_id === 'e2');
check('ranks are sequential', picks1[0].rank === 1 && picks1[1].rank === 2);

check('empty SMS returns empty', extractPicksFromSms('', testEvents).length === 0);
check('null SMS returns empty', extractPicksFromSms(null, testEvents).length === 0);
check('no matching events returns empty', extractPicksFromSms('Nothing here', testEvents).length === 0);

const sms2 = 'Blue Note has Jazz Night at Blue Note tonight';
const picks2 = extractPicksFromSms(sms2, testEvents);
check('no duplicate picks', picks2.length === 1);

// ---- deriveIntent ----
console.log('\nderiveIntent:');

check('no tool calls -> conversational', deriveIntent([]) === 'conversational');
check('null -> conversational', deriveIntent(null) === 'conversational');
check('respond -> conversational', deriveIntent([{ name: 'respond', params: { intent: 'greeting' } }]) === 'conversational');
check('search new_search -> events', deriveIntent([{ name: 'search_events', params: { intent: 'new_search' } }]) === 'events');
check('search details -> details', deriveIntent([{ name: 'search_events', params: { intent: 'details' } }]) === 'details');
check('search more -> more', deriveIntent([{ name: 'search_events', params: { intent: 'more' } }]) === 'more');
check('search refine -> events', deriveIntent([{ name: 'search_events', params: { intent: 'refine' } }]) === 'events');
check('multi-call: last search wins', deriveIntent([
  { name: 'search_events', params: { intent: 'new_search' } },
  { name: 'search_events', params: { intent: 'refine' } },
]) === 'events');

// ---- show_welcome in BRAIN_TOOLS ----
console.log('\nshow_welcome tool:');

const { BRAIN_TOOLS } = require('../../src/brain-llm');
const welcomeTool = BRAIN_TOOLS.find(t => t.name === 'show_welcome');
check('show_welcome tool exists in BRAIN_TOOLS', !!welcomeTool);
check('show_welcome has no required params', !welcomeTool.parameters.required || welcomeTool.parameters.required.length === 0);

// ---- buildBrainSystemPrompt first-session indicator ----
console.log('\nbuildBrainSystemPrompt first-session:');

const { buildBrainSystemPrompt } = require('../../src/brain-llm');

const freshSession = {};
const freshPrompt = buildBrainSystemPrompt(freshSession);
check('fresh session prompt contains first-message indicator', freshPrompt.includes('First message — new session'));

const returningSession = { conversationHistory: [{ role: 'user', content: 'hey' }], lastNeighborhood: 'bushwick' };
const returningPrompt = buildBrainSystemPrompt(returningSession);
check('returning session prompt does NOT contain first-message indicator', !returningPrompt.includes('First message — new session'));

// ---- deriveIntent with show_welcome ----
console.log('\nderiveIntent with show_welcome:');

check('show_welcome -> welcome', deriveIntent([{ name: 'show_welcome', params: {} }]) === 'welcome');
check('show_welcome + respond -> welcome (welcome wins)', deriveIntent([
  { name: 'show_welcome', params: {} },
  { name: 'respond', params: { intent: 'greeting' } },
]) === 'welcome');

// ---- validateComposeSms ----
console.log('\nvalidateComposeSms:');

const goodPool = [
  { id: 'e1', name: 'Jazz Night', venue_name: 'Blue Note', neighborhood: 'Greenwich Village', start_time_local: '2026-03-07T22:00:00' },
  { id: 'e2', name: 'Comedy Hour', venue_name: 'Tiny Cupboard', neighborhood: 'LES', start_time_local: '2026-03-07T21:00:00' },
  { id: 'e3', name: 'Art Opening', venue_name: 'Pioneer Works', neighborhood: 'Red Hook', start_time_local: '2026-03-07T19:00:00' },
];

const good = validateComposeSms('Tonight:\n\nJazz Night — Blue Note, 10pm\nComedy Hour — Tiny Cupboard, 9pm', ['e1', 'e2'], goodPool);
check('valid SMS passes through', good.smsText.includes('Jazz Night'));
check('valid SMS not rebuilt', good.rebuilt === false);

const rebuilt = validateComposeSms('x'.repeat(500), ['e1', 'e2', 'e3'], goodPool);
check('over 480 triggers rebuild', rebuilt.rebuilt === true);

check('>3 picks triggers rebuild', validateComposeSms('picks', ['e1','e2','e3','e4'], goodPool).rebuilt === true);
check('0 picks triggers rebuild', validateComposeSms('no picks', [], goodPool).rebuilt === true);
