const { check } = require('../helpers');
const { makeEventId, normalizeExtractedEvent, normalizeEventName } = require('../../src/sources');

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
