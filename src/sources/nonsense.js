const fs = require('fs');
const path = require('path');
const { fetchEmails } = require('../gmail');
const { backfillEvidence, stripHtml, extractEmailEvents } = require('./shared');

const NONSENSE_DIR = path.join(__dirname, '../../data/nonsense');
const CACHE_FILE = path.join(NONSENSE_DIR, 'cached-events.json');

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

async function fetchNonsenseNYC() {
  console.log('Fetching Nonsense NYC...');
  try {
    const emails = await fetchEmails('from:jstark@nonsensenyc.com subject:nonsense newer_than:8d', 3);
    const cached = loadCachedEvents();

    if (emails.length === 0) {
      if (cached && cached.events.length > 0) {
        console.log(`NonsenseNYC: no emails found, returning ${cached.events.length} cached events`);
        return cached.events;
      }
      console.log('NonsenseNYC: no newsletter emails found and no cache available');
      return [];
    }

    const latest = emails[0];

    if (cached && cached.id === latest.id && cached.events.length > 0) {
      console.log(`NonsenseNYC: returning ${cached.events.length} cached events from "${latest.subject}"`);
      return cached.events;
    }

    console.log(`NonsenseNYC: processing "${latest.subject}" (${latest.date})`);
    const stripped = stripHtml(latest.body);

    const events = await extractEmailEvents({
      text: stripped,
      sourceName: 'nonsensenyc',
      sourceType: 'curated',
      sourceWeight: 0.9,
      sourceUrl: 'https://nonsensenyc.com/',
      label: 'nonsensenyc',
    });

    saveCachedEvents(latest.id, events);
    console.log(`NonsenseNYC: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Nonsense NYC error:', err.message);
    const cached = loadCachedEvents();
    if (cached && cached.events.length > 0) {
      console.log(`NonsenseNYC: error recovery, returning ${cached.events.length} cached events`);
      return cached.events;
    }
    return [];
  }
}

module.exports = { fetchNonsenseNYC };
