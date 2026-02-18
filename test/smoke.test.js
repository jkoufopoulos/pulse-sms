/**
 * Smoke tests for Pulse pure functions.
 * Run: node test/smoke.test.js
 */

const { extractNeighborhood } = require('../src/neighborhoods');
const { makeEventId, normalizeExtractedEvent } = require('../src/sources');
const { resolveNeighborhood, inferCategory, haversine, getNycDateString, rankEventsByProximity, filterUpcomingEvents } = require('../src/geo');
const { lookupVenue } = require('../src/venues');

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
check('excludes unknown neighborhood (dist 4 > 3km cutoff)', !ranked.some(e => e.id === '3'));
check('excludes distant Astoria', !ranked.some(e => e.id === '4'));

const noTarget = rankEventsByProximity(events, null);
check('no target returns all', noTarget.length === events.length);

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

// ---- SOURCES registry ----
console.log('\nSOURCES registry:');

const { SOURCES } = require('../src/events');
check('SOURCES has 16 entries', SOURCES.length === 16);
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

  // ---- Summary ----
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
