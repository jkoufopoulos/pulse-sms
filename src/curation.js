/**
 * Pre-compose curation filters — deterministic event filtering
 * that runs before events reach Claude.
 */

const KIDS_PATTERNS = /\b(kids|children|storytime|story\s*time|family\s*day|toddler|pre-?school|youth|ages?\s*\d+-\d+|puppet|family-?friendly)\b/i;

/**
 * Remove events that are clearly for children/families.
 */
function filterKidsEvents(events) {
  return events.filter(e => {
    const text = `${e.name || ''} ${e.description_short || ''} ${e.short_detail || ''}`;
    return !KIDS_PATTERNS.test(text);
  });
}

/**
 * Remove events below a completeness threshold.
 */
function filterIncomplete(events, threshold = 0.4) {
  return events.filter(e => (e.completeness || 0) >= threshold);
}

/**
 * Detect garbage event names — dates, metadata fields, or too-generic strings
 * that slipped through extraction.
 */
const GARBAGE_NAME_RE = /^(day\s*[&+]\s*date|date\s*[&+]\s*day)\b/i;
const DATE_ONLY_RE = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)?,?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i;
const GENERIC_EVENT_WORDS = new Set(['film', 'art', 'music', 'event', 'show', 'concert', 'performance']);

function isGarbageName(name) {
  if (!name || name.length < 4) return true;
  if (GARBAGE_NAME_RE.test(name)) return true;
  // Name is just a date string (e.g. "Friday, March 7, 2026")
  const stripped = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  if (DATE_ONLY_RE.test(stripped)) return true;
  // "Release date:" prefix — movie/TV announcements
  if (/^release\s+date/i.test(name)) return true;
  // Too-generic "X at Venue" — single generic word + "at" + anything
  const atMatch = name.match(/^(\w+)\s+at\s+/i);
  if (atMatch && GENERIC_EVENT_WORDS.has(atMatch[1].toLowerCase())) return true;
  return false;
}

module.exports = { filterKidsEvents, filterIncomplete, isGarbageName };
