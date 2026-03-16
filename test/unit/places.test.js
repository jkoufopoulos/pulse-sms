const { check } = require('../helpers');
const { normalizePlace, scorePlaceInterestingness, filterByVibe, serializePlacePoolForContinuation } = require('../../src/places');
const { extractPlacePicksFromSms, deriveIntent } = require('../../src/agent-loop');

// ---- normalizePlace ----
console.log('\nnormalizePlace:');

const googlePlace = {
  id: 'ChIJ_test123',
  displayName: { text: 'The Commodore' },
  formattedAddress: '366 Metropolitan Ave, Brooklyn, NY 11211',
  location: { latitude: 40.7143, longitude: -73.9565 },
  priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
  rating: 4.5,
  userRatingCount: 1200,
  googleMapsUri: 'https://maps.google.com/?cid=123',
  editorialSummary: { text: 'Laid-back bar with Southern-inspired fare' },
  servesBeer: true,
  servesWine: true,
  servesCocktails: true,
  outdoorSeating: true,
  goodForGroups: true,
  liveMusic: false,
  regularOpeningHours: { weekdayDescriptions: ['Mon: 5pm-2am', 'Tue: 5pm-2am'] },
};

const normalized = normalizePlace(googlePlace, 'Williamsburg');
check('normalizePlace: id maps correctly', normalized.place_id === 'ChIJ_test123');
check('normalizePlace: name from displayName.text', normalized.name === 'The Commodore');
check('normalizePlace: address maps', normalized.address === '366 Metropolitan Ave, Brooklyn, NY 11211');
check('normalizePlace: neighborhood set', normalized.neighborhood === 'Williamsburg');
check('normalizePlace: lat maps', normalized.lat === 40.7143);
check('normalizePlace: lng maps', normalized.lng === -73.9565);
check('normalizePlace: price_level converts enum', normalized.price_level === 1);
check('normalizePlace: rating maps', normalized.rating === 4.5);
check('normalizePlace: user_ratings_total maps', normalized.user_ratings_total === 1200);
check('normalizePlace: google_maps_url maps', normalized.google_maps_url === 'https://maps.google.com/?cid=123');
check('normalizePlace: editorial_summary maps', normalized.editorial_summary === 'Laid-back bar with Southern-inspired fare');
check('normalizePlace: serves_beer bool', normalized.serves_beer === true);
check('normalizePlace: serves_cocktails bool', normalized.serves_cocktails === true);
check('normalizePlace: outdoor_seating bool', normalized.outdoor_seating === true);
check('normalizePlace: good_for_groups bool', normalized.good_for_groups === true);
check('normalizePlace: live_music bool', normalized.live_music === false);
check('normalizePlace: open_hours_json array', Array.isArray(normalized.open_hours_json));

// Numeric price level pass-through
const numericPrice = normalizePlace({ id: 'test2', displayName: 'Test', priceLevel: 3 }, 'Bushwick');
check('normalizePlace: numeric price_level passes through', numericPrice.price_level === 3);

// Missing fields
const minimal = normalizePlace({ id: 'test3', displayName: { text: 'Bare Minimum' } }, 'LES');
check('normalizePlace: missing fields default to null/false', minimal.rating === null && minimal.serves_beer === false);

// ---- scorePlaceInterestingness ----
console.log('\nscorePlaceInterestingness:');

const highRated = { rating: 4.8, user_ratings_total: 5000, editorial_summary: 'Great place' };
const lowRated = { rating: 3.0, user_ratings_total: 10 };
check('high rated scores higher', scorePlaceInterestingness(highRated) > scorePlaceInterestingness(lowRated));

const withEditorial = { rating: 4.0, user_ratings_total: 100, editorial_summary: 'Cool spot' };
const withoutEditorial = { rating: 4.0, user_ratings_total: 100 };
check('editorial summary adds score bonus', scorePlaceInterestingness(withEditorial) > scorePlaceInterestingness(withoutEditorial));

const cocktailPlace = { rating: 4.0, user_ratings_total: 100, serves_cocktails: true };
const noVibePlace = { rating: 4.0, user_ratings_total: 100, serves_cocktails: false };
check('vibe match adds bonus', scorePlaceInterestingness(cocktailPlace, 'cocktail') > scorePlaceInterestingness(noVibePlace, 'cocktail'));
check('no vibe filter = no bonus', scorePlaceInterestingness(cocktailPlace, null) === scorePlaceInterestingness(noVibePlace, null));

// ---- filterByVibe ----
console.log('\nfilterByVibe:');

const places = [
  { place_id: 'p1', name: 'Dive Bar', price_level: 1, serves_cocktails: false, outdoor_seating: false, good_for_groups: false, live_music: false, serves_wine: false, rating: 4.0 },
  { place_id: 'p2', name: 'Cocktail Lounge', price_level: 3, serves_cocktails: true, outdoor_seating: false, good_for_groups: false, live_music: false, serves_wine: true, rating: 4.5 },
  { place_id: 'p3', name: 'Beer Garden', price_level: 2, serves_cocktails: false, outdoor_seating: true, good_for_groups: true, live_music: false, serves_wine: false, rating: 4.2 },
  { place_id: 'p4', name: 'Music Venue Bar', price_level: 2, serves_cocktails: true, outdoor_seating: false, good_for_groups: true, live_music: true, serves_wine: true, rating: 4.3 },
];

const diveFiltered = filterByVibe(places, 'dive');
check('dive filter returns low price places', diveFiltered.every(p => p.price_level <= 1));
check('dive filter found 1 match', diveFiltered.length === 1);

const cocktailFiltered = filterByVibe(places, 'cocktail');
check('cocktail filter returns serves_cocktails', cocktailFiltered.every(p => p.serves_cocktails));
check('cocktail filter found 2 matches', cocktailFiltered.length === 2);

const outdoorFiltered = filterByVibe(places, 'outdoor');
check('outdoor filter returns outdoor_seating', outdoorFiltered.every(p => p.outdoor_seating));

const groupFiltered = filterByVibe(places, 'group_friendly');
check('group_friendly filter returns good_for_groups', groupFiltered.every(p => p.good_for_groups));

const musicFiltered = filterByVibe(places, 'live_music');
check('live_music filter returns live_music places', musicFiltered.every(p => p.live_music));

const noMatch = filterByVibe(places, null);
check('null vibe returns all places', noMatch.length === places.length);

const unknownVibe = filterByVibe(places, 'nonexistent');
check('unknown vibe returns all places', unknownVibe.length === places.length);

// Fallback: if vibe matches nothing, return all
const onlyDives = [{ place_id: 'p1', price_level: 1, serves_cocktails: false }];
const dateNightResult = filterByVibe(onlyDives, 'date_night');
check('no vibe matches falls back to all', dateNightResult.length === onlyDives.length);

// ---- serializePlacePoolForContinuation ----
console.log('\nserializePlacePoolForContinuation:');

const serialized = serializePlacePoolForContinuation(places, 'Williamsburg', 'bar', 'cocktail');
check('serialized has neighborhood', serialized.neighborhood === 'Williamsburg');
check('serialized has place_type', serialized.place_type === 'bar');
check('serialized has vibe', serialized.vibe === 'cocktail');
check('serialized has match_count', serialized.match_count === places.length);
check('serialized places have place_id', serialized.places[0].place_id === 'p1');
check('serialized places have name', serialized.places[0].name === 'Dive Bar');

// ---- extractPlacePicksFromSms ----
console.log('\nextractPlacePicksFromSms:');

const testPlaces = [
  { place_id: 'p1', name: 'The Commodore' },
  { place_id: 'p2', name: 'Maison Premiere' },
  { place_id: 'p3', name: 'Union Pool' },
];

const sms1 = 'The Commodore is a vibe — Southern-fried chicken, cheap drinks. Maison Premiere does cocktails if you want something fancier.';
const picks1 = extractPlacePicksFromSms(sms1, testPlaces);
check('extractPlacePicksFromSms: finds 2 places', picks1.length === 2);
check('extractPlacePicksFromSms: first is p1', picks1[0].place_id === 'p1');
check('extractPlacePicksFromSms: second is p2', picks1[1].place_id === 'p2');

check('extractPlacePicksFromSms: empty SMS', extractPlacePicksFromSms('', testPlaces).length === 0);
check('extractPlacePicksFromSms: no matches', extractPlacePicksFromSms('Check out this cool spot', testPlaces).length === 0);

// ---- deriveIntent with unified search for places ----
console.log('\nderiveIntent with search for places:');

check('search bars -> places', deriveIntent([{ name: 'search', params: { intent: 'discover', types: ['bars'] } }]) === 'places');
check('search restaurants -> places', deriveIntent([{ name: 'search', params: { intent: 'discover', types: ['restaurants'] } }]) === 'places');
check('search details -> details', deriveIntent([{ name: 'search', params: { intent: 'details' } }]) === 'details');
check('search more -> more', deriveIntent([{ name: 'search', params: { intent: 'more' } }]) === 'more');

// ---- unified search tool in BRAIN_TOOLS ----
console.log('\nunified search tool definition:');

const { BRAIN_TOOLS } = require('../../src/brain-llm');
const searchTool = BRAIN_TOOLS.find(t => t.name === 'search');
check('search tool exists in BRAIN_TOOLS', !!searchTool);
check('search has types param for bars/restaurants', !!searchTool.parameters.properties.types);
check('search has filters.vibe param', !!searchTool.parameters.properties.filters);
check('search has intent param', !!searchTool.parameters.properties.intent);
check('search requires intent', searchTool.parameters.required.includes('intent'));

// ---- System prompt contains routing guidance ----
console.log('\nSystem prompt places routing:');

const { buildBrainSystemPrompt } = require('../../src/brain-llm');
const prompt = buildBrainSystemPrompt({});
check('prompt contains places routing', prompt.includes('bars') && prompt.includes('restaurants'));
check('prompt contains "best bars" example', prompt.includes('best bars'));
check('prompt contains places in examples', prompt.includes('Commodore') || prompt.includes('bars'));

// ---- Session mutual exclusion ----
console.log('\nSession mutual exclusion:');

const { setResponseState, getSession, setSession, clearSession } = require('../../src/session');
const testPhone = '+10000009999';

// Set up places session
setSession(testPhone, {
  lastPlaces: [{ rank: 1, place_id: 'p1' }],
  lastPlaceMap: { p1: { place_id: 'p1', name: 'Test Bar' } },
  lastResultType: 'places',
});
let s = getSession(testPhone);
check('places saved to session', s.lastResultType === 'places');
check('places has lastPlaces', s.lastPlaces.length === 1);

// Events clearing places via frame (P4: single saveResponseFrame call)
setResponseState(testPhone, {
  picks: [{ rank: 1, event_id: 'e1' }],
  eventMap: { e1: { id: 'e1', name: 'Test Event' } },
  neighborhood: 'Bushwick',
  placePicks: [],
  placeMap: {},
  resultType: 'events',
});
s = getSession(testPhone);
check('events clear place state: lastPlaces empty', s.lastPlaces.length === 0);
check('events clear place state: lastResultType is events', s.lastResultType === 'events');
check('events preserved: lastPicks has event', s.lastPicks.length === 1);

// saveResponseFrame passes place params through to setResponseState
const { saveResponseFrame } = require('../../src/pipeline');
clearSession(testPhone);
setSession(testPhone, {});
saveResponseFrame(testPhone, {
  picks: [],
  eventMap: {},
  neighborhood: 'Williamsburg',
  placePicks: [{ rank: 1, place_id: 'p1' }],
  placeMap: { p1: { place_id: 'p1', name: 'Test Bar' } },
  resultType: 'places',
});
s = getSession(testPhone);
check('saveResponseFrame: placePicks flows to lastPlaces', s.lastPlaces.length === 1);
check('saveResponseFrame: placeMap flows to lastPlaceMap', Object.keys(s.lastPlaceMap).length === 1);
check('saveResponseFrame: resultType flows to lastResultType', s.lastResultType === 'places');

// System prompt includes place context when lastResultType is places
const placeSession = {
  lastResultType: 'places',
  lastPlaces: [{ rank: 1, place_id: 'p1' }],
  lastPlaceMap: { p1: { place_id: 'p1', name: 'The Commodore' } },
};
const placePrompt = buildBrainSystemPrompt(placeSession);
check('system prompt includes place context', placePrompt.includes('Last result: PLACES'));
check('system prompt includes place name', placePrompt.includes('The Commodore'));
check('system prompt includes search routing for details', placePrompt.includes('search with intent'));

// No place context when lastResultType is events
const eventSession = {
  lastResultType: 'events',
  lastPicks: [{ rank: 1, event_id: 'e1' }],
  lastEvents: { e1: { id: 'e1', name: 'Test Event', venue_name: 'Test Venue' } },
};
const eventPrompt = buildBrainSystemPrompt(eventSession);
check('system prompt excludes place context for events', !eventPrompt.includes('Last result: PLACES'));

clearSession(testPhone);
