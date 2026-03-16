const { check } = require('../helpers');
const { resolveVenueAlias, lookupVenue, VENUE_ALIASES } = require('../../src/venues');
const { makeEventId, normalizeExtractedEvent } = require('../../src/sources/shared');

// ---- resolveVenueAlias ----
console.log('\nresolveVenueAlias:');

check('maps "Avant Gardner" → "Brooklyn Mirage"', resolveVenueAlias('Avant Gardner') === 'Brooklyn Mirage');
check('maps "The Brooklyn Mirage" → "Brooklyn Mirage"', resolveVenueAlias('The Brooklyn Mirage') === 'Brooklyn Mirage');
check('case insensitive alias', resolveVenueAlias('AVANT GARDNER') === 'Brooklyn Mirage');
check('maps "Le Poisson Rouge" → "(Le) Poisson Rouge"', resolveVenueAlias('Le Poisson Rouge') === '(Le) Poisson Rouge');
check('maps "LPR" → "(Le) Poisson Rouge"', resolveVenueAlias('LPR') === '(Le) Poisson Rouge');
check('maps "BAM Howard Gilman Opera House" → "BAM"', resolveVenueAlias('BAM Howard Gilman Opera House') === 'BAM');
check('maps "BAM Harvey Theater" → "BAM"', resolveVenueAlias('BAM Harvey Theater') === 'BAM');
check('maps "BAM (Brooklyn Academy of Music)" → "BAM"', resolveVenueAlias('BAM (Brooklyn Academy of Music)') === 'BAM');
check('maps "The Lot Radio" → "Lot Radio"', resolveVenueAlias('The Lot Radio') === 'Lot Radio');
check('maps "Nitehawk Cinema Williamsburg" → "Nitehawk Cinema"', resolveVenueAlias('Nitehawk Cinema Williamsburg') === 'Nitehawk Cinema');
check('maps "Alamo Drafthouse Downtown Brooklyn" → "Alamo Drafthouse"', resolveVenueAlias('Alamo Drafthouse Downtown Brooklyn') === 'Alamo Drafthouse');
check('maps "Friends & Lovers" → "Friends and Lovers"', resolveVenueAlias('Friends & Lovers') === 'Friends and Lovers');
check('maps "babys all right" → "Baby\'s All Right"', resolveVenueAlias('babys all right') === "Baby's All Right");
check('maps "The Roxy Cinema" → "Roxy Cinema"', resolveVenueAlias('The Roxy Cinema') === 'Roxy Cinema');
check('maps "Smoke Jazz & Supper Club" → "Smoke Jazz Club"', resolveVenueAlias('Smoke Jazz & Supper Club') === 'Smoke Jazz Club');
check('maps "The Bowery Ballroom" → "Bowery Ballroom"', resolveVenueAlias('The Bowery Ballroom') === 'Bowery Ballroom');
check('maps "BRIC House Media Center" → "BRIC"', resolveVenueAlias('BRIC House Media Center') === 'BRIC');
check('maps "Eris Main Stage" → "Eris"', resolveVenueAlias('Eris Main Stage') === 'Eris');
check('maps "Fabrik Dumbo" → "Fabrik"', resolveVenueAlias('Fabrik Dumbo') === 'Fabrik');
check('maps "Strand Bookstore" → "Strand Book Store"', resolveVenueAlias('Strand Bookstore') === 'Strand Book Store');

// Non-aliases pass through unchanged
check('unknown venue returns unchanged', resolveVenueAlias('Some Random Venue') === 'Some Random Venue');
check('canonical name returns unchanged', resolveVenueAlias('Brooklyn Mirage') === 'Brooklyn Mirage');
check('null returns null', resolveVenueAlias(null) === null);
check('undefined returns undefined', resolveVenueAlias(undefined) === undefined);

// ---- lookupVenue with aliases ----
console.log('\nlookupVenue with alias resolution:');

check('Avant Gardner resolves via alias to Brooklyn Mirage coords', lookupVenue('Avant Gardner')?.lat === 40.7060);
check('The Brooklyn Mirage resolves via alias', lookupVenue('The Brooklyn Mirage')?.lat === 40.7060);
check('LPR resolves to (Le) Poisson Rouge coords', lookupVenue('LPR')?.lat === 40.7296);
check('BAM (Brooklyn Academy of Music) resolves to BAM coords', lookupVenue('BAM (Brooklyn Academy of Music)')?.lat === 40.6861);
check('The Lot Radio resolves to Lot Radio coords', lookupVenue('The Lot Radio')?.lat === 40.7116);
check('Friends & Lovers resolves to Friends and Lovers coords', lookupVenue('Friends & Lovers')?.lat === 40.6747);

// ---- Dedup: aliased venues produce same event ID ----
console.log('\ndedup via alias (same event ID):');

const id1 = makeEventId('Test Show', 'Avant Gardner', '2025-07-01', 'ra', null, null);
const id2 = makeEventId('Test Show', 'Brooklyn Mirage', '2025-07-01', 'ra', null, null);
const id3 = makeEventId('Test Show', 'The Brooklyn Mirage', '2025-07-01', 'ra', null, null);
// Note: makeEventId lowercases venue; alias resolution happens in normalizeExtractedEvent,
// not in makeEventId itself. So id1, id2, id3 may differ. The dedup benefit comes from
// normalizeExtractedEvent canonicalizing venue_name before calling makeEventId.

// Test that normalizeExtractedEvent canonicalizes venue_name
const ev1 = normalizeExtractedEvent(
  { name: 'Test Show', venue_name: 'Avant Gardner', date_local: '2025-07-01' },
  'ra', 'scraper', 1.0
);
const ev2 = normalizeExtractedEvent(
  { name: 'Test Show', venue_name: 'The Brooklyn Mirage', date_local: '2025-07-01' },
  'ra', 'scraper', 1.0
);
const ev3 = normalizeExtractedEvent(
  { name: 'Test Show', venue_name: 'Brooklyn Mirage', date_local: '2025-07-01' },
  'ra', 'scraper', 1.0
);
check('Avant Gardner and Brooklyn Mirage produce same event ID', ev1.id === ev3.id);
check('The Brooklyn Mirage and Brooklyn Mirage produce same event ID', ev2.id === ev3.id);
check('venue_name normalized to canonical in output', ev1.venue_name === 'Brooklyn Mirage');
check('venue_name normalized to canonical in output (variant 2)', ev2.venue_name === 'Brooklyn Mirage');

// Test LPR alias dedup
const evLpr1 = normalizeExtractedEvent(
  { name: 'Jazz Night', venue_name: 'LPR', date_local: '2025-07-01' },
  'skint', 'scraper', 0.8
);
const evLpr2 = normalizeExtractedEvent(
  { name: 'Jazz Night', venue_name: '(Le) Poisson Rouge', date_local: '2025-07-01' },
  'ra', 'scraper', 1.0
);
check('LPR and (Le) Poisson Rouge produce same event ID', evLpr1.id === evLpr2.id);

// ---- VENUE_ALIASES export ----
console.log('\nVENUE_ALIASES export:');
check('VENUE_ALIASES is exported', typeof VENUE_ALIASES === 'object');
check('VENUE_ALIASES has entries', Object.keys(VENUE_ALIASES).length > 10);
