const { check } = require('../helpers');
const { checkMechanical, executeMore, executeDetails } = require('../../src/agent-brain');

const sessionWithPicks = {
  lastPicks: [{ id: 'e1', name: 'Test Event' }],
  lastNeighborhood: 'williamsburg',
  lastResponseHadPicks: true
};

const emptySession = {};

// ---- checkMechanical ----
console.log('\ncheckMechanical:');

// Help returns intent
check('help → { intent: "help" }', JSON.stringify(checkMechanical('help', emptySession)) === '{"intent":"help"}');
check('? → { intent: "help" }', JSON.stringify(checkMechanical('?', emptySession)) === '{"intent":"help"}');
check('HELP (uppercase) → { intent: "help" }', JSON.stringify(checkMechanical('HELP', emptySession)) === '{"intent":"help"}');

// TCPA returns null (silent drop)
check('STOP → null', checkMechanical('STOP', emptySession) === null);
check('unsubscribe → null', checkMechanical('unsubscribe', emptySession) === null);

// Bare numbers → null (fall through to agent brain)
check('bare "1" with picks → null', checkMechanical('1', sessionWithPicks) === null);
check('bare "3" with picks → null', checkMechanical('3', sessionWithPicks) === null);
check('bare "5" without session → null', checkMechanical('5', emptySession) === null);

// "more" / "what else" → null (fall through to agent brain)
check('"more" with session → null', checkMechanical('more', sessionWithPicks) === null);
check('"what else" with session → null', checkMechanical('what else', sessionWithPicks) === null);
check('"more" without session → null', checkMechanical('more', emptySession) === null);

// Greetings → null (fall through to agent brain)
check('"hey" → null', checkMechanical('hey', emptySession) === null);
check('"hello" with session → null', checkMechanical('hello', sessionWithPicks) === null);
check('"yo" → null', checkMechanical('yo', emptySession) === null);

// Thanks → null (fall through to agent brain)
check('"thanks" → null', checkMechanical('thanks', emptySession) === null);
check('"thank you" → null', checkMechanical('thank you', emptySession) === null);

// Bye → null (fall through to agent brain)
check('"bye" → null', checkMechanical('bye', emptySession) === null);
check('"later" → null', checkMechanical('later', emptySession) === null);

// Satisfied-exit → null (fall through to agent brain)
check('"cool" → null', checkMechanical('cool', emptySession) === null);
check('"sounds good" → null', checkMechanical('sounds good', emptySession) === null);
check('"perfect thanks" → null', checkMechanical('perfect thanks', emptySession) === null);

// Decline → null (fall through to agent brain)
check('"nah" → null', checkMechanical('nah', emptySession) === null);
check('"no thanks" → null', checkMechanical('no thanks', emptySession) === null);

// Acknowledgments → null (fall through to agent brain)
check('"ok" with session → null', checkMechanical('ok', sessionWithPicks) === null);
check('"bet" → null', checkMechanical('bet', emptySession) === null);

// Impatient follow-ups → null (fall through to agent brain)
check('"hello??" with session → null', checkMechanical('hello??', sessionWithPicks) === null);
check('"??" → null', checkMechanical('??', emptySession) === null);

// Regular messages → null (fall through to agent brain)
check('"williamsburg" → null', checkMechanical('williamsburg', emptySession) === null);
check('"comedy in bushwick" → null', checkMechanical('comedy in bushwick', emptySession) === null);

// ---- executeMore ----
console.log('\nexecuteMore:');

// Returns noContext when no session
check('null session → noContext', executeMore(null).noContext === true);
check('empty session → noContext', executeMore({}).noContext === true);
check('session without lastPicks → noContext', executeMore({ lastEvents: {} }).noContext === true);
check('session without lastEvents → noContext', executeMore({ lastPicks: [] }).noContext === true);

// Returns events excluding already shown
const moreSession = {
  lastPicks: [{ event_id: 'e1' }],
  lastEvents: {
    e1: { id: 'e1', name: 'Event 1', neighborhood: 'Bushwick' },
    e2: { id: 'e2', name: 'Event 2', neighborhood: 'Bushwick' },
    e3: { id: 'e3', name: 'Event 3', neighborhood: 'Bushwick' },
  },
  allOfferedIds: ['e1'],
  allPicks: [{ event_id: 'e1' }],
  lastNeighborhood: 'Bushwick',
  lastFilters: {},
};
const moreResult = executeMore(moreSession);
check('returns events from pool', moreResult.events.length > 0);
check('excludes already shown e1', moreResult.events.every(e => e.id !== 'e1'));
check('not exhausted', moreResult.exhausted === false);
check('neighborhood set', moreResult.neighborhood === 'Bushwick');

// Returns exhaustion when pool empty
const exhaustedSession = {
  lastPicks: [{ event_id: 'e1' }],
  lastEvents: { e1: { id: 'e1', name: 'Event 1', neighborhood: 'Bushwick' } },
  allOfferedIds: ['e1'],
  allPicks: [{ event_id: 'e1' }],
  lastNeighborhood: 'Bushwick',
  lastFilters: {},
  visitedHoods: ['Bushwick'],
};
const exhaustResult = executeMore(exhaustedSession);
check('exhausted pool → events empty', exhaustResult.events.length === 0);
check('exhausted pool → exhausted true', exhaustResult.exhausted === true);

// Name dedup: excludes events with same name as shown events
const nameDupSession = {
  lastPicks: [{ event_id: 'e1' }],
  lastEvents: {
    e1: { id: 'e1', name: 'Jazz Night', neighborhood: 'Bushwick' },
    e2: { id: 'e2', name: 'Jazz Night', neighborhood: 'Bushwick' },
    e3: { id: 'e3', name: 'Comedy Show', neighborhood: 'Bushwick' },
  },
  allOfferedIds: ['e1'],
  allPicks: [{ event_id: 'e1' }],
  lastNeighborhood: 'Bushwick',
  lastFilters: {},
};
const nameDupResult = executeMore(nameDupSession);
check('name dedup excludes duplicate name', nameDupResult.events.every(e => e.name !== 'Jazz Night'));
check('name dedup keeps unique event', nameDupResult.events.some(e => e.name === 'Comedy Show'));

// ---- executeDetails ----
console.log('\nexecuteDetails:');

const detailsSession = {
  lastPicks: [
    { event_id: 'e1', why: 'great jazz' },
    { event_id: 'e2', why: 'funny comedy' },
  ],
  lastEvents: {
    e1: { id: 'e1', name: 'Jazz Night', venue_name: 'Blue Note', neighborhood: 'West Village',
      category: 'live_music', start_time_local: '21:30', price_display: '$20', is_free: false },
    e2: { id: 'e2', name: 'Open Mic Comedy', venue_name: 'Tiny Cupboard', neighborhood: 'Bushwick',
      category: 'comedy', start_time_local: '20:00', price_display: 'free', is_free: true },
  },
  lastResponseHadPicks: true,
};

// Matches by number
const detNum = executeDetails('2', detailsSession);
check('details: matches by number', detNum.found === true && detNum.event.id === 'e2' && detNum.pickIndex === 2);

// Matches by event name
const detName = executeDetails('jazz', detailsSession);
check('details: matches by event name', detName.found === true && detName.event.id === 'e1');

// Matches by venue name
const detVenue = executeDetails('tiny cupboard', detailsSession);
check('details: matches by venue name', detVenue.found === true && detVenue.event.id === 'e2');

// Matches by category keyword
const detCat = executeDetails('the comedy one', detailsSession);
check('details: matches by category keyword', detCat.found === true && detCat.event.id === 'e2');

// Returns not found when no match
const detNoMatch = executeDetails('the karaoke show', detailsSession);
check('details: returns not found when no match', detNoMatch.found === false && !detNoMatch.noPicks && !detNoMatch.stalePicks);

// Returns noPicks when no session picks
const detNoPicks = executeDetails('2', { lastPicks: [] });
check('details: returns noPicks when no session picks', detNoPicks.noPicks === true);

// Returns noPicks when null session
const detNull = executeDetails('2', null);
check('details: returns noPicks when null session', detNull.noPicks === true);

// Returns stalePicks when lastResponseHadPicks is false
const staleSession = { ...detailsSession, lastResponseHadPicks: false, lastNeighborhood: 'Bushwick' };
const detStale = executeDetails('2', staleSession);
check('details: returns stalePicks when lastResponseHadPicks is false', detStale.stalePicks === true && detStale.neighborhood === 'Bushwick');

// ---- executeWelcome helpers ----
console.log('\nexecuteWelcome helpers:');

const { formatWelcomePick, welcomeTimeLabel } = require('../../src/brain-execute');

check('formatWelcomePick exists', typeof formatWelcomePick === 'function');
check('welcomeTimeLabel exists', typeof welcomeTimeLabel === 'function');

// Test welcomeTimeLabel with a today event
const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const todayEvent = {
  date_local: todayDate,
  start_time_local: todayDate + 'T20:00:00',
};
const todayLabel = welcomeTimeLabel(todayEvent);
check('today evening event label contains "tonight"', todayLabel.includes('tonight'));

// Test formatWelcomePick
const testWelcomeEvent = {
  name: 'Jazz Night',
  venue_name: 'Blue Note',
  neighborhood: 'Greenwich Village',
  category: 'jazz',
  is_free: false,
  price_display: '$20',
  date_local: todayDate,
  start_time_local: todayDate + 'T20:00:00',
};
const pickLine = formatWelcomePick(testWelcomeEvent, 1);
check('pick line starts with rank', pickLine.startsWith('1)'));
check('pick line contains event name', pickLine.includes('Jazz Night'));
check('pick line contains venue', pickLine.includes('Blue Note'));
check('pick line contains neighborhood', pickLine.includes('Greenwich Village'));
check('pick line contains price', pickLine.includes('$20'));

// Test free event
const freeEvent = { ...testWelcomeEvent, is_free: true, price_display: null };
const freeLine = formatWelcomePick(freeEvent, 2);
check('free event shows "free"', freeLine.includes('free'));
