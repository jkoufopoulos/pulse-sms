const { check } = require('../helpers');
const { filterKidsEvents, filterIncomplete, validatePerennialActivity } = require('../../src/curation');

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

console.log('\nvalidatePerennialActivity:');

const triviaBar = { id: 'p1', short_detail: 'Trivia night every Tuesday', description_short: 'Great bar', source_name: 'perennial' };
const jazzBar = { id: 'p2', short_detail: 'Live jazz nightly', description_short: 'Historic venue', source_name: 'perennial' };
const djBar = { id: 'p3', short_detail: 'DJ sets on weekends', description_short: 'Cool spot', source_name: 'perennial' };
const vagueBar = { id: 'p4', short_detail: 'Nice bar with good vibes', description_short: 'Chill place to hang', source_name: 'perennial' };
const emptyDetail = { id: 'p5', short_detail: '', description_short: '', source_name: 'perennial' };
const karaokeBar = { id: 'p6', short_detail: 'Karaoke night', description_short: '', source_name: 'perennial' };

const perennialResult = validatePerennialActivity([triviaBar, jazzBar, djBar, vagueBar, emptyDetail, karaokeBar]);
check('keeps trivia bar', !!perennialResult.find(e => e.id === 'p1'));
check('keeps jazz bar', !!perennialResult.find(e => e.id === 'p2'));
check('keeps DJ bar', !!perennialResult.find(e => e.id === 'p3'));
check('removes vague bar', !perennialResult.find(e => e.id === 'p4'));
check('removes empty detail bar', !perennialResult.find(e => e.id === 'p5'));
check('keeps karaoke bar', !!perennialResult.find(e => e.id === 'p6'));
check('returns 4 events after filtering', perennialResult.length === 4);
