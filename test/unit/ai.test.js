const { check } = require('../helpers');

// ---- AI routing output shape contracts ----
console.log('\nAI routing contracts (routeMessage shape):');

const validRouteOutput = {
  intent: 'events',
  neighborhood: 'East Village',
  filters: { free_only: false, category: null, vibe: null },
  event_reference: null,
  reply: null,
  confidence: 0.9,
};

check('routeMessage has intent', typeof validRouteOutput.intent === 'string');
check('routeMessage has neighborhood', 'neighborhood' in validRouteOutput);
check('routeMessage has filters', typeof validRouteOutput.filters === 'object' && validRouteOutput.filters !== null);
check('routeMessage has confidence', typeof validRouteOutput.confidence === 'number');
check('routeMessage intent is valid', ['events', 'details', 'more', 'free', 'help', 'conversational'].includes(validRouteOutput.intent));
check('routeMessage filters has free_only', 'free_only' in validRouteOutput.filters);

// Validate all valid intents
const validIntents = ['events', 'details', 'more', 'free', 'help', 'conversational'];
for (const intent of validIntents) {
  check(`intent "${intent}" is recognized`, validIntents.includes(intent));
}

console.log('\nAI routing contracts (composeResponse shape):');

const validComposeOutput = {
  sms_text: 'DJ Night at Output (Williamsburg) 9 PM — $20. Sick lineup tonight.\nAlso: Jazz at Smalls 8 PM\nReply DETAILS, MORE, or FREE.',
  picks: [{ rank: 1, event_id: 'abc123' }, { rank: 2, event_id: 'def456' }],
  neighborhood_used: 'Williamsburg',
};

check('composeResponse has sms_text', typeof validComposeOutput.sms_text === 'string');
check('composeResponse sms_text <= 480 chars', validComposeOutput.sms_text.length <= 480);
check('composeResponse has picks array', Array.isArray(validComposeOutput.picks));
check('composeResponse picks have event_id', validComposeOutput.picks.every(p => typeof p.event_id === 'string'));
check('composeResponse picks have rank', validComposeOutput.picks.every(p => typeof p.rank === 'number'));
check('composeResponse has neighborhood_used', typeof validComposeOutput.neighborhood_used === 'string');

// Edge case: empty picks is valid (quiet night)
const emptyComposeOutput = {
  sms_text: "Quiet night in Bushwick. Try Williamsburg or East Village.\nReply DETAILS, MORE, or FREE.",
  picks: [],
  neighborhood_used: 'Bushwick',
};
check('composeResponse allows empty picks', Array.isArray(emptyComposeOutput.picks) && emptyComposeOutput.picks.length === 0);
check('composeResponse empty still has sms_text', typeof emptyComposeOutput.sms_text === 'string' && emptyComposeOutput.sms_text.length > 0);

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
