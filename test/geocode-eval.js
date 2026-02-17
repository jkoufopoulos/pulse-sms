/**
 * Geocode eval — proves that Nominatim geocoding resolves venues
 * that the hardcoded VENUE_MAP misses.
 *
 * Uses LIVE Nominatim API calls (rate-limited to 1 req/sec).
 * Run: node test/geocode-eval.js
 */

const { geocodeVenue, lookupVenue } = require('../src/venues');
const { resolveNeighborhood } = require('../src/geo');

const scenarios = [
  // Venues NOT in VENUE_MAP — geocoding should resolve them
  {
    label: 'Address-based: 56-06 Cooper Ave (Nowadays area)',
    venue_name: null,
    venue_address: '56-06 Cooper Ave, Queens',
    expected_near: { lat: 40.71, lng: -73.92 },
    expected_in_nyc: true,
  },
  {
    label: 'Name-based: Barclays Center',
    venue_name: 'Barclays Center',
    venue_address: null,
    expected_near: { lat: 40.68, lng: -73.98 },
    expected_in_nyc: true,
  },
  {
    label: 'Address-based: 545 West 30th St (The Shed area)',
    venue_name: null,
    venue_address: '545 West 30th St, Manhattan',
    expected_near: { lat: 40.75, lng: -74.00 },
    expected_in_nyc: true,
  },
  {
    label: 'Address-based: 150 Myrtle Ave Brooklyn',
    venue_name: null,
    venue_address: '150 Myrtle Ave, Brooklyn',
    expected_near: { lat: 40.69, lng: -73.98 },
    expected_in_nyc: true,
  },
  {
    label: 'Name-based: Pier 17',
    venue_name: 'Pier 17',
    venue_address: null,
    expected_near: { lat: 40.71, lng: -74.00 },
    expected_in_nyc: true,
  },
  {
    label: 'Address-based: 89 South St (Pier 17 area)',
    venue_name: null,
    venue_address: '89 South St, Manhattan',
    expected_near: { lat: 40.71, lng: -74.00 },
    expected_in_nyc: true,
  },
];

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  console.log('=== Geocode Eval (live Nominatim calls) ===\n');

  let pass = 0;
  let fail = 0;

  for (const s of scenarios) {
    // Check that venue map does NOT have this
    const inMap = s.venue_name ? lookupVenue(s.venue_name) : null;

    await sleep(1100); // respect rate limit
    const coords = await geocodeVenue(s.venue_name, s.venue_address);
    const neighborhood = coords ? resolveNeighborhood(null, coords.lat, coords.lng) : null;

    const closeEnough = coords
      ? haversine(coords.lat, coords.lng, s.expected_near.lat, s.expected_near.lng) < 3
      : false;

    const passed = s.expected_in_nyc ? (coords !== null && closeEnough) : coords === null;

    if (passed) pass++;
    else fail++;

    const icon = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const status = passed ? 'PASS' : 'FAIL';

    console.log(`${icon} ${status}: ${s.label}`);
    console.log(`    in_venue_map:  ${inMap ? 'yes' : 'no'}`);
    console.log(`    geocoded:      ${coords ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : '(null)'}`);
    console.log(`    expected_near: ${s.expected_near.lat}, ${s.expected_near.lng}`);
    console.log(`    distance_km:   ${coords ? haversine(coords.lat, coords.lng, s.expected_near.lat, s.expected_near.lng).toFixed(2) : 'n/a'}`);
    console.log(`    neighborhood:  ${neighborhood || '(null)'}`);
    console.log('');
  }

  console.log('---');
  console.log(`${pass} passed, ${fail} failed out of ${scenarios.length} scenarios`);

  if (fail > 0) process.exit(1);
})();
