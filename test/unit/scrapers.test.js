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

// ---- Skint: bare-word day-header section split ----
// Skint's live HTML uses single-word day headers ("friday", "saturday", etc.)
// inside <p> tags. extractSkintSections must split on these BEFORE applying its
// short-paragraph filter — otherwise the day labels (6-8 chars) get silently
// dropped and the entire post collapses into a single 'intro' chunk, stripping
// the date context the LLM extractor relies on.
console.log('\nSkint day-header parsing:');
const { extractSkintSections } = require('../../src/sources/skint');

const skintFixtureHtml = `<article>
  <h2 class="entry-title">FRI-MON, 6/5-8: SKINT WEEKEND</h2>
  <div class="entry-content">
    <p>cultural fests and events this weekend, free admission unless noted:</p>
    <p>friday</p>
    <p>fri thru 1/10/2027: guggenheim pop 1960 to now exploring the museum</p>
    <p>saturday</p>
    <p>sat 6/14 motor company writers lab reading series 5 playwrights</p>
    <p>sunday</p>
    <p>sun 9/27 yoga at socrates sculpture park free admission</p>
  </div>
</article>`;

const skintSections = extractSkintSections(skintFixtureHtml);
const skintLabels = skintSections.map(s => s.label);
check('skint splits into 4 sections (intro + 3 day sections)', skintSections.length === 4);
check('skint sections include "intro"', skintLabels.includes('intro'));
check('skint sections include "friday"', skintLabels.includes('friday'));
check('skint sections include "saturday"', skintLabels.includes('saturday'));
check('skint sections include "sunday"', skintLabels.includes('sunday'));
const friSection = skintSections.find(s => s.label === 'friday');
check('skint friday section has guggenheim paragraph', friSection?.paragraphs?.[0]?.includes('guggenheim'));
const introSection = skintSections.find(s => s.label === 'intro');
check('skint friday content not bleeding into intro', !introSection?.paragraphs?.join(' ')?.includes('guggenheim'));
