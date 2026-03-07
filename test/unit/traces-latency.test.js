const { check } = require('../helpers');

console.log('\n--- traces-latency.test.js ---');

const { computeLatencyStats } = require('../../src/traces');

// Empty traces
const empty = computeLatencyStats([]);
check('empty returns zeroes', empty.count === 0 && empty.p50 === 0 && empty.p95 === 0);

// Single trace
const single = computeLatencyStats([{ total_latency_ms: 500, brain_latency_ms: 300 }]);
check('single trace p50 = 500', single.p50 === 500);
check('single trace p95 = 500', single.p95 === 500);
check('single trace max = 500', single.max === 500);
check('single trace brain_p50 = 300', single.brain_p50 === 300);

// Multiple traces with known percentiles
const traces = [];
for (let i = 1; i <= 100; i++) {
  traces.push({ total_latency_ms: i * 100, brain_latency_ms: i * 50 });
}
const stats = computeLatencyStats(traces);
check('count is 100', stats.count === 100);
check('p50 ~ 5000', stats.p50 === 5000);
check('p95 ~ 9500', stats.p95 === 9500);
check('p99 ~ 9900', stats.p99 === 9900);
check('max = 10000', stats.max === 10000);
check('brain_p50 ~ 2500', stats.brain_p50 === 2500);
check('brain_p95 ~ 4750', stats.brain_p95 === 4750);
check('avg is reasonable', stats.avg > 4000 && stats.avg < 6000);

// Traces with missing brain_latency_ms
const partial = [
  { total_latency_ms: 1000, brain_latency_ms: null },
  { total_latency_ms: 2000, brain_latency_ms: 800 },
];
const partialStats = computeLatencyStats(partial);
check('partial brain_p50 uses available data', partialStats.brain_p50 === 800);
check('total p50 uses all traces', partialStats.p50 >= 1000);

// Outlier detection
check('has outliers array', Array.isArray(stats.outliers));
