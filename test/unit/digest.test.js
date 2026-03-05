const { check } = require('../helpers');

console.log('\n--- digest.test.js ---');

const { computeDigestStatus, buildNeedsAttention } = require('../../src/daily-digest');

// Test status logic
console.log('\nDigest status logic:');

const green = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 5,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('all ok = green', green === 'green');

const yellow1 = computeDigestStatus({
  sourcesBelow: ['Skint'],
  cacheDrop: 5,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('1 source below = yellow', yellow1 === 'yellow');

const yellow2 = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 25,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('cache drop 25% = yellow', yellow2 === 'yellow');

const yellow3 = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 5,
  userFacingErrors: 0,
  latencyP95: 6000,
});
check('high latency = yellow', yellow3 === 'yellow');

const red1 = computeDigestStatus({
  sourcesBelow: ['Skint', 'RA', 'Dice', 'DoNYC'],
  cacheDrop: 5,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('>3 sources below = red', red1 === 'red');

const red2 = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 5,
  userFacingErrors: 2,
  latencyP95: 2000,
});
check('user-facing errors = red', red2 === 'red');

const red3 = computeDigestStatus({
  sourcesBelow: [],
  cacheDrop: 45,
  userFacingErrors: 0,
  latencyP95: 2000,
});
check('cache drop 45% = red', red3 === 'red');

// Test needs-attention filtering
console.log('\nNeeds attention filtering:');

const sourceData = [
  { name: 'Skint', count: 0, avg7d: 18, minExpected: 5, schedule: null },
  { name: 'BKMag', count: 0, avg7d: 8, minExpected: 5, schedule: { days: ['fri', 'sat'] } },
  { name: 'DoNYC', count: 500, avg7d: 520, minExpected: 100, schedule: null },
  { name: 'RA', count: 3, avg7d: 200, minExpected: 50, schedule: null },
];

// Wednesday — BKMag 0 is expected (off-schedule)
const items = buildNeedsAttention(sourceData, 'wednesday');
check('Skint flagged as warn', items.some(i => i.source === 'Skint' && i.severity === 'warn'));
check('BKMag flagged as info (off-schedule)', items.some(i => i.source === 'BKMag' && i.severity === 'info'));
check('DoNYC not flagged (healthy)', !items.some(i => i.source === 'DoNYC'));
check('RA flagged as warn (3 vs avg 200)', items.some(i => i.source === 'RA' && i.severity === 'warn'));

// Friday — BKMag 0 is unexpected
const fridayItems = buildNeedsAttention(
  [{ name: 'BKMag', count: 0, avg7d: 8, minExpected: 5, schedule: { days: ['fri', 'sat'] } }],
  'friday'
);
check('BKMag on friday flagged as warn', fridayItems.some(i => i.source === 'BKMag' && i.severity === 'warn'));
