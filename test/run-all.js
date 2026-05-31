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
require('./unit/db.test');
require('./unit/agent-brain.test');
require('./unit/model-config.test');
require('./unit/llm.test');
require('./unit/rewrite.test');
require('./unit/agent-loop.test');
require('./unit/traces-latency.test');
require('./unit/extraction-cache.test');
require('./unit/venue-aliases.test');
require('./unit/places.test');
require('./unit/project-brain-context.test');
require('./unit/eval-schema.test');
require('./unit/eval-runs-schema.test');
require('./unit/eval-matcher.test');
const misc = require('./unit/misc.test');

(async () => {
  // Async unit tests
  await venues.runAsync();
  await misc.runAsync();

  // Summary
  const { pass, fail } = require('./helpers').getResults();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
