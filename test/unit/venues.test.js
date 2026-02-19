const { check } = require('../helpers');
const { lookupVenue, learnVenueCoords, batchGeocodeEvents } = require('../../src/venues');

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

// ---- venue persistence exports ----
console.log('\nvenue persistence:');

check('exportLearnedVenues exported', typeof require('../../src/venues').exportLearnedVenues === 'function');
check('importLearnedVenues exported', typeof require('../../src/venues').importLearnedVenues === 'function');

// ---- learnVenueCoords ----
console.log('\nBrooklynVegan + venue auto-learning:');

check('fetchBrooklynVeganEvents exported', typeof require('../../src/sources').fetchBrooklynVeganEvents === 'function');
check('learnVenueCoords exported', typeof require('../../src/venues').learnVenueCoords === 'function');

// Test learnVenueCoords: learn a new venue, then look it up
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

// ---- batchGeocodeEvents (mock test) ----
// Exported as async for runner
module.exports.runAsync = async function() {
  console.log('\nbatchGeocodeEvents (mock):');

  const geoEvents = [
    { id: 'g1', neighborhood: null, venue_name: 'Nowadays', venue_address: null },
    { id: 'g2', neighborhood: null, venue_name: 'Good Room', venue_address: null },
    { id: 'g3', neighborhood: 'East Village', venue_name: 'Some Place', venue_address: null },
    { id: 'g4', neighborhood: null, venue_name: null, venue_address: null },
  ];

  await batchGeocodeEvents(geoEvents);

  check('cached venue resolves neighborhood (Nowadays → Bushwick)', geoEvents[0].neighborhood === 'Bushwick');
  check('cached venue resolves neighborhood (Good Room → Greenpoint)', geoEvents[1].neighborhood === 'Greenpoint');
  check('already-resolved event untouched', geoEvents[2].neighborhood === 'East Village');
  check('no venue info event untouched', geoEvents[3].neighborhood === null);
};
