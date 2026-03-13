const { check } = require('../helpers');
const { computeDigestStatus, buildNeedsAttention } = require('../../src/daily-digest');
const { sendGraduatedAlert } = require('../../src/alerts');

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

// --- sendGraduatedAlert smoke tests ---
console.log('\nsendGraduatedAlert:');

check('sendGraduatedAlert is a function', typeof sendGraduatedAlert === 'function');

// Green digest — should no-op (returns undefined)
const greenResult = sendGraduatedAlert({ status: 'green' });
check('sendGraduatedAlert no-ops on green', greenResult instanceof Promise || greenResult === undefined);

// --- buildNeedsAttention with disabled sources ---
console.log('\nbuildNeedsAttention disabled sources:');

const sourceData = [
  { name: 'Skint', count: 0, avg7d: 15, minExpected: 5, schedule: null, isQuarantined: false, isDisabled: true, consecutiveZeros: 9 },
  { name: 'RA', count: 20, avg7d: 25, minExpected: 10, schedule: null, isQuarantined: false, isDisabled: false, consecutiveZeros: 0 },
  { name: 'BKMag', count: 0, avg7d: 8, minExpected: 3, schedule: { days: ['fri', 'sat'] }, isQuarantined: false, isDisabled: false, consecutiveZeros: 2 },
];

const items = buildNeedsAttention(sourceData, 'wednesday');
check('disabled source appears in needs-attention', items.some(i => i.source === 'Skint'));
check('disabled source has warn severity', items.find(i => i.source === 'Skint')?.severity === 'warn');
check('disabled source mentions consecutive failures', items.find(i => i.source === 'Skint')?.issue.includes('9 consecutive'));
check('healthy source not in needs-attention', !items.some(i => i.source === 'RA'));
check('off-schedule source is info not warn', items.find(i => i.source === 'BKMag')?.severity === 'info');
