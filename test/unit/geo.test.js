const { check } = require('../helpers');
const { resolveNeighborhood, inferCategory, haversine, getNycDateString, getNycUtcOffset, rankEventsByProximity, filterUpcomingEvents, parseAsNycTime, getEventDate } = require('../../src/geo');

// ---- resolveNeighborhood ----
console.log('\nresolveNeighborhood:');

check('direct name match', resolveNeighborhood('East Village', null, null) === 'East Village');
check('alias match', resolveNeighborhood('ev', null, null) === 'East Village');
check('geo with borough string', resolveNeighborhood('Brooklyn', 40.7081, -73.9571) === 'Williamsburg');
check('geo overrides borough', resolveNeighborhood('Brooklyn', 40.6934, -73.9867) === 'Downtown Brooklyn');
check('borough fallback when no coords', resolveNeighborhood('Brooklyn', null, null) === null);
check('manhattan borough fallback null', resolveNeighborhood('Manhattan', null, null) === null);
check('queens borough fallback null', resolveNeighborhood('Queens', null, null) === null);
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

// DST fall-back: 12:30 AM EDT on Nov 2 2025 = 4:30 AM UTC Nov 2
const dstFallbackUtc = Date.UTC(2025, 10, 2, 4, 30); // Nov 2, 2025 4:30 AM UTC = 12:30 AM EDT
check('DST fall-back: today is Nov 2', getNycDateString(0, dstFallbackUtc) === '2025-11-02');
check('DST fall-back: tomorrow is Nov 3 (not Nov 2)', getNycDateString(1, dstFallbackUtc) === '2025-11-03');

// DST spring-forward: 2:30 AM EDT on Mar 9 2025 = 7:30 AM UTC Mar 9
const dstSpringUtc = Date.UTC(2025, 2, 9, 7, 30); // Mar 9, 2025 7:30 AM UTC = 2:30 AM EDT
check('DST spring-forward: today is Mar 9', getNycDateString(0, dstSpringUtc) === '2025-03-09');
check('DST spring-forward: tomorrow is Mar 10', getNycDateString(1, dstSpringUtc) === '2025-03-10');

// Month/year rollover
check('month rollover: Dec 31 + 1 = Jan 1', getNycDateString(1, Date.UTC(2025, 11, 31, 12, 0)) === '2026-01-01');

// getNycUtcOffset returns valid format
const offset = getNycUtcOffset();
check('getNycUtcOffset format', /^[+-]\d{2}:00$/.test(offset));
check('getNycUtcOffset is EST or EDT', offset === '-05:00' || offset === '-04:00');

// parseAsNycTime with no timezone appends NYC offset
const parsedNoTz = parseAsNycTime('2025-07-15T20:00:00');
const parsedWithTz = parseAsNycTime('2025-07-15T20:00:00-04:00');
check('parseAsNycTime no-tz returns valid ms', !isNaN(parsedNoTz));
check('parseAsNycTime with-tz returns valid ms', !isNaN(parsedWithTz));

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
check('excludes unknown neighborhood (dist 4 > 3km cutoff)', !ranked.some(e => e.id === '3'));
check('excludes distant Astoria', !ranked.some(e => e.id === '4'));

const noTarget = rankEventsByProximity(events, null);
check('no target returns all', noTarget.length === events.length);

// Date-tier: today events sort before tomorrow at same distance
const todayStr = getNycDateString(0);
const tomorrowStr = getNycDateString(1);
const dateTierEvents = [
  { id: 'tmrw', neighborhood: 'East Village', date_local: tomorrowStr },
  { id: 'today', neighborhood: 'East Village', date_local: todayStr },
];
const dateTierRanked = rankEventsByProximity(dateTierEvents, 'East Village');
check('today before tomorrow at same distance', dateTierRanked[0].id === 'today');
check('tomorrow still included', dateTierRanked[1].id === 'tmrw');

// No date treated as today-tier
const noDateEvents = [
  { id: 'tmrw2', neighborhood: 'East Village', date_local: tomorrowStr },
  { id: 'nodate', neighborhood: 'East Village' },
];
const noDateRanked = rankEventsByProximity(noDateEvents, 'East Village');
check('no-date event sorts as today tier', noDateRanked[0].id === 'nodate');

// ---- filterUpcomingEvents ----
console.log('\nfilterUpcomingEvents:');

// Pin reference time to 2pm EST to avoid flakiness near midnight
const REF_TIME = (() => {
  const d = new Date();
  d.setUTCHours(19, 0, 0, 0); // 2pm EST = 7pm UTC
  return d.getTime();
})();

function makeTime(hoursFromNow) {
  return new Date(REF_TIME + hoursFromNow * 60 * 60 * 1000).toISOString();
}

const timeEvents = [
  { id: 't1', start_time_local: makeTime(3) },       // future
  { id: 't2', start_time_local: makeTime(-1) },       // 1hr ago (within window)
  { id: 't3', start_time_local: makeTime(-5) },       // 5hrs ago (should be filtered)
  { id: 't4', start_time_local: null },                // no time
  { id: 't5', start_time_local: getNycDateString(1, REF_TIME) }, // date-only (tomorrow)
  { id: 't6', start_time_local: makeTime(-4), end_time_local: makeTime(1) },  // ended but end in future
  { id: 't7', start_time_local: '2020-01-01' },       // date-only past
];
const upcoming = filterUpcomingEvents(timeEvents, { refTimeMs: REF_TIME });
const upIds = upcoming.map(e => e.id);

check('keeps future', upIds.includes('t1'));
check('keeps recent (within 2hr)', upIds.includes('t2'));
check('removes past (5hr ago)', !upIds.includes('t3'));
check('keeps no-time', upIds.includes('t4'));
check('keeps date-only tomorrow', upIds.includes('t5'));
check('keeps event with future end_time', upIds.includes('t6'));
check('removes date-only past', !upIds.includes('t7'));

// ---- parseAsNycTime ----
console.log('\nparseAsNycTime:');

check('ISO with Z parses', !isNaN(parseAsNycTime('2026-02-18T21:00:00Z')));
check('ISO with offset parses', !isNaN(parseAsNycTime('2026-02-18T21:00:00-05:00')));
check('ISO without tz parses (assumes NYC)', !isNaN(parseAsNycTime('2026-02-18T21:00:00')));
check('null → NaN', isNaN(parseAsNycTime(null)));
check('undefined → NaN', isNaN(parseAsNycTime(undefined)));
check('Z and -05:00 differ by offset', Math.abs(parseAsNycTime('2026-02-18T21:00:00Z') - parseAsNycTime('2026-02-18T21:00:00-05:00')) === 5 * 3600 * 1000);

// ---- getEventDate ----
console.log('\ngetEventDate:');

check('event with date_local', getEventDate({ date_local: '2026-02-18' }) === '2026-02-18');
check('event with start_time_local', /^\d{4}-\d{2}-\d{2}$/.test(getEventDate({ start_time_local: '2026-02-18T21:00:00' })));
check('event with neither → null', getEventDate({}) === null);
check('prefers date_local', getEventDate({ date_local: '2026-02-18', start_time_local: '2026-02-19T10:00:00' }) === '2026-02-18');
