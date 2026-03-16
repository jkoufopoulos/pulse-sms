const { check } = require('../helpers');
const { curatePool, computeNearbyHighlight } = require('../../src/brain-execute');

console.log('\ncuratePool:');

const makeEvent = (id, hood, interestingness, cat) => ({
  id, neighborhood: hood, category: cat,
  source_vibe: interestingness >= 5 ? 'discovery' : 'platform',
  is_recurring: interestingness < 3,
  editorial_signal: interestingness >= 7,
  scarcity: interestingness >= 8 ? 'one-night-only' : null,
  venue_size: 'medium',
  interaction_format: null,
  filter_match: false,
  name: `Event ${id}`, venue_name: `Venue ${id}`,
});

const pool = [
  makeEvent('e1', 'Greenpoint', 9, 'live_music'),
  makeEvent('e2', 'Greenpoint', 7, 'comedy'),
  makeEvent('e3', 'Greenpoint', 5, 'art'),
  makeEvent('e4', 'Greenpoint', 3, 'dj'),
  makeEvent('e5', 'Greenpoint', 1, 'trivia'),
  makeEvent('e6', 'Williamsburg', 9, 'live_music'),
  makeEvent('e7', 'Williamsburg', 8, 'comedy'),
  makeEvent('e8', 'Williamsburg', 6, 'dj'),
  makeEvent('e9', 'Williamsburg', 4, 'art'),
  makeEvent('e10', 'LES', 5, 'jazz'),
  makeEvent('e11', 'Greenpoint', 2, 'community'),
  makeEvent('e12', 'Greenpoint', 1, 'food_drink'),
  makeEvent('e13', 'Greenpoint', 1, 'nightlife'),
  makeEvent('e14', 'Greenpoint', 0, 'trivia'),
  makeEvent('e15', 'Greenpoint', 0, 'dj'),
];

// Default: top 10
const result = curatePool(pool, 'Greenpoint');
check('default returns 10 or fewer', result.curatedPool.length <= 10);
check('keeps full pool for nearby computation', result.fullScoredPool.length === 15);
check('curated pool has interestingness scores', result.curatedPool[0].interestingness !== undefined);
check('full scored pool has interestingness scores', result.fullScoredPool[0].interestingness !== undefined);

// Custom limit
const small = curatePool(pool, 'Greenpoint', { poolSize: 5 });
check('custom poolSize=5', small.curatedPool.length <= 5);

// Requested hood events are present
const hoodEvents = result.curatedPool.filter(e => e.neighborhood === 'Greenpoint');
check('requested hood events present', hoodEvents.length >= 1);

// Category diversity
const categories = new Set(result.curatedPool.map(e => e.category));
check('category diversity in curated pool', categories.size >= 3);

// Empty pool
const empty = curatePool([], 'Greenpoint');
check('empty pool returns empty', empty.curatedPool.length === 0);
check('empty pool full scored is empty', empty.fullScoredPool.length === 0);

// ---- computeNearbyHighlight ----
console.log('\ncomputeNearbyHighlight:');

const reqEvents = [
  { neighborhood: 'Greenpoint', interestingness: 3 },
  { neighborhood: 'Greenpoint', interestingness: 2 },
  { neighborhood: 'Greenpoint', interestingness: 1 },
];
const nearbyEvts = [
  { id: 'n1', name: 'MAYHEM Ball', venue_name: '3 Dollar Bill', neighborhood: 'Williamsburg', interestingness: 9, editorial_signal: true, scarcity: 'one-night-only' },
  { id: 'n2', name: 'Sofar Sounds', venue_name: 'Secret Location', neighborhood: 'Williamsburg', interestingness: 7, scarcity: 'one-night-only' },
  { id: 'n3', name: 'Some DJ Night', venue_name: 'Elsewhere', neighborhood: 'Williamsburg', interestingness: 6 },
];

const hl = computeNearbyHighlight(reqEvents, nearbyEvts, 'Greenpoint');
check('highlight present when nearby is stronger', hl !== null);
check('highlight hood is Williamsburg', hl.hood === 'Williamsburg');
check('highlight has top_pick', hl.top_pick.includes('MAYHEM'));
check('highlight has reason', hl.reason.length > 0);

const strongReq = [
  { neighborhood: 'Greenpoint', interestingness: 9 },
  { neighborhood: 'Greenpoint', interestingness: 8 },
  { neighborhood: 'Greenpoint', interestingness: 7 },
];
const weakNearby = [{ neighborhood: 'Williamsburg', interestingness: 2 }];
check('no highlight when requested is stronger', computeNearbyHighlight(strongReq, weakNearby, 'Greenpoint') === null);
check('no highlight with empty nearby', computeNearbyHighlight(reqEvents, [], 'Greenpoint') === null);
