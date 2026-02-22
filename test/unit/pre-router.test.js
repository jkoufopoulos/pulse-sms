const { check } = require('../helpers');
const { preRoute, getAdjacentNeighborhoods } = require('../../src/pre-router');

// ---- preRoute ----
// After the "clean cut", the pre-router only handles mechanical shortcuts:
// help, numbers 1-5, more, event name match, greetings, thanks, bye, impatient follow-up.
// Everything semantic (neighborhoods, categories, time, vibes, free, nudge, boroughs,
// off-topic, unsupported areas) falls through to the unified LLM.
console.log('\npreRoute:');

// Help
check('help → help', preRoute('help', null)?.intent === 'help');
check('? → help', preRoute('?', null)?.intent === 'help');

// Bare numbers with session
const preMockSession = { lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }], lastEvents: { e1: { name: 'Jazz Night' }, e2: { name: 'Comedy Show' } }, lastNeighborhood: 'East Village' };
check('1 with session → details', preRoute('1', preMockSession)?.intent === 'details');
check('1 with session → event_reference "1"', preRoute('1', preMockSession)?.event_reference === '1');
check('2 with session → details', preRoute('2', preMockSession)?.intent === 'details');
check('3 with session → details', preRoute('3', preMockSession)?.intent === 'details');
check('4 with session → details', preRoute('4', preMockSession)?.intent === 'details');
check('5 with session → details', preRoute('5', preMockSession)?.intent === 'details');

// Bare numbers without session
check('1 without session → conversational', preRoute('1', null)?.intent === 'conversational');
check('1 without session has reply', preRoute('1', null)?.reply !== null);
check('5 without session → conversational', preRoute('5', null)?.intent === 'conversational');
check('6 falls through → null', preRoute('6', null) === null);

// More
check('more → more', preRoute('more', null)?.intent === 'more');
check('show me more → more', preRoute('show me more', null)?.intent === 'more');
check('what else → more', preRoute('what else', null)?.intent === 'more');
check("what's next → more", preRoute("what's next", null)?.intent === 'more');
check('more uses session hood', preRoute('more', { lastNeighborhood: 'Bushwick' })?.neighborhood === 'Bushwick');

// Event name match from session
const nameMatchSession = {
  lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: { e1: { name: 'Jazz at Smalls' }, e2: { name: 'The Comedy Show' } },
  lastNeighborhood: 'East Village',
};
check('event name match → details', preRoute('smalls', nameMatchSession)?.intent === 'details');
check('event name match → correct ref', preRoute('smalls', nameMatchSession)?.event_reference === '1');

// Greetings
check('hey → conversational', preRoute('hey', null)?.intent === 'conversational');
check('hi → conversational', preRoute('hi', null)?.intent === 'conversational');
check('hello → conversational', preRoute('hello', null)?.intent === 'conversational');
check('yo → conversational', preRoute('yo', null)?.intent === 'conversational');
check('greeting has reply', preRoute('hey', null)?.reply !== null);

// Thanks
check('thanks → conversational', preRoute('thanks', null)?.intent === 'conversational');
check('thx → conversational', preRoute('thx', null)?.intent === 'conversational');

// Bye
check('bye → conversational', preRoute('bye', null)?.intent === 'conversational');
check('peace → conversational', preRoute('peace', null)?.intent === 'conversational');

// Impatient
check('hello?? with session → conversational', preRoute('hello??', preMockSession)?.intent === 'conversational');
check('??? → conversational', preRoute('???', preMockSession)?.intent === 'conversational');
check('hello?? without session → conversational', preRoute('hello??', null)?.intent === 'conversational');

// --- Everything below now falls through to unified LLM (returns null) ---
console.log('\npreRoute fallthrough (unified LLM handles these):');

// Nudge accept → now handled by unified LLM
const nudgeSession = { pendingNearby: 'Williamsburg' };
check('yes with pendingNearby → null (unified)', preRoute('yes', nudgeSession) === null);
check('yeah → null (unified)', preRoute('yeah', nudgeSession) === null);
check('bet → null (unified)', preRoute('bet', nudgeSession) === null);

// Free → now handled by unified LLM
check('free → null (unified)', preRoute('free', null) === null);
check('free stuff → null (unified)', preRoute('free stuff', null) === null);
check('free events → null (unified)', preRoute('free events', null) === null);

// Off-topic → now handled by unified LLM
check('sports → null (unified)', preRoute('whats the score of the knicks game', null) === null);
check('food → null (unified)', preRoute('where should i get dinner in soho', null) === null);
check('weather → null (unified)', preRoute('whats the weather like tonight', null) === null);

// Bare neighborhoods → now handled by unified LLM
check('east village → null (unified)', preRoute('east village', null) === null);
check('williamsburg → null (unified)', preRoute('williamsburg', null) === null);

// Boroughs → now handled by unified LLM
check('brooklyn → null (unified)', preRoute('brooklyn', null) === null);
check('bk → null (unified)', preRoute('bk', null) === null);

// Unsupported areas → now handled by unified LLM
check('bay ridge → null (unified)', preRoute('bay ridge', null) === null);

// Follow-up filters → now handled by unified LLM
const followUpSession = {
  lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: { e1: { name: 'DJ Honeypot' }, e2: { name: 'Jazz at Smalls' } },
  lastNeighborhood: 'East Village',
};
check('how about theater → null (unified)', preRoute('how about theater', followUpSession) === null);
check('any comedy → null (unified)', preRoute('any comedy', followUpSession) === null);
check('later tonight → null (unified)', preRoute('later tonight', followUpSession) === null);
check('something chill → null (unified)', preRoute('something chill', followUpSession) === null);

// Compound and complex → still null (unchanged)
check('free comedy stuff → null', preRoute('any more free comedy stuff', followUpSession) === null);
check('complex request → null', preRoute('any good jazz shows in williamsburg tonight', null) === null);

// ---- getAdjacentNeighborhoods ----
console.log('\ngetAdjacentNeighborhoods:');

const evAdjacent = getAdjacentNeighborhoods('East Village', 3);
check('EV returns 3 neighbors', evAdjacent.length === 3);
check('EV neighbors exclude cross-borough Wburg', !evAdjacent.includes('Williamsburg'));
check('EV does not include itself', !evAdjacent.includes('East Village'));

const astoriaAdjacent = getAdjacentNeighborhoods('Astoria', 3);
check('Astoria returns 3 neighbors', astoriaAdjacent.length === 3);
check('Astoria first neighbor not UES (cross-borough penalty)', astoriaAdjacent[0] !== 'Upper East Side');

const ftGreeneAdjacent = getAdjacentNeighborhoods('Fort Greene', 5);
check('Fort Greene count=5 returns 5', ftGreeneAdjacent.length === 5);

check('count=1 returns 1', getAdjacentNeighborhoods('East Village', 1).length === 1);
check('unknown neighborhood → empty', getAdjacentNeighborhoods('Narnia', 3).length === 0);
