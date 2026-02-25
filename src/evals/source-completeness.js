/**
 * Source field-completeness eval — catches structured parser regressions.
 *
 * Each structured source has guaranteed fields based on its parser logic.
 * If a parser breaks (schema change, selector change), this eval detects
 * missing fields before they cause downstream symptoms.
 *
 * Run after each scrape via checkSourceCompleteness(fetchMap).
 */

// Universal fields every structured source must have
const UNIVERSAL_FIELDS = ['id', 'source_name', 'name', 'venue_name', 'is_free', 'category'];

// Per-source additional required fields (on top of universal)
const SOURCE_EXPECTATIONS = {
  BAM: {
    fields: ['venue_address', 'neighborhood', 'date_local', 'map_hint'],
    invariants: { neighborhood: 'Fort Greene', is_free: false },
  },
  SmallsLIVE: {
    fields: ['description_short', 'short_detail', 'venue_address', 'neighborhood', 'date_local', 'subcategory', 'map_hint'],
    invariants: { neighborhood: 'West Village', category: 'live_music', subcategory: 'jazz', is_free: false },
  },
  Ticketmaster: {
    fields: ['start_time_local', 'date_local'],
    invariants: {},
  },
  DoNYC: {
    fields: ['date_local'],
    invariants: {},
  },
  'NYC Parks': {
    fields: [],
    invariants: { is_free: true, price_display: 'free' },
  },
  NYPL: {
    fields: [],
    invariants: { is_free: true, price_display: 'free' },
  },
  RA: {
    fields: [],
    invariants: { is_free: false, category: 'nightlife' },
  },
  Songkick: {
    fields: [],
    invariants: { category: 'live_music' },
  },
  Eventbrite: {
    fields: [],
    invariants: {},
  },
  EventbriteComedy: {
    fields: [],
    invariants: {},
  },
  EventbriteArts: {
    fields: [],
    invariants: {},
  },
  Dice: {
    fields: [],
    invariants: {},
  },
  BrooklynVegan: {
    fields: [],
    invariants: {},
  },
};

// Sources that use LLM extraction (not structured parsers) — skip these
const EXTRACTED_SOURCES = new Set(['Skint', 'NonsenseNYC', 'OhMyRockness', 'Yutori', 'Tavily']);

/**
 * Check field completeness for a single event.
 * Returns array of failure strings (empty = pass).
 */
function checkEvent(event, sourceLabel) {
  const failures = [];

  // Universal field checks
  for (const field of UNIVERSAL_FIELDS) {
    const val = event[field];
    if (val === null || val === undefined || val === '') {
      failures.push(`missing universal field "${field}"`);
    }
  }

  // is_free must be boolean, not null/undefined
  if (typeof event.is_free !== 'boolean') {
    failures.push(`is_free is ${typeof event.is_free}, expected boolean`);
  }

  // Structured sources should never have extraction_confidence set
  if (event.extraction_confidence !== null && event.extraction_confidence !== undefined) {
    failures.push(`extraction_confidence is ${event.extraction_confidence}, expected null for structured source`);
  }

  // Source-specific field checks
  const expectations = SOURCE_EXPECTATIONS[sourceLabel];
  if (!expectations) return failures;

  for (const field of expectations.fields) {
    const val = event[field];
    if (val === null || val === undefined || val === '') {
      failures.push(`missing source-specific field "${field}"`);
    }
  }

  // Invariant checks
  for (const [field, expected] of Object.entries(expectations.invariants)) {
    if (event[field] !== expected) {
      failures.push(`invariant "${field}" is ${JSON.stringify(event[field])}, expected ${JSON.stringify(expected)}`);
    }
  }

  return failures;
}

/**
 * Run source completeness checks on a fetchMap from refreshCache.
 * @param {Object} fetchMap — { label: { events, durationMs, status, error } }
 * @returns {Object} — { label: { total, passed, failed, failures: [{ event_id, event_name, issues }] } }
 */
function checkSourceCompleteness(fetchMap) {
  const results = {};

  for (const [label, { events, status }] of Object.entries(fetchMap)) {
    // Skip extracted sources and failed fetches
    if (EXTRACTED_SOURCES.has(label) || status === 'error' || status === 'timeout') continue;
    if (!events || events.length === 0) continue;

    let passed = 0;
    let failed = 0;
    const failures = [];

    for (const event of events) {
      const issues = checkEvent(event, label);
      if (issues.length === 0) {
        passed++;
      } else {
        failed++;
        // Cap failures per source to avoid log flood
        if (failures.length < 5) {
          failures.push({
            event_id: event.id,
            event_name: event.name || '(unnamed)',
            issues,
          });
        }
      }
    }

    results[label] = { total: events.length, passed, failed, failures };

    if (failed > 0) {
      const rate = Math.round((passed / events.length) * 100);
      console.warn(`[SOURCE-EVAL] ${label}: ${failed}/${events.length} events failed completeness (${rate}% pass)`);
      for (const f of failures.slice(0, 3)) {
        console.warn(`  - "${f.event_name}": ${f.issues.join(', ')}`);
      }
    }
  }

  return results;
}

module.exports = { checkSourceCompleteness, checkEvent, SOURCE_EXPECTATIONS, UNIVERSAL_FIELDS };
