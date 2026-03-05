const { check } = require('../helpers');

// --- updateSourceHealth stores field coverage ---
console.log('\nupdateSourceHealth field coverage:');

const { makeHealthEntry, updateSourceHealth, sourceHealth } = require('../../src/source-health');

// Inject a test source
sourceHealth['TestSource'] = makeHealthEntry();

const testEvents = [
  { name: 'Event A', venue_name: 'Venue 1', date_local: '2026-03-05' },
  { name: 'Event B', venue_name: null, date_local: '2026-03-05' },
  { name: 'Event C', venue_name: 'Venue 3', date_local: null },
  { name: null, venue_name: null, date_local: null },
];

updateSourceHealth('TestSource', { events: testEvents, durationMs: 100, status: 'ok', error: null });

const entry = sourceHealth['TestSource'].history[0];
check('history entry has fieldCoverage', !!entry.fieldCoverage);
check('name coverage is 0.75', entry.fieldCoverage.name === 0.75);
check('venue_name coverage is 0.5', entry.fieldCoverage.venue_name === 0.5);
check('date_local coverage is 0.5', entry.fieldCoverage.date_local === 0.5);

// Clean up
delete sourceHealth['TestSource'];
