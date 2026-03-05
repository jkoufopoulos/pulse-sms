/**
 * Scrape Audit — validates data quality across ALL events from ALL sources.
 *
 * Complements extraction-audit.js (LLM-extracted sources only) and
 * source-completeness.js (structured field presence). This module checks
 * format validity, data completeness, and source-level event counts.
 *
 * Each check returns { name, pass, detail }.
 */

// Known categories used across all sources
const VALID_CATEGORIES = new Set([
  'nightlife', 'live_music', 'comedy', 'theater', 'art', 'film',
  'dance', 'community', 'music', 'food', 'trivia', 'tours',
  'literature', 'market', 'other',
]);

// Categories where we expect a start time
const TIME_EXPECTED_CATEGORIES = new Set([
  'nightlife', 'live_music', 'comedy', 'theater',
]);

// Minimum event counts per source (pre-dedup) — catches silent parser breakage
const SOURCE_MINIMUMS = {
  Skint: 5,
  RA: 5,
  Dice: 5,
  DoNYC: 5,
  Ticketmaster: 5,
  NonsenseNYC: 3,
  BrooklynVegan: 3,
  Songkick: 3,
  Eventbrite: 3,
  BAM: 2,
  NYCParks: 2,
  EventbriteComedy: 2,
  TinyCupboard: 5,
  BrooklynCC: 5,
  // Intermittent — no minimum enforced
  // SkintOngoing: 0, Yutori: 0, NYPL: 0, EventbriteArts: 0,
};

// ============================================================
// Per-event checks
// ============================================================

// Checks split into structural (actionable, affects pass rate) and coverage (informational, known gaps)
const COVERAGE_CHECKS = new Set(['price_coverage']);

const checks = {
  date_format_valid(event) {
    const d = event.date_local;
    if (!d) return { name: 'date_format_valid', pass: true, detail: 'no date (skipped)' };
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(d);
    return {
      name: 'date_format_valid',
      pass: valid,
      detail: valid ? d : `bad format: "${d}"`,
    };
  },

  time_format_valid(event) {
    const t = event.start_time_local;
    if (!t) return { name: 'time_format_valid', pass: true, detail: 'no time (skipped)' };
    const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(t);
    return {
      name: 'time_format_valid',
      pass: valid,
      detail: valid ? t : `bad format: "${t}"`,
    };
  },

  time_present(event) {
    const hasTime = !!event.start_time_local;
    if (hasTime) return { name: 'time_present', pass: true, detail: 'has time' };
    const cat = event.category;
    if (!cat || !TIME_EXPECTED_CATEGORIES.has(cat)) {
      return { name: 'time_present', pass: true, detail: `no time, category "${cat}" exempt` };
    }
    return {
      name: 'time_present',
      pass: false,
      detail: `no time for ${cat} event`,
    };
  },

  venue_quality(event) {
    const venue = (event.venue_name || '').trim();
    if (!venue) return { name: 'venue_quality', pass: false, detail: 'no venue_name' };
    const isTba = /^tba$/i.test(venue) || /^to be announced$/i.test(venue);
    if (!isTba) return { name: 'venue_quality', pass: true, detail: venue };

    // Check if venue keywords are in the event name (rescue hint)
    const name = (event.name || '').toLowerCase();
    const hint = name.includes(' at ') || name.includes(' @ ');
    return {
      name: 'venue_quality',
      pass: false,
      detail: hint
        ? `TBA venue, but event name contains location hint: "${event.name}"`
        : 'TBA venue',
    };
  },

  price_coverage(event) {
    if (event.is_free === true) return { name: 'price_coverage', pass: true, detail: 'is_free=true' };
    if (event.price_display) return { name: 'price_coverage', pass: true, detail: `price: ${event.price_display}` };
    return {
      name: 'price_coverage',
      pass: false,
      detail: 'no is_free and no price_display',
    };
  },

  category_valid(event) {
    const cat = event.category;
    if (!cat) return { name: 'category_valid', pass: false, detail: 'no category' };
    const valid = VALID_CATEGORIES.has(cat);
    return {
      name: 'category_valid',
      pass: valid,
      detail: valid ? cat : `unknown category: "${cat}"`,
    };
  },

  has_url(event) {
    const hasUrl = !!(event.ticket_url || event.source_url);
    return {
      name: 'has_url',
      pass: hasUrl,
      detail: hasUrl
        ? (event.ticket_url ? 'ticket_url' : 'source_url')
        : 'no ticket_url or source_url',
    };
  },
};

// ============================================================
// Main audit runner
// ============================================================

/**
 * Run scrape audit on all events + source count checks.
 * @param {Array} events - All valid events from the cache
 * @param {Object} fetchMap - { label: { events, status, ... } } from refreshCache
 * @returns {Object} Audit report
 */
function runScrapeAudit(events, fetchMap) {
  const sourceStats = {};
  const failingEvents = {};

  for (const event of events) {
    const results = Object.values(checks).map(fn => fn(event));
    const failures = results.filter(r => !r.pass);
    const src = event.source_name || 'unknown';

    if (!sourceStats[src]) {
      sourceStats[src] = { total: 0, passed: 0, failures: {}, coverage: {} };
    }
    const stats = sourceStats[src];
    stats.total++;

    // Split failures into structural (affects pass rate) and coverage (informational)
    const structuralFailures = failures.filter(f => !COVERAGE_CHECKS.has(f.name));
    const coverageFailures = failures.filter(f => COVERAGE_CHECKS.has(f.name));

    if (structuralFailures.length === 0) {
      stats.passed++;
    } else {
      for (const f of structuralFailures) {
        stats.failures[f.name] = (stats.failures[f.name] || 0) + 1;
      }
    }
    for (const f of coverageFailures) {
      stats.coverage[f.name] = (stats.coverage[f.name] || 0) + 1;
    }
    if (structuralFailures.length > 0) {
      // Cap failing events to 10 per source
      if (!failingEvents[src]) failingEvents[src] = [];
      if (failingEvents[src].length < 10) {
        failingEvents[src].push({
          event_id: event.id,
          event_name: event.name,
          source: src,
          failures: structuralFailures.map(f => ({ name: f.name, detail: f.detail })),
        });
      }
    }
  }

  // Source count checks (from pre-dedup fetchMap)
  const sourceCountChecks = {};
  for (const [label, minimum] of Object.entries(SOURCE_MINIMUMS)) {
    const fetched = fetchMap?.[label];
    const count = fetched?.events?.length || 0;
    sourceCountChecks[label] = {
      count,
      minimum,
      pass: count >= minimum,
    };
  }

  const totalEvents = events.length;
  const totalPassed = Object.values(sourceStats).reduce((sum, s) => sum + s.passed, 0);
  const totalIssues = totalEvents - totalPassed;
  const sourcesBelow = Object.values(sourceCountChecks).filter(c => !c.pass).length;

  // Flatten failing events into a single array
  const allFailingEvents = [];
  for (const evts of Object.values(failingEvents)) {
    allFailingEvents.push(...evts);
  }

  return {
    type: 'scrape-audit',
    timestamp: new Date().toISOString(),
    summary: {
      total: totalEvents,
      passed: totalPassed,
      issues: totalIssues,
      passRate: totalEvents > 0 ? (totalPassed / totalEvents * 100).toFixed(1) + '%' : 'N/A',
      sourceCount: Object.keys(sourceStats).length,
      sourcesBelow,
    },
    sourceStats,
    sourceCountChecks,
    events: allFailingEvents,
  };
}

module.exports = { runScrapeAudit, checks, VALID_CATEGORIES, SOURCE_MINIMUMS };
