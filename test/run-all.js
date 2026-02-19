/**
 * Test runner — loads all unit + integration tests.
 * Run: node test/run-all.js
 */

// Sync unit tests (run on require)
require('./unit/neighborhoods.test');
require('./unit/events.test');
require('./unit/geo.test');
require('./unit/formatters.test');
const venues = require('./unit/venues.test');
require('./unit/pre-router.test');
require('./unit/perennials.test');
require('./unit/ai.test');
const misc = require('./unit/misc.test');

// Integration tests
const smsFlow = require('./integration/sms-flow.test');

(async () => {
  // Async unit tests
  await venues.runAsync();
  await misc.runAsync();

  // Async integration tests
  await smsFlow.runAsync();

  // Summary
  const { pass, fail } = require('./helpers').getResults();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
