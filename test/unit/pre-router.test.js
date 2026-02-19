const { check } = require('../helpers');
const { preRoute, getAdjacentNeighborhoods } = require('../../src/pre-router');

// ---- preRoute ----
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

// Nudge accept
const nudgeSession = { pendingNearby: 'Williamsburg' };
check('yes with pendingNearby → nudge_accept', preRoute('yes', nudgeSession)?.intent === 'nudge_accept');
check('yeah → nudge_accept', preRoute('yeah', nudgeSession)?.intent === 'nudge_accept');
check('bet → nudge_accept', preRoute('bet', nudgeSession)?.intent === 'nudge_accept');
check("i'm down → nudge_accept", preRoute("i'm down", nudgeSession)?.intent === 'nudge_accept');
check('nudge_accept uses pendingNearby hood', preRoute('sure', nudgeSession)?.neighborhood === 'Williamsburg');
check('counter-suggestion extracts hood', preRoute('sure but how about bushwick', nudgeSession)?.neighborhood === 'Bushwick');

// More
check('more → more', preRoute('more', null)?.intent === 'more');
check('show me more → more', preRoute('show me more', null)?.intent === 'more');
check('what else → more', preRoute('what else', null)?.intent === 'more');
check("what's next → more", preRoute("what's next", null)?.intent === 'more');
check('more uses session hood', preRoute('more', { lastNeighborhood: 'Bushwick' })?.neighborhood === 'Bushwick');

// Free
check('free → free', preRoute('free', null)?.intent === 'free');
check('free stuff → free', preRoute('free stuff', null)?.intent === 'free');
check('free events → free', preRoute('free events', null)?.intent === 'free');
check('free has free_only filter', preRoute('free', null)?.filters?.free_only === true);

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

// Off-topic: sports
check('sports → conversational', preRoute('whats the score of the knicks game', null)?.intent === 'conversational');
check('sports reply mentions nightlife', preRoute('whats the score of the knicks game', null)?.reply?.includes('nightlife'));
check('sports watching exception → null', preRoute('where to watch the knicks game at a bar', null) === null);

// Off-topic: food
check('food → conversational', preRoute('where should i get dinner in soho', null)?.intent === 'conversational');
check('food event exception → null', preRoute('food festival in bushwick', null) === null);

// Off-topic: weather
check('weather → conversational', preRoute('whats the weather like tonight', null)?.intent === 'conversational');

// Bare neighborhood
check('east village → events', preRoute('east village', null)?.intent === 'events');
check('east village → East Village', preRoute('east village', null)?.neighborhood === 'East Village');
check('williamsburg → events', preRoute('williamsburg', null)?.intent === 'events');
check('les → events', preRoute('les', null)?.intent === 'events');
check('ev → events', preRoute('ev', null)?.intent === 'events');
check('wburg → events', preRoute('wburg', null)?.intent === 'events');

// Bare neighborhood with category keywords → falls through to Claude
check('comedy in midtown → null', preRoute('comedy in midtown', null) === null);

// Borough
check('brooklyn → conversational', preRoute('brooklyn', null)?.intent === 'conversational');
check('brooklyn asks which neighborhood', preRoute('brooklyn', null)?.reply?.includes('neighborhood'));
check('bk → conversational', preRoute('bk', null)?.intent === 'conversational');

// Unsupported
check('bay ridge → conversational', preRoute('bay ridge', null)?.intent === 'conversational');
check('bay ridge suggests Sunset Park', preRoute('bay ridge', null)?.reply?.includes('Sunset Park'));

// Fall-through
check('something wild tonight → null', preRoute('something wild tonight', null) === null);
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
