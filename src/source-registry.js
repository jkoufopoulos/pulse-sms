const { fetchSkintEvents, fetchSkintOngoingEvents, fetchNonsenseNYC, fetchYutoriEvents, fetchScreenSlateEvents, fetchBKMagEvents, fetchLumaEvents } = require('./sources');

// Source tier classification for compose prompt
const SOURCE_TIERS = {
  Skint: 'unstructured',
  SkintOngoing: 'unstructured',
  NonsenseNYC: 'unstructured',
  Yutori: 'unstructured',
  ScreenSlate: 'unstructured',
  BKMag: 'unstructured',
  Luma: 'primary',
};

// ============================================================
// Single source registry — editorial sources only
// Listing-only scrapers removed to focus on sources with
// genuine editorial context ("why this, why now"). Scraper
// code preserved in sources/ if we need to re-enable.
// ============================================================

const SOURCES = [
  { label: 'Skint',            fetch: fetchSkintEvents,         weight: 0.9,  mergeRank: 0, endpoint: 'https://theskint.com', minExpected: 5, volatile: true, dbName: 'theskint' },
  { label: 'SkintOngoing',     fetch: fetchSkintOngoingEvents,  weight: 0.9,  mergeRank: 1, endpoint: 'https://theskint.com/ongoing-events/', minExpected: 10, volatile: true, dbName: 'theskint' },
  { label: 'NonsenseNYC',      fetch: fetchNonsenseNYC,         weight: 0.9,  mergeRank: 1, endpoint: 'https://nonsensenyc.com', minExpected: 10, volatile: true, channel: 'email' },
  { label: 'Yutori',           fetch: fetchYutoriEvents,        weight: 0.9,  mergeRank: 2, endpoint: null, minExpected: 20, volatile: true, channel: 'email' },
  { label: 'ScreenSlate',      fetch: fetchScreenSlateEvents,   weight: 0.9,  mergeRank: 3, endpoint: null, minExpected: 5, channel: 'email' },
  { label: 'BKMag',            fetch: fetchBKMagEvents,         weight: 0.9,  mergeRank: 4, endpoint: 'https://www.bkmag.com', minExpected: 5, schedule: { days: ['fri', 'sat'] } },
  { label: 'Luma',             fetch: fetchLumaEvents,          weight: 0.8,  mergeRank: 5, endpoint: 'https://lu.ma', minExpected: 10 },
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

const EMAIL_SOURCES = SOURCES.filter(s => s.channel === 'email');

module.exports = { SOURCES, SOURCE_TIERS, SOURCE_LABELS, SOURCE_DB_NAMES, ENDPOINT_URLS, MERGE_ORDER, SOURCE_EXPECTATIONS, SOURCE_CACHE_NAMES, EMAIL_SOURCES, validateSources };
