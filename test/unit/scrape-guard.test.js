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

// --- checkBaseline ---
console.log('\ncheckBaseline:');

const { checkBaseline } = require('../../src/scrape-guard');
const { sourceHealth: sh, makeHealthEntry: mkEntry } = require('../../src/source-health');

// Helper: build history with consistent counts and coverage
function buildHistory(count, entries, fieldCoverage = { name: 0.95, venue_name: 0.90, date_local: 0.85 }) {
  const history = [];
  for (let i = 0; i < entries; i++) {
    history.push({ timestamp: new Date().toISOString(), count, durationMs: 100, status: 'ok', fieldCoverage });
  }
  return history;
}

// --- Count drift ---
sh['TestGuard'] = { ...mkEntry(), history: buildHistory(100, 5) };
const countDrift = checkBaseline('TestGuard', new Array(30).fill({ name: 'E', venue_name: 'V', date_local: '2026-03-05' }));
check('count drift: quarantined (30 vs avg 100)', countDrift.quarantined === true);
check('count drift: reason mentions count', countDrift.reason.includes('count'));

sh['TestGuard'] = { ...mkEntry(), history: buildHistory(100, 5) };
const countOkEvents = [];
for (let i = 0; i < 80; i++) countOkEvents.push({ name: `Event ${i}`, venue_name: 'V', date_local: '2026-03-05' });
const countOk = checkBaseline('TestGuard', countOkEvents);
check('count ok: not quarantined (80 vs avg 100)', countOk.quarantined === false);

// --- Field coverage drift ---
sh['TestFieldDrift'] = { ...mkEntry(), history: buildHistory(50, 5, { name: 0.95, venue_name: 0.90, date_local: 0.85 }) };
const badVenues = [];
for (let i = 0; i < 50; i++) {
  badVenues.push({ name: `Event ${i}`, venue_name: i < 15 ? 'V' : null, date_local: '2026-03-05' });
}
const fieldDrift = checkBaseline('TestFieldDrift', badVenues);
check('field drift: quarantined (venue coverage 0.30 vs avg 0.90)', fieldDrift.quarantined === true);
check('field drift: reason mentions venue_name', fieldDrift.reason.includes('venue_name'));

// --- Duplicate spike ---
sh['TestDupes'] = { ...mkEntry(), history: buildHistory(50, 5) };
const dupeEvents = new Array(50).fill({ name: 'Same Name', venue_name: 'V', date_local: '2026-03-05' });
const dupResult = checkBaseline('TestDupes', dupeEvents);
check('duplicate spike: quarantined', dupResult.quarantined === true);
check('duplicate spike: reason mentions duplicate', dupResult.reason.includes('duplicate'));

// --- Date sanity (warn only, no quarantine) ---
sh['TestDates'] = { ...mkEntry(), history: buildHistory(50, 5, { name: 0.95, venue_name: 0.90, date_local: 0.95 }) };
const farFuture = [];
for (let i = 0; i < 50; i++) farFuture.push({ name: `Future Event ${i}`, venue_name: 'V', date_local: '2026-06-01' });
const dateResult = checkBaseline('TestDates', farFuture);
check('date sanity: NOT quarantined (warn only)', dateResult.quarantined === false);

// --- Insufficient history: skip checks ---
sh['TestNewSource'] = { ...mkEntry(), history: buildHistory(50, 2) };
const newResult = checkBaseline('TestNewSource', new Array(5).fill({ name: 'E', venue_name: 'V', date_local: '2026-03-05' }));
check('new source (<3 history): not quarantined', newResult.quarantined === false);

// Clean up
for (const k of ['TestGuard', 'TestFieldDrift', 'TestDupes', 'TestDates', 'TestNewSource']) {
  delete sh[k];
}

// --- postScrapeAudit ---
console.log('\npostScrapeAudit:');

const { postScrapeAudit } = require('../../src/scrape-guard');

// Mock fetchMap with a source that has low completeness pass rate
const mockFetchMap = {
  BAM: {
    events: [
      { id: '1', source_name: 'BAM', name: 'Show', venue_name: null, is_free: false, category: 'theater', date_local: '2026-03-05' },
      { id: '2', source_name: 'BAM', name: 'Film', venue_name: null, is_free: false, category: 'film', date_local: '2026-03-05' },
    ],
    status: 'ok',
    durationMs: 100,
    error: null,
  },
};

const auditResult = postScrapeAudit(mockFetchMap, mockFetchMap.BAM.events, {});
check('postScrapeAudit returns alerts array', Array.isArray(auditResult.alerts));
check('postScrapeAudit returns completeness results', !!auditResult.completeness);
