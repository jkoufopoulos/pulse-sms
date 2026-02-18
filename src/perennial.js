const fs = require('fs');
const path = require('path');
const { getAdjacentNeighborhoods } = require('./pre-router');

const DATA_PATH = path.join(__dirname, '..', 'data', 'perennial-picks.json');

let picksCache = null;

function loadPicks() {
  if (picksCache) return picksCache;
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    picksCache = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load perennial picks:', err.message);
    picksCache = {};
  }
  return picksCache;
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Get perennial picks for a neighborhood, filtered by day of week.
 * Returns { local: [...], nearby: [...] }
 *
 * @param {string} neighborhood - Canonical neighborhood name
 * @param {object} [opts]
 * @param {string} [opts.dayOfWeek] - Day name (e.g. 'fri'). Defaults to today in NYC.
 */
function getPerennialPicks(neighborhood, { dayOfWeek } = {}) {
  const picks = loadPicks();

  // Resolve today's day of week in NYC timezone
  const day = dayOfWeek || DAY_NAMES[new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay()];

  function matchesDay(pick) {
    if (!pick.days || pick.days.length === 0) return true;
    return pick.days.includes('any') || pick.days.includes(day);
  }

  // Local picks
  const local = (picks[neighborhood] || []).filter(matchesDay);

  // Nearby picks from adjacent neighborhoods
  const adjacent = getAdjacentNeighborhoods(neighborhood, 3);
  const nearby = [];
  for (const adjHood of adjacent) {
    const adjPicks = (picks[adjHood] || []).filter(matchesDay);
    for (const p of adjPicks) {
      nearby.push({ ...p, neighborhood: adjHood });
    }
  }

  return { local, nearby };
}

/**
 * Convert perennial picks into event-shaped objects for compose.
 * @param {Array} picks - Array of perennial pick objects
 * @param {string} neighborhood - The neighborhood these picks belong to
 * @param {object} [opts]
 * @param {boolean} [opts.isNearby] - If true, confidence is 0.6 instead of 0.7
 * @returns {Array} Event-shaped objects
 */
function toEventObjects(picks, neighborhood, { isNearby } = {}) {
  if (!picks || picks.length === 0) return [];

  const hoodSlug = neighborhood.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');

  return picks.map(pick => {
    const venueSlug = (pick.venue || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
    return {
      id: `perennial_${venueSlug}_${hoodSlug}`,
      name: pick.venue,
      venue_name: pick.venue,
      neighborhood: pick.neighborhood || neighborhood,
      category: pick.category || 'nightlife',
      description_short: pick.vibe,
      short_detail: pick.vibe,
      source_name: 'perennial',
      source_weight: 0.78,
      confidence: isNearby ? 0.6 : 0.7,
      day: null,
      date_local: null,
      start_time_local: null,
      end_time_local: null,
      is_free: pick.is_free || false,
      price_display: null,
      ticket_url: pick.url || null,
      source_url: pick.url || null,
      venue_address: pick.address || null,
    };
  });
}

// Allow cache reset for testing
function _resetCache() {
  picksCache = null;
}

module.exports = { getPerennialPicks, toEventObjects, _resetCache };
