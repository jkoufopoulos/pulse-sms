const crypto = require('crypto');
const { resolveNeighborhood } = require('../geo');
const { lookupVenue, resolveVenueAlias } = require('../venues');

// NYC bounding box — shared across scrapers that need geo filtering
const NYC_BBOX = { minLat: 40.49, maxLat: 40.92, minLng: -74.26, maxLng: -73.70 };

function isInsideNYC(lat, lng) {
  if (isNaN(lat) || isNaN(lng)) return false;
  return lat >= NYC_BBOX.minLat && lat <= NYC_BBOX.maxLat &&
         lng >= NYC_BBOX.minLng && lng <= NYC_BBOX.maxLng;
}

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
    .replace(/\s*\((sold out|ages?\s*\d+\+?|all ages|21\+|18\+|16\+|free|rsvp|canceled|cancelled|postponed)\)\s*/gi, ' ') // strip noise parentheticals only
    .replace(/\s*&\s*(friends|more|guests)\b.*/i, '')         // strip "& Friends", "& More"
    .replace(/\b(ft\.?|feat\.?|featuring|w\/|with)\b.*/i, '') // strip "ft." and everything after
    .replace(/[^\w\s]/g, '')                                  // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a stable event ID from name + venue + date (+ optional startTime).
 * Falls back to source + url hash when core fields are empty to avoid collisions.
 * startTime differentiates distinct performances at the same venue on the same day (#18).
 */
function makeEventId(name, venue, date, source, sourceUrl, startTime) {
  const norm = normalizeEventName(name);
  const v = (venue || '').toLowerCase().trim();
  const d = (date || '').trim();

  // If all three core fields are empty, use source + url as fallback
  if (!norm && !v && !d) {
    const fallback = `${source || 'unknown'}|${sourceUrl || 'no-url'}`;
    return crypto.createHash('md5').update(fallback).digest('hex').slice(0, 12);
  }

  // Extract HH:MM from ISO datetime or bare time
  let t = '';
  if (startTime) {
    const m = startTime.match(/T(\d{2}:\d{2})/);
    t = m ? m[1] : '';
  }

  const raw = `${norm}|${v}|${d}${t ? '|' + t : ''}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

/**
 * Compute data completeness score (0–1) based on which fields are present.
 */
function computeCompleteness(e) {
  let score = 0;
  if (e.name) score += 0.3;
  if (e.date_local) score += 0.2;
  if (e.venue_name && e.venue_name !== 'TBA') score += 0.2;
  if (e.neighborhood) score += 0.15;
  if (e.start_time_local) score += 0.15;
  return score;
}

/**
 * Parse bare am/pm time like "9pm", "10:30am" into "HH:MM".
 * Returns null if not matched.
 */
function parseAmPmTime(str) {
  const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const period = m[3].toLowerCase();
  if (period === 'pm' && h !== 12) h += 12;
  if (period === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Normalize date/time fields from LLM extraction output.
 * Coerces freeform strings into YYYY-MM-DD (date_local) and ISO datetime (start/end_time_local).
 * Mutates the event object in place.
 */
function normalizeDateTimeFields(e) {
  // --- date_local: must be YYYY-MM-DD ---
  if (e.date_local && !/^\d{4}-\d{2}-\d{2}$/.test(e.date_local)) {
    const parsed = new Date(e.date_local);
    if (!isNaN(parsed.getTime())) {
      e.date_local = parsed.toLocaleDateString('en-CA'); // YYYY-MM-DD
    } else {
      e.date_local = null;
    }
  }

  // --- start_time_local / end_time_local: must be ISO datetime ---
  for (const field of ['start_time_local', 'end_time_local']) {
    const val = e[field];
    if (!val) continue;

    // Already ISO datetime
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) continue;

    // Bare HH:MM or HH:MM:SS — combine with date_local
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(val)) {
      if (e.date_local) {
        const timePart = val.length === 5 ? `${val}:00` : val;
        e[field] = `${e.date_local}T${timePart}`;
      }
      continue;
    }

    // Bare am/pm time like "9pm", "10:30am"
    const hhmm = parseAmPmTime(val.trim());
    if (hhmm && e.date_local) {
      e[field] = `${e.date_local}T${hhmm}:00`;
      continue;
    }

    // Unparseable
    e[field] = null;
  }
}

/**
 * Map non-canonical LLM-extracted categories to canonical ones.
 * Canonical set: comedy, live_music, nightlife, art, theater, community,
 * trivia, film, food_drink, spoken_word, other.
 */
const CATEGORY_CANON = {
  music: 'live_music',
  dance: 'nightlife',
  market: 'community',
  literature: 'spoken_word',
};

function canonicalizeCategory(cat) {
  if (!cat) return 'other';
  return CATEGORY_CANON[cat] || cat;
}

function normalizeExtractedEvent(e, sourceName, sourceType, sourceWeight) {
  normalizeDateTimeFields(e);

  // Derive time_window from start_time_local hour when LLM didn't set it (P6: mechanical)
  if (!e.time_window && e.start_time_local) {
    const hourMatch = e.start_time_local.match(/T(\d{2}):/);
    if (hourMatch) {
      const hour = parseInt(hourMatch[1], 10);
      if (hour < 12) e.time_window = 'morning';
      else if (hour < 17) e.time_window = 'afternoon';
      else if (hour < 21) e.time_window = 'evening';
      else e.time_window = 'late_night';
    }
  }

  // Resolve venue aliases before ID generation and lookup (dedup improvement)
  if (e.venue_name) {
    e.venue_name = resolveVenueAlias(e.venue_name);
  }

  const id = makeEventId(e.name, e.venue_name, e.date_local || e.start_time_local || '', sourceName, e.source_url, e.start_time_local);

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
    category: canonicalizeCategory(e.category),
    subcategory: e.category === 'film' ? 'film'
      : e.category === 'dance' ? 'dance'
      : e.category === 'literature' ? 'literature'
      : e.category === 'market' ? 'market'
      : (e.subcategory || null),
    extraction_confidence: e.extraction_confidence ?? e.confidence ?? null,
    completeness: computeCompleteness({
      name: e.name,
      date_local: e.date_local,
      venue_name: e.venue_name || 'TBA',
      neighborhood,
      start_time_local: e.start_time_local,
    }),
    ticket_url: e.ticket_url || null,
    source_url: e.source_url || null,
    map_url: null,
    map_hint: e.map_hint || null,
    series_end: e.series_end || null,
    evidence: e.evidence || {
      name_quote: e.name ? e.name.toLowerCase() : null,
      time_quote: e.start_time_local || null,
      location_quote: e.venue_name && e.venue_name !== 'TBA' ? e.venue_name.toLowerCase() : null,
      price_quote: e.price_display ? e.price_display.toLowerCase() : (e.is_free === true ? 'free' : null),
    },
    editorial_note: e.editorial_note || null,
    editorial_signal: e.editorial_signal || false,
    scarcity: e.scarcity || null,
    // Recurrence fields from LLM or trivia parser
    is_recurring: e.is_recurring || false,
    recurrence_day: e.recurrence_day || null,
    recurrence_time: e.recurrence_time || null,
  };
}

/**
 * Backfill evidence blocks on cached events that predate evidence synthesis.
 * Mutates in place and returns the array.
 */
function backfillEvidence(events) {
  for (const e of events) {
    if (!e.evidence) {
      e.evidence = {
        name_quote: e.name ? e.name.toLowerCase() : null,
        time_quote: e.start_time_local || null,
        location_quote: e.venue_name && e.venue_name !== 'TBA' ? e.venue_name.toLowerCase() : null,
        price_quote: e.price_display ? e.price_display.toLowerCase() : (e.is_free === true ? 'free' : null),
      };
    }
  }
  return events;
}

/**
 * Backfill ISO date/time formats on cached events that predate normalization.
 * Mutates in place and returns the array.
 */
function backfillDateTimes(events) {
  for (const e of events) {
    normalizeDateTimeFields(e);
  }
  return events;
}

/**
 * Strip HTML to plain text, preserving <a href> URLs as "text (URL)" format.
 */
function stripHtml(html) {
  return html
    // Convert <a href="url">text</a> to "text (url)"
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, (_, url, text) => {
      const cleanText = text.replace(/<[^>]*>/g, '').trim();
      // If the link text is the URL itself, just keep the URL
      if (cleanText === url || !cleanText) return url;
      return `${cleanText} (${url})`;
    })
    // Convert <br> and block elements to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]*>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace but preserve paragraph breaks
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Generic email/newsletter event extraction via line-based chunking.
 * Replaces custom splitters (splitByVenue, splitByDay) — the LLM handles structure.
 *
 * @param {object} opts
 * @param {string} opts.text - Plain text content to extract from
 * @param {string} opts.sourceName - Display name (e.g. 'ScreenSlate')
 * @param {string} opts.sourceType - Source type (e.g. 'unstructured', 'curated')
 * @param {number} opts.sourceWeight - Weight for dedup merging
 * @param {string} opts.sourceUrl - Source URL for extraction context
 * @param {string} opts.label - Cache key prefix (e.g. 'screenslate')
 * @param {string} [opts.categoryOverride] - Force category on all events (e.g. 'film')
 * @param {number} [opts.linesPerChunk=50] - Lines per chunk (lower = fewer events per LLM call, less truncation risk)
 * @returns {Promise<object[]>} Normalized, quality-gated events
 */
async function extractEmailEvents({ text, sourceName, sourceType, sourceWeight, sourceUrl, label, categoryOverride, linesPerChunk = 50, sourceHint }) {
  const { extractEvents } = require('../ai');
  const { captureExtractionInput } = require('../extraction-capture');
  const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');

  const lines = text.split('\n').filter(l => l.trim());
  const LINES_PER_CHUNK = linesPerChunk;
  const OVERLAP = 10; // repeat last N lines from previous chunk for venue/section context
  const chunks = [];
  for (let i = 0; i < lines.length; i += LINES_PER_CHUNK) {
    const start = i === 0 ? 0 : i - OVERLAP;
    chunks.push(lines.slice(start, i + LINES_PER_CHUNK).join('\n'));
  }

  console.log(`${sourceName}: ${lines.length} lines → ${chunks.length} chunks`);

  const allEvents = [];
  const CONCURRENCY = 3;

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (content, j) => {
        const chunkIndex = i + j;
        const chunkLabel = `${label}:chunk${chunkIndex}`;
        const cachedChunk = getCachedExtraction(chunkLabel, content);
        if (cachedChunk) return cachedChunk;

        captureExtractionInput(label, content, sourceUrl);
        const extractionContent = sourceHint ? `[SOURCE CONTEXT: ${sourceHint}]\n\n${content}` : content;
        const result = await extractEvents(extractionContent, label, sourceUrl);
        const events = (result.events || [])
          .map(e => {
            if (categoryOverride) e.category = categoryOverride;
            return normalizeExtractedEvent(e, sourceName, sourceType, sourceWeight);
          })
          .filter(e => e.name && e.completeness >= 0.5);

        // Only cache non-empty results — 0 events likely means LLM truncation/failure
        if (events.length > 0) {
          setCachedExtraction(chunkLabel, content, events);
        }
        return events;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') allEvents.push(...r.value);
      else console.warn(`${sourceName}: chunk extraction failed:`, r.reason?.message);
    }
  }

  return allEvents;
}

module.exports = { FETCH_HEADERS, NYC_BBOX, isInsideNYC, makeEventId, normalizeExtractedEvent, normalizeEventName, computeCompleteness, backfillEvidence, backfillDateTimes, stripHtml, extractEmailEvents };
