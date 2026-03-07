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

module.exports = { filterKidsEvents, filterIncomplete };
