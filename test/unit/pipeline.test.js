const { check } = require('../helpers');
const { mergeFilters, eventMatchesFilters, buildTaggedPool } = require('../../src/pipeline');

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
check('defaults: vibe null', defaults.vibe === null);
check('defaults: time_after null', defaults.time_after === null);


// ---- eventMatchesFilters ----
console.log('\neventMatchesFilters:');

const comedyFree = { category: 'comedy', is_free: true, start_time_local: '2026-02-22T20:00:00' };
const comedyPaid = { category: 'comedy', is_free: false, start_time_local: '2026-02-22T21:00:00' };
const musicLate = { category: 'live_music', is_free: false, start_time_local: '2026-02-22T23:30:00' };
const musicEarly = { category: 'live_music', is_free: false, start_time_local: '2026-02-22T18:00:00' };
const artNoTime = { category: 'art', is_free: true };
const lateNight = { category: 'nightlife', is_free: false, start_time_local: '2026-02-23T01:30:00' };

// Category filter
check('category match', eventMatchesFilters(comedyFree, { category: 'comedy' }));
check('category mismatch', !eventMatchesFilters(musicLate, { category: 'comedy' }));

// Free filter
check('free match', eventMatchesFilters(comedyFree, { free_only: true }));
check('free mismatch', !eventMatchesFilters(comedyPaid, { free_only: true }));
check('free_only false → passes', eventMatchesFilters(comedyPaid, { free_only: false }));

// Combined: category + free
check('comedy+free match', eventMatchesFilters(comedyFree, { category: 'comedy', free_only: true }));
check('comedy+free mismatch (paid)', !eventMatchesFilters(comedyPaid, { category: 'comedy', free_only: true }));

// Time filter
check('time 22:00 passes 23:30', eventMatchesFilters(musicLate, { time_after: '22:00' }));
check('time 22:00 fails 18:00', !eventMatchesFilters(musicEarly, { time_after: '22:00' }));
check('time 22:00 passes 20:00? no', !eventMatchesFilters(comedyFree, { time_after: '22:00' }));

// After-midnight wrapping: 01:30 should pass time_after 22:00
check('after-midnight 01:30 passes 22:00', eventMatchesFilters(lateNight, { time_after: '22:00' }));

// No time on event → passes (soft)
check('no start_time → passes time filter', eventMatchesFilters(artNoTime, { time_after: '22:00' }));

// Empty filters → everything passes
check('empty filters → passes', eventMatchesFilters(comedyPaid, {}));
check('all null filters → passes', eventMatchesFilters(comedyPaid, { category: null, free_only: false, time_after: null }));

// All dimensions combined
check('all filters match', eventMatchesFilters(
  { category: 'comedy', is_free: true, start_time_local: '2026-02-22T23:00:00' },
  { category: 'comedy', free_only: true, time_after: '22:00' }
));
check('all filters fail on category', !eventMatchesFilters(
  { category: 'live_music', is_free: true, start_time_local: '2026-02-22T23:00:00' },
  { category: 'comedy', free_only: true, time_after: '22:00' }
));


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
check('no filters: isSparse false', noFilterResult.isSparse === false);
check('no filters: all filter_match false', noFilterResult.pool.every(e => e.filter_match === false));

// Null filters → same as empty
const nullFilterResult = buildTaggedPool(makeEvents(20), null);
check('null filters: pool size 15', nullFilterResult.pool.length === 15);
check('null filters: matchCount 0', nullFilterResult.matchCount === 0);

// All match → 10 matched + 5 unmatched (but all have same category...)
// Mix categories: 8 comedy + 12 nightlife, filter for comedy
const mixed = [
  ...makeEvents(8, { category: 'comedy' }),
  ...makeEvents(12, { category: 'nightlife' }),
];
const comedyResult = buildTaggedPool(mixed, { category: 'comedy' });
check('comedy filter: matchCount 8', comedyResult.matchCount === 8);
check('comedy filter: pool size 15', comedyResult.pool.length === 15);
check('comedy filter: isSparse false (8 >= 3)', comedyResult.isSparse === false);
check('comedy filter: first 8 matched', comedyResult.pool.slice(0, 8).every(e => e.filter_match === true));
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
check('sparse: first 2 matched', sparseResult.pool.slice(0, 2).every(e => e.filter_match === true));
check('sparse: rest unmatched', sparseResult.pool.slice(2).every(e => e.filter_match === false));

// Zero matches → matchCount 0, isSparse false (0 is not sparse, it's empty)
const zeroResult = buildTaggedPool(makeEvents(20, { category: 'nightlife' }), { category: 'comedy' });
check('zero matches: matchCount 0', zeroResult.matchCount === 0);
check('zero matches: isSparse false', zeroResult.isSparse === false);
check('zero matches: pool size 15', zeroResult.pool.length === 15);
check('zero matches: all unmatched', zeroResult.pool.every(e => e.filter_match === false));

// Matched > 10 → cap at 10 matched
const manyMatched = makeEvents(14, { category: 'comedy' });
const manyResult = buildTaggedPool([...manyMatched, ...makeEvents(6, { category: 'nightlife' })], { category: 'comedy' });
check('many matches: matchCount 14', manyResult.matchCount === 14);
check('many matches: pool size 15', manyResult.pool.length === 15);
check('many matches: 10 matched in pool', manyResult.pool.filter(e => e.filter_match).length === 10);
check('many matches: 5 unmatched padding', manyResult.pool.filter(e => !e.filter_match).length === 5);

// Small event list → pool smaller than 15
const smallResult = buildTaggedPool(makeEvents(5, { category: 'comedy' }), { category: 'comedy' });
check('small list: pool size 5', smallResult.pool.length === 5);
check('small list: all matched', smallResult.pool.every(e => e.filter_match === true));
check('small list: matchCount 5', smallResult.matchCount === 5);

// Free filter
const freeEvents = [
  ...makeEvents(4, { is_free: true }),
  ...makeEvents(16, { is_free: false }),
];
const freeResult = buildTaggedPool(freeEvents, { free_only: true });
check('free filter: matchCount 4', freeResult.matchCount === 4);
check('free filter: isSparse false', freeResult.isSparse === false);
check('free filter: first 4 matched', freeResult.pool.slice(0, 4).every(e => e.filter_match === true));

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
check('combined: isSparse true', combinedResult.isSparse === true);
check('combined: first 2 matched', combinedResult.pool.slice(0, 2).every(e => e.filter_match === true));

// Original events not mutated
const original = makeEvents(5, { category: 'comedy' });
const origId = original[0].id;
buildTaggedPool(original, { category: 'comedy' });
check('original not mutated', original[0].filter_match === undefined);
check('original id preserved', original[0].id === origId);
