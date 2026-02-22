const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');

/**
 * Get NYC day-of-week index (0=Sun...6=Sat) and a helper to resolve
 * a day name to its actual date relative to today.
 * Returns { todayDow, resolveDate(dayName) → "YYYY-MM-DD" or null }
 */
function getNycDayContext() {
  const now = new Date();
  const nycStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, d, y] = nycStr.split('/').map(Number);
  const todayDow = new Date(y, m - 1, d).getDay();

  function resolveDate(dayName) {
    const dayIndex = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
      .indexOf(dayName.toLowerCase());
    if (dayIndex === -1) return null;
    // How many days from today? Negative = past, 0 = today, positive = future
    let delta = dayIndex - todayDow;
    if (delta < -3) delta += 7; // more than 3 days ago wraps to next week
    const target = new Date(y, m - 1, d + delta);
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const dd = String(target.getDate()).padStart(2, '0');
    return `${target.getFullYear()}-${mm}-${dd}`;
  }

  function formatDate(isoDate) {
    const [yr, mo, dy] = isoDate.split('-').map(Number);
    return new Date(yr, mo - 1, dy)
      .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      .toUpperCase();
  }

  const todayIso = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return { todayDow, todayIso, resolveDate, formatDate };
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

    const { todayIso, resolveDate, formatDate } = getNycDayContext();

    // Day header pattern — short paragraphs like "friday", "saturday", "ongoing"
    const dayHeaderPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|ongoing)$/i;
    const eventPattern = /^(mon|tue|wed|thu|fri|sat|sun|thru|today|tonight|daily|\d{1,2}\/\d{1,2})/i;

    const eventParagraphs = [];
    let currentDayDate = null; // ISO date for the current section
    let skipSection = false;   // true when section day has passed

    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text) return;

      // Handle day headers — resolve to date and skip past sections
      if (dayHeaderPattern.test(text)) {
        const dayName = text.toLowerCase();
        if (dayName === 'ongoing') {
          currentDayDate = null;
          skipSection = false;
          eventParagraphs.push(`\n--- ONGOING ---`);
        } else {
          currentDayDate = resolveDate(dayName);
          skipSection = currentDayDate && currentDayDate < todayIso;
          if (!skipSection) {
            const label = currentDayDate ? formatDate(currentDayDate) : text.toUpperCase();
            eventParagraphs.push(`\n--- ${label} ---`);
          }
        }
        return;
      }

      if (skipSection) return; // skip events from past-day sections
      if (text.length < 30) return;
      if (text.toLowerCase().startsWith('sponsored')) return;

      // "thru" events span multiple days — always include regardless of section
      if (eventPattern.test(text)) {
        eventParagraphs.push(text);
      }
    });

    // Prepend today's date for context
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    let content = `Published: ${today}\n\n` + eventParagraphs.slice(0, 30).join('\n\n');
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
