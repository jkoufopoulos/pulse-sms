const { fetchSkintEvents, fetchSkintOngoingEvents, fetchEventbriteEvents, fetchSongkickEvents, fetchDiceEvents, fetchRAEvents, fetchNonsenseNYC, fetchDoNYCEvents, fetchBAMEvents, fetchSmallsLiveEvents, fetchNYPLEvents, fetchEventbriteComedy, fetchEventbriteArts, fetchNYCParksEvents, fetchBrooklynVeganEvents, fetchTicketmasterEvents, fetchYutoriEvents, fetchScreenSlateEvents, fetchLumaEvents, fetchTinyCupboardEvents } = require('./sources');

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
  SmallsLIVE: 'primary',
  NYCParks: 'secondary',
  DoNYC: 'secondary',
  Songkick: 'secondary',
  Ticketmaster: 'secondary',
  Eventbrite: 'secondary',
  Luma: 'secondary',
  NYPL: 'secondary',
  EventbriteComedy: 'secondary',
  EventbriteArts: 'secondary',
  TinyCupboard: 'secondary',
};

// ============================================================
// Single source registry — everything derives from this array
// ============================================================

const SOURCES = [
  { label: 'Skint',            fetch: fetchSkintEvents,         weight: 0.9,  mergeRank: 0, endpoint: 'https://theskint.com' },
  { label: 'SkintOngoing',     fetch: fetchSkintOngoingEvents,  weight: 0.9,  mergeRank: 1, endpoint: 'https://theskint.com/ongoing-events/' },
  { label: 'NonsenseNYC',      fetch: fetchNonsenseNYC,         weight: 0.9,  mergeRank: 1, endpoint: 'https://nonsensenyc.com' },
  { label: 'RA',               fetch: fetchRAEvents,            weight: 0.85, mergeRank: 0, endpoint: 'https://ra.co' },
  // OhMyRockness removed — 80% loss to dedup/quality gates, only 3 unique events surviving.
  // Scraper still exists at sources/ohmyrockness.js if we want to re-enable.
  { label: 'Dice',             fetch: fetchDiceEvents,          weight: 0.8,  mergeRank: 0, endpoint: 'https://dice.fm/browse/new_york-5bbf4db0f06331478e9b2c59' },
  { label: 'BrooklynVegan',    fetch: fetchBrooklynVeganEvents, weight: 0.8,  mergeRank: 1, endpoint: 'https://www.brooklynvegan.com' },
  { label: 'BAM',              fetch: fetchBAMEvents,           weight: 0.8,  mergeRank: 2, endpoint: 'https://www.bam.org/api/BAMApi/GetCalendarEventsByDayWithOnGoing' },
  { label: 'SmallsLIVE',       fetch: fetchSmallsLiveEvents,    weight: 0.8,  mergeRank: 3, endpoint: 'https://www.smallslive.com/events/today' },
  { label: 'Yutori',            fetch: fetchYutoriEvents,        weight: 0.8,  mergeRank: 4, endpoint: null },
  { label: 'ScreenSlate',      fetch: fetchScreenSlateEvents,   weight: 0.9,  mergeRank: 2, endpoint: null },
  { label: 'NYCParks',         fetch: fetchNYCParksEvents,      weight: 0.75, mergeRank: 0, endpoint: 'https://www.nycgovparks.org/events' },
  { label: 'DoNYC',            fetch: fetchDoNYCEvents,         weight: 0.75, mergeRank: 1, endpoint: 'https://donyc.com/events/today' },
  { label: 'Songkick',         fetch: fetchSongkickEvents,      weight: 0.75, mergeRank: 2, endpoint: 'https://www.songkick.com/metro-areas/7644-us-new-york/today' },
  { label: 'Ticketmaster',     fetch: fetchTicketmasterEvents,  weight: 0.75, mergeRank: 3, endpoint: 'https://app.ticketmaster.com' },
  { label: 'Luma',              fetch: fetchLumaEvents,          weight: 0.7,  mergeRank: 0, endpoint: 'https://api.lu.ma/discover/get-paginated-events' },
  { label: 'Eventbrite',       fetch: fetchEventbriteEvents,    weight: 0.7,  mergeRank: 1, endpoint: 'https://www.eventbrite.com/d/ny--new-york/events--today/' },
  { label: 'NYPL',             fetch: fetchNYPLEvents,          weight: 0.7,  mergeRank: 2, endpoint: 'https://www.eventbrite.com/o/new-york-public-library-for-the-performing-arts-5993389089' },
  { label: 'EventbriteComedy', fetch: fetchEventbriteComedy,    weight: 0.7,  mergeRank: 3, endpoint: null },
  { label: 'EventbriteArts',   fetch: fetchEventbriteArts,      weight: 0.7,  mergeRank: 4, endpoint: null },
  { label: 'TinyCupboard',    fetch: fetchTinyCupboardEvents,  weight: 0.75, mergeRank: 5, endpoint: 'https://www.thetinycupboard.com/calendar' },
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

const ENDPOINT_URLS = Object.fromEntries(
  SOURCES.filter(s => s.endpoint).map(s => [s.label, s.endpoint])
);

const MERGE_ORDER = [...SOURCES]
  .sort((a, b) => (b.weight - a.weight) || (a.mergeRank - b.mergeRank) || a.label.localeCompare(b.label))
  .map(s => s.label);

module.exports = { SOURCES, SOURCE_TIERS, SOURCE_LABELS, ENDPOINT_URLS, MERGE_ORDER, validateSources };
