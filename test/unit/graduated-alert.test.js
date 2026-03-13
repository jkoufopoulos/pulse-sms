const { check } = require('../helpers');
const { computeDigestStatus } = require('../../src/daily-digest');

console.log('\ngraduated alert severity:');

// Green — no alert
check('green: no issues', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 0, userFacingErrors: 0, latencyP95: 1000,
}) === 'green');

// Yellow — 1-2 sources
check('yellow: 1 source below', computeDigestStatus({
  sourcesBelow: ['Skint'], cacheDrop: 5, userFacingErrors: 0, latencyP95: 1000,
}) === 'yellow');

// Yellow — cache drop 25%
check('yellow: cache drop 25%', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 25, userFacingErrors: 0, latencyP95: 1000,
}) === 'yellow');

// Yellow — high latency
check('yellow: high latency p95', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 0, userFacingErrors: 0, latencyP95: 6000,
}) === 'yellow');

// Red — >5 sources
check('red: 6 sources below', computeDigestStatus({
  sourcesBelow: ['A', 'B', 'C', 'D', 'E', 'F'], cacheDrop: 0, userFacingErrors: 0, latencyP95: 1000,
}) === 'red');

// Red — cache drop 50%
check('red: cache drop 50%', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 50, userFacingErrors: 0, latencyP95: 1000,
}) === 'red');

// Red — user-facing errors
check('red: user-facing errors', computeDigestStatus({
  sourcesBelow: [], cacheDrop: 0, userFacingErrors: 2, latencyP95: 1000,
}) === 'red');
