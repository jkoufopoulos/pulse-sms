const { check } = require('../helpers');
const path = require('path');
const fs = require('fs');

// ---- Nonsense NYC: cache fallback ----
console.log('\nNonsense NYC cache fallback:');

const NONSENSE_DIR = path.join(__dirname, '../../data/nonsense');
const CACHE_FILE = path.join(NONSENSE_DIR, 'cached-events.json');

const nonsenseMod = require('../../src/sources/nonsense');
check('nonsense module exports fetchNonsenseNYC', typeof nonsenseMod.fetchNonsenseNYC === 'function');

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
