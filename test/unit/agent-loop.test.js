const { check } = require('../helpers');
const { sanitizeForLLM, extractPicksFromSms, deriveIntent } = require('../../src/agent-loop');

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
