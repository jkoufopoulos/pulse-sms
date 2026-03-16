const { check } = require('../helpers');
const { CLASSIFY_CATEGORIES } = require('../../src/enrichment');

console.log('\nclassifyOtherEvents:');

// --- CLASSIFY_CATEGORIES ---
console.log('\nCLASSIFY_CATEGORIES:');

check('has comedy', CLASSIFY_CATEGORIES.includes('comedy'));
check('has live_music', CLASSIFY_CATEGORIES.includes('live_music'));
check('has nightlife', CLASSIFY_CATEGORIES.includes('nightlife'));
check('has art', CLASSIFY_CATEGORIES.includes('art'));
check('has theater', CLASSIFY_CATEGORIES.includes('theater'));
check('has community', CLASSIFY_CATEGORIES.includes('community'));
check('has trivia', CLASSIFY_CATEGORIES.includes('trivia'));
check('has film', CLASSIFY_CATEGORIES.includes('film'));
check('has food_drink', CLASSIFY_CATEGORIES.includes('food_drink'));
check('has spoken_word', CLASSIFY_CATEGORIES.includes('spoken_word'));
check('has tours', CLASSIFY_CATEGORIES.includes('tours'));
check('has dance', CLASSIFY_CATEGORIES.includes('dance'));
check('has other', CLASSIFY_CATEGORIES.includes('other'));
check('no unknown categories', CLASSIFY_CATEGORIES.length === 13);

// --- Filtering logic (test without calling LLM) ---
console.log('\nFiltering logic:');

// Simulate the filter used inside classifyOtherEvents
function filterOtherEvents(events) {
  return events.filter(e => e.category === 'other');
}

const testEvents = [
  { name: 'Comedy Show', category: 'comedy', source_name: 'dice' },
  { name: 'Mystery Event', category: 'other', source_name: 'skint' },
  { name: 'Art Opening', category: 'art', source_name: 'donyc' },
  { name: 'Weird Happening', category: 'other', source_name: 'nonsense' },
  { name: 'Jazz Night', category: 'live_music', source_name: 'dice' },
  { name: 'Unknown Thing', category: 'other', source_name: 'bkmag' },
];

const others = filterOtherEvents(testEvents);
check('filters only "other" events', others.length === 3);
check('includes Mystery Event', others.some(e => e.name === 'Mystery Event'));
check('includes Weird Happening', others.some(e => e.name === 'Weird Happening'));
check('includes Unknown Thing', others.some(e => e.name === 'Unknown Thing'));
check('excludes Comedy Show', !others.some(e => e.name === 'Comedy Show'));
check('excludes Art Opening', !others.some(e => e.name === 'Art Opening'));
check('excludes Jazz Night', !others.some(e => e.name === 'Jazz Night'));

// Empty input
check('empty input returns empty', filterOtherEvents([]).length === 0);

// No "other" events
const noOthers = [
  { name: 'A', category: 'comedy' },
  { name: 'B', category: 'art' },
];
check('no "other" events returns empty', filterOtherEvents(noOthers).length === 0);

// All "other" events
const allOthers = [
  { name: 'A', category: 'other' },
  { name: 'B', category: 'other' },
];
check('all "other" events returns all', filterOtherEvents(allOthers).length === 2);

// Events with null/undefined category
const nullCats = [
  { name: 'A', category: null },
  { name: 'B', category: undefined },
  { name: 'C', category: 'other' },
];
check('null category not matched', filterOtherEvents(nullCats).length === 1);
check('only "other" matched from null/undefined mix', filterOtherEvents(nullCats)[0].name === 'C');
