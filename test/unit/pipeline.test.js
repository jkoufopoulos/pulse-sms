const { check } = require('../helpers');
const { mergeFilters, eventMatchesFilters, buildTaggedPool, normalizeFilters } = require('../../src/pipeline');

// ---- mergeFilters ----
console.log('\nmergeFilters:');

// Both empty
check('both null → empty', JSON.stringify(mergeFilters(null, null)) === '{}');
check('both undefined → empty', JSON.stringify(mergeFilters(undefined, undefined)) === '{}');

// One side only
check('existing only → preserves', mergeFilters({ category: 'comedy' }, null).category === 'comedy');
check('incoming only → uses incoming', mergeFilters(null, { category: 'comedy' }).category === 'comedy');

// Compounding: incoming adds to existing
const compounded = mergeFilters({ category: 'comedy' }, { time_after: '22:00' });
check('compound: category persists', compounded.category === 'comedy');
check('compound: time_after added', compounded.time_after === '22:00');

// Override: incoming truthy value wins
check('override: incoming category wins', mergeFilters({ category: 'comedy' }, { category: 'theater' }).category === 'theater');

// Falsy incoming falls back to existing
check('null incoming category → existing', mergeFilters({ category: 'comedy' }, { category: null }).category === 'comedy');
check('undefined incoming → existing', mergeFilters({ category: 'comedy' }, {}).category === 'comedy');

// free_only compounding
check('free_only: true + null → true', mergeFilters({ free_only: true }, {}).free_only === true);
check('free_only: false + true → true', mergeFilters({ free_only: false }, { free_only: true }).free_only === true);
check('free_only: true + false → true (||)', mergeFilters({ free_only: true }, { free_only: false }).free_only === true);

// Full compound scenario: "comedy" then "later tonight" then "free"
const step1 = mergeFilters({}, { category: 'comedy' });
const step2 = mergeFilters(step1, { time_after: '22:00' });
const step3 = mergeFilters(step2, { free_only: true });
check('3-step compound: category', step3.category === 'comedy');
check('3-step compound: time_after', step3.time_after === '22:00');
check('3-step compound: free_only', step3.free_only === true);
check('3-step compound: vibe null', step3.vibe === null);

// Defaults
const defaults = mergeFilters({}, {});
check('defaults: free_only false', defaults.free_only === false);
check('defaults: category null', defaults.category === null);
check('defaults: subcategory null', defaults.subcategory === null);
check('defaults: vibe null', defaults.vibe === null);
check('defaults: time_after null', defaults.time_after === null);

// Subcategory compounding
check('subcategory: incoming wins', mergeFilters({}, { subcategory: 'jazz' }).subcategory === 'jazz');
check('subcategory: existing preserved', mergeFilters({ subcategory: 'jazz' }, {}).subcategory === 'jazz');
check('subcategory: incoming overrides', mergeFilters({ subcategory: 'jazz' }, { subcategory: 'rock' }).subcategory === 'rock');
check('subcategory: null incoming → existing', mergeFilters({ subcategory: 'jazz' }, { subcategory: null }).subcategory === 'jazz');
const jazzCompound = mergeFilters({ category: 'live_music', subcategory: 'jazz' }, { time_after: '22:00' });
check('subcategory persists through compound', jazzCompound.subcategory === 'jazz');
check('category persists through compound', jazzCompound.category === 'live_music');


// ---- eventMatchesFilters ----
console.log('\neventMatchesFilters:');

const comedyFree = { category: 'comedy', is_free: true, start_time_local: '2026-02-22T20:00:00' };
const comedyPaid = { category: 'comedy', is_free: false, start_time_local: '2026-02-22T21:00:00' };
const musicLate = { category: 'live_music', is_free: false, start_time_local: '2026-02-22T23:30:00' };
const musicEarly = { category: 'live_music', is_free: false, start_time_local: '2026-02-22T18:00:00' };
const artNoTime = { category: 'art', is_free: true };
const lateNight = { category: 'nightlife', is_free: false, start_time_local: '2026-02-23T01:30:00' };

// Category filter — returns 'hard' (exact match, no subcategory)
check('category match → hard', eventMatchesFilters(comedyFree, { category: 'comedy' }) === 'hard');
check('category mismatch → false', eventMatchesFilters(musicLate, { category: 'comedy' }) === false);

// Free filter — returns 'hard'
check('free match → hard', eventMatchesFilters(comedyFree, { free_only: true }) === 'hard');
check('free mismatch → false', eventMatchesFilters(comedyPaid, { free_only: true }) === false);
check('free_only false → hard', eventMatchesFilters(comedyPaid, { free_only: false }) === 'hard');

// Combined: category + free
check('comedy+free match → hard', eventMatchesFilters(comedyFree, { category: 'comedy', free_only: true }) === 'hard');
check('comedy+free mismatch (paid) → false', eventMatchesFilters(comedyPaid, { category: 'comedy', free_only: true }) === false);

// Time filter
check('time 22:00 passes 23:30 → hard', eventMatchesFilters(musicLate, { time_after: '22:00' }) === 'hard');
check('time 22:00 fails 18:00 → false', eventMatchesFilters(musicEarly, { time_after: '22:00' }) === false);
check('time 22:00 passes 20:00? no', eventMatchesFilters(comedyFree, { time_after: '22:00' }) === false);

// After-midnight wrapping: 01:30 should pass time_after 22:00
check('after-midnight 01:30 passes 22:00 → hard', eventMatchesFilters(lateNight, { time_after: '22:00' }) === 'hard');

// No time on event → passes (soft)
check('no start_time → passes time filter → hard', eventMatchesFilters(artNoTime, { time_after: '22:00' }) === 'hard');

// Empty filters → hard
check('empty filters → hard', eventMatchesFilters(comedyPaid, {}) === 'hard');
check('all null filters → hard', eventMatchesFilters(comedyPaid, { category: null, free_only: false, time_after: null }) === 'hard');

// All dimensions combined
check('all filters match → hard', eventMatchesFilters(
  { category: 'comedy', is_free: true, start_time_local: '2026-02-22T23:00:00' },
  { category: 'comedy', free_only: true, time_after: '22:00' }
) === 'hard');
check('all filters fail on category → false', eventMatchesFilters(
  { category: 'live_music', is_free: true, start_time_local: '2026-02-22T23:00:00' },
  { category: 'comedy', free_only: true, time_after: '22:00' }
) === false);

// Soft match: subcategory set → broad category match returns 'soft'
check('jazz subcategory + live_music match → soft', eventMatchesFilters(
  { category: 'live_music', is_free: false, start_time_local: '2026-02-22T21:00:00' },
  { category: 'live_music', subcategory: 'jazz' }
) === 'soft');
check('jazz subcategory + comedy → false (category mismatch)', eventMatchesFilters(
  { category: 'comedy', is_free: false },
  { category: 'live_music', subcategory: 'jazz' }
) === false);
check('jazz subcategory + free_only mismatch → false', eventMatchesFilters(
  { category: 'live_music', is_free: false },
  { category: 'live_music', subcategory: 'jazz', free_only: true }
) === false);
check('jazz subcategory + free match → soft', eventMatchesFilters(
  { category: 'live_music', is_free: true },
  { category: 'live_music', subcategory: 'jazz', free_only: true }
) === 'soft');


// ---- buildTaggedPool ----
console.log('\nbuildTaggedPool:');

// Generate test events
function makeEvents(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    name: `Event ${i}`,
    category: overrides.category || 'nightlife',
    is_free: overrides.is_free || false,
    start_time_local: overrides.start_time_local || '2026-02-22T20:00:00',
    ...overrides,
  }));
}

// No filters → 15 events, all filter_match=false, matchCount=0
const noFilterResult = buildTaggedPool(makeEvents(20), {});
check('no filters: pool size 15', noFilterResult.pool.length === 15);
check('no filters: matchCount 0', noFilterResult.matchCount === 0);
check('no filters: hardCount 0', noFilterResult.hardCount === 0);
check('no filters: softCount 0', noFilterResult.softCount === 0);
check('no filters: isSparse false', noFilterResult.isSparse === false);
check('no filters: all filter_match false', noFilterResult.pool.every(e => e.filter_match === false));

// Null filters → same as empty
const nullFilterResult = buildTaggedPool(makeEvents(20), null);
check('null filters: pool size 15', nullFilterResult.pool.length === 15);
check('null filters: matchCount 0', nullFilterResult.matchCount === 0);

// Hard match: exact category (no subcategory) → filter_match='hard'
const mixed = [
  ...makeEvents(8, { category: 'comedy' }),
  ...makeEvents(12, { category: 'nightlife' }),
];
const comedyResult = buildTaggedPool(mixed, { category: 'comedy' });
check('comedy filter: matchCount 8', comedyResult.matchCount === 8);
check('comedy filter: hardCount 8', comedyResult.hardCount === 8);
check('comedy filter: softCount 0', comedyResult.softCount === 0);
check('comedy filter: pool size 15', comedyResult.pool.length === 15);
check('comedy filter: isSparse false (8 >= 3)', comedyResult.isSparse === false);
check('comedy filter: first 8 hard', comedyResult.pool.slice(0, 8).every(e => e.filter_match === 'hard'));
check('comedy filter: last 7 unmatched', comedyResult.pool.slice(8).every(e => e.filter_match === false));

// Sparse: 2 comedy + 20 nightlife
const sparseEvents = [
  ...makeEvents(2, { category: 'comedy' }),
  ...makeEvents(20, { category: 'nightlife' }),
];
const sparseResult = buildTaggedPool(sparseEvents, { category: 'comedy' });
check('sparse: matchCount 2', sparseResult.matchCount === 2);
check('sparse: isSparse true', sparseResult.isSparse === true);
check('sparse: pool size 15', sparseResult.pool.length === 15);
check('sparse: first 2 hard', sparseResult.pool.slice(0, 2).every(e => e.filter_match === 'hard'));
check('sparse: rest unmatched', sparseResult.pool.slice(2).every(e => e.filter_match === false));

// Zero matches → matchCount 0, isSparse false (0 is not sparse, it's empty)
const zeroResult = buildTaggedPool(makeEvents(20, { category: 'nightlife' }), { category: 'comedy' });
check('zero matches: matchCount 0', zeroResult.matchCount === 0);
check('zero matches: isSparse false', zeroResult.isSparse === false);
check('zero matches: pool size 15', zeroResult.pool.length === 15);
check('zero matches: all unmatched', zeroResult.pool.every(e => e.filter_match === false));

// Hard matched > 10 → cap at 10 hard
const manyMatched = makeEvents(14, { category: 'comedy' });
const manyResult = buildTaggedPool([...manyMatched, ...makeEvents(6, { category: 'nightlife' })], { category: 'comedy' });
check('many matches: matchCount 14', manyResult.matchCount === 14);
check('many matches: hardCount 14', manyResult.hardCount === 14);
check('many matches: pool size 15', manyResult.pool.length === 15);
check('many matches: 10 hard in pool', manyResult.pool.filter(e => e.filter_match === 'hard').length === 10);
check('many matches: 5 unmatched padding', manyResult.pool.filter(e => e.filter_match === false).length === 5);

// Small event list → pool smaller than 15
const smallResult = buildTaggedPool(makeEvents(5, { category: 'comedy' }), { category: 'comedy' });
check('small list: pool size 5', smallResult.pool.length === 5);
check('small list: all hard', smallResult.pool.every(e => e.filter_match === 'hard'));
check('small list: matchCount 5', smallResult.matchCount === 5);

// Free filter
const freeEvents = [
  ...makeEvents(4, { is_free: true }),
  ...makeEvents(16, { is_free: false }),
];
const freeResult = buildTaggedPool(freeEvents, { free_only: true });
check('free filter: matchCount 4', freeResult.matchCount === 4);
check('free filter: hardCount 4', freeResult.hardCount === 4);
check('free filter: isSparse false', freeResult.isSparse === false);
check('free filter: first 4 hard', freeResult.pool.slice(0, 4).every(e => e.filter_match === 'hard'));

// Combined filters: comedy + free
const combinedEvents = [
  { id: 'cf1', name: 'Free Comedy 1', category: 'comedy', is_free: true, start_time_local: '2026-02-22T20:00:00' },
  { id: 'cf2', name: 'Free Comedy 2', category: 'comedy', is_free: true, start_time_local: '2026-02-22T21:00:00' },
  { id: 'cp1', name: 'Paid Comedy', category: 'comedy', is_free: false, start_time_local: '2026-02-22T20:00:00' },
  { id: 'fm1', name: 'Free Music', category: 'live_music', is_free: true, start_time_local: '2026-02-22T20:00:00' },
  ...makeEvents(10, { category: 'nightlife' }),
];
const combinedResult = buildTaggedPool(combinedEvents, { category: 'comedy', free_only: true });
check('combined: matchCount 2 (free+comedy)', combinedResult.matchCount === 2);
check('combined: hardCount 2', combinedResult.hardCount === 2);
check('combined: isSparse true', combinedResult.isSparse === true);
check('combined: first 2 hard', combinedResult.pool.slice(0, 2).every(e => e.filter_match === 'hard'));

// Original events not mutated
const original = makeEvents(5, { category: 'comedy' });
const origId = original[0].id;
buildTaggedPool(original, { category: 'comedy' });
check('original not mutated', original[0].filter_match === undefined);
check('original id preserved', original[0].id === origId);

// Three-tier pool: soft match with subcategory
const threetierEvents = [
  ...makeEvents(3, { category: 'live_music' }),  // will be soft (jazz subcategory)
  ...makeEvents(12, { category: 'nightlife' }),   // unmatched
];
const softResult = buildTaggedPool(threetierEvents, { category: 'live_music', subcategory: 'jazz' });
check('soft: hardCount 0', softResult.hardCount === 0);
check('soft: softCount 3', softResult.softCount === 3);
check('soft: matchCount 3', softResult.matchCount === 3);
check('soft: isSparse false', softResult.isSparse === false);
check('soft: first 3 soft', softResult.pool.slice(0, 3).every(e => e.filter_match === 'soft'));
check('soft: rest unmatched', softResult.pool.slice(3).every(e => e.filter_match === false));

// Three-tier: mixed hard + soft (free=hard constraint, jazz=soft)
const mixedTierEvents = [
  { id: 'fj1', name: 'Free Jazz', category: 'live_music', is_free: true, start_time_local: '2026-02-22T20:00:00' },
  { id: 'fj2', name: 'Free Rock', category: 'live_music', is_free: true, start_time_local: '2026-02-22T21:00:00' },
  { id: 'pm1', name: 'Paid Music', category: 'live_music', is_free: false, start_time_local: '2026-02-22T20:00:00' },
  ...makeEvents(10, { category: 'nightlife' }),
];
// free_only + jazz subcategory: free live_music events pass all filters but subcategory makes them 'soft'
const mixedTierResult = buildTaggedPool(mixedTierEvents, { category: 'live_music', subcategory: 'jazz', free_only: true });
check('mixed tier: softCount 2 (free live_music)', mixedTierResult.softCount === 2);
check('mixed tier: hardCount 0', mixedTierResult.hardCount === 0);
check('mixed tier: first 2 soft', mixedTierResult.pool.slice(0, 2).every(e => e.filter_match === 'soft'));

// Pool ordering: hard first, then soft, then unmatched
const orderEvents = [
  { id: 'h1', name: 'Free Comedy', category: 'comedy', is_free: true, start_time_local: '2026-02-22T20:00:00' },
  { id: 's1', name: 'Free Jazz', category: 'live_music', is_free: true, start_time_local: '2026-02-22T20:00:00' },
  { id: 'u1', name: 'Paid Nightlife', category: 'nightlife', is_free: false, start_time_local: '2026-02-22T20:00:00' },
];
// free_only filter (no subcategory): comedy + live_music free = hard, nightlife paid = unmatched
const orderResult = buildTaggedPool(orderEvents, { free_only: true });
check('order: first 2 hard', orderResult.pool.slice(0, 2).every(e => e.filter_match === 'hard'));
check('order: last unmatched', orderResult.pool[2].filter_match === false);


// ---- normalizeFilters ----
console.log('\nnormalizeFilters:');

// Null / invalid input
check('null → null', normalizeFilters(null) === null);
check('undefined → null', normalizeFilters(undefined) === null);
check('string → null', normalizeFilters('comedy') === null);
check('empty obj → null', normalizeFilters({}) === null);

// Standard passthrough (already canonical)
const standard = normalizeFilters({ category: 'comedy', free_only: true, time_after: '22:00' });
check('passthrough: category', standard.category === 'comedy');
check('passthrough: free_only', standard.free_only === true);
check('passthrough: time_after', standard.time_after === '22:00');
check('passthrough: no subcategory', standard.subcategory === undefined);

// Subcategory mapping — LLM returns sub-genre, normalizeFilters preserves it
check('jazz → live_music', normalizeFilters({ category: 'jazz' }).category === 'live_music');
check('jazz → subcategory jazz', normalizeFilters({ category: 'jazz' }).subcategory === 'jazz');
check('rock → live_music', normalizeFilters({ category: 'rock' }).category === 'live_music');
check('rock → subcategory rock', normalizeFilters({ category: 'rock' }).subcategory === 'rock');
check('indie → live_music', normalizeFilters({ category: 'indie' }).category === 'live_music');
check('indie → subcategory indie', normalizeFilters({ category: 'indie' }).subcategory === 'indie');
check('folk → live_music', normalizeFilters({ category: 'folk' }).category === 'live_music');
check('punk → live_music', normalizeFilters({ category: 'punk' }).category === 'live_music');
check('techno → nightlife', normalizeFilters({ category: 'techno' }).category === 'nightlife');
check('techno → subcategory techno', normalizeFilters({ category: 'techno' }).subcategory === 'techno');
check('house → nightlife', normalizeFilters({ category: 'house' }).category === 'nightlife');
check('electronic → nightlife', normalizeFilters({ category: 'electronic' }).category === 'nightlife');
check('dj → nightlife', normalizeFilters({ category: 'dj' }).category === 'nightlife');
check('standup → comedy', normalizeFilters({ category: 'standup' }).category === 'comedy');
check('standup → subcategory standup', normalizeFilters({ category: 'standup' }).subcategory === 'standup');
check('improv → comedy', normalizeFilters({ category: 'improv' }).category === 'comedy');
check('theatre → theater', normalizeFilters({ category: 'theatre' }).category === 'theater');
check('theatre → subcategory theatre', normalizeFilters({ category: 'theatre' }).subcategory === 'theatre');
check('trivia → community', normalizeFilters({ category: 'trivia' }).category === 'community');
check('karaoke → community', normalizeFilters({ category: 'karaoke' }).category === 'community');
check('drag → community', normalizeFilters({ category: 'drag' }).category === 'community');

// Canonical categories should NOT get subcategory
check('comedy: no subcategory', normalizeFilters({ category: 'comedy' }).subcategory === undefined);
check('live_music: no subcategory', normalizeFilters({ category: 'live_music' }).subcategory === undefined);
check('nightlife: no subcategory', normalizeFilters({ category: 'nightlife' }).subcategory === undefined);

// Case insensitivity
check('Jazz → live_music', normalizeFilters({ category: 'Jazz' }).category === 'live_music');
check('Jazz → subcategory jazz', normalizeFilters({ category: 'Jazz' }).subcategory === 'jazz');
check('TECHNO → nightlife', normalizeFilters({ category: 'TECHNO' }).category === 'nightlife');

// Unknown category passes through
check('unknown → passthrough', normalizeFilters({ category: 'wellness' }).category === 'wellness');
check('unknown: no subcategory', normalizeFilters({ category: 'wellness' }).subcategory === undefined);

// Explicit subcategory field preserved
check('explicit subcategory preserved', normalizeFilters({ subcategory: 'jazz' }).subcategory === 'jazz');
check('explicit subcategory + category', normalizeFilters({ category: 'live_music', subcategory: 'jazz' }).subcategory === 'jazz');

// free_only coercion
check('free_only 1 → true', normalizeFilters({ free_only: 1 }).free_only === true);
check('free_only "yes" → true', normalizeFilters({ free_only: 'yes' }).free_only === true);
check('free_only 0 → false', normalizeFilters({ free_only: 0 }).free_only === false);
check('free_only "" → false', normalizeFilters({ free_only: '' }).free_only === false);

// time_after validation
check('valid time_after', normalizeFilters({ time_after: '22:00' }).time_after === '22:00');
check('valid midnight', normalizeFilters({ time_after: '00:00' }).time_after === '00:00');
check('invalid time_after → null', normalizeFilters({ time_after: '10pm' }).time_after === null);
check('invalid format → null', normalizeFilters({ time_after: 'late' }).time_after === null);

// Vibe passthrough
check('vibe passes through', normalizeFilters({ vibe: 'chill' }).vibe === 'chill');
