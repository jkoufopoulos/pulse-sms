/**
 * Smoke tests for NightOwl pure functions.
 * Run: node test/smoke.test.js
 */

const { renderSMS } = require('../src/services/sms-render');
const { extractNeighborhood } = require('../src/utils/neighborhoods');
const { makeEventId } = require('../src/services/sources');
const { resolveNeighborhood, inferCategory, haversine, getNycDateString, rankEventsByProximity, filterUpcomingEvents } = require('../src/utils/geo');

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.error(`  FAIL: ${name}`);
  }
}

// ---- renderSMS ----
console.log('\nrenderSMS:');

const eventMap = {
  abc123: {
    name: 'DJ Night', venue_name: 'Output', neighborhood: 'Williamsburg',
    start_time_local: '2026-02-14T21:00:00', is_free: false, price_display: '$20',
  },
  def456: {
    name: 'Jazz at Smalls', venue_name: 'Smalls', neighborhood: 'West Village',
    start_time_local: '2026-02-14T20:00:00', is_free: false, price_display: '$20',
  },
};

const basic = renderSMS({ picks: [{ rank: 1, event_id: 'abc123', why: 'Sick lineup' }] }, eventMap);
check('includes event name', basic.includes('DJ Night'));
check('includes venue', basic.includes('Output'));
check('within 480 chars', basic.length <= 480);
check('includes CTA', basic.includes('Reply DETAILS'));

const multi = renderSMS({
  picks: [
    { rank: 1, event_id: 'abc123', why: 'Sick lineup' },
    { rank: 2, event_id: 'def456', why: 'Chill vibes' },
  ],
}, eventMap);
check('multi-pick includes Also:', multi.includes('Also:'));
check('multi-pick within 480', multi.length <= 480);

check('clarification', renderSMS({ need_clarification: true, clarifying_question: 'What hood?', picks: [] }, {}) === 'What hood?');
check('fallback note', renderSMS({ picks: [] }, {}).includes('Quiet night'));

const missing = renderSMS({ picks: [{ rank: 1, event_id: 'missing', why: 'Great show' }] }, eventMap);
check('missing event falls back to why', missing.includes('Great show'));

// ---- extractNeighborhood ----
console.log('\nextractNeighborhood:');

check('east village', extractNeighborhood('east village tonight') === 'East Village');
check('LES', extractNeighborhood('LES shows') === 'Lower East Side');
check('williamsburg', extractNeighborhood('wburg bars') === 'Williamsburg');
check('hells kitchen', extractNeighborhood("hell's kitchen food") === "Hell's Kitchen");
check('no match', extractNeighborhood('hello world') === null);
check('prefers longer match', extractNeighborhood('events in lower east side today') === 'Lower East Side');
// Word boundary: short aliases don't match inside common words
check('ev not in events', extractNeighborhood('any events tonight') === null);
check('ev not in every', extractNeighborhood('every bar nearby') === null);
check('ev not in never', extractNeighborhood('never mind') === null);
check('ev standalone works', extractNeighborhood('ev tonight') === 'East Village');
// Borough shortcuts
check('brooklyn', extractNeighborhood('brooklyn tonight') === 'Williamsburg');
check('bk', extractNeighborhood('anything in bk') === 'Williamsburg');
check('manhattan', extractNeighborhood('manhattan') === 'Midtown');
check('queens', extractNeighborhood('queens') === 'Astoria');
// New aliases
check('union sq', extractNeighborhood('union sq tonight') === 'Flatiron');
check('nolita', extractNeighborhood('nolita drinks') === 'SoHo');
check('e.v.', extractNeighborhood('E.V. tonight') === 'East Village');
check('nyc', extractNeighborhood('nyc tonight') === 'Midtown');

// ---- makeEventId ----
console.log('\nmakeEventId:');

const id1 = makeEventId('Test Event', 'The Venue', '2026-02-14');
const id2 = makeEventId('Test Event', 'The Venue', '2026-02-14');
const id3 = makeEventId('Different Event', 'The Venue', '2026-02-14');
check('stable (same input = same id)', id1 === id2);
check('different for different events', id1 !== id3);
check('12 chars', id1.length === 12);
check('case insensitive', makeEventId('TEST EVENT', 'THE VENUE', '2026-02-14') === id1);

// ---- resolveNeighborhood ----
console.log('\nresolveNeighborhood:');

check('direct name match', resolveNeighborhood('East Village', null, null) === 'East Village');
check('alias match', resolveNeighborhood('ev', null, null) === 'East Village');
check('geo with borough string', resolveNeighborhood('Brooklyn', 40.7081, -73.9571) === 'Williamsburg');
check('geo overrides borough', resolveNeighborhood('Brooklyn', 40.6934, -73.9867) === 'Downtown Brooklyn');
check('borough fallback when no coords', resolveNeighborhood('Brooklyn', null, null) === 'Williamsburg');
check('null for unknown', resolveNeighborhood('Mars', null, null) === null);
check('null for empty', resolveNeighborhood(null, null, null) === null);

// ---- inferCategory ----
console.log('\ninferCategory:');

check('comedy', inferCategory('stand-up comedy show') === 'comedy');
check('art', inferCategory('gallery opening reception tonight') === 'art');
check('nightlife', inferCategory('dj set techno party') === 'nightlife');
check('live_music', inferCategory('jazz concert') === 'live_music');
check('theater', inferCategory('off-broadway theatre performance') === 'theater');
check('food_drink', inferCategory('wine tasting event') === 'food_drink');
check('community', inferCategory('community market and festival') === 'community');
check('other', inferCategory('something random happening') === 'other');

// ---- haversine ----
console.log('\nhaversine:');

const evToWburg = haversine(40.7264, -73.9818, 40.7081, -73.9571);
check('EV→Wburg ~2.7km', evToWburg > 2 && evToWburg < 4);
check('same point = 0', haversine(40.7, -73.9, 40.7, -73.9) === 0);

// ---- getNycDateString ----
console.log('\ngetNycDateString:');

const today = getNycDateString(0);
check('YYYY-MM-DD format', /^\d{4}-\d{2}-\d{2}$/.test(today));
const tomorrow = getNycDateString(1);
check('tomorrow is after today', tomorrow > today);

// ---- rankEventsByProximity ----
console.log('\nrankEventsByProximity:');

const events = [
  { id: '1', neighborhood: 'East Village' },
  { id: '2', neighborhood: 'Williamsburg' },
  { id: '3', neighborhood: null },
  { id: '4', neighborhood: 'Astoria' },
];
const ranked = rankEventsByProximity(events, 'East Village');
check('closest first', ranked[0].id === '1');
check('includes nearby Wburg', ranked.some(e => e.id === '2'));
check('includes unknown neighborhood', ranked.some(e => e.id === '3'));
check('excludes distant Astoria', !ranked.some(e => e.id === '4'));

const noTarget = rankEventsByProximity(events, null);
check('no target returns all', noTarget.length === events.length);

// ---- filterUpcomingEvents ----
console.log('\nfilterUpcomingEvents:');

function makeTime(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

const timeEvents = [
  { id: 't1', start_time_local: makeTime(3) },       // future
  { id: 't2', start_time_local: makeTime(-1) },       // 1hr ago (within window)
  { id: 't3', start_time_local: makeTime(-5) },       // 5hrs ago (should be filtered)
  { id: 't4', start_time_local: null },                // no time
  { id: 't5', start_time_local: '2026-02-14' },       // date only
  { id: 't6', start_time_local: makeTime(-4), end_time_local: makeTime(1) },  // ended but end in future
];
const upcoming = filterUpcomingEvents(timeEvents);
const upIds = upcoming.map(e => e.id);

check('keeps future', upIds.includes('t1'));
check('keeps recent (within 2hr)', upIds.includes('t2'));
check('removes past (5hr ago)', !upIds.includes('t3'));
check('keeps no-time', upIds.includes('t4'));
check('keeps date-only', upIds.includes('t5'));
check('keeps event with future end_time', upIds.includes('t6'));

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
