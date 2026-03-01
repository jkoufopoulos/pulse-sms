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

// Clear filters — requires lastFilters with active values
console.log('\npreRoute clear_filters:');
const filterSession = {
  lastPicks: [{ event_id: 'e1' }],
  lastEvents: { e1: { name: 'Jazz Night' } },
  lastNeighborhood: 'East Village',
  lastFilters: { category: 'comedy', free_only: false, vibe: null, time_after: null },
};

// Targeted clearing — "forget the comedy" clears category only, returns events intent
const forgetComedy = preRoute('forget the comedy', filterSession);
check('forget the comedy → targeted (events)', forgetComedy?.intent === 'events');
check('forget the comedy → category null', forgetComedy?.filters?.category === null);
check('forget the comedy → preserves neighborhood', forgetComedy?.neighborhood === 'East Village');

const neverMindComedy = preRoute('never mind the comedy', filterSession);
check('never mind the comedy → targeted (events)', neverMindComedy?.intent === 'events');
check('never mind the comedy → category null', neverMindComedy?.filters?.category === null);

// Targeted free clearing
const filterSessionFree = { ...filterSession, lastFilters: { ...filterSession.lastFilters, free_only: true } };
const forgetFree = preRoute('forget the free', filterSessionFree);
check('forget the free → targeted (events)', forgetFree?.intent === 'events');
check('forget the free → free_only false', forgetFree?.filters?.free_only === false);

// Targeted time clearing
const filterSessionTime = { ...filterSession, lastFilters: { ...filterSession.lastFilters, time_after: '22:00' } };
const forgetLate = preRoute('forget the late', filterSessionTime);
check('forget the late → targeted (events)', forgetLate?.intent === 'events');
check('forget the late → time_after null', forgetLate?.filters?.time_after === null);

// Targeted jazz clearing (subcategory)
const filterSessionJazz = { ...filterSession, lastFilters: { category: 'live_music', subcategory: 'jazz' } };
const forgetJazz = preRoute('forget the jazz', filterSessionJazz);
check('forget the jazz → targeted (events)', forgetJazz?.intent === 'events');
check('forget the jazz → category null', forgetJazz?.filters?.category === null);
check('forget the jazz → subcategory null', forgetJazz?.filters?.subcategory === null);

// Full clearing — generic phrases
check('show me everything → clear_filters', preRoute('show me everything', filterSession)?.intent === 'clear_filters');
check('everything → clear_filters', preRoute('everything', filterSession)?.intent === 'clear_filters');
check('clear filter → clear_filters', preRoute('clear filter', filterSession)?.intent === 'clear_filters');
check('clear filters → clear_filters', preRoute('clear filters', filterSession)?.intent === 'clear_filters');
check('no filter → clear_filters', preRoute('no filter', filterSession)?.intent === 'clear_filters');
check('drop the filter → clear_filters', preRoute('drop the filter', filterSession)?.intent === 'clear_filters');
check('show all → clear_filters', preRoute('show all', filterSession)?.intent === 'clear_filters');
check('just regular stuff → clear_filters', preRoute('just regular stuff', filterSession)?.intent === 'clear_filters');
check('all events → clear_filters', preRoute('all events', filterSession)?.intent === 'clear_filters');
check('nvm → clear_filters', preRoute('nvm', filterSession)?.intent === 'clear_filters');
check('forget it → clear_filters', preRoute('forget it', filterSession)?.intent === 'clear_filters');
check('nah forget it → clear_filters', preRoute('nah forget it', filterSession)?.intent === 'clear_filters');
check('drop it → clear_filters', preRoute('drop it', filterSession)?.intent === 'clear_filters');
check('start over → clear_filters', preRoute('start over', filterSession)?.intent === 'clear_filters');
// Prefix messages do NOT match (full-line regex) — fall through to LLM
check('ok forget the comedy → null (has prefix)', preRoute('ok forget the comedy', filterSession) === null);
check('actually show me everything → null (has prefix)', preRoute('actually show me everything', filterSession) === null);
check('yeah nvm → null (has prefix)', preRoute('yeah nvm', filterSession) === null);
// Compound messages do NOT match — fall through to LLM
check('forget the comedy, how about jazz → null (compound)', preRoute('forget the comedy, how about jazz', filterSession) === null);

// No active filters → falls through (not clear_filters)
const noFilterSession = { lastPicks: [{ event_id: 'e1' }], lastEvents: { e1: { name: 'Jazz Night' } }, lastNeighborhood: 'East Village', lastFilters: {} };
check('no active filters → null', preRoute('forget the comedy', noFilterSession) === null);
check('null lastFilters → null', preRoute('show me everything', { ...noFilterSession, lastFilters: null }) === null);

// No session → falls through
check('no session → null', preRoute('forget the comedy', null) === null);

// --- Compound filter extraction ---
console.log('\npreRoute compound extraction:');

// Category + free
const freeComedy = preRoute('free comedy', followUpSession);
check('free comedy → events', freeComedy?.intent === 'events');
check('free comedy → free_only', freeComedy?.filters?.free_only === true);
check('free comedy → comedy', freeComedy?.filters?.category === 'comedy');
check('free comedy → session hood', freeComedy?.neighborhood === 'East Village');

const freeJazz = preRoute('free jazz', followUpSession);
check('free jazz → events', freeJazz?.intent === 'events');
check('free jazz → free_only', freeJazz?.filters?.free_only === true);
check('free jazz → live_music', freeJazz?.filters?.category === 'live_music');
check('free jazz → subcategory jazz', freeJazz?.filters?.subcategory === 'jazz');

const anyFreeMusic = preRoute('any free music', followUpSession);
check('any free music → events', anyFreeMusic?.intent === 'events');
check('any free music → free_only', anyFreeMusic?.filters?.free_only === true);
check('any free music → live_music', anyFreeMusic?.filters?.category === 'live_music');

// Category + time
const lateJazz = preRoute('late jazz', followUpSession);
check('late jazz → events', lateJazz?.intent === 'events');
check('late jazz → time 22:00', lateJazz?.filters?.time_after === '22:00');
check('late jazz → live_music', lateJazz?.filters?.category === 'live_music');
check('late jazz → subcategory jazz', lateJazz?.filters?.subcategory === 'jazz');

const comedyTonight = preRoute('comedy tonight', followUpSession);
check('comedy tonight → events', comedyTonight?.intent === 'events');
check('comedy tonight → no time filter', !comedyTonight?.filters?.time_after);
check('comedy tonight → comedy', comedyTonight?.filters?.category === 'comedy');

const lateNightComedy = preRoute('late night comedy', followUpSession);
check('late night comedy → events', lateNightComedy?.intent === 'events');
check('late night comedy → time 22:00', lateNightComedy?.filters?.time_after === '22:00');
check('late night comedy → comedy', lateNightComedy?.filters?.category === 'comedy');

// Category + neighborhood (no session needed)
const comedyInBushwick = preRoute('comedy in bushwick', null);
check('comedy in bushwick → events', comedyInBushwick?.intent === 'events');
check('comedy in bushwick → comedy', comedyInBushwick?.filters?.category === 'comedy');
check('comedy in bushwick → Bushwick', comedyInBushwick?.neighborhood === 'Bushwick');

const jazzInVillage = preRoute('jazz in east village', null);
check('jazz in east village → events', jazzInVillage?.intent === 'events');
check('jazz in east village → live_music', jazzInVillage?.filters?.category === 'live_music');
check('jazz in east village → subcategory jazz', jazzInVillage?.filters?.subcategory === 'jazz');
check('jazz in east village → East Village', jazzInVillage?.neighborhood === 'East Village');

// Free + time
const freeTonight = preRoute('free stuff tonight', null);
check('free stuff tonight → events', freeTonight?.intent === 'events');
check('free stuff tonight → free_only', freeTonight?.filters?.free_only === true);
check('free stuff tonight → no time filter', !freeTonight?.filters?.time_after);
check('free stuff tonight → no hood', freeTonight?.neighborhood === null);

const freeAndLate = preRoute('anything free and late', followUpSession);
check('anything free and late → events', freeAndLate?.intent === 'events');
check('anything free and late → free_only', freeAndLate?.filters?.free_only === true);
check('anything free and late → time 22:00', freeAndLate?.filters?.time_after === '22:00');

// Triple: free + category + time
const freeComedyTonight = preRoute('free comedy tonight', followUpSession);
check('free comedy tonight → events', freeComedyTonight?.intent === 'events');
check('free comedy tonight → free_only', freeComedyTonight?.filters?.free_only === true);
check('free comedy tonight → comedy', freeComedyTonight?.filters?.category === 'comedy');
check('free comedy tonight → no time filter', !freeComedyTonight?.filters?.time_after);

const freeLateJazz = preRoute('free late jazz', followUpSession);
check('free late jazz → events', freeLateJazz?.intent === 'events');
check('free late jazz → free_only', freeLateJazz?.filters?.free_only === true);
check('free late jazz → live_music', freeLateJazz?.filters?.category === 'live_music');
check('free late jazz → subcategory jazz', freeLateJazz?.filters?.subcategory === 'jazz');
check('free late jazz → time 22:00', freeLateJazz?.filters?.time_after === '22:00');

// Compound with conversational filler (from original test, now caught)
const freeComedyStuff = preRoute('any more free comedy stuff', followUpSession);
check('free comedy stuff → events (compound)', freeComedyStuff?.intent === 'events');
check('free comedy stuff → free_only', freeComedyStuff?.filters?.free_only === true);
check('free comedy stuff → comedy', freeComedyStuff?.filters?.category === 'comedy');

// Complex request with neighborhood + category + time (from original test, now caught)
const complexReq = preRoute('any good jazz shows in williamsburg tonight', null);
check('complex jazz+wburg+tonight → events', complexReq?.intent === 'events');
check('complex jazz+wburg+tonight → live_music', complexReq?.filters?.category === 'live_music');
check('complex jazz+wburg+tonight → subcategory jazz', complexReq?.filters?.subcategory === 'jazz');
check('complex jazz+wburg+tonight → Williamsburg', complexReq?.neighborhood === 'Williamsburg');
check('complex jazz+wburg+tonight → no time filter', !complexReq?.filters?.time_after);

// "free tonight" with session — "tonight" boosts compound threshold without setting time_after
const freeTonightSession = preRoute('free tonight', followUpSession);
check('free tonight (session) → events', freeTonightSession?.intent === 'events');
check('free tonight (session) → free_only', freeTonightSession?.filters?.free_only === true);
check('free tonight (session) → no time filter', !freeTonightSession?.filters?.time_after);

// Midnight compounds
const afterMidnightComedy = preRoute('comedy after midnight', followUpSession);
check('comedy after midnight → time 00:00', afterMidnightComedy?.filters?.time_after === '00:00');
check('comedy after midnight → comedy', afterMidnightComedy?.filters?.category === 'comedy');

// Underground techno in bushwick — category + neighborhood
const undergroundTechno = preRoute('underground techno in bushwick', null);
check('underground techno in bushwick → events', undergroundTechno?.intent === 'events');
check('underground techno in bushwick → nightlife', undergroundTechno?.filters?.category === 'nightlife');
check('underground techno in bushwick → Bushwick', undergroundTechno?.neighborhood === 'Bushwick');

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

// Bare category/time without session → citywide serving (first-message detection)
check('bare jazz (no session) → events (citywide)', preRoute('jazz', null)?.intent === 'events');
check('bare jazz (no session) → live_music', preRoute('jazz', null)?.filters?.category === 'live_music');
check('bare free (no session) → null', preRoute('free', null) === null);
check('bare tonight (no session) → events (citywide)', preRoute('tonight', null)?.intent === 'events');
check('bare comedy (no session) → events (citywide)', preRoute('comedy', null)?.intent === 'events');
check('bare comedy (no session) → comedy', preRoute('comedy', null)?.filters?.category === 'comedy');

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

const jazzAfter11pm = preRoute('jazz after 11pm', followUpSession);
check('jazz after 11pm → time_after 23:00 (compound)', jazzAfter11pm?.filters?.time_after === '23:00');
check('jazz after 11pm → live_music', jazzAfter11pm?.filters?.category === 'live_music');

// Existing fuzzy patterns still work
const laterTonight = preRoute('later tonight', followUpSession);
check('later tonight → still 22:00', laterTonight?.filters?.time_after === '22:00');
const afterMidnight = preRoute('after midnight', followUpSession);
check('after midnight → still 00:00', afterMidnight?.filters?.time_after === '00:00');

// Compound: specific time + category
const comedyAfter9pm = preRoute('comedy after 9pm', followUpSession);
check('comedy after 9pm → events', comedyAfter9pm?.intent === 'events');
check('comedy after 9pm → comedy', comedyAfter9pm?.filters?.category === 'comedy');
check('comedy after 9pm → time_after 21:00', comedyAfter9pm?.filters?.time_after === '21:00');

// Compound: free + specific time + neighborhood
const freeAfter8pmBushwick = preRoute('free stuff after 8pm in bushwick', null);
check('free after 8pm bushwick → events', freeAfter8pmBushwick?.intent === 'events');
check('free after 8pm bushwick → free_only', freeAfter8pmBushwick?.filters?.free_only === true);
check('free after 8pm bushwick → time_after 20:00', freeAfter8pmBushwick?.filters?.time_after === '20:00');
check('free after 8pm bushwick → Bushwick', freeAfter8pmBushwick?.neighborhood === 'Bushwick');

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
