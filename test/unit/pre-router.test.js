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

// Boroughs → pre-router asks user to narrow to a neighborhood
check('brooklyn → conversational', preRoute('brooklyn', null)?.intent === 'conversational');
check('brooklyn → asks to narrow', preRoute('brooklyn', null)?.reply?.includes('neighborhood'));
check('bk → conversational', preRoute('bk', null)?.intent === 'conversational');
check('bk → asks to narrow', preRoute('bk', null)?.reply?.includes('neighborhood'));

// Unsupported areas → now handled by unified LLM
check('bay ridge → null (unified)', preRoute('bay ridge', null) === null);

// Follow-up filters → pre-detected deterministically, injected into unified LLM branch
const followUpSession = {
  lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: { e1: { name: 'DJ Honeypot' }, e2: { name: 'Jazz at Smalls' } },
  lastNeighborhood: 'East Village',
};
const theater = preRoute('how about theater', followUpSession);
check('how about theater → events+theater', theater?.intent === 'events' && theater?.filters?.category === 'theater');
const comedy = preRoute('any comedy', followUpSession);
check('any comedy → events+comedy', comedy?.intent === 'events' && comedy?.filters?.category === 'comedy');
const late = preRoute('later tonight', followUpSession);
check('later tonight → events+time', late?.intent === 'events' && late?.filters?.time_after === '22:00');
const chill = preRoute('something chill', followUpSession);
check('something chill → events+vibe', chill?.intent === 'events' && chill?.filters?.vibe === 'chill');

// Expanded free patterns (P1 filter persistence)
check('free again → events+free', preRoute('free again', followUpSession)?.filters?.free_only === true);
check('free please → events+free', preRoute('free please', followUpSession)?.filters?.free_only === true);
check('how about free stuff → events+free', preRoute('how about free stuff', followUpSession)?.filters?.free_only === true);
check('anything free for a group → events+free', preRoute('anything free for a group', followUpSession)?.filters?.free_only === true);
check('something free tho → events+free', preRoute('something free tho', followUpSession)?.filters?.free_only === true);
check('free instead → events+free', preRoute('free instead', followUpSession)?.filters?.free_only === true);

// Expanded category patterns (P1 filter persistence)
check('more comedy → events+comedy', preRoute('more comedy', followUpSession)?.filters?.category === 'comedy');
check('more jazz → events+live_music', preRoute('more jazz', followUpSession)?.filters?.category === 'live_music');
check('no i meant comedy → events+comedy', preRoute('no i meant comedy', followUpSession)?.filters?.category === 'comedy');
check('actually jazz → events+live_music', preRoute('actually jazz', followUpSession)?.filters?.category === 'live_music');
check('anything with live music → events+live_music', preRoute('anything with live music', followUpSession)?.filters?.category === 'live_music');
check('anything with live music tho → events+live_music', preRoute('anything with live music tho', followUpSession)?.filters?.category === 'live_music');
check('i want comedy → events+comedy', preRoute('i want comedy', followUpSession)?.filters?.category === 'comedy');
check('ok how about art → events+art', preRoute('ok how about art', followUpSession)?.filters?.category === 'art');

// Session without lastNeighborhood (misspelled hood) — filters still detected
const noHoodSession = {
  lastPicks: [{ event_id: 'e1' }],
  lastEvents: { e1: { name: 'DJ Honeypot' } },
};
check('comedy (no hood session) → events', preRoute('comedy', noHoodSession)?.intent === 'events');
check('comedy (no hood session) → neighborhood null', preRoute('comedy', noHoodSession)?.neighborhood === null);
check('free (no hood session) → events+free', preRoute('free', noHoodSession)?.filters?.free_only === true);

// --- Filter clearing and compound extraction → now handled by unified LLM ---
// These messages all fall through to null since pre-router no longer handles them
console.log('\npreRoute filter clearing/compound → null (LLM handles):');
const filterSession = {
  lastPicks: [{ event_id: 'e1' }],
  lastEvents: { e1: { name: 'Jazz Night' } },
  lastNeighborhood: 'East Village',
  lastFilters: { category: 'comedy', free_only: false, vibe: null, time_after: null },
};
check('forget the comedy → null (LLM)', preRoute('forget the comedy', filterSession) === null);
check('show me everything → null (LLM)', preRoute('show me everything', filterSession) === null);
check('clear filters → null (LLM)', preRoute('clear filters', filterSession) === null);
check('nvm → null (LLM)', preRoute('nvm', filterSession) === null);
check('free comedy → null (LLM)', preRoute('free comedy', followUpSession) === null);
check('comedy in bushwick → null (LLM)', preRoute('comedy in bushwick', null) === null);
check('free late jazz → null (LLM)', preRoute('free late jazz', followUpSession) === null);
check('underground techno in bushwick → null (LLM)', preRoute('underground techno in bushwick', null) === null);

// Bare category with session → captured by bare category detection
console.log('\npreRoute bare category detection:');
// Use a session without category words in event names to avoid event name match
const bareCatSession = {
  lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: { e1: { name: 'DJ Honeypot' }, e2: { name: 'Sunset Social' } },
  lastNeighborhood: 'East Village',
};
const bareComedy = preRoute('comedy', bareCatSession);
check('bare comedy (session) → events', bareComedy?.intent === 'events');
check('bare comedy (session) → comedy', bareComedy?.filters?.category === 'comedy');
check('bare comedy (session) → session hood', bareComedy?.neighborhood === 'East Village');

const bareJazz = preRoute('jazz', bareCatSession);
check('bare jazz (session) → events', bareJazz?.intent === 'events');
check('bare jazz (session) → live_music', bareJazz?.filters?.category === 'live_music');
check('bare jazz (session) → subcategory jazz', bareJazz?.filters?.subcategory === 'jazz');

const bareTheater = preRoute('theater', bareCatSession);
check('bare theater (session) → events', bareTheater?.intent === 'events');
check('bare theater (session) → theater', bareTheater?.filters?.category === 'theater');

const bareComedyShows = preRoute('comedy shows', bareCatSession);
check('bare comedy shows (session) → events', bareComedyShows?.intent === 'events');
check('bare comedy shows (session) → comedy', bareComedyShows?.filters?.category === 'comedy');

// Bare category/time without session → now handled by unified LLM (no first-message detection)
check('bare jazz (no session) → null (LLM)', preRoute('jazz', null) === null);
check('bare free (no session) → null', preRoute('free', null) === null);
check('bare tonight (no session) → null (LLM)', preRoute('tonight', null) === null);
check('bare comedy (no session) → null (LLM)', preRoute('comedy', null) === null);

// Specific time follow-ups (single-dimension, session-aware)
console.log('\npreRoute specific time follow-ups:');
const after8pm = preRoute('after 8pm', followUpSession);
check('after 8pm → events', after8pm?.intent === 'events');
check('after 8pm → time_after 20:00', after8pm?.filters?.time_after === '20:00');
check('after 8pm → session hood', after8pm?.neighborhood === 'East Village');

const around930pm = preRoute('around 9:30pm', followUpSession);
check('around 9:30pm → events', around930pm?.intent === 'events');
check('around 9:30pm → time_after 21:30', around930pm?.filters?.time_after === '21:30');

const anythingAfter10pm = preRoute('anything after 10pm', followUpSession);
check('anything after 10pm → time_after 22:00', anythingAfter10pm?.filters?.time_after === '22:00');

// Compound time+category → now handled by unified LLM (no compound extraction)
check('jazz after 11pm → null (LLM)', preRoute('jazz after 11pm', followUpSession) === null);
check('comedy after 9pm → null (LLM)', preRoute('comedy after 9pm', followUpSession) === null);
check('free after 8pm bushwick → null (LLM)', preRoute('free stuff after 8pm in bushwick', null) === null);

// Existing fuzzy patterns still work (single-dimension, session-aware)
const laterTonight = preRoute('later tonight', followUpSession);
check('later tonight → still 22:00', laterTonight?.filters?.time_after === '22:00');
const afterMidnight = preRoute('after midnight', followUpSession);
check('after midnight → still 00:00', afterMidnight?.filters?.time_after === '00:00');

// Bare hour without am/pm assumes PM: "after 10" → 22:00
const after10bare = preRoute('after 10', followUpSession);
check('after 10 (bare) → time_after 22:00', after10bare?.filters?.time_after === '22:00');

// Bare neighborhoods still fall through (0 filter dimensions)
check('east village alone → null', preRoute('east village', null) === null);
check('bushwick alone → null', preRoute('bushwick', null) === null);

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
