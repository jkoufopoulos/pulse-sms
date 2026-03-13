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

// --- Count drift — warn only, no quarantine ---
sh['TestGuard'] = { ...mkEntry(), history: buildHistory(100, 5) };
const countDriftEvents = Array.from({ length: 30 }, (_, i) => ({ name: `Event ${i}`, venue_name: 'V', date_local: '2026-03-05' }));
const countDrift = checkBaseline('TestGuard', countDriftEvents);
check('count drift: NOT quarantined (warn only)', countDrift.quarantined === false);

// --- Field coverage drift (threshold 0.60) ---
sh['TestFieldDrift'] = { ...mkEntry(), history: buildHistory(50, 5, { name: 0.95, venue_name: 0.90, date_local: 0.85, start_time_local: 0.80, neighborhood: 0.75 }) };
const badVenues = [];
for (let i = 0; i < 50; i++) {
  badVenues.push({ name: `Event ${i}`, venue_name: i < 10 ? 'V' : null, date_local: '2026-03-05' });
}
const fieldDrift = checkBaseline('TestFieldDrift', badVenues);
check('field drift: quarantined (venue coverage 0.20 vs avg 0.90)', fieldDrift.quarantined === true);
check('field drift: reason mentions venue_name', fieldDrift.reason.includes('venue_name'));

// Moderate drop should NOT quarantine (enrichment handles it)
sh['TestFieldModerate'] = { ...mkEntry(), history: buildHistory(50, 5, { name: 0.95, venue_name: 0.90, date_local: 0.85, start_time_local: 0.80, neighborhood: 0.75 }) };
const moderateVenues = [];
for (let i = 0; i < 50; i++) {
  moderateVenues.push({ name: `Event ${i}`, venue_name: i < 25 ? 'V' : null, date_local: '2026-03-05' });
}
const moderateResult = checkBaseline('TestFieldModerate', moderateVenues);
check('moderate field drop: NOT quarantined (0.50 vs 0.90, drop=0.40 < 0.60)', moderateResult.quarantined === false);

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

// --- Volatile source: uses median instead of mean ---
console.log('\nvolatile source baseline:');

// Simulate volatile history: 3, 14, 1108, 74, 43 (median=43, mean=248)
sh['TestVolatile'] = { ...mkEntry(), history: [], volatile: true };
for (const count of [3, 14, 1108, 74, 43]) {
  sh['TestVolatile'].history.push({
    timestamp: new Date().toISOString(), count, durationMs: 100, status: 'ok',
    fieldCoverage: { name: 0.95, venue_name: 0.90, date_local: 0.85 },
  });
}

// Count drift no longer quarantines — volatile sources pass regardless of count
const volatileEvents = Array.from({ length: 5 }, (_, i) => ({ name: `Event ${i}`, venue_name: 'V', date_local: '2026-03-05' }));
const volatileResult = checkBaseline('TestVolatile', volatileEvents);
check('volatile source: not quarantined (count drift is warn-only)', volatileResult.quarantined === false);

// --- Duplicate spike: legitimate multi-show venue ---
console.log('\nduplicate spike — multi-show:');
sh['TestMultiShow'] = { ...mkEntry(), history: buildHistory(25, 5) };
const multiShowEvents = [];
for (let d = 7; d <= 13; d++) {
  for (const time of ['19:00', '20:30', '22:15']) {
    multiShowEvents.push({
      name: 'Best of Brooklyn Stand-Up Comedy',
      venue_name: 'The Tiny Cupboard',
      date_local: `2026-03-${String(d).padStart(2, '0')}`,
      start_time_local: `2026-03-${String(d).padStart(2, '0')}T${time}:00`,
    });
  }
}
multiShowEvents.push({ name: 'Trivia Night', venue_name: 'The Tiny Cupboard', date_local: '2026-03-07', start_time_local: '2026-03-07T18:00:00' });
multiShowEvents.push({ name: 'Open Mic', venue_name: 'The Tiny Cupboard', date_local: '2026-03-08', start_time_local: '2026-03-08T17:00:00' });
const multiShowResult = checkBaseline('TestMultiShow', multiShowEvents);
check('multi-show venue: NOT quarantined (distinct times)', multiShowResult.quarantined === false);

// True duplication: same name AND same time (extraction error)
sh['TestTrueDupes'] = { ...mkEntry(), history: buildHistory(20, 5) };
const trueDupeEvents = [];
for (let i = 0; i < 15; i++) {
  trueDupeEvents.push({ name: 'Broken Event', venue_name: 'V', date_local: '2026-03-07', start_time_local: '2026-03-07T20:00:00' });
}
for (let i = 0; i < 5; i++) {
  trueDupeEvents.push({ name: `Other ${i}`, venue_name: 'V', date_local: '2026-03-07', start_time_local: '2026-03-07T19:00:00' });
}
const trueDupeResult = checkBaseline('TestTrueDupes', trueDupeEvents);
check('true duplication: quarantined (same name+time)', trueDupeResult.quarantined === true);

// Clean up
for (const k of ['TestGuard', 'TestFieldDrift', 'TestFieldModerate', 'TestDupes', 'TestDates', 'TestNewSource', 'TestVolatile', 'TestMultiShow', 'TestTrueDupes']) {
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
