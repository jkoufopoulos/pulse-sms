const { check } = require('../helpers');
const { makeEventId, normalizeExtractedEvent, normalizeEventName } = require('../../src/sources');
const { isGarbageName, remapOtherCategory } = require('../../src/events');

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

// ---- startTime differentiation (#18) ----
console.log('\nmakeEventId with startTime:');

const early = makeEventId('Show', 'Venue', '2026-03-01', 's', null, '2026-03-01T19:00:00');
const late = makeEventId('Show', 'Venue', '2026-03-01', 's', null, '2026-03-01T22:00:00');
check('different startTimes → different IDs', early !== late);
check('startTime IDs are 12 chars', early.length === 12 && late.length === 12);
// Backward compat: no startTime → same ID as before
const noTime = makeEventId('Show', 'Venue', '2026-03-01');
const nullTime = makeEventId('Show', 'Venue', '2026-03-01', null, null, null);
check('no startTime → backward compatible ID', noTime === nullTime);
// Same startTime → same ID
const same1 = makeEventId('Show', 'Venue', '2026-03-01', 's', null, '2026-03-01T19:00:00');
check('same startTime → same ID', early === same1);

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

// ---- scoreInterestingness ----
const { scoreInterestingness } = require('../../src/events');

console.log('\nscoreInterestingness:');

check('discovery one-off intimate = 6', scoreInterestingness({
  source_vibe: 'discovery', is_recurring: false, venue_size: 'intimate', interaction_format: null,
}) === 6);

check('mainstream recurring massive = -3', scoreInterestingness({
  source_vibe: 'mainstream', is_recurring: true, venue_size: 'massive', interaction_format: null,
}) === -3);

check('niche recurring interactive = 3', scoreInterestingness({
  source_vibe: 'niche', is_recurring: true, venue_size: null, interaction_format: 'interactive',
}) === 3);

check('platform one-off unknown venue = 2', scoreInterestingness({
  source_vibe: 'platform', is_recurring: false, venue_size: null, interaction_format: null,
}) === 2);

check('no source_vibe = platform default', scoreInterestingness({
  is_recurring: false, venue_size: 'medium',
}) === 2);

check('editorial_signal adds +2', scoreInterestingness({
  source_vibe: 'discovery', is_recurring: false, venue_size: 'intimate', editorial_signal: true,
}) === 8);

check('scarcity adds +2', scoreInterestingness({
  source_vibe: 'discovery', is_recurring: false, venue_size: 'intimate', scarcity: 'one-night-only',
}) === 8);

check('editorial + scarcity adds +4', scoreInterestingness({
  source_vibe: 'discovery', is_recurring: false, venue_size: 'intimate', editorial_signal: true, scarcity: 'closing',
}) === 10);

check('no editorial/scarcity = no bonus', scoreInterestingness({
  source_vibe: 'discovery', is_recurring: false, venue_size: 'intimate', editorial_signal: false, scarcity: null,
}) === 6);

// ---- selectDiversePicks ----
const { selectDiversePicks } = require('../../src/events');

console.log('\nselectDiversePicks:');

const scoredPool = [
  { id: '1', category: 'comedy', interestingness: 6 },
  { id: '2', category: 'comedy', interestingness: 5 },
  { id: '3', category: 'live_music', interestingness: 5 },
  { id: '4', category: 'art', interestingness: 4 },
  { id: '5', category: 'comedy', interestingness: 4 },
  { id: '6', category: 'nightlife', interestingness: 3 },
];

const picks = selectDiversePicks(scoredPool, 3);
check('returns 3 picks', picks.length === 3);
check('first pick is highest score', picks[0].id === '1');
check('no two picks share a category', new Set(picks.map(p => p.category)).size === 3);

const twoCategories = [
  { id: '1', category: 'comedy', interestingness: 6 },
  { id: '2', category: 'comedy', interestingness: 5 },
  { id: '3', category: 'comedy', interestingness: 4 },
];
const picks2 = selectDiversePicks(twoCategories, 3);
check('fills from best remaining when diversity exhausted', picks2.length === 3);

check('empty pool returns empty', selectDiversePicks([], 3).length === 0);

// ---- scoreSurprise ----
const { scoreSurprise } = require('../../src/events');
console.log('\nscoreSurprise:');

check('discovery + one-night-only + interactive = high surprise', scoreSurprise({
  source_vibe: 'discovery', scarcity: 'one-night-only', interaction_format: 'interactive', venue_size: 'intimate',
}) >= 7);

check('mainstream recurring passive = 0 surprise', scoreSurprise({
  source_vibe: 'mainstream', scarcity: null, interaction_format: 'passive', venue_size: 'large',
}) === 0);

check('niche participatory = moderate surprise', (() => {
  const s = scoreSurprise({ source_vibe: 'niche', interaction_format: 'participatory' });
  return s >= 2 && s <= 4;
})());

check('capped at 10', scoreSurprise({
  source_vibe: 'discovery', scarcity: 'one-night-only', interaction_format: 'interactive', venue_size: 'intimate',
}, { sessionCount: 5, categories: { jazz: 10 }, neighborhoods: { bushwick: 10 } }) <= 10);

// With profile: unfamiliar category adds surprise
const profile = { sessionCount: 3, categories: { jazz: 10, comedy: 5 }, neighborhoods: { bushwick: 10 } };
const familiarCat = scoreSurprise({ source_vibe: 'discovery', category: 'jazz' }, profile);
const unfamiliarCat = scoreSurprise({ source_vibe: 'discovery', category: 'art' }, profile);
check('unfamiliar category scores higher than familiar', unfamiliarCat > familiarCat);

// With profile: unfamiliar neighborhood adds surprise
const familiarHood = scoreSurprise({ source_vibe: 'discovery', neighborhood: 'bushwick' }, profile);
const unfamiliarHood = scoreSurprise({ source_vibe: 'discovery', neighborhood: 'les' }, profile);
check('unfamiliar neighborhood scores higher than familiar', unfamiliarHood > familiarHood);

// No profile = no profile bonus
const noProfile = scoreSurprise({ source_vibe: 'discovery', category: 'art', neighborhood: 'les' }, null);
const newUser = scoreSurprise({ source_vibe: 'discovery', category: 'art', neighborhood: 'les' }, { sessionCount: 1 });
check('no profile and new user get same score', noProfile === newUser);

// ---- isGarbageName ----
console.log('\nisGarbageName:');
check('rejects "Day & Date: Friday, March 7, 2026"', isGarbageName('Day & Date: Friday, March 7, 2026'));
check('rejects "Day + Date: Saturday"', isGarbageName('Day + Date: Saturday'));
check('rejects bare date "Friday, March 7, 2026"', isGarbageName('Friday, March 7, 2026'));
check('rejects bare date "March 7, 2026"', isGarbageName('March 7, 2026'));
check('rejects empty string', isGarbageName(''));
check('rejects null', isGarbageName(null));
check('rejects short name "DJ"', isGarbageName('DJ'));
check('keeps real event "Blade Rave"', !isGarbageName('Blade Rave'));
check('keeps real event "Femme Photographers"', !isGarbageName('Femme Photographers'));
check('keeps "March of the Penguins" (month word in real name)', !isGarbageName('March of the Penguins'));
check('keeps "Friday Night Lights"', !isGarbageName('Friday Night Lights'));
check('rejects "Release date: April 1, 2026"', isGarbageName('Release date: April 1, 2026'));
check('rejects "Film at Lincoln Center"', isGarbageName('Film at Lincoln Center'));
check('rejects "Art at The Shed"', isGarbageName('Art at The Shed'));
check('rejects "Music at The Bell House"', isGarbageName('Music at The Bell House'));
check('keeps "Jazz at Lincoln Center Orchestra"', !isGarbageName('Jazz at Lincoln Center Orchestra'));
check('keeps "Blade Rave at Elsewhere"', !isGarbageName('Blade Rave at Elsewhere'));
check('keeps "Live Music at Brooklyn Bowl"', !isGarbageName('Live Music at Brooklyn Bowl'));
check('keeps "Film Forum Double Feature"', !isGarbageName('Film Forum Double Feature'));

// ---- remapOtherCategory ----
console.log('\nremapOtherCategory:');

// Should remap known patterns
check('sound bath → community', remapOtherCategory({ category: 'other', name: 'Sound Bath at the Studio' }).category === 'community');
check('meditation → community', remapOtherCategory({ category: 'other', name: 'Full Moon Meditation Circle' }).category === 'community');
check('zine fair → community', remapOtherCategory({ category: 'other', name: 'Brooklyn Zine Fair 2026' }).category === 'community');
check('popup market → community', remapOtherCategory({ category: 'other', name: 'Vintage Popup Market' }).category === 'community');
check('flea market → community', remapOtherCategory({ category: 'other', name: 'Fort Greene Flea' }).category === 'community');
check('immersive theater → theater', remapOtherCategory({ category: 'other', name: 'Immersive Theater Experience' }).category === 'theater');
check('performance art → theater', remapOtherCategory({ category: 'other', name: 'Performance Art Night' }).category === 'theater');
check('film screening → film', remapOtherCategory({ category: 'other', name: 'Short Film Screening' }).category === 'film');
check('movie night → film', remapOtherCategory({ category: 'other', name: 'Outdoor Movie Night' }).category === 'film');
check('documentary → film', remapOtherCategory({ category: 'other', name: 'Documentary Premiere' }).category === 'film');
check('vinyl night → nightlife', remapOtherCategory({ category: 'other', name: 'Vinyl Night at Mood Ring' }).category === 'nightlife');
check('dance party → nightlife', remapOtherCategory({ category: 'other', name: 'Disco Dance Party' }).category === 'nightlife');
check('dj set → nightlife', remapOtherCategory({ category: 'other', name: 'Late Night DJ Set' }).category === 'nightlife');
check('jazz → live_music', remapOtherCategory({ category: 'other', name: 'Jazz Jam Session' }).category === 'live_music');
check('acoustic → live_music', remapOtherCategory({ category: 'other', name: 'Acoustic Night' }).category === 'live_music');
check('live band → live_music', remapOtherCategory({ category: 'other', name: 'Live Band Showcase' }).category === 'live_music');
check('trivia → trivia', remapOtherCategory({ category: 'other', name: 'Tuesday Trivia Night' }).category === 'trivia');
check('quiz night → trivia', remapOtherCategory({ category: 'other', name: 'Pub Quiz Night' }).category === 'trivia');
check('game night → trivia', remapOtherCategory({ category: 'other', name: 'Board Game Night' }).category === 'trivia');
check('gallery opening → art', remapOtherCategory({ category: 'other', name: 'Gallery Opening Reception' }).category === 'art');
check('art exhibition → art', remapOtherCategory({ category: 'other', name: 'New Art Exhibition' }).category === 'art');
check('book reading → spoken_word', remapOtherCategory({ category: 'other', name: 'Book Reading & Signing' }).category === 'spoken_word');
check('poetry slam → spoken_word', remapOtherCategory({ category: 'other', name: 'Poetry Slam Night' }).category === 'spoken_word');
check('storytelling → spoken_word', remapOtherCategory({ category: 'other', name: 'Storytelling Open Mic' }).category === 'spoken_word');
check('wine tasting → food_drink', remapOtherCategory({ category: 'other', name: 'Natural Wine Tasting' }).category === 'food_drink');
check('supper club → food_drink', remapOtherCategory({ category: 'other', name: 'Underground Supper Club' }).category === 'food_drink');
check('food popup → food_drink', remapOtherCategory({ category: 'other', name: 'Thai Food Popup' }).category === 'food_drink');

// Should NOT remap non-other categories
check('comedy stays comedy', remapOtherCategory({ category: 'comedy', name: 'Stand-up Night' }).category === 'comedy');

// Should leave genuinely unknown "other" alone
check('unknown stays other', remapOtherCategory({ category: 'other', name: 'Mysterious Gathering 2026' }).category === 'other');
// Gala fundraiser should remap to community
check('gala remaps to community', remapOtherCategory({ category: 'other', name: 'Annual Gala Fundraiser' }).category === 'community');

// Should also check description_short
check('description match works', remapOtherCategory({ category: 'other', name: 'Special Event', description_short: 'An evening of jazz and cocktails' }).category === 'live_music');

// Returns the same object (mutates in place)
const remapEvt = { category: 'other', name: 'Trivia Tuesday' };
check('returns same object', remapOtherCategory(remapEvt) === remapEvt);
