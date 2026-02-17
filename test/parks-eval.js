/**
 * Live eval for NYC Parks event source.
 * Fetches page 1 from nycgovparks.org, parses Schema.org microdata,
 * and validates the extraction pipeline.
 *
 * Run: node test/parks-eval.js
 */

const cheerio = require('cheerio');
const { resolveNeighborhood, getNycDateString, inferCategory } = require('../src/geo');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html',
};

async function main() {
  console.log('NYC Parks Events — Live Eval\n');

  const today = getNycDateString(0);
  const tomorrow = getNycDateString(1);
  console.log(`Today: ${today}, Tomorrow: ${tomorrow}\n`);

  // Fetch page 1
  const url = 'https://www.nycgovparks.org/events';
  console.log(`Fetching ${url}...`);
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error(`Fetch failed: ${res.status}`);
    process.exit(1);
  }

  const html = await res.text();
  console.log(`HTML: ${html.length} chars\n`);

  const $ = cheerio.load(html);
  const eventBlocks = $('[itemscope][itemtype="http://schema.org/Event"]');
  console.log(`Schema.org Event blocks found: ${eventBlocks.length}`);

  if (eventBlocks.length === 0) {
    console.error('FAIL: No Schema.org Event blocks found — page structure may have changed');
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  const events = [];

  eventBlocks.each((i, el) => {
    const $el = $(el);

    const title = $el.find('[itemprop="name"] > a').first().text().trim()
      || $el.find('h3[itemprop="name"]').first().text().trim();
    const startDate = $el.find('meta[itemprop="startDate"]').attr('content') || null;
    const endDate = $el.find('meta[itemprop="endDate"]').attr('content') || null;
    const dateLocal = startDate ? startDate.slice(0, 10) : null;
    const venueName = $el.find('[itemprop="location"] [itemprop="name"]').first().text().trim() || null;
    const venueAddress = $el.find('meta[itemprop="streetAddress"]').attr('content') || null;
    const borough = $el.find('[itemprop="addressLocality"]').first().text().trim() || null;
    const description = $el.find('[itemprop="description"]').first().text().trim() || null;

    events.push({ title, startDate, endDate, dateLocal, venueName, venueAddress, borough, description });
  });

  // Show first 5 parsed events
  console.log(`\nFirst 5 events:\n`);
  for (const e of events.slice(0, 5)) {
    const neighborhood = resolveNeighborhood(e.borough, null, null);
    const nameAndDesc = ((e.title || '') + ' ' + (e.description || '')).toLowerCase();
    const category = inferCategory(nameAndDesc);

    console.log(`  "${e.title}"`);
    console.log(`    Date: ${e.dateLocal}  Start: ${e.startDate}`);
    console.log(`    Venue: ${e.venueName}`);
    console.log(`    Address: ${e.venueAddress}`);
    console.log(`    Borough: ${e.borough} → Neighborhood: ${neighborhood}`);
    console.log(`    Category: ${category}`);
    console.log(`    Description: ${(e.description || '').slice(0, 80)}...`);
    console.log();
  }

  // Validation checks
  console.log('Validation:\n');

  const withTitles = events.filter(e => e.title);
  const pct = ((withTitles.length / events.length) * 100).toFixed(0);
  if (withTitles.length > 0) { pass++; console.log(`  PASS: ${withTitles.length}/${events.length} (${pct}%) have titles`); }
  else { fail++; console.error(`  FAIL: No events have titles`); }

  const withDates = events.filter(e => e.dateLocal);
  if (withDates.length > 0) { pass++; console.log(`  PASS: ${withDates.length}/${events.length} have dates`); }
  else { fail++; console.error(`  FAIL: No events have dates`); }

  const withBoroughs = events.filter(e => e.borough);
  if (withBoroughs.length > 0) { pass++; console.log(`  PASS: ${withBoroughs.length}/${events.length} have boroughs`); }
  else { fail++; console.error(`  FAIL: No events have boroughs`); }

  const withVenues = events.filter(e => e.venueName);
  if (withVenues.length > 0) { pass++; console.log(`  PASS: ${withVenues.length}/${events.length} have venue names`); }
  else { fail++; console.error(`  FAIL: No events have venue names`); }

  const withAddresses = events.filter(e => e.venueAddress);
  if (withAddresses.length > 0) { pass++; console.log(`  PASS: ${withAddresses.length}/${events.length} have addresses`); }
  else { fail++; console.error(`  FAIL: No events have addresses`); }

  // Neighborhood resolution
  const neighborhoods = events.map(e => resolveNeighborhood(e.borough, null, null)).filter(Boolean);
  const uniqueHoods = [...new Set(neighborhoods)];
  if (uniqueHoods.length > 0) { pass++; console.log(`  PASS: Resolved to ${uniqueHoods.length} neighborhoods: ${uniqueHoods.join(', ')}`); }
  else { fail++; console.error(`  FAIL: No neighborhoods resolved`); }

  // Borough distribution
  const boroughCounts = {};
  for (const e of events) {
    if (e.borough) boroughCounts[e.borough] = (boroughCounts[e.borough] || 0) + 1;
  }
  console.log(`\n  Borough distribution: ${JSON.stringify(boroughCounts)}`);

  // Today/tomorrow filter
  const todayEvents = events.filter(e => e.dateLocal === today);
  const tomorrowEvents = events.filter(e => e.dateLocal === tomorrow);
  console.log(`  Today: ${todayEvents.length}, Tomorrow: ${tomorrowEvents.length}, Other: ${events.length - todayEvents.length - tomorrowEvents.length}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
