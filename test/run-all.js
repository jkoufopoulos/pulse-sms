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
require('./unit/pipeline.test');
require('./unit/ai.test');
require('./unit/curation.test');
require('./unit/scrapers.test');
require('./unit/scrape-guard.test');
require('./unit/db.test');
require('./unit/agent-brain.test');
require('./unit/proactive.test');
require('./unit/digest.test');
require('./unit/model-config.test');
require('./unit/llm.test');
require('./unit/agent-loop.test');
require('./unit/traces-latency.test');
require('./unit/source-health-disable.test');
require('./unit/graduated-alert.test');
require('./unit/nudges.test');
require('./unit/extraction-cache.test');
require('./unit/classify-other.test');
require('./unit/venue-aliases.test');
require('./unit/places.test');
const misc = require('./unit/misc.test');
const profile = require('./unit/preference-profile.test');

// Integration tests
const smsFlow = require('./integration/sms-flow.test');

(async () => {
  // Async unit tests
  await venues.runAsync();
  await misc.runAsync();
  await profile.runAsync();

  // Async integration tests
  await smsFlow.runAsync();

  // Summary
  const { pass, fail } = require('./helpers').getResults();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
