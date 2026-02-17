/**
 * Venue lookup eval — proves that normalizeExtractedEvent
 * resolves neighborhoods from venue coordinates, not Claude's text guess.
 *
 * Run: node test/venue-eval.js
 */

const { normalizeExtractedEvent } = require('../src/sources');
const { lookupVenue } = require('../src/venues');
const { resolveNeighborhood } = require('../src/geo');

// Simulate realistic Claude-extracted events (no lat/lng, often wrong/missing neighborhood)
const scenarios = [
  // === Thin neighborhoods that were getting dropped or misclassified ===
  {
    label: 'Skint: Jazz at Smalls, Claude said "SoHo"',
    input: { name: 'Late Night Jazz', venue_name: 'Smalls Jazz Club', neighborhood: 'SoHo', confidence: 0.8 },
    source: 'theskint',
    expected_neighborhood: 'West Village',
  },
  {
    label: 'Nonsense: DJ set at Ode to Babel, Claude said "Williamsburg"',
    input: { name: 'Afrobeats Night', venue_name: 'Ode to Babel', neighborhood: 'Williamsburg', confidence: 0.7 },
    source: 'nonsensenyc',
    expected_neighborhood: 'Bed-Stuy',
  },
  {
    label: 'Skint: Concert at Beacon Theatre, Claude said "Midtown"',
    input: { name: 'Bon Iver Live', venue_name: 'Beacon Theatre', neighborhood: 'Midtown', confidence: 0.8 },
    source: 'theskint',
    expected_neighborhood: 'Upper West Side',
  },
  {
    label: 'Skint: Film at BAM, Claude said "Downtown Brooklyn"',
    input: { name: 'BAMcinemaFest Screening', venue_name: 'BAM', neighborhood: 'Downtown Brooklyn', confidence: 0.7 },
    source: 'theskint',
    expected_neighborhood: 'Fort Greene',
  },
  {
    label: 'Nonsense: Comedy at Bell House, Claude said "Park Slope"',
    input: { name: 'Comedy Night', venue_name: 'The Bell House', neighborhood: 'Park Slope', confidence: 0.7 },
    source: 'nonsensenyc',
    expected_neighborhood: 'Gowanus',
  },
  {
    label: 'Skint: Jazz at Village Vanguard, Claude gave null',
    input: { name: 'Monday Night Orchestra', venue_name: 'Village Vanguard', neighborhood: null, confidence: 0.7 },
    source: 'theskint',
    expected_neighborhood: 'West Village',
  },
  {
    label: 'OMR: Show at Warsaw, Claude said "Williamsburg"',
    input: { name: 'Indie Rock Show', venue_name: 'Warsaw', neighborhood: 'Williamsburg', confidence: 0.7 },
    source: 'ohmyrockness',
    expected_neighborhood: 'Greenpoint',
  },
  {
    label: 'Nonsense: Party at Good Room, Claude gave null',
    input: { name: 'House Music All Night', venue_name: 'Good Room', neighborhood: null, confidence: 0.8 },
    source: 'nonsensenyc',
    expected_neighborhood: 'Greenpoint',
  },
  {
    label: 'Skint: Show at Pioneer Works, Claude said "Brooklyn"',
    input: { name: 'Art & Music Night', venue_name: 'Pioneer Works', neighborhood: 'Brooklyn', confidence: 0.6 },
    source: 'theskint',
    expected_neighborhood: 'Red Hook',
  },
  {
    label: 'Skint: Event at Smoke Jazz Club, Claude said "Harlem"',
    input: { name: 'Late Set', venue_name: 'Smoke Jazz Club', neighborhood: 'Harlem', confidence: 0.7 },
    source: 'theskint',
    expected_neighborhood: 'Upper West Side',
  },

  // === Events that SHOULD fall back to Claude's guess (unknown venue) ===
  {
    label: 'Skint: Pop-up at unknown bar, Claude said "East Village"',
    input: { name: 'Pop-up Party', venue_name: 'Some Random Bar', neighborhood: 'East Village', confidence: 0.6 },
    source: 'theskint',
    expected_neighborhood: 'East Village',
  },
  {
    label: 'Nonsense: Event at unknown venue, Claude said "Bushwick"',
    input: { name: 'Warehouse Rave', venue_name: 'Secret Location TBA', neighborhood: 'Bushwick', confidence: 0.5 },
    source: 'nonsensenyc',
    expected_neighborhood: 'Bushwick',
  },

  // === Events with existing coords (should NOT be overridden) ===
  {
    label: 'Skint: Le Bain with EV coords (should use existing coords)',
    input: { name: 'Rooftop Party', venue_name: 'Le Bain', neighborhood: null, latitude: '40.7264', longitude: '-73.9818', confidence: 0.8 },
    source: 'theskint',
    expected_neighborhood: 'East Village',
  },

  // === Punctuation normalization ===
  {
    label: 'OMR: "Babys All Right" (missing apostrophe)',
    input: { name: 'Indie Show', venue_name: 'Babys All Right', neighborhood: null, confidence: 0.8 },
    source: 'ohmyrockness',
    expected_neighborhood: 'Williamsburg',
  },
  {
    label: 'Skint: "Arlenes Grocery" (missing apostrophe)',
    input: { name: 'Rock Show', venue_name: 'Arlenes Grocery', neighborhood: null, confidence: 0.7 },
    source: 'theskint',
    expected_neighborhood: 'Lower East Side',
  },

  // === RA migration sanity ===
  {
    label: 'RA migration: Nowadays',
    input: { name: 'Day Party', venue_name: 'Nowadays', neighborhood: null, confidence: 0.8 },
    source: 'theskint',
    expected_neighborhood: 'Bushwick',
  },
  {
    label: 'RA migration: House of Yes',
    input: { name: 'Circus Night', venue_name: 'House of Yes', neighborhood: null, confidence: 0.8 },
    source: 'theskint',
    expected_neighborhood: 'Bushwick',
  },
  {
    label: 'RA migration: Le Bain (no existing coords)',
    input: { name: 'Rooftop Set', venue_name: 'Le Bain', neighborhood: null, confidence: 0.8 },
    source: 'theskint',
    expected_neighborhood: 'Chelsea',
  },
];

// Run evals
console.log('=== Venue Lookup Eval ===\n');

let pass = 0;
let fail = 0;

for (const s of scenarios) {
  const venueCoords = lookupVenue(s.input.venue_name);
  const hasExistingCoords = !isNaN(parseFloat(s.input.latitude)) && !isNaN(parseFloat(s.input.longitude));
  const result = normalizeExtractedEvent(s.input, s.source, 'curated', 0.9);

  // What would have happened WITHOUT venue lookup (old behavior)?
  const oldNeighborhood = resolveNeighborhood(
    s.input.neighborhood,
    parseFloat(s.input.latitude),
    parseFloat(s.input.longitude)
  );

  const passed = result.neighborhood === s.expected_neighborhood;
  const wasFixed = oldNeighborhood !== result.neighborhood;

  if (passed) pass++;
  else fail++;

  const status = passed ? 'PASS' : 'FAIL';
  const icon = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';

  console.log(`${icon} ${status}: ${s.label}`);
  console.log(`    venue_name:     ${s.input.venue_name}`);
  console.log(`    venue_coords:   ${venueCoords ? `${venueCoords.lat}, ${venueCoords.lng}` : '(not found)'}`);
  console.log(`    had_own_coords: ${hasExistingCoords}`);
  console.log(`    claude_guess:   ${s.input.neighborhood || '(null)'}`);
  console.log(`    old_behavior:   ${oldNeighborhood || '(null)'}`);
  console.log(`    new_result:     ${result.neighborhood || '(null)'}`);
  console.log(`    expected:       ${s.expected_neighborhood}`);
  if (wasFixed && !hasExistingCoords) {
    console.log(`    \x1b[33m↑ FIXED by venue lookup\x1b[0m`);
  }
  console.log('');
}

console.log('---');
console.log(`${pass} passed, ${fail} failed out of ${scenarios.length} scenarios`);

const fixed = scenarios.filter(s => {
  const old = resolveNeighborhood(s.input.neighborhood, parseFloat(s.input.latitude), parseFloat(s.input.longitude));
  const result = normalizeExtractedEvent(s.input, s.source, 'curated', 0.9);
  return old !== result.neighborhood;
});
console.log(`${fixed.length} scenarios were FIXED by venue lookup (would have been wrong before)`);

if (fail > 0) process.exit(1);
