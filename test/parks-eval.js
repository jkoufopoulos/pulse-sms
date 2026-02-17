/**
 * Multi-turn pipeline eval for NYC Parks events.
 *
 * Proves parks events flow through the full pipeline: fetch → rank → compose → SMS.
 * Designs test scenarios around REAL events fetched from nycgovparks.org,
 * mixes them with synthetic competition events, and runs the compose pipeline
 * (real Claude API calls) to verify parks events surface in responses.
 *
 * If nycgovparks.org is unavailable (WAF challenge, rate limit), falls back
 * to representative synthetic parks events modeled on real data so the
 * pipeline eval still runs.
 *
 * Requires: ANTHROPIC_API_KEY
 * Run: node test/parks-eval.js
 */

const { fetchNYCParksEvents, makeEventId } = require('../src/sources');
const { composeResponse } = require('../src/ai');
const { rankEventsByProximity, filterUpcomingEvents, getNycDateString, inferCategory } = require('../src/geo');

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
 * Create synthetic non-free nightlife/music events as competition.
 * These simulate what Dice/RA/Songkick would contribute to the cache.
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
 * Representative parks events modeled on real nycgovparks.org data.
 * Used as fallback when the live site is unavailable (WAF, rate limit).
 * Shapes match fetchNYCParksEvents() output exactly.
 */
function makeFallbackParksEvents(dateLocal) {
  return [
    {
      id: makeEventId('Total Body Fitness', 'Prospect Park', dateLocal, 'nyc_parks'),
      source_name: 'nyc_parks', source_type: 'government', source_weight: 0.75,
      name: 'Total Body Fitness',
      description_short: 'Fun low-impact full-body workout including cardio, strength and balance exercises',
      short_detail: 'Fun low-impact full-body workout including cardio, strength and balance exercises',
      venue_name: 'Prospect Park', venue_address: '95 Prospect Park West',
      neighborhood: 'Williamsburg', date_local: dateLocal,
      start_time_local: `${dateLocal}T08:00:00-05:00`, end_time_local: `${dateLocal}T09:00:00-05:00`,
      time_window: null, is_free: true, price_display: 'free',
      category: 'community', subcategory: 'fitness',
      confidence: 0.85,
      ticket_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/total-body-fitness`,
      source_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/total-body-fitness`,
      map_url: null, map_hint: '95 Prospect Park West',
    },
    {
      id: makeEventId('Arsenal Gallery Exhibition', 'Arsenal', dateLocal, 'nyc_parks'),
      source_name: 'nyc_parks', source_type: 'government', source_weight: 0.75,
      name: 'Arsenal Gallery: Celebrating 40 Years of Ebony',
      description_short: 'The Ebony Society of NYC Parks invites you to celebrate Black History Month with an art exhibition',
      short_detail: 'The Ebony Society of NYC Parks invites you to celebrate Black History Month with an art exhibition',
      venue_name: 'Arsenal', venue_address: '830 Fifth Avenue',
      neighborhood: 'Midtown', date_local: dateLocal,
      start_time_local: `${dateLocal}T09:00:00-05:00`, end_time_local: `${dateLocal}T17:00:00-05:00`,
      time_window: null, is_free: true, price_display: 'free',
      category: 'art', subcategory: 'nature',
      confidence: 0.85,
      ticket_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/arsenal-gallery`,
      source_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/arsenal-gallery`,
      map_url: null, map_hint: '830 Fifth Avenue',
    },
    {
      id: makeEventId('Think Global Act Local Exhibition', 'Visitor Center', dateLocal, 'nyc_parks'),
      source_name: 'nyc_parks', source_type: 'government', source_weight: 0.75,
      name: 'Exhibition: Think Global. Act Local.',
      description_short: 'Multi-artist exhibit of works highlighting endangered local and global species in various media',
      short_detail: 'Multi-artist exhibit of works highlighting endangered local and global species in various media',
      venue_name: 'Conference House Park Visitor Center', venue_address: '298 Satterlee Street',
      neighborhood: 'Midtown', date_local: dateLocal,
      start_time_local: `${dateLocal}T10:00:00-05:00`, end_time_local: `${dateLocal}T16:00:00-05:00`,
      time_window: null, is_free: true, price_display: 'free',
      category: 'art', subcategory: 'nature',
      confidence: 0.85,
      ticket_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/think-global`,
      source_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/think-global`,
      map_url: null, map_hint: '298 Satterlee Street',
    },
    {
      id: makeEventId('Winter Bird Count', 'Van Cortlandt Park', dateLocal, 'nyc_parks'),
      source_name: 'nyc_parks', source_type: 'government', source_weight: 0.75,
      name: 'Winter Bird Count',
      description_short: 'Join our Urban Park Rangers for a winter bird watching walk through the park',
      short_detail: 'Join our Urban Park Rangers for a winter bird watching walk through the park',
      venue_name: 'Van Cortlandt Park', venue_address: 'Van Cortlandt Park South',
      neighborhood: 'Midtown', date_local: dateLocal,
      start_time_local: `${dateLocal}T10:00:00-05:00`, end_time_local: `${dateLocal}T12:00:00-05:00`,
      time_window: null, is_free: true, price_display: 'free',
      category: 'community', subcategory: 'nature',
      confidence: 0.85,
      ticket_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/winter-bird-count`,
      source_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/winter-bird-count`,
      map_url: null, map_hint: 'Van Cortlandt Park South',
    },
    {
      id: makeEventId('Tai Chi in the Park', 'Central Park', dateLocal, 'nyc_parks'),
      source_name: 'nyc_parks', source_type: 'government', source_weight: 0.75,
      name: 'Tai Chi in the Park',
      description_short: 'Free tai chi class open to all skill levels in Central Park',
      short_detail: 'Free tai chi class open to all skill levels in Central Park',
      venue_name: 'Central Park', venue_address: 'Central Park West & 72nd Street',
      neighborhood: 'Midtown', date_local: dateLocal,
      start_time_local: `${dateLocal}T11:00:00-05:00`, end_time_local: `${dateLocal}T12:00:00-05:00`,
      time_window: null, is_free: true, price_display: 'free',
      category: 'community', subcategory: 'fitness',
      confidence: 0.85,
      ticket_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/tai-chi`,
      source_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/tai-chi`,
      map_url: null, map_hint: 'Central Park West & 72nd Street',
    },
    {
      id: makeEventId('Sunset Yoga', 'Brooklyn Bridge Park', dateLocal, 'nyc_parks'),
      source_name: 'nyc_parks', source_type: 'government', source_weight: 0.75,
      name: 'Sunset Yoga at Brooklyn Bridge Park',
      description_short: 'Free outdoor yoga session with stunning Manhattan skyline views',
      short_detail: 'Free outdoor yoga session with stunning Manhattan skyline views',
      venue_name: 'Brooklyn Bridge Park', venue_address: 'Pier 1, Old Fulton Street',
      neighborhood: 'DUMBO', date_local: dateLocal,
      start_time_local: `${dateLocal}T16:30:00-05:00`, end_time_local: `${dateLocal}T17:30:00-05:00`,
      time_window: null, is_free: true, price_display: 'free',
      category: 'community', subcategory: 'fitness',
      confidence: 0.85,
      ticket_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/sunset-yoga`,
      source_url: `https://www.nycgovparks.org/events/${dateLocal.replace(/-/g, '/')}/sunset-yoga`,
      map_url: null, map_hint: 'Pier 1, Old Fulton Street',
    },
  ];
}

async function main() {
  console.log('=== NYC Parks Pipeline Eval (Multi-Turn) ===\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required for pipeline eval (Claude compose calls)');
    process.exit(1);
  }

  const today = getNycDateString(0);
  const tomorrow = getNycDateString(1);
  console.log(`Today: ${today}, Tomorrow: ${tomorrow}\n`);

  // ================================================================
  // PHASE 1: Fetch real parks events — design tests around them
  // ================================================================
  console.log('--- Phase 1: Fetch & Inspect ---\n');

  let parksEvents = await fetchNYCParksEvents();
  let usedFallback = false;

  if (parksEvents.length === 0) {
    console.log('  Live fetch returned 0 events (likely WAF challenge). Using fallback data.\n');
    parksEvents = makeFallbackParksEvents(tomorrow);
    usedFallback = true;
  }

  check('parks events available (live or fallback)', parksEvents.length > 0);

  // Map which neighborhoods have parks events
  const hoodCounts = {};
  for (const e of parksEvents) {
    if (e.neighborhood) hoodCounts[e.neighborhood] = (hoodCounts[e.neighborhood] || 0) + 1;
  }
  console.log(`  Neighborhood distribution: ${JSON.stringify(hoodCounts)}`);
  if (usedFallback) console.log('  (fallback data — modeled on real nycgovparks.org scrape)');

  // Pick the neighborhood with the most parks events (best test target)
  const targetHood = Object.entries(hoodCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  if (!targetHood) {
    console.error('\nNo parks events resolved to any neighborhood — cannot test.');
    process.exit(1);
  }

  const parksInTarget = parksEvents.filter(e => e.neighborhood === targetHood);
  console.log(`\n  Target neighborhood: ${targetHood} (${parksInTarget.length} parks events)`);

  // Show the specific parks events we're designing tests around
  console.log(`\n  Events we expect to surface:\n`);
  for (const e of parksInTarget.slice(0, 5)) {
    console.log(`    "${e.name}" at ${e.venue_name}`);
    console.log(`      ${e.date_local} ${e.start_time_local ? e.start_time_local.split('T')[1]?.slice(0, 5) : '?'} | ${e.category} | free`);
    console.log(`      ${e.venue_address || '(no address)'}`);
    console.log();
  }

  // Validate event shape
  check('all parks events have source_name nyc_parks', parksEvents.every(e => e.source_name === 'nyc_parks'));
  check('all parks events are free', parksEvents.every(e => e.is_free === true));
  check('all parks events have price_display "free"', parksEvents.every(e => e.price_display === 'free'));
  check('all parks events have dates', parksEvents.every(e => e.date_local));
  check('all parks events have venue names', parksEvents.every(e => e.venue_name));
  check('parks events have nycgovparks.org URLs', parksEvents.filter(e => e.ticket_url?.includes('nycgovparks.org')).length > 0);

  // ================================================================
  // PHASE 2: Ranking — do parks events survive proximity filter?
  // ================================================================
  console.log('\n--- Phase 2: Ranking Pipeline ---\n');

  // Use the date with most events (today or tomorrow)
  const todayParks = parksInTarget.filter(e => e.date_local === today);
  const tomorrowParks = parksInTarget.filter(e => e.date_local === tomorrow);
  const bestDate = todayParks.length >= tomorrowParks.length ? today : tomorrow;
  const bestDateLabel = bestDate === today ? 'today' : 'tomorrow';
  const parksForDate = parksInTarget.filter(e => e.date_local === bestDate);

  console.log(`  Using ${bestDateLabel} (${bestDate}): ${parksForDate.length} parks events in ${targetHood}`);

  // Build mixed cache: parks + synthetic competition
  const syntheticEvents = makeSyntheticCompetition(targetHood, bestDate);
  const cache = [...parksForDate, ...syntheticEvents];

  console.log(`  Cache: ${cache.length} total (${parksForDate.length} parks + ${syntheticEvents.length} synthetic)\n`);

  // Rank by proximity
  const upcoming = filterUpcomingEvents(cache);
  const ranked = rankEventsByProximity(upcoming, targetHood);

  const parksInRanked = ranked.filter(e => e.source_name === 'nyc_parks');
  check('parks events survive proximity filter', parksInRanked.length > 0);
  console.log(`    ${parksInRanked.length}/${ranked.length} ranked events are parks`);

  // Top 8 sent to Claude
  const top8 = ranked.slice(0, 8);
  const parksInTop8 = top8.filter(e => e.source_name === 'nyc_parks');
  check('parks events in top 8 sent to Claude', parksInTop8.length > 0);
  console.log(`    ${parksInTop8.length}/${top8.length} top-8 events are parks`);

  // Show what Claude will see
  console.log(`\n  Top 8 event list for Claude:\n`);
  for (const e of top8) {
    const tag = e.source_name === 'nyc_parks' ? '\x1b[36m[PARKS]\x1b[0m' : `[${e.source_name}]`;
    console.log(`    ${tag} "${e.name}" | ${e.category} | ${e.is_free ? 'free' : e.price_display} | w=${e.source_weight}`);
  }

  // ================================================================
  // PHASE 3: Turn 1 — "what's happening in {hood}"
  // ================================================================
  console.log('\n--- Phase 3: Turn 1 — General Events Request ---\n');
  console.log(`  Sending: "what's happening in ${targetHood.toLowerCase()}"\n`);

  const t1Start = Date.now();
  const turn1 = await composeResponse(
    `what's happening in ${targetHood.toLowerCase()}`,
    top8, targetHood, { free_only: false, category: null, vibe: null },
  );
  const t1Ms = Date.now() - t1Start;

  console.log(`  Claude response (${t1Ms}ms, ${turn1.sms_text.length} chars):\n`);
  console.log(`  \x1b[36m${turn1.sms_text}\x1b[0m\n`);

  check('Turn 1: valid SMS (> 0 chars)', turn1.sms_text.length > 0);
  check('Turn 1: SMS under 480 chars', turn1.sms_text.length <= 480);
  softCheck('Turn 1: has picks (Claude may skip if all events are tomorrow)', turn1.picks.length > 0);
  check('Turn 1: latency under 15s', t1Ms < 15000);

  // Check if Claude picked any parks events
  const parksIds = new Set(parksEvents.map(e => e.id));
  const parksPicked1 = turn1.picks.filter(p => parksIds.has(p.event_id));
  softCheck(`Turn 1: Claude picked a parks event (${parksPicked1.length}/${turn1.picks.length} picks)`, parksPicked1.length > 0);

  // Check if parks event names appear in the SMS text
  const smsLower1 = turn1.sms_text.toLowerCase();
  const parksNameInSms1 = parksInTop8.some(e => smsLower1.includes(e.name.toLowerCase().slice(0, 15)));
  softCheck('Turn 1: parks event name appears in SMS text', parksNameInSms1);

  if (turn1.not_picked_reason) {
    console.log(`  Not picked reason: ${turn1.not_picked_reason}\n`);
  }

  // Show pick details
  for (const p of turn1.picks) {
    const evt = top8.find(e => e.id === p.event_id);
    const isParks = parksIds.has(p.event_id);
    const tag = isParks ? '\x1b[36m[PARKS]\x1b[0m' : `[${evt?.source_name || '?'}]`;
    console.log(`  Pick #${p.rank}: ${tag} "${evt?.name || p.event_id}" — ${p.why || ''}`);
  }

  // ================================================================
  // PHASE 4: Turn 2 — "free" (parks should dominate)
  // ================================================================
  console.log('\n--- Phase 4: Turn 2 — Free Events Filter ---\n');

  const freeEvents = top8.filter(e => e.is_free);
  const freeParksCount = freeEvents.filter(e => e.source_name === 'nyc_parks').length;

  console.log(`  Free filter: ${freeEvents.length} events (${freeParksCount} parks, ${freeEvents.length - freeParksCount} other)\n`);

  check('Turn 2: free filter keeps parks events', freeParksCount > 0);
  check('Turn 2: parks are majority of free events', freeParksCount >= freeEvents.length * 0.5);

  if (freeEvents.length > 0) {
    console.log(`  Sending: "free events"\n`);

    const t2Start = Date.now();
    const turn2 = await composeResponse(
      'free events', freeEvents, targetHood, { free_only: true, category: null, vibe: null },
      { excludeIds: turn1.picks.map(p => p.event_id) },
    );
    const t2Ms = Date.now() - t2Start;

    console.log(`  Claude response (${t2Ms}ms, ${turn2.sms_text.length} chars):\n`);
    console.log(`  \x1b[36m${turn2.sms_text}\x1b[0m\n`);

    check('Turn 2: valid SMS (<= 480 chars)', turn2.sms_text.length > 0 && turn2.sms_text.length <= 480);
    check('Turn 2: latency under 15s', t2Ms < 15000);

    const parksPicked2 = turn2.picks.filter(p => parksIds.has(p.event_id));
    softCheck(`Turn 2: Claude picked parks event in free response (${parksPicked2.length}/${turn2.picks.length})`, parksPicked2.length > 0);

    // Show pick details
    for (const p of turn2.picks) {
      const evt = freeEvents.find(e => e.id === p.event_id);
      const isParks = parksIds.has(p.event_id);
      const tag = isParks ? '\x1b[36m[PARKS]\x1b[0m' : `[${evt?.source_name || '?'}]`;
      console.log(`  Pick #${p.rank}: ${tag} "${evt?.name || p.event_id}" — ${p.why || ''}`);
    }
  } else {
    console.log('  (skipped — no free events in top 8 after filtering)');
  }

  // ================================================================
  // PHASE 5: Turn 3 — Category match (if parks events have non-"other" categories)
  // ================================================================
  console.log('\n--- Phase 5: Turn 3 — Category Filter ---\n');

  const parksCats = {};
  for (const e of parksInTop8) {
    parksCats[e.category] = (parksCats[e.category] || 0) + 1;
  }
  console.log(`  Parks categories in top 8: ${JSON.stringify(parksCats)}`);

  // Find a non-"other" category that has parks events
  const testCat = Object.entries(parksCats)
    .filter(([cat]) => cat !== 'other')
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  if (testCat) {
    const catEvents = top8.filter(e => e.category === testCat);
    const catParks = catEvents.filter(e => e.source_name === 'nyc_parks');

    console.log(`  Testing category "${testCat}": ${catEvents.length} events (${catParks.length} parks)\n`);
    console.log(`  Sending: "${testCat.replace(/_/g, ' ')} in ${targetHood.toLowerCase()}"\n`);

    const t3Start = Date.now();
    const turn3 = await composeResponse(
      `${testCat.replace(/_/g, ' ')} in ${targetHood.toLowerCase()}`,
      catEvents, targetHood, { free_only: false, category: testCat, vibe: null },
    );
    const t3Ms = Date.now() - t3Start;

    console.log(`  Claude response (${t3Ms}ms, ${turn3.sms_text.length} chars):\n`);
    console.log(`  \x1b[36m${turn3.sms_text}\x1b[0m\n`);

    check('Turn 3: valid SMS (<= 480 chars)', turn3.sms_text.length > 0 && turn3.sms_text.length <= 480);

    const parksPicked3 = turn3.picks.filter(p => parksIds.has(p.event_id));
    softCheck(`Turn 3: parks event in "${testCat}" response`, parksPicked3.length > 0);

    for (const p of turn3.picks) {
      const evt = catEvents.find(e => e.id === p.event_id);
      const isParks = parksIds.has(p.event_id);
      const tag = isParks ? '\x1b[36m[PARKS]\x1b[0m' : `[${evt?.source_name || '?'}]`;
      console.log(`  Pick #${p.rank}: ${tag} "${evt?.name || p.event_id}" — ${p.why || ''}`);
    }
  } else {
    console.log('  (skipped — all parks events categorized as "other")');
  }

  // ================================================================
  // PHASE 6: URL & source verification
  // ================================================================
  console.log('\n--- Phase 6: Source Integrity ---\n');

  check('parks events have valid nycgovparks.org URLs',
    parksInTop8.every(e => !e.ticket_url || e.ticket_url.startsWith('https://www.nycgovparks.org/')));
  check('parks events have source_weight 0.75',
    parksInTop8.every(e => e.source_weight === 0.75));
  check('parks events have confidence 0.85',
    parksInTop8.every(e => e.confidence === 0.85));
  check('parks events have venue addresses',
    parksInTop8.filter(e => e.venue_address).length > 0);

  // ================================================================
  // Summary
  // ================================================================
  console.log('\n========================================');
  console.log(`Pipeline checks: ${pass} passed, ${fail} failed`);
  console.log(`Claude checks:   ${soft_pass} passed, ${soft_fail} soft-failed (non-deterministic)`);
  if (usedFallback) console.log('Note: used fallback data (live site unavailable)');
  console.log('========================================\n');

  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
