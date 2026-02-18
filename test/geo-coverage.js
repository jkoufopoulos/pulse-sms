/**
 * Diagnostic: how many events resolve neighborhoods at each stage?
 * Runs all sources, counts resolution rates before and after geocoding.
 *
 * Run: node test/geo-coverage.js
 */

const { fetchSkintEvents, fetchEventbriteEvents, fetchSongkickEvents, fetchDiceEvents, fetchRAEvents, fetchNonsenseNYC, fetchOhMyRockness, fetchEventbriteComedy, fetchEventbriteArts, fetchNYCParksEvents, fetchBrooklynVeganEvents, fetchDoNYCEvents, fetchBAMEvents, fetchSmallsLiveEvents, fetchNYPLEvents, searchTavilyEvents } = require('../src/sources');
const { batchGeocodeEvents } = require('../src/venues');

async function main() {
  console.log('Fetching all sources...\n');

  const results = await Promise.allSettled([
    fetchSkintEvents(),
    fetchEventbriteEvents(),
    fetchSongkickEvents(),
    fetchRAEvents(),
    fetchDiceEvents(),
    fetchNonsenseNYC(),
    fetchOhMyRockness(),
    fetchEventbriteComedy(),
    fetchEventbriteArts(),
    fetchNYCParksEvents(),
    fetchBrooklynVeganEvents(),
    fetchDoNYCEvents(),
    fetchBAMEvents(),
    fetchSmallsLiveEvents(),
    fetchNYPLEvents(),
    searchTavilyEvents('free events NYC tonight'),
  ]);

  const labels = [
    'Skint', 'Eventbrite', 'Songkick', 'RA', 'Dice',
    'NonsenseNYC', 'OhMyRockness', 'EB Comedy', 'EB Arts',
    'NYC Parks', 'BrooklynVegan',
    'DoNYC', 'BAM', 'SmallsLIVE', 'NYPL', 'Tavily',
  ];

  const allEvents = [];

  console.log('\n=== Per-Source Neighborhood Coverage (before geocoding) ===\n');
  console.log('Source'.padEnd(18) + 'Total'.padStart(6) + 'Resolved'.padStart(10) + 'Missing'.padStart(9) + '  Rate');
  console.log('-'.repeat(55));

  for (let i = 0; i < results.length; i++) {
    const events = results[i].status === 'fulfilled' ? results[i].value : [];
    const resolved = events.filter(e => e.neighborhood);
    const missing = events.filter(e => !e.neighborhood);
    const rate = events.length > 0 ? ((resolved.length / events.length) * 100).toFixed(0) + '%' : 'n/a';

    console.log(
      labels[i].padEnd(18) +
      String(events.length).padStart(6) +
      String(resolved.length).padStart(10) +
      String(missing.length).padStart(9) +
      '  ' + rate
    );

    allEvents.push(...events);
  }

  const totalResolved = allEvents.filter(e => e.neighborhood).length;
  const totalMissing = allEvents.filter(e => !e.neighborhood).length;
  console.log('-'.repeat(55));
  console.log(
    'TOTAL'.padEnd(18) +
    String(allEvents.length).padStart(6) +
    String(totalResolved).padStart(10) +
    String(totalMissing).padStart(9) +
    '  ' + ((totalResolved / allEvents.length) * 100).toFixed(0) + '%'
  );

  // Show unresolved events
  const unresolved = allEvents.filter(e => !e.neighborhood);
  if (unresolved.length > 0) {
    console.log(`\n=== ${unresolved.length} Unresolved Events (need geocoding) ===\n`);

    // Group by source
    const bySource = {};
    for (const e of unresolved) {
      const src = e.source_name;
      if (!bySource[src]) bySource[src] = [];
      bySource[src].push(e);
    }

    for (const [src, events] of Object.entries(bySource)) {
      console.log(`  [${src}]`);
      for (const e of events.slice(0, 10)) {
        console.log(`    "${e.name}" at ${e.venue_name || '(no venue)'} — ${e.venue_address || '(no address)'}`);
      }
      if (events.length > 10) console.log(`    ... and ${events.length - 10} more`);
      console.log();
    }
  }

  // Run geocoding
  console.log('=== Running Nominatim geocoding ===\n');
  await batchGeocodeEvents(allEvents);

  const afterResolved = allEvents.filter(e => e.neighborhood).length;
  const afterMissing = allEvents.filter(e => !e.neighborhood).length;
  const geocoded = afterResolved - totalResolved;

  console.log(`\n=== After Geocoding ===\n`);
  console.log(`Before:    ${totalResolved}/${allEvents.length} resolved (${((totalResolved / allEvents.length) * 100).toFixed(0)}%)`);
  console.log(`Geocoded:  ${geocoded} new resolutions`);
  console.log(`After:     ${afterResolved}/${allEvents.length} resolved (${((afterResolved / allEvents.length) * 100).toFixed(0)}%)`);
  console.log(`Still unresolved: ${afterMissing}`);

  // Show what's still unresolved
  const stillMissing = allEvents.filter(e => !e.neighborhood);
  if (stillMissing.length > 0) {
    console.log(`\n=== Still Unresolved After Geocoding ===\n`);
    for (const e of stillMissing.slice(0, 20)) {
      console.log(`  [${e.source_name}] "${e.name}" at ${e.venue_name || '(no venue)'} — ${e.venue_address || '(no address)'}`);
    }
    if (stillMissing.length > 20) console.log(`  ... and ${stillMissing.length - 20} more`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
