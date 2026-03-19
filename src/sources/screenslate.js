const fs = require('fs');
const path = require('path');
const { fetchEmails } = require('../gmail');
const { backfillEvidence, stripHtml, extractEmailEvents } = require('./shared');

const SCREENSLATE_DIR = path.join(__dirname, '../../data/screenslate');
const CACHE_FILE = path.join(SCREENSLATE_DIR, 'cached-events.json');

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

async function fetchScreenSlateEvents() {
  console.log('Fetching Screen Slate...');
  try {
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

    if (cached && cached.id === latest.id && cached.events.length > 0) {
      console.log(`ScreenSlate: returning ${cached.events.length} cached events from "${latest.subject}"`);
      return cached.events;
    }

    console.log(`ScreenSlate: processing "${latest.subject}" (${latest.date})`);
    const stripped = stripHtml(latest.body);

    const events = await extractEmailEvents({
      text: stripped,
      sourceName: 'ScreenSlate',
      sourceType: 'unstructured',
      sourceWeight: 0.9,
      sourceUrl: 'https://screenslate.com',
      label: 'screenslate',
      categoryOverride: 'film',
      sourceHint: 'This is Screen Slate, a curated NYC film guide. The newsletter has three sections: (1) a featured editorial article recommending a specific film — ALWAYS extract this as an event with editorial_signal=true and capture the editorial prose in editorial_note. (2) Daily film listings by venue — ONLY extract screenings that are special: Q&As, in-person appearances, premieres, sneak previews, restorations, or retrospective series. Skip standard repertory showtimes. (3) An exhibitions section — extract all current exhibitions with their closing dates.',
    });

    saveCachedEvents(latest.id, events);
    console.log(`ScreenSlate: ${events.length} events`);
    return events;
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

module.exports = { fetchScreenSlateEvents };
