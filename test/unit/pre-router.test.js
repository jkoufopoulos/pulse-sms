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

// --- Follow-up filter modifications (with active session) ---
console.log('\npreRoute follow-up filters:');

const followUpSession = {
  lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: { e1: { name: 'DJ Honeypot' }, e2: { name: 'Jazz at Smalls' } },
  lastNeighborhood: 'East Village',
};

// Category follow-ups
check('how about theater → events', preRoute('how about theater', followUpSession)?.intent === 'events');
check('how about theater → theater category', preRoute('how about theater', followUpSession)?.filters?.category === 'theater');
check('how about theater → session hood', preRoute('how about theater', followUpSession)?.neighborhood === 'East Village');
check('any comedy → events', preRoute('any comedy', followUpSession)?.intent === 'events');
check('any comedy → comedy category', preRoute('any comedy', followUpSession)?.filters?.category === 'comedy');
check('what about jazz → events', preRoute('what about jazz', followUpSession)?.intent === 'events');
check('what about jazz → live_music', preRoute('what about jazz', followUpSession)?.filters?.category === 'live_music');
check('show me art → events', preRoute('show me art', followUpSession)?.intent === 'events');
check('show me art → art category', preRoute('show me art', followUpSession)?.filters?.category === 'art');
check('any comedy shows → events', preRoute('any comedy shows', followUpSession)?.intent === 'events');

// Time follow-ups
check('later tonight → events', preRoute('later tonight', followUpSession)?.intent === 'events');
check('later tonight → time_after 22:00', preRoute('later tonight', followUpSession)?.filters?.time_after === '22:00');
check('later tonight → session hood', preRoute('later tonight', followUpSession)?.neighborhood === 'East Village');
check('after midnight → time_after 00:00', preRoute('after midnight', followUpSession)?.filters?.time_after === '00:00');
check('how about later → events', preRoute('how about later', followUpSession)?.intent === 'events');
check('late night → events', preRoute('late night', followUpSession)?.intent === 'events');
check('anything late → events', preRoute('anything late', followUpSession)?.intent === 'events');

// Vibe follow-ups
check('something chill → events', preRoute('something chill', followUpSession)?.intent === 'events');
check('something chill → vibe', preRoute('something chill', followUpSession)?.filters?.vibe === 'chill');
check('something chill → session hood', preRoute('something chill', followUpSession)?.neighborhood === 'East Village');
check('anything wild → events', preRoute('anything wild', followUpSession)?.intent === 'events');
check('anything wild → vibe', preRoute('anything wild', followUpSession)?.filters?.vibe === 'wild');
check('something romantic → events', preRoute('something romantic', followUpSession)?.intent === 'events');

// No session → falls through to Claude
check('how about theater no session → null', preRoute('how about theater', null) === null);
check('later tonight no session → null', preRoute('later tonight', null) === null);
check('something chill no session → null', preRoute('something chill', null) === null);

// Compound messages fall through to Claude (too complex for regex)
check('free comedy stuff → null (compound)', preRoute('any more free comedy stuff', followUpSession) === null);

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
