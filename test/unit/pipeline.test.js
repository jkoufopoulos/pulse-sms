const { check } = require('../helpers');
const { mergeFilters, eventMatchesFilters, buildTaggedPool, normalizeFilters, failsTimeGate, describeFilters } = require('../../src/pipeline');

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

// Explicit-key semantics: key present in incoming (even null/false) overrides
check('explicit null category → null (overrides)', mergeFilters({ category: 'comedy' }, { category: null }).category === null);
check('absent key → falls back to existing', mergeFilters({ category: 'comedy' }, {}).category === 'comedy');

// free_only compounding
check('free_only: true + absent → true', mergeFilters({ free_only: true }, {}).free_only === true);
check('free_only: false + true → true', mergeFilters({ free_only: false }, { free_only: true }).free_only === true);
check('free_only: true + explicit false → false', mergeFilters({ free_only: true }, { free_only: false }).free_only === false);

// Full compound scenario: "comedy" then "later tonight" then "free"
const step1 = mergeFilters({}, { category: 'comedy' });
const step2 = mergeFilters(step1, { time_after: '22:00' });
const step3 = mergeFilters(step2, { free_only: true });
check('3-step compound: category', step3.category === 'comedy');
check('3-step compound: time_after', step3.time_after === '22:00');
check('3-step compound: free_only', step3.free_only === true);
check('3-step compound: vibe null', step3.vibe === null);

// Partial clearing: explicit null clears one filter, others persist
const partialClear = mergeFilters({ category: 'comedy', free_only: true, time_after: '22:00' }, { category: null });
check('partial clear: category → null', partialClear.category === null);
check('partial clear: free_only persists', partialClear.free_only === true);
check('partial clear: time_after persists', partialClear.time_after === '22:00');

// Category replacement: new category overrides old
const catReplace = mergeFilters({ category: 'comedy' }, { category: 'jazz' });
check('category replacement: jazz wins', catReplace.category === 'jazz');

// Free clearing: explicit false clears free_only
const freeClear = mergeFilters({ category: 'comedy', free_only: true }, { free_only: false });
check('free clear: free_only → false', freeClear.free_only === false);
check('free clear: category persists', freeClear.category === 'comedy');

// Time clearing: explicit null clears time_after
const timeClear = mergeFilters({ category: 'comedy', time_after: '22:00' }, { time_after: null });
check('time clear: time_after → null', timeClear.time_after === null);
check('time clear: category persists', timeClear.category === 'comedy');

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
check('subcategory: explicit null → null (overrides)', mergeFilters({ subcategory: 'jazz' }, { subcategory: null }).subcategory === null);
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

// Time filter — no longer checked in eventMatchesFilters (enforced upstream by failsTimeGate in buildTaggedPool)
check('time_after ignored: early event → hard', eventMatchesFilters(musicEarly, { time_after: '22:00' }) === 'hard');
check('time_after ignored: late event → hard', eventMatchesFilters(musicLate, { time_after: '22:00' }) === 'hard');
// No start_time with time filter → soft (we don't know if it matches, LLM deprioritizes)
check('time_after: no start_time → soft', eventMatchesFilters(artNoTime, { time_after: '22:00' }) === 'soft');

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
check('comedy filter: pool size 8 (matched only)', comedyResult.pool.length === 8);
check('comedy filter: isSparse false (8 >= 3)', comedyResult.isSparse === false);
check('comedy filter: all hard', comedyResult.pool.every(e => e.filter_match === 'hard'));
check('comedy filter: no unmatched in pool', comedyResult.pool.every(e => e.filter_match !== false));

// Sparse: 2 comedy + 20 nightlife
const sparseEvents = [
  ...makeEvents(2, { category: 'comedy' }),
  ...makeEvents(20, { category: 'nightlife' }),
];
const sparseResult = buildTaggedPool(sparseEvents, { category: 'comedy' });
check('sparse: matchCount 2', sparseResult.matchCount === 2);
check('sparse: isSparse true', sparseResult.isSparse === true);
check('sparse: pool size 2 (matched only)', sparseResult.pool.length === 2);
check('sparse: all hard', sparseResult.pool.every(e => e.filter_match === 'hard'));
check('sparse: no unmatched in pool', sparseResult.pool.every(e => e.filter_match !== false));

// Zero matches → matchCount 0, isSparse false (0 is not sparse, it's empty)
const zeroResult = buildTaggedPool(makeEvents(20, { category: 'nightlife' }), { category: 'comedy' });
check('zero matches: matchCount 0', zeroResult.matchCount === 0);
check('zero matches: isSparse false', zeroResult.isSparse === false);
check('zero matches: pool size 0 (no matches, no padding)', zeroResult.pool.length === 0);

// Hard matched > 10 → cap at 10 hard
const manyMatched = makeEvents(14, { category: 'comedy' });
const manyResult = buildTaggedPool([...manyMatched, ...makeEvents(6, { category: 'nightlife' })], { category: 'comedy' });
check('many matches: matchCount 14', manyResult.matchCount === 14);
check('many matches: hardCount 14', manyResult.hardCount === 14);
check('many matches: pool size 10 (hard cap, no padding)', manyResult.pool.length === 10);
check('many matches: all hard', manyResult.pool.every(e => e.filter_match === 'hard'));
check('many matches: no unmatched in pool', manyResult.pool.every(e => e.filter_match !== false));

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
check('soft: all soft', softResult.pool.every(e => e.filter_match === 'soft'));
check('soft: pool size 3 (matched only)', softResult.pool.length === 3);
check('soft: no unmatched in pool', softResult.pool.every(e => e.filter_match !== false));

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
check('order: both hard', orderResult.pool.every(e => e.filter_match === 'hard'));
check('order: pool size 2 (no unmatched padding)', orderResult.pool.length === 2);


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


// ---- failsTimeGate ----
console.log('\nfailsTimeGate:');

// Event before filter time → fails
check('18:00 event fails 22:00 gate', failsTimeGate(
  { start_time_local: '2026-02-22T18:00:00' }, '22:00') === true);
check('20:00 event fails 22:00 gate', failsTimeGate(
  { start_time_local: '2026-02-22T20:00:00' }, '22:00') === true);

// Event at or after filter time → passes
check('22:00 event passes 22:00 gate', failsTimeGate(
  { start_time_local: '2026-02-22T22:00:00' }, '22:00') === false);
check('23:30 event passes 22:00 gate', failsTimeGate(
  { start_time_local: '2026-02-22T23:30:00' }, '22:00') === false);

// After-midnight wrapping: 01:00 treated as next-day, passes 22:00
check('01:00 after-midnight passes 22:00 gate', failsTimeGate(
  { start_time_local: '2026-02-23T01:00:00' }, '22:00') === false);
check('01:30 after-midnight passes 22:00 gate', failsTimeGate(
  { start_time_local: '2026-02-23T01:30:00' }, '22:00') === false);
check('05:00 after-midnight passes 22:00 gate', failsTimeGate(
  { start_time_local: '2026-02-23T05:00:00' }, '22:00') === false);

// After-midnight filter: 00:00 excludes 22:00 but includes 01:00
check('22:00 event fails 00:00 gate', failsTimeGate(
  { start_time_local: '2026-02-22T22:00:00' }, '00:00') === true);
check('01:00 event passes 00:00 gate', failsTimeGate(
  { start_time_local: '2026-02-23T01:00:00' }, '00:00') === false);

// No start_time → passes (does not fail)
check('no start_time → passes', failsTimeGate({}, '22:00') === false);
check('null start_time → passes', failsTimeGate({ start_time_local: null }, '22:00') === false);

// Non-parseable time format → passes
check('date-only → passes', failsTimeGate(
  { start_time_local: '2026-02-22' }, '22:00') === false);


// ---- buildTaggedPool time gate ----
console.log('\nbuildTaggedPool time gate:');

const timeEvents = [
  { id: 't1', name: 'Early Show', category: 'comedy', is_free: false, start_time_local: '2026-02-22T18:00:00' },
  { id: 't2', name: 'Dinner Show', category: 'comedy', is_free: false, start_time_local: '2026-02-22T20:00:00' },
  { id: 't3', name: 'Late Show', category: 'comedy', is_free: false, start_time_local: '2026-02-22T23:00:00' },
  { id: 't4', name: 'After Midnight', category: 'comedy', is_free: false, start_time_local: '2026-02-23T01:30:00' },
  { id: 't5', name: 'No Time Event', category: 'comedy', is_free: false },
];

// time_after: 22:00 — should exclude t1 (18:00) and t2 (20:00), keep t3, t4, t5
const timeGatedResult = buildTaggedPool(timeEvents, { time_after: '22:00' });
check('time gate: pool excludes early events', timeGatedResult.pool.every(e => e.id !== 't1' && e.id !== 't2'));
check('time gate: 23:00 event in pool', timeGatedResult.pool.some(e => e.id === 't3'));
check('time gate: after-midnight in pool', timeGatedResult.pool.some(e => e.id === 't4'));
check('time gate: no-time event in pool', timeGatedResult.pool.some(e => e.id === 't5'));
check('time gate: pool size 3', timeGatedResult.pool.length === 3);

// time_after + category: 22:00 + comedy — hard gates time, then matches category
const timeCatEvents = [
  { id: 'tc1', name: 'Early Comedy', category: 'comedy', is_free: false, start_time_local: '2026-02-22T18:00:00' },
  { id: 'tc2', name: 'Late Comedy', category: 'comedy', is_free: false, start_time_local: '2026-02-22T23:00:00' },
  { id: 'tc3', name: 'Late Music', category: 'live_music', is_free: false, start_time_local: '2026-02-22T23:30:00' },
  { id: 'tc4', name: 'Early Music', category: 'live_music', is_free: false, start_time_local: '2026-02-22T19:00:00' },
];
const timeCatResult = buildTaggedPool(timeCatEvents, { category: 'comedy', time_after: '22:00' });
check('time+cat: early comedy excluded', timeCatResult.pool.every(e => e.id !== 'tc1'));
check('time+cat: early music excluded', timeCatResult.pool.every(e => e.id !== 'tc4'));
check('time+cat: late comedy is hard match', timeCatResult.pool.find(e => e.id === 'tc2')?.filter_match === 'hard');
check('time+cat: late music not in pool', !timeCatResult.pool.some(e => e.id === 'tc3'));
check('time+cat: matchCount 1', timeCatResult.matchCount === 1);
check('time+cat: pool size 1 (matched only)', timeCatResult.pool.length === 1);

// After-midnight filter: 00:00 — excludes 22:00 but includes 01:00
const midnightEvents = [
  { id: 'mn1', name: '10pm Event', category: 'nightlife', is_free: false, start_time_local: '2026-02-22T22:00:00' },
  { id: 'mn2', name: '1am Event', category: 'nightlife', is_free: false, start_time_local: '2026-02-23T01:00:00' },
  { id: 'mn3', name: '3am Event', category: 'nightlife', is_free: false, start_time_local: '2026-02-23T03:00:00' },
];
const midnightResult = buildTaggedPool(midnightEvents, { time_after: '00:00' });
check('midnight gate: 22:00 excluded', midnightResult.pool.every(e => e.id !== 'mn1'));
check('midnight gate: 01:00 included', midnightResult.pool.some(e => e.id === 'mn2'));
check('midnight gate: 03:00 included', midnightResult.pool.some(e => e.id === 'mn3'));
check('midnight gate: pool size 2', midnightResult.pool.length === 2);

// No time filter → no time gating (events still classified normally)
const noTimeFilterResult = buildTaggedPool(timeEvents, { category: 'comedy' });
check('no time filter: all events in pool', noTimeFilterResult.pool.length === 5);
check('no time filter: all hard matched', noTimeFilterResult.pool.every(e => e.filter_match === 'hard'));


// ---- describeFilters ----
console.log('\ndescribeFilters:');

// Single filters
check('comedy → "comedy"', describeFilters({ category: 'comedy' }) === 'comedy');
check('live_music → "live music"', describeFilters({ category: 'live_music' }) === 'live music');
check('nightlife → "nightlife"', describeFilters({ category: 'nightlife' }) === 'nightlife');
check('art → "art"', describeFilters({ category: 'art' }) === 'art');
check('theater → "theater"', describeFilters({ category: 'theater' }) === 'theater');
check('community → "community"', describeFilters({ category: 'community' }) === 'community');
check('free_only → "free events"', describeFilters({ free_only: true }) === 'free events');

// Subcategory overrides category
check('jazz subcategory → "jazz"', describeFilters({ category: 'live_music', subcategory: 'jazz' }) === 'jazz');
check('rock subcategory → "rock"', describeFilters({ category: 'live_music', subcategory: 'rock' }) === 'rock');
check('techno subcategory → "techno"', describeFilters({ category: 'nightlife', subcategory: 'techno' }) === 'techno');
check('standup subcategory → "standup"', describeFilters({ category: 'comedy', subcategory: 'standup' }) === 'standup');

// Compound: free + category
check('free comedy → "free comedy"', describeFilters({ category: 'comedy', free_only: true }) === 'free comedy');
check('free jazz → "free jazz"', describeFilters({ category: 'live_music', subcategory: 'jazz', free_only: true }) === 'free jazz');

// Compound: free + category + time
check('free comedy after 10pm', describeFilters({ category: 'comedy', free_only: true, time_after: '22:00' }) === 'free comedy after 10pm');
check('free jazz after 10pm', describeFilters({ category: 'live_music', subcategory: 'jazz', free_only: true, time_after: '22:00' }) === 'free jazz after 10pm');

// Time variants
check('time 22:00 → after 10pm', describeFilters({ time_after: '22:00' }) === 'events after 10pm');
check('time 00:00 → after midnight', describeFilters({ time_after: '00:00' }) === 'events after midnight');
check('time 21:00 → after 9pm', describeFilters({ time_after: '21:00' }) === 'events after 9pm');
check('time 12:00 → after noon', describeFilters({ time_after: '12:00' }) === 'events after noon');
check('time 13:30 → after 1:30pm', describeFilters({ time_after: '13:30' }) === 'events after 1:30pm');
check('comedy after 9pm', describeFilters({ category: 'comedy', time_after: '21:00' }) === 'comedy after 9pm');

// Vibe
check('chill → "chill"', describeFilters({ vibe: 'chill' }) === 'chill');
check('free chill → "free chill"', describeFilters({ free_only: true, vibe: 'chill' }) === 'free chill');
check('chill comedy → "comedy chill"', describeFilters({ category: 'comedy', vibe: 'chill' }) === 'comedy chill');

// Edge cases
check('null → "events"', describeFilters(null) === 'events');
check('undefined → "events"', describeFilters(undefined) === 'events');
check('empty → "events"', describeFilters({}) === 'events');
check('all falsy → "events"', describeFilters({ category: null, free_only: false, time_after: null, vibe: null }) === 'events');
check('free_only false → "events"', describeFilters({ free_only: false }) === 'events');
check('non-object → "events"', describeFilters('comedy') === 'events');
