const fs = require('fs');
const path = require('path');
const { fetchEmails } = require('../gmail');
const { backfillEvidence, stripHtml, extractEmailEvents } = require('./shared');

const SCREENSLATE_DIR = path.join(__dirname, '../../data/screenslate');
const CACHE_FILE = path.join(SCREENSLATE_DIR, 'cached-events.json');

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

    // Prepend the email date so the LLM knows what day these listings are for
    const emailDate = new Date(latest.date).toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const datedText = `--- SCREEN SLATE DAILY LISTINGS: ${emailDate} ---\n\n${stripped}`;

    const events = await extractEmailEvents({
      text: datedText,
      sourceName: 'ScreenSlate',
      sourceType: 'unstructured',
      sourceWeight: 0.9,
      sourceUrl: 'https://screenslate.com',
      label: 'screenslate',
      categoryOverride: 'film',
      linesPerChunk: 40,
      sourceHint: `This is Screen Slate, a curated NYC film and art guide. The date for all listings is ${emailDate}. Extract these types of events:\n1. FEATURED ARTICLE at the top — the editorial recommendation. Set editorial_signal=true, capture the editorial prose in editorial_note (max 150 chars).\n2. SPECIAL SCREENINGS — any screening with: Q&A, in-person appearance, premiere, sneak preview, 4K restoration, 35mm print, presented by, or retrospective series. These are worth attending specifically today.\n3. EXHIBITIONS — gallery/museum shows with closing dates.\n4. Skip standard repertory showtimes that have no special context.`,
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
