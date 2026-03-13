const { check } = require('../helpers');

const { sourceHealth, makeHealthEntry, updateSourceHealth, isSourceDisabled, shouldProbeDisabled, computeFieldCoverage } = require('../../src/source-health');

console.log('\nauto-disable after 7 consecutive zeros:');

// --- Auto-disable at threshold ---
sourceHealth['TestDisable'] = makeHealthEntry();
for (let i = 0; i < 7; i++) {
  updateSourceHealth('TestDisable', { events: [], durationMs: 100, status: 'ok', error: null });
}
check('disabled after 7 consecutive zeros', sourceHealth['TestDisable'].disabled === true);
check('disabledAt is set', sourceHealth['TestDisable'].disabledAt !== null);
check('isSourceDisabled returns true', isSourceDisabled('TestDisable') === true);

// --- Not disabled at 6 ---
sourceHealth['TestNotYet'] = makeHealthEntry();
for (let i = 0; i < 6; i++) {
  updateSourceHealth('TestNotYet', { events: [], durationMs: 100, status: 'ok', error: null });
}
check('not disabled at 6 zeros', sourceHealth['TestNotYet'].disabled === false);
check('isSourceDisabled returns false', isSourceDisabled('TestNotYet') === false);

// --- Auto-recovery ---
console.log('\nauto-recovery:');
sourceHealth['TestRecover'] = makeHealthEntry();
for (let i = 0; i < 7; i++) {
  updateSourceHealth('TestRecover', { events: [], durationMs: 100, status: 'ok', error: null });
}
check('disabled before recovery', sourceHealth['TestRecover'].disabled === true);

updateSourceHealth('TestRecover', {
  events: [{ name: 'E', venue_name: 'V', date_local: '2026-03-13' }],
  durationMs: 100, status: 'ok', error: null,
});
check('recovered after successful scrape', sourceHealth['TestRecover'].disabled === false);
check('disabledAt cleared', sourceHealth['TestRecover'].disabledAt === null);
check('consecutiveZeros reset', sourceHealth['TestRecover'].consecutiveZeros === 0);

// --- shouldProbeDisabled ---
console.log('\nshouldProbeDisabled:');
sourceHealth['TestProbe'] = makeHealthEntry();
sourceHealth['TestProbe'].disabled = true;
sourceHealth['TestProbe'].disabledAt = new Date().toISOString();
sourceHealth['TestProbe'].lastProbeAt = null;
check('should probe: never probed', shouldProbeDisabled('TestProbe') === true);

sourceHealth['TestProbe'].lastProbeAt = new Date().toISOString();
check('should not probe: just probed', shouldProbeDisabled('TestProbe') === false);

sourceHealth['TestProbe'].lastProbeAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
check('should probe: probed >24h ago', shouldProbeDisabled('TestProbe') === true);

// Not disabled = no probe needed
sourceHealth['TestProbeOk'] = makeHealthEntry();
check('should not probe: not disabled', shouldProbeDisabled('TestProbeOk') === false);

// Unknown source
check('should not probe: unknown source', shouldProbeDisabled('NonExistent') === false);

// --- computeFieldCoverage includes start_time_local and neighborhood ---
console.log('\ncomputeFieldCoverage:');
const coverageEvents = [
  { name: 'A', venue_name: 'V', date_local: '2026-03-13', start_time_local: '2026-03-13T19:00:00', neighborhood: 'Williamsburg' },
  { name: 'B', venue_name: 'V', date_local: '2026-03-13', start_time_local: null, neighborhood: 'Bushwick' },
  { name: 'C', venue_name: null, date_local: '2026-03-13', start_time_local: '2026-03-13T20:00:00', neighborhood: null },
];
const coverage = computeFieldCoverage(coverageEvents);
check('start_time_local coverage is 2/3', Math.abs(coverage.start_time_local - 0.667) < 0.01);
check('neighborhood coverage is 2/3', Math.abs(coverage.neighborhood - 0.667) < 0.01);
check('name coverage is 1', coverage.name === 1);
check('empty events returns zeros', computeFieldCoverage([]).start_time_local === 0);

// Clean up
for (const k of ['TestDisable', 'TestNotYet', 'TestRecover', 'TestProbe', 'TestProbeOk']) {
  delete sourceHealth[k];
}
