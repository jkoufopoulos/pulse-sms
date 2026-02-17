const crypto = require('crypto');
const { resolveNeighborhood } = require('../geo');
const { lookupVenue } = require('../venues');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html',
};

/**
 * Normalize event names for dedup — strips suffixes, parentheticals, punctuation.
 */
function normalizeEventName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')                          // strip parentheticals: (SOLD OUT), (Early Show)
    .replace(/\s*&\s*(friends|more|guests)\b.*/i, '')         // strip "& Friends", "& More"
    .replace(/\b(ft\.?|feat\.?|featuring|w\/|with)\b.*/i, '') // strip "ft." and everything after
    .replace(/[^\w\s]/g, '')                                  // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a stable event ID from name + venue + date.
 */
function makeEventId(name, venue, date, source) {
  const raw = `${normalizeEventName(name)}|${(venue || '').toLowerCase().trim()}|${(date || '').trim()}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

function normalizeExtractedEvent(e, sourceName, sourceType, sourceWeight) {
  const id = makeEventId(e.name, e.venue_name, e.date_local || e.start_time_local || '', sourceName);

  // Try venue lookup for coords when Claude didn't extract lat/lng
  let lat = parseFloat(e.latitude);
  let lng = parseFloat(e.longitude);
  let neighborhoodHint = e.neighborhood;
  if ((isNaN(lat) || isNaN(lng)) && e.venue_name) {
    const coords = lookupVenue(e.venue_name);
    if (coords) {
      lat = coords.lat;
      lng = coords.lng;
      neighborhoodHint = null; // trust venue coords over Claude's text guess
    }
  }

  // Validate Claude-extracted neighborhood against known neighborhoods, then fall back to geo
  const neighborhood = resolveNeighborhood(neighborhoodHint, lat, lng);

  return {
    id,
    source_name: sourceName,
    source_type: sourceType,
    source_weight: sourceWeight,
    name: e.name,
    description_short: e.description_short || null,
    short_detail: e.description_short || null,
    venue_name: e.venue_name || 'TBA',
    venue_address: e.venue_address || null,
    neighborhood,
    start_time_local: e.start_time_local || null,
    end_time_local: e.end_time_local || null,
    date_local: e.date_local || null,
    time_window: e.time_window || null,
    is_free: e.is_free === true,
    price_display: e.price_display || null,
    category: e.category || 'other',
    subcategory: e.subcategory || null,
    confidence: e.confidence || 0.5,
    ticket_url: e.ticket_url || null,
    source_url: e.source_url || null,
    map_url: null,
    map_hint: e.map_hint || null,
  };
}

module.exports = { FETCH_HEADERS, makeEventId, normalizeExtractedEvent };
