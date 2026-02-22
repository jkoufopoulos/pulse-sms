const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');

/**
 * Resolve a day name to the next upcoming date (today or later) in ET.
 * Returns "FRIDAY, FEBRUARY 21, 2026" style string.
 */
function resolveUpcomingDate(dayName) {
  const dayIndex = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
    .indexOf(dayName.toLowerCase());
  if (dayIndex === -1) return null;

  const now = new Date();
  // Get current NYC date
  const nycStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, d, y] = nycStr.split('/').map(Number);
  const nycDate = new Date(y, m - 1, d);
  const todayDow = nycDate.getDay();

  let daysAhead = dayIndex - todayDow;
  if (daysAhead < 0) daysAhead += 7; // always look forward (or today if same day)

  const target = new Date(y, m - 1, d + daysAhead);
  return target.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase();
}

async function fetchSkintEvents() {
  console.log('Fetching The Skint...');
  try {
    const res = await fetch('https://theskint.com/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Skint fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const entry = $('.entry-content').first();
    if (!entry.length) {
      console.warn('Skint: .entry-content not found');
      return [];
    }

    // Day header pattern — short paragraphs like "friday", "saturday", "ongoing"
    const dayHeaderPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|ongoing)$/i;
    const eventPattern = /^(mon|tue|wed|thu|fri|sat|sun|thru|today|tonight|daily|\d{1,2}\/\d{1,2})/i;
    const eventParagraphs = [];
    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text) return;
      // Resolve day headers to explicit dates so Claude doesn't have to guess
      if (dayHeaderPattern.test(text)) {
        const dayName = text.toLowerCase();
        if (dayName === 'ongoing') {
          eventParagraphs.push(`\n--- ONGOING ---`);
        } else {
          const resolved = resolveUpcomingDate(dayName);
          eventParagraphs.push(`\n--- ${resolved || text.toUpperCase()} ---`);
        }
        return;
      }
      if (text.length < 30) return;
      if (text.toLowerCase().startsWith('sponsored')) return;
      if (eventPattern.test(text)) {
        eventParagraphs.push(text);
      }
    });

    // Prepend today's date for context
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    let content = `Published: ${today}\n\n` + eventParagraphs.slice(0, 20).join('\n\n');
    if (content.length < 50) {
      content = entry.text().trim().slice(0, 5000);
    }

    if (content.length < 50) {
      console.warn('Skint content too short, skipping extraction');
      return [];
    }

    console.log(`Skint content: ${content.length} chars (${eventParagraphs.length} event paragraphs)`);
    captureExtractionInput('theskint', content, 'https://theskint.com/');

    const result = await extractEvents(content, 'theskint', 'https://theskint.com/');
    const events = (result.events || [])
      .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9))
      .filter(e => e.name && e.completeness >= 0.5);

    console.log(`Skint: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Skint error:', err.message);
    return [];
  }
}

module.exports = { fetchSkintEvents };
