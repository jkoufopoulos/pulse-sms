/**
 * Multi-turn pipeline eval for BrooklynVegan events.
 *
 * Proves BV events flow through the full pipeline: fetch -> rank -> compose -> SMS.
 * Tests venue auto-learning: BV's lat/lng data grows the in-memory venue map,
 * helping resolve neighborhoods for other sources.
 *
 * If nyc-shows.brooklynvegan.com is unavailable, falls back to representative
 * synthetic events so the pipeline eval still runs.
 *
 * Requires: ANTHROPIC_API_KEY
 * Run: node test/bv-eval.js
 */

const { fetchBrooklynVeganEvents, makeEventId } = require('../src/sources');
const { composeResponse } = require('../src/ai');
const { rankEventsByProximity, filterUpcomingEvents, getNycDateString } = require('../src/geo');
const { lookupVenue, learnVenueCoords } = require('../src/venues');

let pass = 0;
let fail = 0;
let soft_pass = 0;
let soft_fail = 0;

function check(name, condition) {
  if (condition) { pass++; console.log(`  \x1b[32mPASS\x1b[0m: ${name}`); }
  else { fail++; console.error(`  \x1b[31mFAIL\x1b[0m: ${name}`); }
}

function softCheck(name, condition) {
  if (condition) { soft_pass++; console.log(`  \x1b[32mPASS\x1b[0m: ${name}`); }
  else { soft_fail++; console.log(`  \x1b[33mSOFT FAIL\x1b[0m: ${name} (non-deterministic — Claude's choice)`); }
}

/**
 * Create synthetic competition events (Dice/RA/Songkick-style).
 */
function makeSyntheticCompetition(neighborhood, dateLocal) {
  return [
    {
      id: makeEventId('DJ Night at The Warehouse', 'The Warehouse', dateLocal, 'dice'),
      source_name: 'dice', source_type: 'aggregator', source_weight: 0.8,
      name: 'DJ Night at The Warehouse',
      description_short: 'Techno and house all night with resident DJs',
      short_detail: 'Techno and house all night with resident DJs',
      venue_name: 'The Warehouse', venue_address: null,
      neighborhood, date_local: dateLocal,
      start_time_local: `${dateLocal}T22:00:00`, end_time_local: null,
      is_free: false, price_display: '$20', category: 'nightlife', subcategory: null,
      confidence: 0.85, ticket_url: 'https://dice.fm/event/warehouse-night',
    },
    {
      id: makeEventId('Jazz Trio at Blue Note', 'Blue Note', dateLocal, 'songkick'),
      source_name: 'songkick', source_type: 'aggregator', source_weight: 0.75,
      name: 'Jazz Trio at Blue Note',
      description_short: 'Live jazz from the Steve Lehman Trio',
      short_detail: 'Live jazz from the Steve Lehman Trio',
      venue_name: 'Blue Note', venue_address: null,
      neighborhood, date_local: dateLocal,
      start_time_local: `${dateLocal}T20:00:00`, end_time_local: `${dateLocal}T23:00:00`,
      is_free: false, price_display: '$30', category: 'live_music', subcategory: null,
      confidence: 0.85, ticket_url: 'https://www.songkick.com/concerts/blue-note',
    },
    {
      id: makeEventId('Stand-Up Showcase', 'Comedy Dungeon', dateLocal, 'eventbrite'),
      source_name: 'eventbrite', source_type: 'aggregator', source_weight: 0.7,
      name: 'Stand-Up Showcase',
      description_short: 'Five comics, one wild night of stand-up',
      short_detail: 'Five comics, one wild night of stand-up',
      venue_name: 'Comedy Dungeon', venue_address: null,
      neighborhood, date_local: dateLocal,
      start_time_local: `${dateLocal}T21:00:00`, end_time_local: `${dateLocal}T23:30:00`,
      is_free: false, price_display: '$15', category: 'comedy', subcategory: null,
      confidence: 0.85, ticket_url: 'https://www.eventbrite.com/e/standup-showcase',
    },
  ];
}

/**
 * Representative BV events modeled on real DoStuff API data.
 * Used as fallback when the live API is unavailable.
 */
function makeFallbackBVEvents(dateLocal) {
  return [
    {
      id: makeEventId('Mdou Moctar', 'Brooklyn Steel', dateLocal, 'brooklynvegan'),
      source_name: 'brooklynvegan', source_type: 'curated', source_weight: 0.8,
      name: 'Mdou Moctar',
      description_short: 'Mdou Moctar, Los Bitchos',
      short_detail: 'Mdou Moctar, Los Bitchos',
      venue_name: 'Brooklyn Steel', venue_address: '319 Frost St, Brooklyn, NY 11222',
      neighborhood: 'Williamsburg', date_local: dateLocal,
      start_time_local: `${dateLocal}T20:00:00`, end_time_local: null,
      is_free: false, price_display: '$25', category: 'live_music', subcategory: 'music',
      confidence: 0.9, ticket_url: 'https://link.dice.fm/mdou-moctar',
      source_url: 'https://nyc-shows.brooklynvegan.com/events/12345',
      map_url: null, map_hint: '319 Frost St, Brooklyn, NY 11222',
    },
    {
      id: makeEventId('Wednesday', 'Music Hall of Williamsburg', dateLocal, 'brooklynvegan'),
      source_name: 'brooklynvegan', source_type: 'curated', source_weight: 0.8,
      name: 'Wednesday',
      description_short: 'Wednesday, MJ Lenderman',
      short_detail: 'Wednesday, MJ Lenderman',
      venue_name: 'Music Hall of Williamsburg', venue_address: '66 N 6th St, Brooklyn, NY 11249',
      neighborhood: 'Williamsburg', date_local: dateLocal,
      start_time_local: `${dateLocal}T19:00:00`, end_time_local: null,
      is_free: false, price_display: '$30', category: 'live_music', subcategory: 'music',
      confidence: 0.9, ticket_url: 'https://link.dice.fm/wednesday',
      source_url: 'https://nyc-shows.brooklynvegan.com/events/12346',
      map_url: null, map_hint: '66 N 6th St, Brooklyn, NY 11249',
    },
    {
      id: makeEventId('Geese', 'Elsewhere', dateLocal, 'brooklynvegan'),
      source_name: 'brooklynvegan', source_type: 'curated', source_weight: 0.8,
      name: 'Geese',
      description_short: 'Geese, Been Stellar',
      short_detail: 'Geese, Been Stellar',
      venue_name: 'Elsewhere', venue_address: '599 Johnson Ave, Brooklyn, NY 11237',
      neighborhood: 'Bushwick', date_local: dateLocal,
      start_time_local: `${dateLocal}T20:00:00`, end_time_local: null,
      is_free: false, price_display: '$22', category: 'live_music', subcategory: 'music',
      confidence: 0.9, ticket_url: 'https://link.dice.fm/geese',
      source_url: 'https://nyc-shows.brooklynvegan.com/events/12347',
      map_url: null, map_hint: '599 Johnson Ave, Brooklyn, NY 11237',
    },
    {
      id: makeEventId('Bar Italia', 'Bowery Ballroom', dateLocal, 'brooklynvegan'),
      source_name: 'brooklynvegan', source_type: 'curated', source_weight: 0.8,
      name: 'Bar Italia',
      description_short: 'Bar Italia',
      short_detail: 'Bar Italia',
      venue_name: 'Bowery Ballroom', venue_address: '6 Delancey St, New York, NY 10002',
      neighborhood: 'Lower East Side', date_local: dateLocal,
      start_time_local: `${dateLocal}T21:00:00`, end_time_local: null,
      is_free: false, price_display: '$28', category: 'live_music', subcategory: 'music',
      confidence: 0.9, ticket_url: 'https://link.dice.fm/bar-italia',
      source_url: 'https://nyc-shows.brooklynvegan.com/events/12348',
      map_url: null, map_hint: '6 Delancey St, New York, NY 10002',
    },
    {
      id: makeEventId('Free Jazz in the Park', 'Prospect Park Bandshell', dateLocal, 'brooklynvegan'),
      source_name: 'brooklynvegan', source_type: 'curated', source_weight: 0.8,
      name: 'Free Jazz in the Park',
      description_short: 'Sons of Kemet, Irreversible Entanglements',
      short_detail: 'Sons of Kemet, Irreversible Entanglements',
      venue_name: 'Prospect Park Bandshell', venue_address: 'Prospect Park West, Brooklyn, NY',
      neighborhood: 'Park Slope', date_local: dateLocal,
      start_time_local: `${dateLocal}T18:00:00`, end_time_local: null,
      is_free: true, price_display: 'free', category: 'live_music', subcategory: 'music',
      confidence: 0.9, ticket_url: null,
      source_url: 'https://nyc-shows.brooklynvegan.com/events/12349',
      map_url: null, map_hint: 'Prospect Park West, Brooklyn, NY',
    },
  ];
}

async function main() {
  console.log('=== BrooklynVegan Pipeline Eval (Multi-Turn) ===\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required for pipeline eval (Claude compose calls)');
    process.exit(1);
  }

  const today = getNycDateString(0);
  const tomorrow = getNycDateString(1);
  console.log(`Today: ${today}, Tomorrow: ${tomorrow}\n`);

  // ================================================================
  // PHASE 1: Fetch real BV events — design tests around them
  // ================================================================
  console.log('--- Phase 1: Fetch & Inspect ---\n');

  let bvEvents = await fetchBrooklynVeganEvents();
  let usedFallback = false;

  if (bvEvents.length === 0) {
    console.log('  Live fetch returned 0 events. Using fallback data.\n');
    bvEvents = makeFallbackBVEvents(tomorrow);
    usedFallback = true;
  }

  check('BV events available (live or fallback)', bvEvents.length > 0);

  // Map which neighborhoods have BV events
  const hoodCounts = {};
  for (const e of bvEvents) {
    if (e.neighborhood) hoodCounts[e.neighborhood] = (hoodCounts[e.neighborhood] || 0) + 1;
  }
  console.log(`  Neighborhood distribution: ${JSON.stringify(hoodCounts)}`);
  if (usedFallback) console.log('  (fallback data — modeled on real DoStuff API)');

  // Validate event shape
  check('all BV events have source_name brooklynvegan', bvEvents.every(e => e.source_name === 'brooklynvegan'));
  check('all BV events have source_weight 0.8', bvEvents.every(e => e.source_weight === 0.8));
  check('all BV events have confidence 0.9', bvEvents.every(e => e.confidence === 0.9));
  check('all BV events have dates', bvEvents.every(e => e.date_local));
  check('all BV events have venue names', bvEvents.every(e => e.venue_name && e.venue_name !== 'TBA'));
  check('BV events have neighborhoods', bvEvents.filter(e => e.neighborhood).length > 0);
  check('no sold_out events included', bvEvents.every(e => !/(sold out|canceled|cancelled)/i.test(e.name)));

  // Show sample events
  console.log(`\n  Sample events (first 5):\n`);
  for (const e of bvEvents.slice(0, 5)) {
    console.log(`    "${e.name}" at ${e.venue_name} (${e.neighborhood || 'unknown'})`);
    console.log(`      ${e.date_local} | ${e.category} | ${e.is_free ? 'free' : e.price_display || 'paid'}`);
    console.log(`      ${e.venue_address || '(no address)'}`);
    console.log();
  }

  // ================================================================
  // PHASE 2: Ranking — do BV events survive proximity filter?
  // ================================================================
  console.log('--- Phase 2: Ranking Pipeline ---\n');

  // Pick neighborhood with most BV events
  const targetHood = Object.entries(hoodCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  if (!targetHood) {
    console.error('\nNo BV events resolved to any neighborhood — cannot test.');
    process.exit(1);
  }

  const bvInTarget = bvEvents.filter(e => e.neighborhood === targetHood);
  console.log(`  Target neighborhood: ${targetHood} (${bvInTarget.length} BV events)`);

  // Build mixed cache: BV + synthetic competition
  const syntheticEvents = makeSyntheticCompetition(targetHood, bvInTarget[0]?.date_local || tomorrow);
  const cache = [...bvInTarget, ...syntheticEvents];

  console.log(`  Cache: ${cache.length} total (${bvInTarget.length} BV + ${syntheticEvents.length} synthetic)\n`);

  // Rank by proximity
  const upcoming = filterUpcomingEvents(cache);
  const ranked = rankEventsByProximity(upcoming, targetHood);

  const bvInRanked = ranked.filter(e => e.source_name === 'brooklynvegan');
  check('BV events survive proximity filter', bvInRanked.length > 0);
  console.log(`    ${bvInRanked.length}/${ranked.length} ranked events are BV`);

  // Top 8 sent to Claude
  const top8 = ranked.slice(0, 8);
  const bvInTop8 = top8.filter(e => e.source_name === 'brooklynvegan');
  check('BV events in top 8 sent to Claude', bvInTop8.length > 0);
  console.log(`    ${bvInTop8.length}/${top8.length} top-8 events are BV`);

  // Show what Claude will see
  console.log(`\n  Top 8 event list for Claude:\n`);
  for (const e of top8) {
    const tag = e.source_name === 'brooklynvegan' ? '\x1b[35m[BV]\x1b[0m' : `[${e.source_name}]`;
    console.log(`    ${tag} "${e.name}" | ${e.category} | ${e.is_free ? 'free' : e.price_display} | w=${e.source_weight}`);
  }

  // ================================================================
  // PHASE 3: Venue auto-learning
  // ================================================================
  console.log('\n--- Phase 3: Venue Auto-Learning ---\n');

  // Check if learnVenueCoords populated new entries from live fetch
  const bvVenues = bvEvents
    .filter(e => e.venue_name && e.venue_name !== 'TBA' && e.venue_address)
    .map(e => e.venue_name);

  const uniqueVenues = [...new Set(bvVenues)];
  let learnedCount = 0;
  for (const v of uniqueVenues) {
    if (lookupVenue(v)) learnedCount++;
  }
  console.log(`  ${learnedCount}/${uniqueVenues.length} BV venues are in the venue map`);
  check('venue auto-learning: BV venues are in map', learnedCount > 0);

  // Test the learning mechanism directly
  const testVenue = 'BV Eval Test Venue 12345';
  check('test venue not in map before learning', lookupVenue(testVenue) === null);
  learnVenueCoords(testVenue, 40.7128, -73.9500);
  check('test venue in map after learning', lookupVenue(testVenue)?.lat === 40.7128);
  check('learnVenueCoords does not overwrite existing entries', (() => {
    learnVenueCoords(testVenue, 0, 0);
    return lookupVenue(testVenue)?.lat === 40.7128;
  })());

  // ================================================================
  // PHASE 4: Turn 1 — "what's happening in {hood}"
  // ================================================================
  console.log('\n--- Phase 4: Turn 1 — General Events Request ---\n');
  console.log(`  Sending: "what's happening in ${targetHood.toLowerCase()}"\n`);

  const t1Start = Date.now();
  const turn1 = await composeResponse(
    `what's happening in ${targetHood.toLowerCase()}`,
    top8, targetHood, { free_only: false, category: null, vibe: null },
  );
  const t1Ms = Date.now() - t1Start;

  console.log(`  Claude response (${t1Ms}ms, ${turn1.sms_text.length} chars):\n`);
  console.log(`  \x1b[35m${turn1.sms_text}\x1b[0m\n`);

  check('Turn 1: valid SMS (> 0 chars)', turn1.sms_text.length > 0);
  check('Turn 1: SMS under 480 chars', turn1.sms_text.length <= 480);
  softCheck('Turn 1: has picks', turn1.picks.length > 0);
  check('Turn 1: latency under 15s', t1Ms < 15000);

  // Check if Claude picked any BV events
  const bvIds = new Set(bvEvents.map(e => e.id));
  const bvPicked1 = turn1.picks.filter(p => bvIds.has(p.event_id));
  softCheck(`Turn 1: Claude picked a BV event (${bvPicked1.length}/${turn1.picks.length} picks)`, bvPicked1.length > 0);

  // Check if BV event names appear in the SMS text
  const smsLower1 = turn1.sms_text.toLowerCase();
  const bvNameInSms1 = bvInTop8.some(e => smsLower1.includes(e.name.toLowerCase().slice(0, 15)));
  softCheck('Turn 1: BV event name appears in SMS text', bvNameInSms1);

  // Show pick details
  for (const p of turn1.picks) {
    const evt = top8.find(e => e.id === p.event_id);
    const isBV = bvIds.has(p.event_id);
    const tag = isBV ? '\x1b[35m[BV]\x1b[0m' : `[${evt?.source_name || '?'}]`;
    console.log(`  Pick #${p.rank}: ${tag} "${evt?.name || p.event_id}" — ${p.why || ''}`);
  }

  // ================================================================
  // PHASE 5: Turn 2 — "any live music" (BV should dominate — it's a music source)
  // ================================================================
  console.log('\n--- Phase 5: Turn 2 — Live Music Filter ---\n');

  const musicEvents = top8.filter(e => e.category === 'live_music');
  const bvMusicCount = musicEvents.filter(e => e.source_name === 'brooklynvegan').length;

  console.log(`  Music filter: ${musicEvents.length} events (${bvMusicCount} BV, ${musicEvents.length - bvMusicCount} other)\n`);

  check('Turn 2: music filter keeps BV events', bvMusicCount > 0);
  softCheck('Turn 2: BV dominates music events', bvMusicCount >= musicEvents.length * 0.3);

  if (musicEvents.length > 0) {
    console.log(`  Sending: "any live music tonight"\n`);

    const t2Start = Date.now();
    const turn2 = await composeResponse(
      'any live music tonight', musicEvents, targetHood, { free_only: false, category: 'live_music', vibe: null },
      { excludeIds: turn1.picks.map(p => p.event_id) },
    );
    const t2Ms = Date.now() - t2Start;

    console.log(`  Claude response (${t2Ms}ms, ${turn2.sms_text.length} chars):\n`);
    console.log(`  \x1b[35m${turn2.sms_text}\x1b[0m\n`);

    check('Turn 2: valid SMS (<= 480 chars)', turn2.sms_text.length > 0 && turn2.sms_text.length <= 480);
    check('Turn 2: latency under 15s', t2Ms < 15000);

    const bvPicked2 = turn2.picks.filter(p => bvIds.has(p.event_id));
    softCheck(`Turn 2: Claude picked BV event in music response (${bvPicked2.length}/${turn2.picks.length})`, bvPicked2.length > 0);

    for (const p of turn2.picks) {
      const evt = musicEvents.find(e => e.id === p.event_id);
      const isBV = bvIds.has(p.event_id);
      const tag = isBV ? '\x1b[35m[BV]\x1b[0m' : `[${evt?.source_name || '?'}]`;
      console.log(`  Pick #${p.rank}: ${tag} "${evt?.name || p.event_id}" — ${p.why || ''}`);
    }
  } else {
    console.log('  (skipped — no live_music events in top 8 after filtering)');
  }

  // ================================================================
  // PHASE 6: Source integrity
  // ================================================================
  console.log('\n--- Phase 6: Source Integrity ---\n');

  check('BV events have source_weight 0.8',
    bvInTop8.every(e => e.source_weight === 0.8));
  check('BV events have confidence 0.9',
    bvInTop8.every(e => e.confidence === 0.9));
  check('BV events have venue addresses',
    bvInTop8.filter(e => e.venue_address).length > 0);
  check('BV events have source_type curated',
    bvInTop8.every(e => e.source_type === 'curated'));
  check('no sold_out events in BV results',
    bvEvents.every(e => !/(sold out|canceled|cancelled)/i.test(e.name)));

  // URL checks
  const bvWithTicketUrl = bvEvents.filter(e => e.ticket_url);
  console.log(`  ${bvWithTicketUrl.length}/${bvEvents.length} BV events have ticket URLs`);
  const bvWithSourceUrl = bvEvents.filter(e => e.source_url);
  if (bvWithSourceUrl.length > 0) {
    check('BV source URLs point to nyc-shows.brooklynvegan.com',
      bvWithSourceUrl.every(e => e.source_url.includes('nyc-shows.brooklynvegan.com')));
  }

  // ================================================================
  // Summary
  // ================================================================
  console.log('\n========================================');
  console.log(`Pipeline checks: ${pass} passed, ${fail} failed`);
  console.log(`Claude checks:   ${soft_pass} passed, ${soft_fail} soft-failed (non-deterministic)`);
  if (usedFallback) console.log('Note: used fallback data (live API unavailable)');
  console.log('========================================\n');

  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
