const fs = require('fs');
const path = require('path');
const { extractEvents } = require('../ai');
const { fetchEmails } = require('../gmail');
const { normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { stripHtml } = require('./yutori');

const NONSENSE_DIR = path.join(__dirname, '../../data/nonsense');
const CACHE_FILE = path.join(NONSENSE_DIR, 'cached-events.json');

/**
 * Load cached events from a previously processed newsletter.
 * Returns { id, events } or null if no cache exists.
 */
function loadCachedEvents() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('NonsenseNYC: failed to load cached-events.json:', err.message);
  }
  return null;
}

/**
 * Save extracted events alongside the newsletter ID they came from.
 */
function saveCachedEvents(emailId, events) {
  try {
    fs.mkdirSync(NONSENSE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ id: emailId, events }, null, 2));
  } catch (err) {
    console.warn('NonsenseNYC: failed to save cached-events.json:', err.message);
  }
}

/**
 * Split a NonsenseNYC newsletter into day sections.
 * The newsletter uses "XXXXX FRIDAY, FEBRUARY 20 XXXXX" as day headers.
 * Returns array of { day, content } objects.
 */
function splitByDay(text) {
  const dayPattern = /XXXXX\s+((?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)[^X]*?)\s*XXXXX/gi;
  const sections = [];
  let match;
  const matches = [];

  while ((match = dayPattern.exec(text)) !== null) {
    matches.push({ day: match[1].trim(), index: match.index });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(start, end).trim();
    if (content.length >= 100) {
      sections.push({ day: matches[i].day, content });
    }
  }

  return sections;
}

async function fetchNonsenseNYC() {
  console.log('Fetching Nonsense NYC...');
  try {
    // Fetch newsletter emails from Gmail (weekly, look back 8 days)
    const emails = await fetchEmails('from:jstark@nonsensenyc.com subject:nonsense newer_than:8d', 3);
    if (emails.length === 0) {
      console.log('NonsenseNYC: no newsletter emails found');
      return [];
    }

    const cached = loadCachedEvents();
    const latest = emails[0];

    // If the latest newsletter is already cached, return cached events
    if (cached && cached.id === latest.id) {
      console.log(`NonsenseNYC: returning ${cached.events.length} cached events from "${latest.subject}"`);
      return cached.events;
    }

    const newsletter = latest;

    console.log(`NonsenseNYC: processing "${newsletter.subject}" (${newsletter.date})`);
    const stripped = stripHtml(newsletter.body);

    // Split into day sections for manageable extraction calls
    const sections = splitByDay(stripped);
    if (sections.length === 0) {
      // Fallback: treat entire content as one section (cap at 10KB)
      console.log('NonsenseNYC: no day headers found, using full content');
      const content = stripped.slice(0, 10000);
      captureExtractionInput('nonsensenyc', content, 'https://nonsensenyc.com/');
      const result = await extractEvents(content, 'nonsensenyc', 'https://nonsensenyc.com/');
      const events = (result.events || [])
        .map(e => normalizeExtractedEvent(e, 'nonsensenyc', 'curated', 0.9))
        .filter(e => e.name && e.completeness >= 0.5);

      saveCachedEvents(newsletter.id, events);
      console.log(`NonsenseNYC: ${events.length} events`);
      return events;
    }

    console.log(`NonsenseNYC: ${sections.length} day sections found`);
    const allEvents = [];

    // Process day sections in parallel (max 3 concurrent)
    const CONCURRENCY = 3;
    for (let i = 0; i < sections.length; i += CONCURRENCY) {
      const batch = sections.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async ({ day, content }) => {
          console.log(`NonsenseNYC: extracting ${day} (${content.length} chars)`);
          captureExtractionInput('nonsensenyc', content, 'https://nonsensenyc.com/');
          const result = await extractEvents(content, 'nonsensenyc', 'https://nonsensenyc.com/');
          return (result.events || [])
            .map(e => normalizeExtractedEvent(e, 'nonsensenyc', 'curated', 0.9))
            .filter(e => e.name && e.completeness >= 0.5);
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allEvents.push(...r.value);
        } else {
          console.warn('NonsenseNYC: extraction failed for day section:', r.reason?.message);
        }
      }
    }

    saveCachedEvents(newsletter.id, allEvents);
    console.log(`NonsenseNYC: ${allEvents.length} events from ${sections.length} day sections`);
    return allEvents;
  } catch (err) {
    console.error('Nonsense NYC error:', err.message);
    return [];
  }
}

module.exports = { fetchNonsenseNYC, splitByDay };
