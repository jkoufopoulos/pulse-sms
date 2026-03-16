const { check } = require('../helpers');
const { collectIncompleteEvents, stripRawText } = require('../../src/enrichment');

console.log('\nEnrichment:');

// --- collectIncompleteEvents ---
console.log('\ncollectIncompleteEvents:');

const testEvents = [
  { name: 'A', source_name: 'theskint', start_time_local: '2026-03-13T19:00:00', venue_name: 'Venue', neighborhood: 'LES', series_end: null, _rawText: 'fri 7pm: A' },
  { name: 'B', source_name: 'theskint', start_time_local: null, venue_name: 'Venue', neighborhood: 'LES', series_end: null, _rawText: 'fri: B: desc. Venue (LES), free.' },
  { name: 'C', source_name: 'theskint', start_time_local: null, venue_name: 'Bar', neighborhood: 'Bushwick', series_end: null, _rawText: 'sat: C: desc. Bar (Bushwick), $10.' },
  { name: 'D', source_name: 'theskint', start_time_local: '2026-03-13T20:00:00', venue_name: 'Spot', neighborhood: 'Williamsburg', series_end: null, _rawText: 'fri 8pm: D' },
  { name: 'E', source_name: 'theskint', start_time_local: null, venue_name: 'Gallery', neighborhood: 'Tribeca', series_end: '2026-04-01', _rawText: 'thru april: E' },
  { name: 'F', source_name: 'dice', start_time_local: null, series_end: null },
  { name: 'G', source_name: 'theskint', start_time_local: '2026-03-13T08:00:00', venue_name: 'TBA', neighborhood: null, series_end: null, _rawText: 'fri 8am: G: citywide event.' },
];

const result = collectIncompleteEvents(testEvents);
check('finds 3 incomplete events with _rawText', result.length === 3);
check('B collected (no time)', result.some(e => e.name === 'B'));
check('C collected (no time)', result.some(e => e.name === 'C'));
check('G collected (TBA venue)', result.some(e => e.name === 'G'));
check('A not collected (complete)', !result.some(e => e.name === 'A'));
check('D not collected (complete)', !result.some(e => e.name === 'D'));
check('E not collected (series_end, has venue+hood)', !result.some(e => e.name === 'E'));
check('F not collected (no _rawText)', !result.some(e => e.name === 'F'));

// Edge: empty input
check('empty input returns empty', collectIncompleteEvents([]).length === 0);

// Edge: all complete
const allComplete = [
  { name: 'X', start_time_local: '2026-03-13T19:00:00', venue_name: 'Spot', neighborhood: 'LES', _rawText: 'fri 7pm: X' },
];
check('all complete returns empty', collectIncompleteEvents(allComplete).length === 0);

// Edge: missing _rawText not collected (structured API source)
const noRaw = [
  { name: 'Y', start_time_local: null, series_end: null },
];
check('no _rawText not collected', collectIncompleteEvents(noRaw).length === 0);

// --- stripRawText ---
console.log('\nstripRawText:');

const evts = [{ name: 'A', _rawText: 'raw' }, { name: 'B' }];
stripRawText(evts);
check('_rawText removed', !evts[0]._rawText);
check('other fields preserved', evts[0].name === 'A');
check('event without _rawText unchanged', evts[1].name === 'B');
