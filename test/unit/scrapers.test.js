const { check } = require('../helpers');
const path = require('path');
const fs = require('fs');

// ---- Nonsense NYC: cache fallback ----
console.log('\nNonsense NYC cache fallback:');

const NONSENSE_DIR = path.join(__dirname, '../../data/nonsense');
const CACHE_FILE = path.join(NONSENSE_DIR, 'cached-events.json');

const nonsenseMod = require('../../src/sources/nonsense');
check('nonsense module exports fetchNonsenseNYC', typeof nonsenseMod.fetchNonsenseNYC === 'function');
check('nonsense module exports splitByDay', typeof nonsenseMod.splitByDay === 'function');

const { splitByDay } = nonsenseMod;

const sampleNewsletter = `
Some intro text here.

XXXXX FRIDAY, FEBRUARY 27 XXXXX
Event 1: Jazz at Smalls, 183 W 10th St. 7pm. $20. This is a great show with wonderful musicians playing all night long.
Event 2: Comedy at Union Hall, 702 Union St. 9pm. $10. Stand up comedy featuring NYC's best comics and special guests.

XXXXX SATURDAY, FEBRUARY 28 XXXXX
Event 3: Art Opening at some gallery in Chelsea with free drinks and snacks for everyone who shows up early enough.
Event 4: DJ Night at Good Room, 98 Meserole Ave. 10pm. $15. Electronic music party with great sound system.
`;

const sections = splitByDay(sampleNewsletter);
check('splitByDay finds 2 day sections', sections.length === 2);
check('splitByDay first section is Friday', /FRIDAY/.test(sections[0].day));
check('splitByDay second section is Saturday', /SATURDAY/.test(sections[1].day));
check('splitByDay sections have content', sections[0].content.length >= 100);

const cacheExists = fs.existsSync(CACHE_FILE);
check('nonsense cache file exists on disk', cacheExists);
if (cacheExists) {
  const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  check('cached data has id field', typeof cached.id === 'string');
  check('cached data has events array', Array.isArray(cached.events));
}

// _rawText no longer carried through (enrichment layer removed)

// ---- Sofar Sounds: neighborhood extraction ----
console.log('\nSofar Sounds scraper:');

const { extractNeighborhood } = require('../../src/sources/sofarsounds');

check('extracts "Meatpacking District"',
  extractNeighborhood('Sofar Sounds - Meatpacking District') === 'Meatpacking District');
check('extracts "East Village"',
  extractNeighborhood('Sofar Sounds - East Village') === 'East Village');
check('extracts "Lower Manhattan"',
  extractNeighborhood('Sofar Sounds - Lower Manhattan') === 'Lower Manhattan');
check('handles en-dash separator',
  extractNeighborhood('Sofar Sounds – SOHO') === 'SOHO');
check('handles em-dash separator',
  extractNeighborhood('Sofar Sounds — Williamsburg') === 'Williamsburg');
check('returns null for non-Sofar event',
  extractNeighborhood('Jazz at Blue Note') === null);
check('returns null for bare "Sofar Sounds"',
  extractNeighborhood('Sofar Sounds') === null);

console.log('\nCategory normalization at boundary:');
const { normalizeExtractedEvent } = require('../../src/sources/shared');
const musicEvent = normalizeExtractedEvent({ name: 'Jazz Night', category: 'music', venue_name: 'Blue Note', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('music category normalized to live_music', musicEvent.category === 'live_music');
const liveEvent = normalizeExtractedEvent({ name: 'Rock Show', category: 'live_music', venue_name: 'Bowery', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('live_music category preserved', liveEvent.category === 'live_music');
const comedyEvent = normalizeExtractedEvent({ name: 'Stand Up', category: 'comedy', venue_name: 'Cellar', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('comedy category unchanged', comedyEvent.category === 'comedy');
const noCategory = normalizeExtractedEvent({ name: 'Some Event', venue_name: 'Somewhere', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('missing category defaults to other', noCategory.category === 'other');
