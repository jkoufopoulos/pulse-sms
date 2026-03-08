const { fetchSkintEvents, fetchSkintOngoingEvents, fetchEventbriteEvents, fetchSongkickEvents, fetchDiceEvents, fetchRAEvents, fetchNonsenseNYC, fetchDoNYCEvents, fetchBAMEvents, fetchNYPLEvents, fetchEventbriteComedy, fetchEventbriteArts, fetchNYCParksEvents, fetchBrooklynVeganEvents, fetchYutoriEvents, fetchScreenSlateEvents, fetchLumaEvents, fetchTinyCupboardEvents, fetchBrooklynCCEvents, fetchNYCTriviaEvents, fetchBKMagEvents, fetchSofarSoundsEvents } = require('./sources');

// Source tier classification for compose prompt
const SOURCE_TIERS = {
  Skint: 'unstructured',
  SkintOngoing: 'unstructured',
  NonsenseNYC: 'unstructured',
  Yutori: 'unstructured',
  ScreenSlate: 'unstructured',
  RA: 'primary',
  Dice: 'primary',
  BrooklynVegan: 'primary',
  BAM: 'primary',
  // SmallsLIVE removed — single-venue jazz, low volume. Scraper preserved at sources/smallslive.js.
  NYCParks: 'secondary',
  DoNYC: 'secondary',
  Songkick: 'secondary',
  // Ticketmaster removed — 826 events, 70% Broadway/tourist theater. ~30 useful jazz/indie events
  // don't justify the noise. Key venues (Birdland, Blue Note, Brooklyn Bowl) covered by other sources.
  Eventbrite: 'secondary',
  Luma: 'curated',
  NYPL: 'secondary',
  EventbriteComedy: 'secondary',
  EventbriteArts: 'secondary',
  TinyCupboard: 'secondary',
  BrooklynCC: 'secondary',
  NYCTrivia: 'secondary',
  BKMag: 'unstructured',
  SofarSounds: 'secondary',
};

// ============================================================
// Single source registry — everything derives from this array
// ============================================================

const SOURCES = [
  { label: 'Skint',            fetch: fetchSkintEvents,         weight: 0.9,  mergeRank: 0, endpoint: 'https://theskint.com', minExpected: 5, dbName: 'theskint' },
  { label: 'SkintOngoing',     fetch: fetchSkintOngoingEvents,  weight: 0.9,  mergeRank: 1, endpoint: 'https://theskint.com/ongoing-events/', minExpected: 10, dbName: 'theskint' },
  { label: 'NonsenseNYC',      fetch: fetchNonsenseNYC,         weight: 0.9,  mergeRank: 1, endpoint: 'https://nonsensenyc.com', minExpected: 10, volatile: true },
  { label: 'RA',               fetch: fetchRAEvents,            weight: 0.85, mergeRank: 0, endpoint: 'https://ra.co', minExpected: 50 },
  // OhMyRockness removed — 80% loss to dedup/quality gates, only 3 unique events surviving.
  // Scraper still exists at sources/ohmyrockness.js if we want to re-enable.
  { label: 'Dice',             fetch: fetchDiceEvents,          weight: 0.8,  mergeRank: 0, endpoint: 'https://dice.fm/browse/new_york-5bbf4db0f06331478e9b2c59', minExpected: 50 },
  { label: 'BrooklynVegan',    fetch: fetchBrooklynVeganEvents, weight: 0.8,  mergeRank: 1, endpoint: 'https://www.brooklynvegan.com', minExpected: 10 },
  { label: 'BAM',              fetch: fetchBAMEvents,           weight: 0.8,  mergeRank: 2, endpoint: 'https://www.bam.org/api/BAMApi/GetCalendarEventsByDayWithOnGoing', minExpected: 20 },
  // SmallsLIVE removed — single-venue jazz, low volume. Scraper preserved at sources/smallslive.js.
  { label: 'Yutori',            fetch: fetchYutoriEvents,        weight: 0.8,  mergeRank: 4, endpoint: null, minExpected: 20, volatile: true },
  { label: 'ScreenSlate',      fetch: fetchScreenSlateEvents,   weight: 0.9,  mergeRank: 2, endpoint: null, minExpected: 5 },
  { label: 'NYCParks',         fetch: fetchNYCParksEvents,      weight: 0.75, mergeRank: 0, endpoint: 'https://www.nycgovparks.org/events', minExpected: 15, dbName: 'nyc_parks' },
  { label: 'DoNYC',            fetch: fetchDoNYCEvents,         weight: 0.75, mergeRank: 1, endpoint: 'https://donyc.com/events/today', minExpected: 100 },
  { label: 'Songkick',         fetch: fetchSongkickEvents,      weight: 0.75, mergeRank: 2, endpoint: 'https://www.songkick.com/metro-areas/7644-us-new-york/today', minExpected: 20 },
  // Ticketmaster removed — 826 events, 70% Broadway/tourist. Birdland/Blue Note covered by Dice/Songkick.
  // Scraper preserved at sources/ticketmaster.js. Re-enable if users request Broadway/theater.
  { label: 'Luma',              fetch: fetchLumaEvents,          weight: 0.9,  mergeRank: 0, endpoint: 'https://api.lu.ma/discover/get-paginated-events', minExpected: 100 },
  { label: 'Eventbrite',       fetch: fetchEventbriteEvents,    weight: 0.7,  mergeRank: 1, endpoint: 'https://www.eventbrite.com/d/ny--new-york/events--today/', minExpected: 10 },
  { label: 'NYPL',             fetch: fetchNYPLEvents,          weight: 0.7,  mergeRank: 2, endpoint: 'https://www.eventbrite.com/o/new-york-public-library-for-the-performing-arts-5993389089', minExpected: 10 },
  { label: 'EventbriteComedy', fetch: fetchEventbriteComedy,    weight: 0.7,  mergeRank: 3, endpoint: null, minExpected: 20 },
  { label: 'EventbriteArts',   fetch: fetchEventbriteArts,      weight: 0.7,  mergeRank: 4, endpoint: null, minExpected: 10 },
  { label: 'TinyCupboard',    fetch: fetchTinyCupboardEvents,  weight: 0.75, mergeRank: 5, endpoint: 'https://www.thetinycupboard.com/calendar', minExpected: 10 },
  { label: 'BrooklynCC',      fetch: fetchBrooklynCCEvents,    weight: 0.75, mergeRank: 6, endpoint: 'https://www.brooklyncc.com/show-schedule', minExpected: 15 },
  { label: 'NYCTrivia',       fetch: fetchNYCTriviaEvents,     weight: 0.75, mergeRank: 7, endpoint: 'https://nyctrivialeague.com/', minExpected: 50 },
  { label: 'BKMag',           fetch: fetchBKMagEvents,         weight: 0.9,  mergeRank: 3, endpoint: 'https://www.bkmag.com', minExpected: 5, schedule: { days: ['fri', 'sat'] } },
  { label: 'SofarSounds',    fetch: fetchSofarSoundsEvents,   weight: 0.8,  mergeRank: 4, endpoint: 'https://donyc.com/venues/sofar-sounds-secret-location', minExpected: 5 },
  // Tavily removed entirely — daily scrape returns 0 events, hot-path fallback added 9-15s
  // latency per request with 58% waste rate. All event data comes from the 18 scrapers above.
];

// Boot-time validation — fail fast on config errors
function validateSources(sources) {
  const labels = new Set();
  for (const s of sources) {
    if (!s.label) throw new Error('Source missing label');
    if (labels.has(s.label)) throw new Error(`Duplicate source label: ${s.label}`);
    labels.add(s.label);
    if (typeof s.fetch !== 'function') throw new Error(`${s.label}: fetch must be a function`);
    if (typeof s.weight !== 'number' || s.weight < 0 || s.weight > 1) throw new Error(`${s.label}: weight must be 0-1`);
  }
}
validateSources(SOURCES);

// Derived — no manual sync needed
const SOURCE_LABELS = SOURCES.map(s => s.label);
// All source_name values that appear in the DB (label, lowercase label, and explicit dbName)
const SOURCE_DB_NAMES = [...new Set(SOURCES.flatMap(s => [s.label, s.label.toLowerCase(), ...(s.dbName ? [s.dbName] : [])]))];

const ENDPOINT_URLS = Object.fromEntries(
  SOURCES.filter(s => s.endpoint).map(s => [s.label, s.endpoint])
);

const MERGE_ORDER = [...SOURCES]
  .sort((a, b) => (b.weight - a.weight) || (a.mergeRank - b.mergeRank) || a.label.localeCompare(b.label))
  .map(s => s.label);

const SOURCE_EXPECTATIONS = Object.fromEntries(
  SOURCES.map(s => [s.label, { minExpected: s.minExpected || 0, schedule: s.schedule || null }])
);

// Map label → the source_name used in the event cache (dbName if set, else lowercase label)
const SOURCE_CACHE_NAMES = Object.fromEntries(
  SOURCES.map(s => [s.label, s.dbName || s.label.toLowerCase()])
);

module.exports = { SOURCES, SOURCE_TIERS, SOURCE_LABELS, SOURCE_DB_NAMES, ENDPOINT_URLS, MERGE_ORDER, SOURCE_EXPECTATIONS, SOURCE_CACHE_NAMES, validateSources };
