// === Deterministic trivia parser (P6: deterministic extraction first) ===

/**
 * Known NYC neighborhoods for splitting "Venue Name Neighborhood" text.
 * Sorted by length descending so longest match wins.
 */
const TRIVIA_HOODS = [
  'prospect lefferts gardens', 'bedford stuyvesant',
  'washington heights', 'morningside heights', 'financial district',
  'greenwich village', 'prospect heights', 'brooklyn heights',
  'long island city', 'battery park city',
  'carroll gardens', 'hamilton heights', 'lower east side',
  'upper east side', 'upper west side', 'jackson heights',
  'sheepshead bay', 'brighton beach', 'coney island',
  "hell's kitchen", 'hells kitchen', 'crown heights',
  'windsor terrace', 'borough park', 'bensonhurst',
  'clinton hill', 'midtown east', 'carnegie hill',
  'east village', 'west village', 'south slope', 'sunset park',
  'east harlem', 'ditmas park', 'kensington',
  'park slope', 'murray hill', 'fort greene', 'cobble hill',
  'boerum hill', 'red hook', 'bay ridge', 'kips bay', "kip's bay", 'bed-stuy', 'bowery',
  'williamsburg', 'greenpoint', 'bushwick', 'chelsea', 'gramercy',
  'sunnyside', 'woodside', 'ridgewood', 'elmhurst', 'corona',
  'forest hills', 'rego park', 'kew gardens', 'jamaica', 'bayside',
  'mott haven', 'fordham', 'belmont', 'concourse', 'riverdale',
  'downtown brooklyn', 'midtown', 'harlem', 'astoria', 'tribeca',
  'flatbush', 'midwood', 'flushing', 'gowanus', 'dumbo', 'soho', 'noho',
].sort((a, b) => b.length - a.length);

/**
 * Split "Venue Name Neighborhood" into { venue, neighborhood }.
 * Matches known neighborhoods from the end of the string.
 */
function splitVenueAndHood(text) {
  const lower = text.toLowerCase().trim();
  for (const hood of TRIVIA_HOODS) {
    if (lower.endsWith(' ' + hood) || lower === hood) {
      const cutpoint = text.length - hood.length;
      const venue = text.slice(0, cutpoint).trim();
      const neighborhood = text.slice(cutpoint).trim();
      if (venue.length > 0) return { venue, neighborhood };
    }
  }
  return { venue: text.trim(), neighborhood: null };
}

function parseTo24h(timeStr) {
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${min}`;
}

/**
 * Parse time ranges like "7:30 PM", "6:30–9:30 PM", "8:00 PM – 10:00 PM".
 */
function parseTimeRange(str) {
  const m = str.match(/(\d{1,2}:\d{2})\s*([AP]M)?\s*(?:[-–]\s*(\d{1,2}:\d{2})\s*)?([AP]M)?/i);
  if (!m) return { start: null, end: null };
  const [, t1, ampm1, t2, ampm2] = m;
  const startAmPm = (ampm1 || ampm2 || '').toUpperCase();
  const endAmPm = (ampm2 || ampm1 || '').toUpperCase();
  if (!startAmPm) return { start: null, end: null };
  const start = parseTo24h(t1 + ' ' + startAmPm);
  const end = t2 ? parseTo24h(t2 + ' ' + endAmPm) : null;
  return { start, end };
}

const MONTH_MAP = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function resolveMonthDay(monthStr, day, refYear) {
  const monthIdx = MONTH_MAP[monthStr.toLowerCase()];
  if (monthIdx === undefined) return null;
  const d = new Date(refYear, monthIdx, parseInt(day, 10));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const DAY_INDICES = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};
const DAY_NAMES_LIST = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function nextDayOfWeek(dayName, refDate) {
  const target = DAY_INDICES[dayName.toLowerCase()];
  if (target === undefined) return null;
  const ref = new Date(refDate + 'T12:00:00');
  const current = ref.getDay();
  let diff = target - current;
  if (diff < 0) diff += 7;
  ref.setDate(ref.getDate() + diff);
  return ref.toISOString().slice(0, 10);
}

function getDayName(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return DAY_NAMES_LIST[d.getDay()];
}

/**
 * Parse Format A: "Venue Name Neighborhood, Borough Time"
 * Found in NYC Trivia League bulk emails under day-of-week headers.
 */
function parseFormatA(content, currentDate, currentDayName) {
  const m = content.match(/^(.+),\s*(Brooklyn|Manhattan|Queens|Bronx|Staten Island)\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!m) return null;

  const [, venueAndHood, , timeStr] = m;
  const { venue, neighborhood } = splitVenueAndHood(venueAndHood);
  const startTime = parseTo24h(timeStr);

  const isGameEvent = /trivia|bingo|quiz/i.test(venue);
  const name = isGameEvent
    ? (neighborhood ? `${venue} (${neighborhood})` : venue)
    : (neighborhood ? `Trivia Night at ${venue} (${neighborhood})` : `Trivia Night at ${venue}`);

  return {
    name,
    venue_name: venue,
    venue_address: null,
    neighborhood,
    date_local: currentDate,
    start_time_local: startTime,
    end_time_local: null,
    dayName: currentDayName,
  };
}

/**
 * Parse Format B/D: em-dash separated trivia events.
 * Format B: "Venue — Neighborhood, Borough — [Address] — Day — Time [— recurrence]"
 * Format D: "Venue — Neighborhood, Borough — Day, Date @ Time — Price"
 */
function parseFormatB(content, dayDateMap, baseDate) {
  const segments = content.split(/\s*—\s*/).map(s => s.trim()).filter(Boolean);
  if (segments.length < 3) return null;

  const venue = segments[0];
  const locationInfo = segments[1];
  const refYear = parseInt(baseDate.slice(0, 4), 10);

  let address = null;
  let dayName = null;
  let timeStr = null;
  let explicitDate = null;
  let priceText = null;

  for (let i = 2; i < segments.length; i++) {
    const seg = segments[i].replace(/\.\s*$/, '').trim();
    if (!seg) continue;

    // Combined day+date+time: "Tuesday, Mar 4 @ 7:00 PM"
    const combinedMatch = seg.match(/(\w+day),?\s+(\w+)\s+(\d{1,2})\s*@\s*(.+)/i);
    if (combinedMatch) {
      dayName = combinedMatch[1].toLowerCase();
      explicitDate = resolveMonthDay(combinedMatch[2], combinedMatch[3], refYear);
      timeStr = combinedMatch[4].trim();
      continue;
    }

    if (/^\w+day$/i.test(seg)) {
      dayName = seg.toLowerCase();
    } else if (/\d{1,2}:\d{2}\s*[AP]M/i.test(seg)) {
      timeStr = seg;
    } else if (/^\$/.test(seg) || /^free$/i.test(seg)) {
      priceText = seg;
    } else if (/\d/.test(seg) && seg.length > 10 && !/^yes/i.test(seg)) {
      address = seg;
    }
  }

  if (!dayName && !timeStr) return null;

  const neighborhood = locationInfo.split(',')[0].trim();
  const { start, end } = timeStr ? parseTimeRange(timeStr) : { start: null, end: null };
  const date = explicitDate || (dayName ? (dayDateMap[dayName] || nextDayOfWeek(dayName, baseDate)) : null);

  const isFree = !priceText || /free/i.test(priceText);
  const isGameEvent = /trivia|bingo|quiz/i.test(venue);
  const name = isGameEvent
    ? (neighborhood ? `${venue} (${neighborhood})` : venue)
    : (neighborhood ? `Trivia Night at ${venue} (${neighborhood})` : `Trivia Night at ${venue}`);

  return {
    name,
    venue_name: venue,
    venue_address: address,
    neighborhood,
    date_local: date,
    start_time_local: start,
    end_time_local: end,
    dayName,
    isFree,
    priceText: isFree ? 'Free' : priceText,
  };
}

/**
 * Parse Format E: "Venue (Neighborhood[, Borough]) @ Time [— Price]"
 * Found in "previously reported" sections under day-of-week headers.
 */
function parseFormatE(content, currentDate, currentDayName) {
  const m = content.match(/^(.+?)\s*\(([^)]+)\)\s*@\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!m) return null;

  const [, venue, hoodBoro, timeStr] = m;
  const neighborhood = hoodBoro.split(',')[0].trim();
  const startTime = parseTo24h(timeStr);

  // Check for price after em-dash
  const priceMatch = content.match(/—\s*(.+)$/);
  const priceText = priceMatch ? priceMatch[1].trim() : null;
  const isFree = !priceText || /free/i.test(priceText);

  const isGameEvent = /trivia|bingo|quiz/i.test(venue);
  const name = isGameEvent
    ? (neighborhood ? `${venue} (${neighborhood})` : venue)
    : (neighborhood ? `Trivia Night at ${venue} (${neighborhood})` : `Trivia Night at ${venue}`);

  return {
    name,
    venue_name: venue.trim(),
    venue_address: null,
    neighborhood,
    date_local: currentDate,
    start_time_local: startTime,
    end_time_local: null,
    dayName: currentDayName,
    isFree,
    priceText: isFree ? 'Free' : priceText,
  };
}

/**
 * Parse Format C: "Event Name — Location, Address; Day, Time; Next: Date"
 * Found in upcoming picks emails with explicit next-occurrence dates.
 */
function parseFormatC(content, refYear) {
  const m = content.match(
    /^(.+?)\s*—\s*(.+?);\s*(?:\d+(?:st|nd|rd|th)\s+)?(\w+day),?\s*(.+?);\s*Next:\s*(.+)$/i
  );
  if (!m) return null;

  const [, eventName, locationInfo, dayName, timeStr, nextDateStr] = m;

  // Parse "Next: March 6, 2026"
  const nextMatch = nextDateStr.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})?/);
  let date = null;
  if (nextMatch) {
    date = resolveMonthDay(nextMatch[1], nextMatch[2], nextMatch[3] ? parseInt(nextMatch[3]) : refYear);
  }

  const locParts = locationInfo.split(',').map(s => s.trim());
  const neighborhood = locParts[0];
  const address = locParts.length > 1 ? locParts.slice(1).join(', ').trim() : null;

  // Extract venue from "X at VENUE" pattern
  const atMatch = eventName.match(/\bat\s+(.+)$/i);
  const venueName = atMatch ? atMatch[1].trim() : null;

  const { start, end } = parseTimeRange(timeStr);

  return {
    name: eventName.trim(),
    venue_name: venueName || eventName.trim(),
    venue_address: address,
    neighborhood,
    date_local: date,
    start_time_local: start,
    end_time_local: end,
    dayName: dayName.toLowerCase(),
  };
}

/**
 * Deterministically parse trivia events from preprocessed Yutori text.
 * Handles three formats: A (bulk venue list), B (em-dash separated), C (semicolon + Next: date).
 */
function parseTriviaEvents(text, filename) {
  const baseDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  const baseDate = baseDateMatch ? baseDateMatch[1] : null;
  if (!baseDate) return [];
  const refYear = parseInt(baseDate.slice(0, 4), 10);

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const events = [];
  let currentDate = null;
  let currentDayName = null;

  // Pass 1: Build day header → date map from explicit headers ("Tuesday, Feb 24")
  const dayDateMap = {};
  for (const line of lines) {
    const m = line.match(/^(?:##\s*)?(\w+day),?\s+(\w+)\s+(\d{1,2})\b/i);
    if (m) {
      const resolved = resolveMonthDay(m[2], m[3], refYear);
      if (resolved) dayDateMap[m[1].toLowerCase()] = resolved;
    }
  }

  // Pass 2: Parse events
  for (const line of lines) {
    // Day headers
    const headerMatch = line.match(/^(?:##\s*)?(\w+day),?\s+(\w+)\s+(\d{1,2})\b/i);
    if (headerMatch) {
      currentDate = resolveMonthDay(headerMatch[2], headerMatch[3], refYear);
      currentDayName = headerMatch[1].toLowerCase();
      continue;
    }

    if (!line.startsWith('[Event]')) continue;

    const content = line.replace(/^\[Event\]\s*/, '').replace(/\.\s*\.?\s*$/, '').trim();
    if (!content || content.length < 10) continue;

    // Skip metadata/summary lines
    if (/^(Entry fee|Registration|Format:|Prizes|Most events|Themed nights|Weekly recurring|21\+ requirement|Earliest upcoming|Event:|Day & time:|Locations:|Team size:)/i.test(content)) continue;

    let event = null;

    const hasEmDash = content.includes('\u2014');
    const hasNextDate = /;\s*Next:/i.test(content);

    if (hasEmDash && hasNextDate) {
      event = parseFormatC(content, refYear);
    } else if (hasEmDash) {
      event = parseFormatB(content, dayDateMap, baseDate);
      // Format B returns null for 2-segment lines — try Format E
      if (!event) {
        event = parseFormatE(content, currentDate, currentDayName);
      }
    } else {
      event = parseFormatE(content, currentDate, currentDayName);
      if (!event) {
        event = parseFormatA(content, currentDate, currentDayName);
      }
    }

    if (!event) continue;

    const dayName = event.dayName || (event.date_local ? getDayName(event.date_local) : null);
    const isFree = event.isFree !== false;

    events.push({
      name: event.name,
      venue_name: event.venue_name,
      venue_address: event.venue_address || null,
      neighborhood: event.neighborhood,
      date_local: event.date_local,
      start_time_local: event.start_time_local,
      end_time_local: event.end_time_local,
      is_free: isFree,
      price_display: event.priceText || (isFree ? 'Free' : null),
      category: 'trivia',
      extraction_confidence: 0.95,
      source_url: null,
      is_recurring: true,
      recurrence_day: dayName,
      recurrence_time: event.start_time_local,
      evidence: {
        name_quote: event.name ? event.name.toLowerCase() : null,
        time_quote: event.start_time_local || null,
        location_quote: event.venue_name ? event.venue_name.toLowerCase() : null,
        price_quote: event.priceText || (isFree ? 'free' : null),
      },
    });
  }

  return events;
}

module.exports = {
  parseTriviaEvents,
  // Exported for use by general-parser.js
  TRIVIA_HOODS,
  parseTo24h,
  resolveMonthDay,
};
