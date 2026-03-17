const fs = require('fs');
const path = require('path');
const { extractEvents } = require('../ai');
const { fetchEmails } = require('../gmail');
const { normalizeExtractedEvent, backfillEvidence } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');
const { stripHtml } = require('./shared');

const SCREENSLATE_DIR = path.join(__dirname, '../../data/screenslate');
const CACHE_FILE = path.join(SCREENSLATE_DIR, 'cached-events.json');
const EXTRACT_BUDGET_MS = 45000; // bail before the 60s global timeout

/**
 * Load cached events from a previously processed newsletter.
 * Returns { id, events } or null if no cache exists.
 */
function loadCachedEvents() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data?.events) backfillEvidence(data.events);
      return data;
    }
  } catch (err) {
    console.warn('ScreenSlate: failed to load cached-events.json:', err.message);
  }
  return null;
}

/**
 * Save extracted events alongside the newsletter ID they came from.
 */
function saveCachedEvents(emailId, events) {
  try {
    fs.mkdirSync(SCREENSLATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ id: emailId, events }, null, 2));
  } catch (err) {
    console.warn('ScreenSlate: failed to save cached-events.json:', err.message);
  }
}

/**
 * Split a Screen Slate newsletter into venue sections.
 * Venue headers are all-caps lines like "ANTHOLOGY FILM ARCHIVES", "FILM FORUM", "METROGRAPH".
 * Excludes credit lines like "JEAN RENOIR, 1939, 97M, 35MM" (contain comma + year pattern).
 * Returns array of { venue, content } objects.
 */
function splitByVenue(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentVenue = null;
  let currentLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (isVenueHeader(trimmed)) {
      // Save previous section
      if (currentVenue && currentLines.length > 0) {
        const content = currentLines.join('\n').trim();
        if (content.length >= 50) {
          sections.push({ venue: currentVenue, content: `${currentVenue}\n${content}` });
        }
      }
      currentVenue = trimmed;
      currentLines = [];
    } else if (currentVenue) {
      currentLines.push(line);
    }
    // Lines before first venue header (editorial intro) are skipped
  }

  // Save last section
  if (currentVenue && currentLines.length > 0) {
    const content = currentLines.join('\n').trim();
    if (content.length >= 50) {
      sections.push({ venue: currentVenue, content: `${currentVenue}\n${content}` });
    }
  }

  return sections;
}

/**
 * Detect whether a line is a venue header.
 * Must be all-uppercase, 3-60 chars, no comma+4-digit-year pattern (credit lines),
 * and not a common non-venue all-caps pattern.
 */
function isVenueHeader(line) {
  if (!line || line.length < 3 || line.length > 60) return false;
  // Must be all uppercase letters/digits, spaces, hyphens, ampersands, apostrophes, periods, slashes, colons
  if (!/^[A-Z0-9\s\-&''./:]+$/.test(line)) return false;
  // Must have at least 2 letter characters
  if ((line.match(/[A-Z]/g) || []).length < 2) return false;
  // Exclude credit lines: "DIRECTOR, YEAR, RUNTIME, FORMAT"
  if (/,\s*\d{4}/.test(line)) return false;
  // Exclude lines that are just showtimes
  if (/^\d{1,2}:\d{2}/.test(line)) return false;
  // Exclude single words that are likely format descriptors
  if (/^(NEW|DCP|35MM|16MM|70MM|DIGITAL|RESTORED|PREMIERE|SPECIAL|SERIES)$/.test(line)) return false;
  return true;
}

async function fetchScreenSlateEvents() {
  console.log('Fetching Screen Slate...');
  try {
    // Fetch newsletter emails from Gmail (daily, look back 5 days to cover weekends)
    const emails = await fetchEmails('from:jon@screenslate.com newer_than:5d', 3);
    const cached = loadCachedEvents();

    if (emails.length === 0) {
      if (cached && cached.events.length > 0) {
        console.log(`ScreenSlate: no emails found, returning ${cached.events.length} cached events`);
        return cached.events;
      }
      console.log('ScreenSlate: no newsletter emails found and no cache available');
      return [];
    }

    const latest = emails[0];

    // If the latest newsletter is already cached with events, return them
    // (skip cache if 0 events — likely a previous extraction failure)
    if (cached && cached.id === latest.id && cached.events.length > 0) {
      console.log(`ScreenSlate: returning ${cached.events.length} cached events from "${latest.subject}"`);
      return cached.events;
    }

    console.log(`ScreenSlate: processing "${latest.subject}" (${latest.date})`);
    const stripped = stripHtml(latest.body);

    // Split into venue sections for manageable extraction calls
    const sections = splitByVenue(stripped);
    if (sections.length === 0) {
      // Fallback: treat entire content as one section (cap at 10KB)
      console.log('ScreenSlate: no venue headers found, using full content');
      const content = stripped.slice(0, 10000);
      captureExtractionInput('screenslate', content, 'https://screenslate.com');
      const cachedEvents = getCachedExtraction('screenslate', content);
      let events;
      if (cachedEvents) {
        events = cachedEvents;
      } else {
        const result = await extractEvents(content, 'screenslate', 'https://screenslate.com');
        events = (result.events || [])
          .map(e => {
            e.category = 'film';
            return normalizeExtractedEvent(e, 'ScreenSlate', 'unstructured', 0.9);
          })
          .filter(e => e.name && e.completeness >= 0.5);
        setCachedExtraction('screenslate', content, events);
      }

      saveCachedEvents(latest.id, events);
      console.log(`ScreenSlate: ${events.length} events`);
      return events;
    }

    console.log(`ScreenSlate: ${sections.length} venue sections found`);
    const allEvents = [];
    const extractStart = Date.now();

    // Process venue sections in parallel (max 3 concurrent)
    const CONCURRENCY = 3;
    let sectionsProcessed = 0;
    for (let i = 0; i < sections.length; i += CONCURRENCY) {
      // Bail if extraction time budget is nearly exhausted
      if (Date.now() - extractStart > EXTRACT_BUDGET_MS) {
        console.warn(`ScreenSlate: time budget hit after ${sectionsProcessed}/${sections.length} sections, returning ${allEvents.length} events`);
        break;
      }

      const batch = sections.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async ({ venue, content }) => {
          console.log(`ScreenSlate: extracting ${venue} (${content.length} chars)`);
          captureExtractionInput('screenslate', content, 'https://screenslate.com');
          const cacheKey = `screenslate:${venue}`;
          const cachedVenue = getCachedExtraction(cacheKey, content);
          if (cachedVenue) return cachedVenue;
          const result = await extractEvents(content, 'screenslate', 'https://screenslate.com');
          const extracted = (result.events || [])
            .map(e => {
              e.category = 'film';
              return normalizeExtractedEvent(e, 'ScreenSlate', 'unstructured', 0.9);
            })
            .filter(e => e.name && e.completeness >= 0.5);
          setCachedExtraction(cacheKey, content, extracted);
          return extracted;
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allEvents.push(...r.value);
        } else {
          console.warn('ScreenSlate: extraction failed for venue section:', r.reason?.message);
        }
      }
      sectionsProcessed += batch.length;
    }

    saveCachedEvents(latest.id, allEvents);
    console.log(`ScreenSlate: ${allEvents.length} events from ${sectionsProcessed}/${sections.length} venue sections (${((Date.now() - extractStart) / 1000).toFixed(1)}s)`);
    return allEvents;
  } catch (err) {
    console.error('Screen Slate error:', err.message);
    const cached = loadCachedEvents();
    if (cached && cached.events.length > 0) {
      console.log(`ScreenSlate: error recovery, returning ${cached.events.length} cached events`);
      return cached.events;
    }
    return [];
  }
}

module.exports = { fetchScreenSlateEvents, splitByVenue, isVenueHeader };
