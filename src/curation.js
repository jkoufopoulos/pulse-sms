/**
 * Pre-compose curation filters — deterministic event filtering
 * that runs before events reach Claude.
 */

const KIDS_PATTERNS = /\b(kids|children|storytime|story\s*time|family\s*day|toddler|pre-?school|youth|ages?\s*\d+-\d+|puppet|family-?friendly)\b/i;

/**
 * Remove NYC Parks events that are clearly for children.
 * Only filters events where source_name includes 'nyc-parks'.
 */
function filterKidsEvents(events) {
  return events.filter(e => {
    if (!e.source_name || !e.source_name.includes('nyc-parks')) return true;
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

const ACTIVITY_PATTERNS = /\b(trivia|jazz|dj|karaoke|comedy|danc(e|ing)|vinyl|live\s*(music|band|show)|happy\s*hour|open\s*mic|bingo|drag|burlesque|poetry|improv|stand-?up|salsa|bachata|swing|hip-?hop|funk|soul|r&b|punk|metal|folk|indie|electronic|techno|house|afrobeat|reggae|latin|cumbia)\b/i;

/**
 * Remove perennial picks that lack a specific activity.
 * Keeps picks whose short_detail/vibe mentions trivia, jazz, DJs, etc.
 * Removes "nice bar" perennials that have nothing specific happening.
 */
function validatePerennialActivity(perennialEvents) {
  return perennialEvents.filter(e => {
    const text = `${e.short_detail || ''} ${e.description_short || ''}`;
    return ACTIVITY_PATTERNS.test(text);
  });
}

module.exports = { filterKidsEvents, filterIncomplete, validatePerennialActivity, KIDS_PATTERNS, ACTIVITY_PATTERNS };
