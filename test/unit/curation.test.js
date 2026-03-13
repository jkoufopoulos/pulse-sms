const { check } = require('../helpers');
const { filterKidsEvents, filterIncomplete, hasValidNeighborhood, isGarbageVenue } = require('../../src/curation');

console.log('\nfilterKidsEvents:');

const kidsEvent = { id: 'k1', name: 'Kids Storytime at the Park', source_name: 'nyc-parks', description_short: 'Fun for toddlers', completeness: 0.8 };
const adultParkEvent = { id: 'k2', name: 'Jazz in the Park', source_name: 'nyc-parks', description_short: 'Live jazz under the stars', completeness: 0.8 };
const familyDayEvent = { id: 'k3', name: 'Family Day Festival', source_name: 'nyc-parks', description_short: 'Activities for children and parents', completeness: 0.8 };
const nonParkKids = { id: 'k4', name: 'Kids Comedy Show', source_name: 'dice', description_short: 'Family friendly comedy', completeness: 0.8 };

const kidsResult = filterKidsEvents([kidsEvent, adultParkEvent, familyDayEvent, nonParkKids]);
check('removes kids storytime from nyc-parks', !kidsResult.find(e => e.id === 'k1'));
check('keeps adult park event', !!kidsResult.find(e => e.id === 'k2'));
check('removes family day from nyc-parks', !kidsResult.find(e => e.id === 'k3'));
check('removes kids event from non-parks source too', !kidsResult.find(e => e.id === 'k4'));
check('returns 1 event after filtering', kidsResult.length === 1);

const emptyResult = filterKidsEvents([]);
check('handles empty array', emptyResult.length === 0);

console.log('\nfilterIncomplete:');

const highComp = { id: 'c1', completeness: 0.9 };
const medComp = { id: 'c2', completeness: 0.5 };
const lowComp = { id: 'c3', completeness: 0.3 };
const noComp = { id: 'c4' };

const compResult = filterIncomplete([highComp, medComp, lowComp, noComp]);
check('keeps high completeness', !!compResult.find(e => e.id === 'c1'));
check('keeps medium completeness', !!compResult.find(e => e.id === 'c2'));
check('removes low completeness', !compResult.find(e => e.id === 'c3'));
check('removes no completeness', !compResult.find(e => e.id === 'c4'));

const customThreshold = filterIncomplete([highComp, medComp, lowComp], 0.6);
check('custom threshold removes medium', !customThreshold.find(e => e.id === 'c2'));
check('custom threshold keeps high', !!customThreshold.find(e => e.id === 'c1'));

console.log('\nhasValidNeighborhood:');

check('accepts known neighborhood', hasValidNeighborhood({ neighborhood: 'Williamsburg' }));
check('accepts another known neighborhood', hasValidNeighborhood({ neighborhood: 'East Village' }));
check('rejects null neighborhood', !hasValidNeighborhood({ neighborhood: null }));
check('rejects undefined neighborhood', !hasValidNeighborhood({}));
check('rejects empty string', !hasValidNeighborhood({ neighborhood: '' }));
check('rejects unknown neighborhood', !hasValidNeighborhood({ neighborhood: 'Mars' }));
check('rejects "none"', !hasValidNeighborhood({ neighborhood: 'none' }));

console.log('\nisGarbageVenue:');

check('accepts normal venue', !isGarbageVenue('Film Forum'));
check('accepts venue with special chars', !isGarbageVenue('ROSA – Agave & Wine Lounge'));
check('accepts null venue (missing, not garbage)', !isGarbageVenue(null));
check('accepts undefined venue', !isGarbageVenue(undefined));
check('accepts TBA venue (missing data)', !isGarbageVenue('TBA'));
check('rejects metadata field "Lead investor"', isGarbageVenue('Lead investor: Andreessen Horowitz'));
check('rejects metadata field "Details"', isGarbageVenue('Details'));
check('rejects metadata field "Platform"', isGarbageVenue('Platform'));
check('rejects metadata field "Tier 1"', isGarbageVenue('Tier 1'));
check('rejects tech jargon venue "LLM"', isGarbageVenue('LLM training benchmark'));
check('rejects tech jargon venue "GPU"', isGarbageVenue('GPU center'));
check('rejects long sentence venue', isGarbageVenue('Reteti Sanctuary in Kenya, documenting their care and rehabilitation of orphaned elephants in a changing climate'));
check('accepts short venue name', !isGarbageVenue('BAM'));

