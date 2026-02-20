const { NEIGHBORHOODS } = require('./neighborhoods');

// Borough-level fallback map (L8: moved to module scope)
const BOROUGH_FALLBACK_MAP = {
  'brooklyn': null,
  'manhattan': null,
  'queens': null,
  'bronx': null,
  'staten island': null,
  'new york': null,
  'new york (nyc)': null,
  'new york city': null,
};

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
    if (BOROUGH_FALLBACK_MAP[lower] !== undefined) return BOROUGH_FALLBACK_MAP[lower];
  }

  return null;
}

/**
 * Extract the NYC date (YYYY-MM-DD) from an event's date_local or start_time_local.
 */
function getEventDate(event) {
  if (event.date_local) return event.date_local;
  if (!event.start_time_local) return null;
  // Try ISO parse
  try {
    const ms = parseAsNycTime(event.start_time_local);
    if (!isNaN(ms)) {
      return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    }
  } catch {}
  // Try bare date (YYYY-MM-DD without time)
  const dateMatch = event.start_time_local.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];
  return null;
}

/**
 * Rank events by date (today first) then proximity to target neighborhood.
 * Filter: include everything within ~3km.
 * Sort: today > tomorrow > future, then closest first within each tier.
 */
function rankEventsByProximity(events, targetNeighborhood, { refTimeMs } = {}) {
  if (!targetNeighborhood) return events;

  const targetData = NEIGHBORHOODS[targetNeighborhood];
  if (!targetData) return events;

  const now = refTimeMs || Date.now();
  const todayNyc = getNycDateString(0, now);
  const tomorrowNyc = getNycDateString(1, now);

  const scored = events.map(e => {
    // Distance
    const hood = e.neighborhood;
    let dist = 4.0;
    if (hood) {
      const hoodData = NEIGHBORHOODS[hood];
      if (hoodData) {
        dist = haversine(targetData.lat, targetData.lng, hoodData.lat, hoodData.lng);
      } else {
        for (const [name, data] of Object.entries(NEIGHBORHOODS)) {
          if (data.aliases.includes(hood.toLowerCase()) || name.toLowerCase() === hood.toLowerCase()) {
            dist = haversine(targetData.lat, targetData.lng, data.lat, data.lng);
            break;
          }
        }
      }
    }

    // Date tier: today first, then tomorrow, then future
    const eventDate = getEventDate(e);
    let dateTier;
    if (!eventDate || eventDate === todayNyc) dateTier = 0;
    else if (eventDate === tomorrowNyc) dateTier = 1;
    else dateTier = 2;

    return { event: e, dist, dateTier };
  });

  return scored
    .filter(s => s.dist <= 3)
    .sort((a, b) => {
      if (a.dateTier !== b.dateTier) return a.dateTier - b.dateTier;
      return a.dist - b.dist;
    })
    .map(s => s.event);
}

/**
 * Get today's (or today+offset) date string in NYC timezone as YYYY-MM-DD.
 * Uses calendar-day arithmetic instead of ms-arithmetic to avoid DST bugs
 * (adding 86400000ms can land on the wrong calendar day during fall-back).
 */
function getNycDateString(dayOffset = 0, refTimeMs = Date.now()) {
  const d = new Date(refTimeMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const year = parseInt(parts.find(p => p.type === 'year').value);
  const month = parseInt(parts.find(p => p.type === 'month').value);
  const day = parseInt(parts.find(p => p.type === 'day').value);
  // Date constructor handles month/year rollover correctly
  const result = new Date(year, month - 1, day + dayOffset);
  const yyyy = result.getFullYear();
  const mm = String(result.getMonth() + 1).padStart(2, '0');
  const dd = String(result.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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
 * Get the current NYC UTC offset string (e.g. "-05:00" for EST, "-04:00" for EDT).
 * Uses Intl.DateTimeFormat which handles DST transitions correctly regardless of
 * the server's local timezone.
 */
function getNycUtcOffset() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date());
  const tz = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = tz.match(/GMT([+-]?\d+)/);
  if (!m) return '-05:00';
  const h = parseInt(m[1], 10);
  const sign = h <= 0 ? '-' : '+';
  return `${sign}${String(Math.abs(h)).padStart(2, '0')}:00`;
}

/**
 * Parse a datetime string as NYC time. If the string has no timezone offset,
 * assume it's Eastern Time and append the current NYC UTC offset.
 */
function parseAsNycTime(dtString) {
  if (!dtString) return NaN;
  // Already has timezone info (Z, +HH:MM, -HH:MM) — parse as-is
  if (/[Z+-]\d{2}:?\d{2}$/.test(dtString) || dtString.endsWith('Z')) {
    return new Date(dtString).getTime();
  }
  // Append current NYC UTC offset (handles EST/EDT automatically)
  return new Date(dtString + getNycUtcOffset()).getTime();
}

/**
 * Filter out events that have likely already ended.
 * Keeps events that:
 * - Have no parseable start time (let Claude decide)
 * - Started within the last 2 hours (might still be going)
 * - Haven't started yet
 * - Have an end_time that's still in the future
 */
function filterUpcomingEvents(events, { refTimeMs } = {}) {
  const now = refTimeMs || Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const todayNyc = getNycDateString(0, now);

  return events.filter(e => {
    // Check end_time FIRST — late-night events that span midnight are still happening
    if (e.end_time_local && /T\d{2}:/.test(e.end_time_local)) {
      try {
        const endMs = parseAsNycTime(e.end_time_local);
        if (!isNaN(endMs) && endMs > now) return true;
      } catch {}
    }

    // Check start_time — events within last 2 hours or in future are live regardless of date
    if (e.start_time_local && /T\d{2}:/.test(e.start_time_local)) {
      try {
        const eventMs = parseAsNycTime(e.start_time_local);
        if (!isNaN(eventMs)) {
          if (eventMs > twoHoursAgo) return true;
          return false; // has specific time and it's too old
        }
      } catch {}
    }

    // Filter out events whose date is in the past
    const eventDate = getEventDate(e);
    if (eventDate && eventDate < todayNyc) return false;

    // No time info — keep if date is today or missing
    return true;
  });
}

/**
 * Filter events to those starting at or after a given HH:MM time (NYC timezone).
 * Events without parseable start times are kept (let Claude decide).
 * Returns original array if no events match the filter (soft filter).
 */
function filterByTimeAfter(events, timeAfterHHMM) {
  if (!timeAfterHHMM || !/^\d{2}:\d{2}$/.test(timeAfterHHMM)) return events;
  const [filterH, filterM] = timeAfterHHMM.split(':').map(Number);
  const filterMinutes = filterH * 60 + filterM;

  const filtered = events.filter(e => {
    if (!e.start_time_local || !/T\d{2}:/.test(e.start_time_local)) return true; // no time → keep
    try {
      const ms = parseAsNycTime(e.start_time_local);
      if (isNaN(ms)) return true;
      const nycDate = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false });
      const [h, m] = nycDate.split(':').map(Number);
      const eventMinutes = h * 60 + m;
      // Handle after-midnight: if filter is 22:00 and event is 01:00, treat 01:00 as 25:00
      const adjustedEvent = eventMinutes < 6 * 60 ? eventMinutes + 24 * 60 : eventMinutes;
      const adjustedFilter = filterMinutes < 6 * 60 ? filterMinutes + 24 * 60 : filterMinutes;
      return adjustedEvent >= adjustedFilter;
    } catch { return true; }
  });

  return filtered.length > 0 ? filtered : events; // soft filter
}

module.exports = { resolveNeighborhood, rankEventsByProximity, getNycDateString, getNycUtcOffset, inferCategory, haversine, filterUpcomingEvents, getEventDate, parseAsNycTime, filterByTimeAfter };
