const { check } = require('../helpers');

console.log('coverage.test.js');

const { computeCoverageMatrix } = require('../../src/source-health');

const events = [
  { neighborhood: 'Williamsburg', category: 'live_music', date_local: '2026-04-04', start_time_local: '2026-04-04T20:00:00', source_url: 'https://x.com' },
  { neighborhood: 'Williamsburg', category: 'live_music', date_local: '2026-04-04', start_time_local: '2026-04-04T21:00:00', source_url: 'https://x.com' },
  { neighborhood: 'Williamsburg', category: 'comedy', date_local: '2026-04-05', start_time_local: null, source_url: null },
  { neighborhood: 'Bushwick', category: 'live_music', date_local: '2026-04-04', start_time_local: '2026-04-04T22:00:00', source_url: 'https://x.com' },
];

const matrix = computeCoverageMatrix(events);

check('coverage: has neighborhood entries', matrix.byNeighborhood['Williamsburg'] !== undefined);
check('coverage: Williamsburg has 3 events', matrix.byNeighborhood['Williamsburg'].total === 3);
check('coverage: Williamsburg complete is 2', matrix.byNeighborhood['Williamsburg'].complete === 2);
check('coverage: Bushwick has 1 event', matrix.byNeighborhood['Bushwick'].total === 1);
check('coverage: category breakdown exists', matrix.byCategory['live_music'] !== undefined);
check('coverage: live_music count is 3', matrix.byCategory['live_music'].total === 3);
check('coverage: summary has total', matrix.summary.total === 4);
check('coverage: summary has completeRate', matrix.summary.completeRate > 0);

module.exports = { check };
