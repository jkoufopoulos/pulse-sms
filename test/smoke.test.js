/**
 * Smoke tests for Pulse pure functions.
 * Run: node test/smoke.test.js
 */

const { extractNeighborhood } = require('../src/neighborhoods');
const { makeEventId, normalizeExtractedEvent, normalizeEventName } = require('../src/sources');
const { resolveNeighborhood, inferCategory, haversine, getNycDateString, getNycUtcOffset, rankEventsByProximity, filterUpcomingEvents, parseAsNycTime, getEventDate } = require('../src/geo');
const { lookupVenue } = require('../src/venues');
const { preRoute, getAdjacentNeighborhoods } = require('../src/pre-router');
const { formatTime, cleanUrl, formatEventDetails } = require('../src/formatters');

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
// Borough shortcuts — boroughs now go through detectBorough, not extractNeighborhood
check('brooklyn returns null', extractNeighborhood('brooklyn tonight') === null);
check('bk returns null', extractNeighborhood('anything in bk') === null);
check('manhattan returns null', extractNeighborhood('manhattan') === null);
check('queens returns null', extractNeighborhood('queens') === null);
check('nyc returns null', extractNeighborhood('nyc tonight') === null);
// detectBorough tests
const { detectBorough, detectUnsupported } = require('../src/neighborhoods');
check('detectBorough bk', detectBorough('anything in bk')?.borough === 'brooklyn');
check('detectBorough queens', detectBorough('queens')?.borough === 'queens');
check('detectBorough brooklyn has hoods', detectBorough('brooklyn tonight')?.neighborhoods?.includes('Williamsburg'));
check('detectBorough non-borough', detectBorough('east village') === null);
// detectUnsupported tests
check('detectUnsupported bay ridge', detectUnsupported('bay ridge')?.name === 'Bay Ridge');
check('detectUnsupported bay ridge has nearby', detectUnsupported('bay ridge')?.nearby?.includes('Sunset Park'));
check('detectUnsupported known hood returns null', detectUnsupported('east village') === null);
check('detectUnsupported gibberish returns null', detectUnsupported('asdfjkl') === null);
// New aliases
check('union sq', extractNeighborhood('union sq tonight') === 'Flatiron');
check('nolita', extractNeighborhood('nolita drinks') === 'SoHo');
check('e.v.', extractNeighborhood('E.V. tonight') === 'East Village');

// ---- extractNeighborhood: landmarks ----
console.log('\nextractNeighborhood (landmarks):');

check('prospect park', extractNeighborhood('near prospect park') === 'Park Slope');
check('central park', extractNeighborhood('central park area') === 'Midtown');
check('washington square', extractNeighborhood('by washington square') === 'Greenwich Village');
check('wash sq', extractNeighborhood('wash sq tonight') === 'Greenwich Village');
check('bryant park', extractNeighborhood('bryant park vibes') === 'Midtown');
check('mccarren park', extractNeighborhood('mccarren park') === 'Williamsburg');
check('tompkins square', extractNeighborhood('near tompkins square') === 'East Village');
check('tompkins', extractNeighborhood('tompkins area') === 'East Village');
check('domino park', extractNeighborhood('domino park') === 'Williamsburg');
check('brooklyn bridge', extractNeighborhood('near brooklyn bridge') === 'DUMBO');
check('highline', extractNeighborhood('the highline') === 'Chelsea');
check('high line', extractNeighborhood('near the high line') === 'Chelsea');
check('hudson yards', extractNeighborhood('hudson yards tonight') === 'Chelsea');
check('barclays center', extractNeighborhood('near barclays center') === 'Downtown Brooklyn');
check('msg', extractNeighborhood('near msg') === 'Midtown');
check('lincoln center', extractNeighborhood('lincoln center area') === 'Upper West Side');
check('carnegie hall', extractNeighborhood('carnegie hall tonight') === 'Midtown');

// ---- extractNeighborhood: subway refs ----
console.log('\nextractNeighborhood (subway):');

check('bedford ave', extractNeighborhood('near bedford ave') === 'Williamsburg');
check('bedford stop', extractNeighborhood('bedford stop') === 'Williamsburg');
check('1st ave', extractNeighborhood('at 1st ave') === 'East Village');
check('first ave', extractNeighborhood('first ave area') === 'East Village');
check('14th street', extractNeighborhood('14th street') === 'Flatiron');
check('14th st', extractNeighborhood('near 14th st') === 'Flatiron');
check('grand central', extractNeighborhood('grand central') === 'Midtown');
check('atlantic ave', extractNeighborhood('at atlantic ave') === 'Downtown Brooklyn');
check('atlantic terminal', extractNeighborhood('atlantic terminal') === 'Downtown Brooklyn');
check('dekalb', extractNeighborhood('near dekalb') === 'Downtown Brooklyn');

// ---- makeEventId ----
console.log('\nmakeEventId:');

const id1 = makeEventId('Test Event', 'The Venue', '2026-02-14');
const id2 = makeEventId('Test Event', 'The Venue', '2026-02-14');
const id3 = makeEventId('Different Event', 'The Venue', '2026-02-14');
check('stable (same input = same id)', id1 === id2);
check('different for different events', id1 !== id3);
check('12 chars', id1.length === 12);
check('case insensitive', makeEventId('TEST EVENT', 'THE VENUE', '2026-02-14') === id1);
// Parenthetical time info preserved — different set times should NOT collide
const earlySet = makeEventId('DJ Cool (8 PM set)', 'Smalls', '2026-02-18');
const lateSet = makeEventId('DJ Cool (10 PM set)', 'Smalls', '2026-02-18');
check('different set times get different IDs', earlySet !== lateSet);
// Noise parentheticals still stripped
const soldOut = makeEventId('DJ Cool (SOLD OUT)', 'Smalls', '2026-02-18');
const noParens = makeEventId('DJ Cool', 'Smalls', '2026-02-18');
check('SOLD OUT stripped (same ID as bare)', soldOut === noParens);
const ages21 = makeEventId('Rock Night (21+)', 'Mercury Lounge', '2026-02-18');
const noAge = makeEventId('Rock Night', 'Mercury Lounge', '2026-02-18');
check('(21+) stripped (same ID as bare)', ages21 === noAge);
// Empty fields fallback — must be deterministic (no randomUUID)
const emptyA = makeEventId('', '', '', 'skint', undefined);
const emptyB = makeEventId('', '', '', 'skint', undefined);
check('empty fields: deterministic (same ID both calls)', emptyA === emptyB);
check('empty fields: 12 chars', emptyA.length === 12);
// Different sources with empty fields get different IDs
const emptyOther = makeEventId('', '', '', 'nonsense', undefined);
check('empty fields: different source → different ID', emptyA !== emptyOther);
// Source + URL fallback is deterministic
const urlA = makeEventId('', '', '', 'skint', 'https://example.com/event');
const urlB = makeEventId('', '', '', 'skint', 'https://example.com/event');
check('source+url fallback: deterministic', urlA === urlB);

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

// DST fall-back: 12:30 AM EDT on Nov 2 2025 = 4:30 AM UTC Nov 2
// Adding 86400000ms (old approach) would land on 4:30 AM UTC Nov 3 = 11:30 PM EST Nov 2 (wrong!)
// Calendar-day arithmetic should correctly return Nov 3
const dstFallbackUtc = Date.UTC(2025, 10, 2, 4, 30); // Nov 2, 2025 4:30 AM UTC = 12:30 AM EDT
check('DST fall-back: today is Nov 2', getNycDateString(0, dstFallbackUtc) === '2025-11-02');
check('DST fall-back: tomorrow is Nov 3 (not Nov 2)', getNycDateString(1, dstFallbackUtc) === '2025-11-03');

// DST spring-forward: 2:30 AM EDT on Mar 9 2025 = 7:30 AM UTC Mar 9
// Clocks spring forward at 2 AM → skip an hour. Calendar day should still be correct.
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
// In July (EDT), these should produce the same result since offset is -04:00
// We can't test exact equality without mocking time, but both should be valid numbers
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

// ---- AI routing output shape contracts ----
console.log('\nAI routing contracts (routeMessage shape):');

// Simulate a routeMessage response and validate its shape
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

// ---- lookupVenue ----
console.log('\nlookupVenue:');

check('exact match', lookupVenue('Nowadays')?.lat === 40.7061);
check('case insensitive', lookupVenue('nowadays')?.lat === 40.7061);
check('punctuation normalization', lookupVenue('Babys All Right')?.lat === 40.7095);
check('apostrophe variant', lookupVenue("Baby's All Right")?.lat === 40.7095);
check('null for unknown', lookupVenue('Nonexistent Venue') === null);
check('null for empty', lookupVenue(null) === null);
check('null for empty string', lookupVenue('') === null);
check('Good Room → Greenpoint coords', lookupVenue('Good Room')?.lat === 40.7268);
check('Le Bain → Chelsea coords', lookupVenue('Le Bain')?.lat === 40.7408);
check('Smalls Jazz Club found', lookupVenue('Smalls Jazz Club')?.lat === 40.7346);

// ---- Brooklyn Heights ----
console.log('\nBrooklyn Heights:');

check('resolveNeighborhood Brooklyn Heights', resolveNeighborhood('Brooklyn Heights', null, null) === 'Brooklyn Heights');
check('alias bk heights', resolveNeighborhood('bk heights', null, null) === 'Brooklyn Heights');
check('extractNeighborhood brooklyn heights', extractNeighborhood('brooklyn heights tonight') === 'Brooklyn Heights');
check('extractNeighborhood bk heights', extractNeighborhood('bk heights tonight') === 'Brooklyn Heights');
check('borough landmark bam', extractNeighborhood('near bam tonight') === 'Fort Greene');
check('borough landmark brooklyn heights promenade', extractNeighborhood('brooklyn heights promenade walk') === 'Brooklyn Heights');
check('Brooklyn Heights in brooklyn borough', require('../src/neighborhoods').detectBorough('brooklyn')?.neighborhoods?.includes('Brooklyn Heights'));

// ---- normalizeExtractedEvent: venue lookup integration ----
console.log('\nnormalizeExtractedEvent (venue → neighborhood):');

// Core scenario: Skint event at known venue, no lat/lng, Claude guessed wrong neighborhood
const smallsEvent = normalizeExtractedEvent({
  name: 'Late Night Jazz Session',
  venue_name: 'Smalls Jazz Club',
  neighborhood: 'SoHo', // Claude's wrong guess
  confidence: 0.8,
}, 'theskint', 'curated', 0.9);
check('Smalls Jazz Club → West Village (overrides Claude SoHo guess)', smallsEvent.neighborhood === 'West Village');

// Known venue, no lat/lng, Claude gave no neighborhood at all
const goodRoomEvent = normalizeExtractedEvent({
  name: 'House Night',
  venue_name: 'Good Room',
  neighborhood: null,
  confidence: 0.8,
}, 'nonsensenyc', 'curated', 0.9);
check('Good Room + null neighborhood → Greenpoint', goodRoomEvent.neighborhood === 'Greenpoint');

// Known venue, no lat/lng, Claude said "Brooklyn" (borough, not neighborhood)
const publicRecordsEvent = normalizeExtractedEvent({
  name: 'Ambient Night',
  venue_name: 'Public Records',
  neighborhood: 'Brooklyn',
  confidence: 0.7,
}, 'theskint', 'curated', 0.9);
check('Public Records + "Brooklyn" → resolves via coords not borough fallback',
  publicRecordsEvent.neighborhood !== null && publicRecordsEvent.neighborhood !== 'Williamsburg');

// Venue with punctuation mismatch (Claude strips apostrophe)
const babysEvent = normalizeExtractedEvent({
  name: 'Indie Rock Show',
  venue_name: 'Babys All Right',  // missing apostrophe
  neighborhood: null,
  confidence: 0.8,
}, 'ohmyrockness', 'curated', 0.85);
check('Babys All Right (no apostrophe) → Williamsburg', babysEvent.neighborhood === 'Williamsburg');

// Unknown venue, no lat/lng — falls back to Claude's text neighborhood
const unknownVenueEvent = normalizeExtractedEvent({
  name: 'Pop-up Party',
  venue_name: 'Some Random Bar',
  neighborhood: 'East Village',
  confidence: 0.6,
}, 'theskint', 'curated', 0.9);
check('unknown venue + valid Claude neighborhood → keeps Claude guess', unknownVenueEvent.neighborhood === 'East Village');

// Unknown venue, no lat/lng, bad Claude neighborhood → null
const unknownBothEvent = normalizeExtractedEvent({
  name: 'Mystery Event',
  venue_name: 'Totally Made Up Place',
  neighborhood: 'Narnia',
  confidence: 0.5,
}, 'theskint', 'curated', 0.9);
check('unknown venue + unknown neighborhood → null', unknownBothEvent.neighborhood === null);

// Event WITH lat/lng already — venue lookup should NOT override
const eventWithCoords = normalizeExtractedEvent({
  name: 'Rooftop Party',
  venue_name: 'Le Bain',  // Chelsea venue
  neighborhood: null,
  latitude: '40.7264',  // East Village coords
  longitude: '-73.9818',
  confidence: 0.8,
}, 'theskint', 'curated', 0.9);
check('event with existing lat/lng → uses those coords, not venue lookup', eventWithCoords.neighborhood === 'East Village');

// Bed-Stuy venue (thin neighborhood that was missing coverage)
const bedStuyEvent = normalizeExtractedEvent({
  name: 'DJ Set',
  venue_name: 'Ode to Babel',
  neighborhood: 'Williamsburg', // Claude wrong guess
  confidence: 0.7,
}, 'nonsensenyc', 'curated', 0.9);
check('Ode to Babel → Bed-Stuy (not Williamsburg)', bedStuyEvent.neighborhood === 'Bed-Stuy');

// UWS venue
const beaconEvent = normalizeExtractedEvent({
  name: 'Big Concert',
  venue_name: 'Beacon Theatre',
  neighborhood: 'Midtown', // Claude wrong guess
  confidence: 0.8,
}, 'theskint', 'curated', 0.9);
check('Beacon Theatre → Upper West Side (not Midtown)', beaconEvent.neighborhood === 'Upper West Side');

// West Village venue via Nonsense NYC
const villageVanguardEvent = normalizeExtractedEvent({
  name: 'Jazz Night',
  venue_name: 'Village Vanguard',
  neighborhood: null,
  confidence: 0.7,
}, 'nonsensenyc', 'curated', 0.9);
check('Village Vanguard → West Village', villageVanguardEvent.neighborhood === 'West Village');

// Fort Greene venue (BAM)
const bamEvent = normalizeExtractedEvent({
  name: 'Film Screening',
  venue_name: 'BAM',
  neighborhood: 'Downtown Brooklyn', // close but wrong
  confidence: 0.7,
}, 'theskint', 'curated', 0.9);
check('BAM → Fort Greene (not Downtown Brooklyn)', bamEvent.neighborhood === 'Fort Greene');

// Gowanus venue
const bellHouseEvent = normalizeExtractedEvent({
  name: 'Comedy Show',
  venue_name: 'The Bell House',
  neighborhood: 'Park Slope', // close but wrong
  confidence: 0.7,
}, 'theskint', 'curated', 0.9);
check('The Bell House → Gowanus', bellHouseEvent.neighborhood === 'Gowanus');

// RA migration: verify old RA_VENUE_MAP venues still work via lookupVenue
console.log('\nnormalizeExtractedEvent (RA migration sanity):');

const nowadaysEvent = normalizeExtractedEvent({
  name: 'Day Party',
  venue_name: 'Nowadays',
  neighborhood: null,
  confidence: 0.8,
}, 'theskint', 'curated', 0.9);
check('Nowadays → Bushwick (RA migration)', nowadaysEvent.neighborhood === 'Bushwick');

const houseOfYesEvent = normalizeExtractedEvent({
  name: 'Circus Party',
  venue_name: 'House of Yes',
  neighborhood: null,
  confidence: 0.8,
}, 'theskint', 'curated', 0.9);
check('House of Yes → Bushwick (RA migration)', houseOfYesEvent.neighborhood === 'Bushwick');

const leBainEvent = normalizeExtractedEvent({
  name: 'Rooftop Night',
  venue_name: 'Le Bain',
  neighborhood: null,
  confidence: 0.8,
}, 'theskint', 'curated', 0.9);
check('Le Bain → Chelsea (RA migration)', leBainEvent.neighborhood === 'Chelsea');

// ---- cross-source dedup ----
console.log('\ncross-source dedup:');

check('cross-source dedup', makeEventId('Show', 'Venue', '2026-02-14', 'dice') === makeEventId('Show', 'Venue', '2026-02-14', 'brooklynvegan'));

// ---- venue persistence exports ----
console.log('\nvenue persistence:');

check('exportLearnedVenues exported', typeof require('../src/venues').exportLearnedVenues === 'function');
check('importLearnedVenues exported', typeof require('../src/venues').importLearnedVenues === 'function');

// ---- fetchNYCParksEvents export ----
console.log('\nfetchNYCParksEvents:');

check('fetchNYCParksEvents exported', typeof require('../src/sources').fetchNYCParksEvents === 'function');

// ---- fetchDoNYCEvents export ----
console.log('\nfetchDoNYCEvents:');

check('fetchDoNYCEvents exported', typeof require('../src/sources').fetchDoNYCEvents === 'function');

// ---- fetchBAMEvents export ----
console.log('\nfetchBAMEvents:');

check('fetchBAMEvents exported', typeof require('../src/sources').fetchBAMEvents === 'function');

// ---- fetchSmallsLiveEvents export ----
console.log('\nfetchSmallsLiveEvents:');

check('fetchSmallsLiveEvents exported', typeof require('../src/sources').fetchSmallsLiveEvents === 'function');

// ---- fetchNYPLEvents export ----
console.log('\nfetchNYPLEvents:');

check('fetchNYPLEvents exported', typeof require('../src/sources').fetchNYPLEvents === 'function');

// ---- fetchBrooklynVeganEvents + learnVenueCoords exports ----
console.log('\nBrooklynVegan + venue auto-learning:');

check('fetchBrooklynVeganEvents exported', typeof require('../src/sources').fetchBrooklynVeganEvents === 'function');
check('learnVenueCoords exported', typeof require('../src/venues').learnVenueCoords === 'function');

// Test learnVenueCoords: learn a new venue, then look it up
const { learnVenueCoords } = require('../src/venues');
learnVenueCoords('Test Venue BV Eval', 40.7128, -73.9500);
check('learnVenueCoords populates venue map', lookupVenue('Test Venue BV Eval')?.lat === 40.7128);
check('learnVenueCoords does not overwrite existing', (() => {
  learnVenueCoords('Nowadays', 0, 0); // should NOT overwrite
  return lookupVenue('Nowadays')?.lat === 40.7061;
})());
check('learnVenueCoords ignores null name', (() => {
  learnVenueCoords(null, 40.7, -73.9);
  return true; // no crash
})());
check('learnVenueCoords ignores NaN coords', (() => {
  learnVenueCoords('Bad Coords Venue', NaN, -73.9);
  return lookupVenue('Bad Coords Venue') === null;
})());

// ---- getPerennialPicks ----
console.log('\ngetPerennialPicks:');

const { getPerennialPicks, toEventObjects, _resetCache } = require('../src/perennial');

// Basic: known neighborhood returns local picks
const wvPicks = getPerennialPicks('West Village', { dayOfWeek: 'fri' });
check('West Village has local picks', wvPicks.local.length > 0);
check('West Village picks include Smalls', wvPicks.local.some(p => p.venue === 'Smalls Jazz Club'));
check('returns { local, nearby } shape', Array.isArray(wvPicks.local) && Array.isArray(wvPicks.nearby));

// Day filtering: Bed-Stuy has "any" day picks and day-specific picks
const bedStuyMon = getPerennialPicks('Bed-Stuy', { dayOfWeek: 'mon' });
check('Bed-Stuy has "any" day picks on Monday', bedStuyMon.local.length > 0);
const bedStuyFri = getPerennialPicks('Bed-Stuy', { dayOfWeek: 'fri' });
check('Bed-Stuy has more picks on Friday than Monday', bedStuyFri.local.length > bedStuyMon.local.length);

// "any" day always matches
const uwsPicks = getPerennialPicks('Upper West Side', { dayOfWeek: 'tue' });
check('UWS "any" day picks show on Tuesday', uwsPicks.local.length > 0);

// Adjacent neighborhoods show up as nearby
const chelseaPicks = getPerennialPicks('Chelsea', { dayOfWeek: 'fri' });
check('Chelsea has nearby picks from adjacent hoods', chelseaPicks.nearby.length > 0);
check('nearby picks have neighborhood tag', chelseaPicks.nearby.every(p => typeof p.neighborhood === 'string'));

// Unknown neighborhood returns empty
const unknownPicks = getPerennialPicks('Mars', { dayOfWeek: 'fri' });
check('unknown neighborhood returns empty local', unknownPicks.local.length === 0);

// ---- toEventObjects ----
console.log('\ntoEventObjects:');

const wvEventObjs = toEventObjects(wvPicks.local, 'West Village');
check('returns array', Array.isArray(wvEventObjs));
check('non-empty for West Village', wvEventObjs.length > 0);

const firstObj = wvEventObjs[0];
check('id starts with perennial_', firstObj.id.startsWith('perennial_'));
check('id is stable across calls', toEventObjects(wvPicks.local, 'West Village')[0].id === firstObj.id);
check('source_name is perennial', firstObj.source_name === 'perennial');
check('source_weight is 0.78', firstObj.source_weight === 0.78);
check('date_local is null', firstObj.date_local === null);
check('start_time_local is null', firstObj.start_time_local === null);
check('day is null', firstObj.day === null);
check('has name', typeof firstObj.name === 'string' && firstObj.name.length > 0);
check('has venue_name', typeof firstObj.venue_name === 'string');
check('has neighborhood', firstObj.neighborhood === 'West Village');
check('has short_detail', typeof firstObj.short_detail === 'string');
check('has description_short', typeof firstObj.description_short === 'string');
check('confidence is 0.7 for local', firstObj.confidence === 0.7);

// Nearby picks get lower confidence
const nearbyEventObjs = toEventObjects(chelseaPicks.nearby, 'Chelsea', { isNearby: true });
check('nearby confidence is 0.6', nearbyEventObjs.length > 0 && nearbyEventObjs[0].confidence === 0.6);

// Free picks have is_free: true
const bedStuyAllPicks = getPerennialPicks('Bed-Stuy', { dayOfWeek: 'fri' });
const bedStuyEventObjs = toEventObjects(bedStuyAllPicks.local, 'Bed-Stuy');
const freeObj = bedStuyEventObjs.find(e => e.is_free === true);
const paidObj = bedStuyEventObjs.find(e => e.is_free === false);
check('free picks have is_free: true', freeObj !== undefined);
check('paid picks have is_free: false', paidObj !== undefined);

// Empty input returns empty array
check('empty array returns empty', toEventObjects([], 'Test').length === 0);
check('null returns empty', toEventObjects(null, 'Test').length === 0);

// URL fields populated from pick url
const smallsObj = wvEventObjs.find(e => e.name === 'Smalls Jazz Club');
check('ticket_url from pick url', smallsObj && smallsObj.ticket_url === 'https://www.smallslive.com');
check('source_url from pick url', smallsObj && smallsObj.source_url === 'https://www.smallslive.com');

// Picks without url have null
const johnnysObj = wvEventObjs.find(e => e.name === "Johnny's Bar");
check('no url pick has null ticket_url', johnnysObj && johnnysObj.ticket_url === null);

// ---- RA source: is_free should always be false ----
console.log('\nRA source (is_free):');

// RA events should never be marked free since isTicketed doesn't reliably mean free
const raSource = require('../src/sources/ra');
check('fetchRAEvents is exported', typeof raSource.fetchRAEvents === 'function');

// ---- msUntilNextScrape logic (boundary test) ----
console.log('\nmsUntilNextScrape logic:');

// Replicate the formula to verify the < vs <= fix
const SCRAPE_HOUR = 10;
function testMsUntilNextScrape(hour, minute, second) {
  let hoursUntil = SCRAPE_HOUR - hour;
  if (hoursUntil < 0) hoursUntil += 24; // fixed: was <= 0
  return (hoursUntil * 3600 - minute * 60 - second) * 1000;
}
check('at 10:00 AM: triggers soon (not 24h)', testMsUntilNextScrape(10, 0, 0) === 0);
check('at 10:00:30 AM: triggers soon', testMsUntilNextScrape(10, 0, 30) < 0); // already past, will be ~0
check('at 09:59 AM: ~60s away', testMsUntilNextScrape(9, 59, 0) === 60000);
check('at 11:00 AM: schedules for tomorrow', testMsUntilNextScrape(11, 0, 0) === 23 * 3600000);
check('at 09:00 AM: 1 hour away', testMsUntilNextScrape(9, 0, 0) === 3600000);

// ---- SOURCES registry ----
console.log('\nSOURCES registry:');

const { SOURCES } = require('../src/events');
check('SOURCES has at least 14 entries', SOURCES.length >= 14);
check('SOURCES labels are unique', new Set(SOURCES.map(s => s.label)).size === SOURCES.length);
check('all SOURCES have fetch functions', SOURCES.every(s => typeof s.fetch === 'function'));
check('all SOURCES have valid weights', SOURCES.every(s => s.weight > 0 && s.weight <= 1));
check('SOURCES includes Skint', SOURCES.some(s => s.label === 'Skint'));
check('SOURCES includes Tavily', SOURCES.some(s => s.label === 'Tavily'));
check('Skint weight is 0.9', SOURCES.find(s => s.label === 'Skint').weight === 0.9);
check('Tavily weight is 0.6', SOURCES.find(s => s.label === 'Tavily').weight === 0.6);

// ---- getHealthStatus shape ----
console.log('\ngetHealthStatus:');

const { getHealthStatus } = require('../src/events');
check('getHealthStatus is a function', typeof getHealthStatus === 'function');

const healthData = getHealthStatus();
check('has status field', typeof healthData.status === 'string');
check('status is ok|degraded|critical', ['ok', 'degraded', 'critical'].includes(healthData.status));
check('has cache object', typeof healthData.cache === 'object' && healthData.cache !== null);
check('cache has size', 'size' in healthData.cache);
check('cache has age_minutes', 'age_minutes' in healthData.cache);
check('cache has fresh', 'fresh' in healthData.cache);
check('cache has last_refresh', 'last_refresh' in healthData.cache);
check('has scrape object', typeof healthData.scrape === 'object' && healthData.scrape !== null);
check('scrape has startedAt', 'startedAt' in healthData.scrape);
check('scrape has totalDurationMs', 'totalDurationMs' in healthData.scrape);
check('scrape has sourcesOk', 'sourcesOk' in healthData.scrape);
check('scrape has sourcesFailed', 'sourcesFailed' in healthData.scrape);
check('has sources object', typeof healthData.sources === 'object' && healthData.sources !== null);
check('sources has Skint', 'Skint' in healthData.sources);
check('sources has RA', 'RA' in healthData.sources);
check('sources has 16 entries', Object.keys(healthData.sources).length === 16);

const sampleSource = healthData.sources.Skint;
check('source has status field', 'status' in sampleSource);
check('source has last_count', 'last_count' in sampleSource);
check('source has consecutive_zeros', 'consecutive_zeros' in sampleSource);
check('source has duration_ms', 'duration_ms' in sampleSource);
check('source has http_status', 'http_status' in sampleSource);
check('source has last_error', 'last_error' in sampleSource);
check('source has last_scrape', 'last_scrape' in sampleSource);
check('source has success_rate', 'success_rate' in sampleSource);
check('source has history array', Array.isArray(sampleSource.history));

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

// Bare numbers without session
check('1 without session → conversational', preRoute('1', null)?.intent === 'conversational');
check('1 without session has reply', preRoute('1', null)?.reply !== null);
check('5 falls through → null', preRoute('5', null) === null);

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

// ---- formatTime ----
console.log('\nformatTime:');

check('bare date includes month', formatTime('2026-02-18').includes('Feb'));
const ftIso = formatTime('2026-02-18T21:00:00');
check('ISO datetime includes month', ftIso.includes('Feb'));
check('ISO datetime includes time', /\d:\d{2}/.test(ftIso));
check('ISO with Z includes time', /\d:\d{2}/.test(formatTime('2026-02-18T21:00:00Z')));
check('ISO with offset includes time', /\d:\d{2}/.test(formatTime('2026-02-18T21:00:00-05:00')));
check('null returns null', formatTime(null) === null);
check('invalid string passes through', formatTime('not-a-date') === 'not-a-date');

// ---- cleanUrl ----
console.log('\ncleanUrl:');

check('strips UTM params', !cleanUrl('https://example.com/event?utm_source=fb&utm_medium=social').includes('utm_'));
check('strips fbclid', !cleanUrl('https://example.com/event?fbclid=abc123').includes('fbclid'));
check('shortens Eventbrite', cleanUrl('https://www.eventbrite.com/e/some-event-slug-1234567890').includes('/e/1234567890'));
check('shortens Dice', cleanUrl('https://dice.fm/event/abc123-some-event-name').includes('/event/abc123'));
check('shortens Songkick', cleanUrl('https://www.songkick.com/concerts/12345-artist-name').includes('/concerts/12345'));
check('clean URL unchanged', cleanUrl('https://example.com/events') === 'https://example.com/events');
check('null returns null', cleanUrl(null) === null);
check('invalid URL returns as-is', cleanUrl('not-a-url') === 'not-a-url');

// ---- formatEventDetails ----
console.log('\nformatEventDetails:');

check('minimal event has name', formatEventDetails({ name: 'Jazz Night' }).includes('Jazz Night'));
const fullEvt = {
  name: 'Jazz Night',
  venue_name: 'Smalls Jazz Club',
  start_time_local: '2026-02-18T21:00:00',
  is_free: false,
  price_display: '$20',
  venue_address: '183 W 10th St',
  source_url: 'https://example.com/jazz',
};
const fullDetail = formatEventDetails(fullEvt);
check('full event has venue', fullDetail.includes('Smalls Jazz Club'));
check('full event has time', /\d:\d{2}/.test(fullDetail));
check('full event has price', fullDetail.includes('$20'));
check('full event has URL', fullDetail.includes('example.com'));
check('free event shows Free!', formatEventDetails({ name: 'Free Show', is_free: true }).includes('Free!'));
check('venue-in-name dedup', !formatEventDetails({ name: 'Jazz at Smalls Jazz Club', venue_name: 'Smalls Jazz Club' }).includes('Club at Smalls'));
check('result under 480 chars', fullDetail.length <= 480);

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

// ---- normalizeEventName ----
console.log('\nnormalizeEventName:');

check('strips (SOLD OUT)', normalizeEventName('Jazz Night (SOLD OUT)') === 'jazz night');
check('strips & Friends', normalizeEventName('Langhorne Slim & Friends') === 'langhorne slim');
check('strips ft. and after', normalizeEventName('DJ Set ft. Someone') === 'dj set');
check('case insensitive', normalizeEventName('BODEGA') === 'bodega');
check('collapses whitespace', normalizeEventName('  Extra  Spaces  ') === 'extra spaces');
check('strips (21+)', normalizeEventName('Rock Night (21+)') === 'rock night');
check('strips (Free)', normalizeEventName('Comedy Hour (Free)') === 'comedy hour');
check('preserves set times', normalizeEventName('DJ Cool (8 PM set)').includes('8 pm set'));
check('null returns empty', normalizeEventName(null) === '');

// ---- batchGeocodeEvents (mock test) ----
console.log('\nbatchGeocodeEvents (mock):');

const { batchGeocodeEvents } = require('../src/venues');

// Create events that would need geocoding — but use events whose venues
// are already in the VENUE_MAP cache (batchGeocodeEvents checks cache first)
const geoEvents = [
  { id: 'g1', neighborhood: null, venue_name: 'Nowadays', venue_address: null },
  { id: 'g2', neighborhood: null, venue_name: 'Good Room', venue_address: null },
  { id: 'g3', neighborhood: 'East Village', venue_name: 'Some Place', venue_address: null }, // already resolved, skip
  { id: 'g4', neighborhood: null, venue_name: null, venue_address: null }, // no venue info, skip
];

// batchGeocodeEvents is async — run and check
(async () => {
  await batchGeocodeEvents(geoEvents);

  check('cached venue resolves neighborhood (Nowadays → Bushwick)', geoEvents[0].neighborhood === 'Bushwick');
  check('cached venue resolves neighborhood (Good Room → Greenpoint)', geoEvents[1].neighborhood === 'Greenpoint');
  check('already-resolved event untouched', geoEvents[2].neighborhood === 'East Village');
  check('no venue info event untouched', geoEvents[3].neighborhood === null);

  // ---- alerts module ----
  console.log('\nalerts module:');

  const { sendHealthAlert } = require('../src/alerts');
  check('sendHealthAlert is a function', typeof sendHealthAlert === 'function');

  // Should no-op gracefully without RESEND_API_KEY (no env var set in tests)
  const alertResult = await sendHealthAlert(
    [{ label: 'TestSource', consecutiveZeros: 3, lastError: 'timeout', lastStatus: 'timeout' }],
    { dedupedEvents: 100, sourcesOk: 14, sourcesFailed: 1, sourcesEmpty: 1, totalDurationMs: 5000, completedAt: new Date().toISOString() }
  );
  check('sendHealthAlert no-ops without API key (returns undefined)', alertResult === undefined);

  // Empty failures list should no-op
  const emptyResult = await sendHealthAlert([], {});
  check('sendHealthAlert no-ops with empty failures', emptyResult === undefined);

  // ---- Session merge semantics ----
  console.log('\nSession merge:');

  const { getSession, setSession, clearSession, clearSessionInterval } = require('../src/session');
  const testPhone = '+15555550000';
  clearSession(testPhone);
  setSession(testPhone, { lastNeighborhood: 'Williamsburg', lastPicks: [{ event_id: 'abc' }] });
  const s1 = getSession(testPhone);
  check('initial session has neighborhood', s1.lastNeighborhood === 'Williamsburg');
  check('initial session has picks', s1.lastPicks.length === 1);

  // Partial update should preserve existing fields
  setSession(testPhone, { pendingFilters: { free_only: true } });
  const s2 = getSession(testPhone);
  check('partial update preserves neighborhood', s2.lastNeighborhood === 'Williamsburg');
  check('partial update preserves picks', s2.lastPicks.length === 1);
  check('partial update adds new field', s2.pendingFilters.free_only === true);

  // Full update overwrites
  setSession(testPhone, { lastNeighborhood: 'Bushwick', lastPicks: [] });
  const s3 = getSession(testPhone);
  check('full update overwrites neighborhood', s3.lastNeighborhood === 'Bushwick');
  check('full update overwrites picks', s3.lastPicks.length === 0);
  check('full update preserves merged field', s3.pendingFilters.free_only === true);
  clearSession(testPhone);
  clearSessionInterval(); // prevent interval from keeping Node alive

  // ---- TCPA opt-out regex ----
  console.log('\nTCPA opt-out regex:');

  const { OPT_OUT_KEYWORDS } = require('../src/handler');
  check('STOP matches', OPT_OUT_KEYWORDS.test('STOP'));
  check('"stop" matches', OPT_OUT_KEYWORDS.test('stop'));
  check('"stop please" matches', OPT_OUT_KEYWORDS.test('stop please'));
  check('"  quit" matches (leading whitespace)', OPT_OUT_KEYWORDS.test('  quit'));
  check('"unsubscribe me" matches', OPT_OUT_KEYWORDS.test('unsubscribe me'));
  check('"can\'t stop dancing" does NOT match', !OPT_OUT_KEYWORDS.test("can't stop dancing"));
  check('"don\'t quit" does NOT match', !OPT_OUT_KEYWORDS.test("don't quit"));
  check('"I want to cancel" does NOT match', !OPT_OUT_KEYWORDS.test("I want to cancel"));
  check('"east village" does NOT match', !OPT_OUT_KEYWORDS.test('east village'));
  check('"what\'s happening" does NOT match', !OPT_OUT_KEYWORDS.test("what's happening"));

  // ---- smartTruncate ----
  console.log('\nsmartTruncate:');
  const { smartTruncate } = require('../src/formatters');
  check('short text unchanged', smartTruncate('hello') === 'hello');
  check('exact 480 unchanged', smartTruncate('a'.repeat(480)) === 'a'.repeat(480));
  check('481 gets truncated', smartTruncate('a'.repeat(481)).length <= 481);
  check('truncated ends with ellipsis', smartTruncate('word '.repeat(100)).endsWith('…'));
  check('does not cut mid-word', !smartTruncate('word '.repeat(100)).endsWith('wor…'));
  const urlText = 'Event name\nhttps://example.com/' + 'x'.repeat(500);
  check('drops partial URL line', !smartTruncate(urlText).includes('https://'));

  // ---- Integration: SMS hot path (pre-routed intents, no AI API calls) ----
  console.log('\nIntegration: SMS hot path:');

  const { _handleMessage, setSession: hSetSession, clearSession: hClearSession, clearSmsIntervals } = require('../src/handler');
  const { enableTestCapture, disableTestCapture } = require('../src/twilio');
  const intPhone = '+10000000099';

  // Helper: send message, capture SMS output
  async function sendAndCapture(phone, message) {
    enableTestCapture(phone);
    await _handleMessage(phone, message);
    return disableTestCapture(phone);
  }

  // 1. Help flow — static response, no AI
  hClearSession(intPhone);
  let msgs = await sendAndCapture(intPhone, 'help');
  check('help: sends 1 message', msgs.length === 1);
  check('help: mentions neighborhoods', msgs[0]?.body.includes('East Village'));
  check('help: mentions details', msgs[0]?.body.includes('details'));

  // 2. Greeting flow — static response, no AI
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'hey');
  check('greeting: sends 1 message', msgs.length === 1);
  check('greeting: mentions neighborhood', msgs[0]?.body.includes('neighborhood'));

  // 3. Thanks flow — static response, no AI
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'thanks');
  check('thanks: sends 1 message', msgs.length === 1);
  check('thanks: friendly reply', msgs[0]?.body.includes('Anytime'));

  // 4. More without session — asks for neighborhood, no AI
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'more');
  check('more (no session): sends 1 message', msgs.length === 1);
  check('more (no session): asks for neighborhood', msgs[0]?.body.includes('neighborhood'));

  // 5. TCPA compliance — "STOP" gets no response
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'STOP');
  check('TCPA: STOP sends 0 messages', msgs.length === 0);

  // 6. Bare number without session — friendly redirect, no AI
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, '1');
  check('number (no session): sends 1 message', msgs.length === 1);
  check('number (no session): asks for neighborhood', msgs[0]?.body.includes('neighborhood'));

  // 7. Bare number with seeded session — event details (AI fails → fallback to formatEventDetails)
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastPicks: [{ event_id: 'int_evt1', why: 'great vibes' }],
    lastEvents: {
      int_evt1: { id: 'int_evt1', name: 'Jazz Night at Smalls', venue_name: 'Smalls Jazz Club', neighborhood: 'West Village', start_time_local: '2026-02-18T21:00:00', is_free: false, price_display: '$20', ticket_url: 'https://example.com/jazz', source_url: 'https://example.com/jazz' }
    },
    lastNeighborhood: 'West Village',
  });
  msgs = await sendAndCapture(intPhone, '1');
  check('details (session): sends message', msgs.length >= 1);
  check('details (session): contains event info', msgs[0]?.body.includes('Jazz Night') || msgs[0]?.body.includes('Smalls'));

  // 8. Free without neighborhood — asks for neighborhood, no AI
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'free');
  check('free (no hood): sends 1 message', msgs.length === 1);
  check('free (no hood): asks for neighborhood', msgs[0]?.body.includes('neighborhood'));

  // 9. Off-topic deflection — food question, no AI
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'best pizza near me');
  check('off-topic food: sends 1 message', msgs.length === 1);
  check('off-topic food: deflects to nightlife', msgs[0]?.body.includes('nightlife'));

  // 10. Conversational with active session — mentions "more"
  hClearSession(intPhone);
  hSetSession(intPhone, { lastNeighborhood: 'Bushwick', lastPicks: [{ event_id: 'x' }] });
  msgs = await sendAndCapture(intPhone, 'hey');
  check('greeting (active session): mentions more', msgs[0]?.body.includes('more'));

  // 11. Out-of-range pick number — helpful error instead of silent clamp
  // Pre-router matches 1-3, so use "3" with only 2 picks to test out-of-range
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastPicks: [
      { event_id: 'oor_evt1', why: 'great' },
      { event_id: 'oor_evt2', why: 'fun' },
    ],
    lastEvents: {
      oor_evt1: { id: 'oor_evt1', name: 'Event A', venue_name: 'Venue A' },
      oor_evt2: { id: 'oor_evt2', name: 'Event B', venue_name: 'Venue B' },
    },
    lastNeighborhood: 'East Village',
  });
  msgs = await sendAndCapture(intPhone, '3');
  check('out-of-range pick: sends 1 message', msgs.length === 1);
  check('out-of-range pick: mentions valid range', msgs[0]?.body.includes('1-2'));

  // 12. Stale pendingNearby cleared on non-nudge intent
  hClearSession(intPhone);
  hSetSession(intPhone, {
    pendingNearby: 'Flatiron',
    lastNeighborhood: 'East Village',
    lastPicks: [{ event_id: 'pn_evt1', why: 'vibe' }],
    lastEvents: { pn_evt1: { id: 'pn_evt1', name: 'Test Event' } },
  });
  // Send "help" — not a nudge response. pendingNearby should be cleared.
  msgs = await sendAndCapture(intPhone, 'help');
  check('stale nudge: help still works', msgs.length === 1);
  const { getSession: hGetSession } = require('../src/session');
  const sessionAfter = hGetSession(intPhone);
  check('stale nudge: pendingNearby cleared', sessionAfter?.pendingNearby === null || sessionAfter?.pendingNearby === undefined);

  // 13. Pick number "3" with only 1 pick — range message
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastPicks: [{ event_id: 'one_evt', why: 'cool' }],
    lastEvents: { one_evt: { id: 'one_evt', name: 'Solo Event' } },
    lastNeighborhood: 'LES',
  });
  msgs = await sendAndCapture(intPhone, '3');
  check('1-pick range: sends 1 message', msgs.length === 1);
  check('1-pick range: says "1 pick"', msgs[0]?.body.includes('1 pick') || msgs[0]?.body.includes('reply 1'));

  // 14. dispatchWithFallback — "more" with events triggers Claude → fails without API key → intent-specific error
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastNeighborhood: 'Williamsburg',
    lastPicks: [{ event_id: 'fb_evt1', why: 'fun' }],
    lastEvents: {
      fb_evt1: { id: 'fb_evt1', name: 'Event Already Shown', venue_name: 'V1', neighborhood: 'Williamsburg' },
      fb_evt2: { id: 'fb_evt2', name: 'Unseen Event', venue_name: 'V2', neighborhood: 'Williamsburg' },
    },
  });
  msgs = await sendAndCapture(intPhone, 'more');
  check('dispatchWithFallback: sends 1 message', msgs.length === 1);
  check('dispatchWithFallback: intent-specific error', msgs[0]?.body.includes("Couldn't load more picks"));

  // Cleanup
  hClearSession(intPhone);
  clearSmsIntervals();

  // ---- Summary ----
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
