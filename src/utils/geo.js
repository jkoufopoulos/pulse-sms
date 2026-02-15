const { NEIGHBORHOODS } = require('./neighborhoods');

/**
 * Try to match a locality string (e.g. "Brooklyn", "Manhattan") or lat/lng
 * to one of our defined neighborhoods.
 */
function resolveNeighborhood(locality, lat, lng) {
  if (!locality && !lat) return null;

  // Direct locality match against neighborhood names and aliases
  if (locality) {
    const lower = locality.toLowerCase();
    for (const [name, data] of Object.entries(NEIGHBORHOODS)) {
      if (name.toLowerCase() === lower) return name;
      for (const alias of data.aliases) {
        if (alias === lower) return name;
      }
    }
  }

  // If we have coordinates, find the nearest neighborhood (preferred over borough fallback)
  if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const [name, data] of Object.entries(NEIGHBORHOODS)) {
      const dist = haversine(lat, lng, data.lat, data.lng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = name;
      }
    }
    // Only match if within 3km of a known neighborhood
    if (nearestDist < 3) return nearest;
  }

  // Borough-level fallback — only used when no coordinates available
  if (locality) {
    const lower = locality.toLowerCase();
    const boroughMap = {
      'brooklyn': 'Williamsburg',
      'manhattan': 'Midtown',
      'queens': 'Astoria',
      'bronx': null,
      'staten island': null,
      'new york': 'Midtown',
      'new york (nyc)': 'Midtown',
      'new york city': 'Midtown',
    };
    if (boroughMap[lower] !== undefined) return boroughMap[lower];
  }

  return null;
}

/**
 * Rank events by proximity to target neighborhood.
 * Light filter: include everything within ~5km (same borough-ish),
 * plus all events with unknown neighborhood (let Claude decide).
 * Sorted: closest first, then unknown-neighborhood events at the end.
 */
function rankEventsByProximity(events, targetNeighborhood) {
  if (!targetNeighborhood) return events;

  const targetData = NEIGHBORHOODS[targetNeighborhood];
  if (!targetData) return events;

  const scored = events.map(e => {
    const hood = e.neighborhood;
    if (!hood) return { event: e, dist: 4.0 }; // unknown = include, sort late

    const hoodData = NEIGHBORHOODS[hood];
    if (!hoodData) {
      for (const [name, data] of Object.entries(NEIGHBORHOODS)) {
        if (data.aliases.includes(hood.toLowerCase()) || name.toLowerCase() === hood.toLowerCase()) {
          const dist = haversine(targetData.lat, targetData.lng, data.lat, data.lng);
          return { event: e, dist };
        }
      }
      return { event: e, dist: 4.0 };
    }

    const dist = haversine(targetData.lat, targetData.lng, hoodData.lat, hoodData.lng);
    return { event: e, dist };
  });

  return scored
    .filter(s => s.dist <= 5)
    .sort((a, b) => a.dist - b.dist)
    .map(s => s.event);
}

/**
 * Get today's (or today+offset) date string in NYC timezone as YYYY-MM-DD.
 */
function getNycDateString(dayOffset = 0) {
  const d = new Date();
  const parts = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).split('-');
  const nycDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]) + dayOffset);
  return nycDate.toISOString().slice(0, 10);
}

/**
 * Infer event category from name + description text (already lowercased).
 */
function inferCategory(text) {
  if (/\b(comedy|stand-?up|improv|open mic)\b/.test(text)) return 'comedy';
  if (/\b(gallery|exhibit|art show|opening reception|installation)\b/.test(text)) return 'art';
  if (/\b(dj|dance party|club night|rave|techno|house music)\b/.test(text)) return 'nightlife';
  if (/\b(concert|live music|band|singer|songwriter|jazz|acoustic)\b/.test(text)) return 'live_music';
  if (/\b(theater|theatre|musical|play|performance|broadway)\b/.test(text)) return 'theater';
  if (/\b(food|tasting|wine|beer|cocktail|brunch|dinner)\b/.test(text)) return 'food_drink';
  if (/\b(workshop|class|meetup|volunteer|community|market|fair|festival)\b/.test(text)) return 'community';
  return 'other';
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Filter out events that have likely already ended.
 * Keeps events that:
 * - Have no parseable start time (let Claude decide)
 * - Started within the last 2 hours (might still be going)
 * - Haven't started yet
 * - Have an end_time that's still in the future
 */
function filterUpcomingEvents(events) {
  const now = Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;

  return events.filter(e => {
    if (!e.start_time_local) return true;
    if (!/T\d{2}:/.test(e.start_time_local)) return true;

    try {
      const eventMs = new Date(e.start_time_local).getTime();
      if (isNaN(eventMs)) return true;

      // If event has an end time still in the future, include it regardless of start
      if (e.end_time_local && /T\d{2}:/.test(e.end_time_local)) {
        const endMs = new Date(e.end_time_local).getTime();
        if (!isNaN(endMs) && endMs > now) return true;
      }

      // Include if started within last 2 hours or hasn't started yet
      return eventMs > twoHoursAgo;
    } catch {
      return true;
    }
  });
}

module.exports = { resolveNeighborhood, rankEventsByProximity, getNycDateString, inferCategory, haversine, filterUpcomingEvents };
