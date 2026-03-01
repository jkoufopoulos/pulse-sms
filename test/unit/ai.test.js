const { check } = require('../helpers');

// ---- AI unified output shape contracts (executeQuery / unifiedRespond) ----
console.log('\nAI contracts (unifiedRespond shape):');

const validUnifiedOutput = {
  type: 'event_picks',
  sms_text: 'DJ Night at Output (Williamsburg) 9 PM — $20. Sick lineup tonight.\nAlso: Jazz at Smalls 8 PM\nReply DETAILS, MORE, or FREE.',
  picks: [{ rank: 1, event_id: 'abc123', why: 'tonight + in neighborhood' }, { rank: 2, event_id: 'def456', why: 'great lineup' }],
  clear_filters: false,
  filter_intent: { action: 'none' },
};

check('unifiedRespond has type', typeof validUnifiedOutput.type === 'string');
check('unifiedRespond type is valid', ['event_picks', 'conversational', 'ask_neighborhood'].includes(validUnifiedOutput.type));
check('unifiedRespond has sms_text', typeof validUnifiedOutput.sms_text === 'string');
check('unifiedRespond sms_text <= 480 chars', validUnifiedOutput.sms_text.length <= 480);
check('unifiedRespond has picks array', Array.isArray(validUnifiedOutput.picks));
check('unifiedRespond picks have event_id', validUnifiedOutput.picks.every(p => typeof p.event_id === 'string'));
check('unifiedRespond picks have rank', validUnifiedOutput.picks.every(p => typeof p.rank === 'number'));
check('unifiedRespond picks have why', validUnifiedOutput.picks.every(p => typeof p.why === 'string'));
check('unifiedRespond has clear_filters', typeof validUnifiedOutput.clear_filters === 'boolean');
check('unifiedRespond has filter_intent', typeof validUnifiedOutput.filter_intent === 'object');
check('unifiedRespond filter_intent has action', typeof validUnifiedOutput.filter_intent.action === 'string');
check('unifiedRespond filter_intent action valid', ['none', 'clear_all', 'modify'].includes(validUnifiedOutput.filter_intent.action));

// Edge case: empty picks is valid (quiet night)
const emptyOutput = {
  type: 'conversational',
  sms_text: "Quiet night in Bushwick. Try Williamsburg or East Village.",
  picks: [],
  clear_filters: false,
};
check('allows empty picks', Array.isArray(emptyOutput.picks) && emptyOutput.picks.length === 0);
check('empty still has sms_text', typeof emptyOutput.sms_text === 'string' && emptyOutput.sms_text.length > 0);

// ask_neighborhood type
const askHoodOutput = {
  type: 'ask_neighborhood',
  sms_text: "Where are you looking? I can check for free jazz in any neighborhood.",
  picks: [],
};
check('ask_neighborhood type valid', askHoodOutput.type === 'ask_neighborhood');
check('ask_neighborhood has empty picks', askHoodOutput.picks.length === 0);

// ---- parseJsonFromResponse ----
console.log('\nparseJsonFromResponse:');
const { parseJsonFromResponse } = require('../../src/ai');

// Fenced JSON
const fenced = '```json\n{"sms_text": "Tonight!", "picks": []}\n```';
check('fenced JSON parses', parseJsonFromResponse(fenced)?.sms_text === 'Tonight!');

// Bare JSON with } inside string value
const tricky = '{"sms_text": "Event at Venue} tonight", "picks": []}';
const trickyParsed = parseJsonFromResponse(tricky);
check('} inside string: parses correctly', trickyParsed?.sms_text === 'Event at Venue} tonight');
check('} inside string: picks array intact', Array.isArray(trickyParsed?.picks));

// No JSON at all
check('no JSON returns null', parseJsonFromResponse('just some text') === null);

// JSON with surrounding text
const wrapped = 'Here is the result: {"intent": "events", "neighborhood": "Bushwick"} done.';
check('JSON with surrounding text', parseJsonFromResponse(wrapped)?.intent === 'events');
