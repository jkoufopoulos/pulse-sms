const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString, getNycUtcOffset } = require('../geo');
const { lookupVenue } = require('../venues');
const { resolveNeighborhood } = require('../geo');

const SOURCE_URL = 'https://nyctrivialeague.com/';

// Map day-of-week header text to JS day number (0=Sun, 1=Mon, ...)
const DAY_MAP = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 0,
};

// Skip entries with these patterns (case-insensitive)
const HIATUS_RE = /on\s+hiatus|coming\s+(to\s+)?\w+\s+(spring|summer|fall|winter|2026|2027)/i;

/**
 * Parse time string like "7pm", "6:30pm", "8:30pm" → "HH:MM"
 */
function parseTime(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] || '00';
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/**
 * Get the next 7 days as [{dateStr, dayOfWeek}]
 */
function getNextSevenDays() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dateStr = getNycDateString(i);
    const d = new Date(dateStr + 'T12:00:00');
    days.push({ dateStr, dayOfWeek: d.getDay() });
  }
  return days;
}

async function fetchNYCTriviaEvents() {
  console.log('Fetching NYC Trivia League...');
  try {
    const res = await fetch(SOURCE_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`NYC Trivia League fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Parse venue listings grouped by day-of-week headers
    const listings = [];
    let currentDay = null;

    const $content = $('#entry-content-anchor');
    $content.children('h3, p').each((_, el) => {
      const $el = $(el);

      // Day header: <h3>...<a>Trivia Mondays</a>...</h3>
      if (el.tagName === 'h3') {
        const headerText = $el.text().toLowerCase();
        for (const [dayName, dayNum] of Object.entries(DAY_MAP)) {
          if (headerText.includes(dayName)) {
            currentDay = dayNum;
            break;
          }
        }
        return;
      }

      // Venue listing: <p> tag under a day header
      if (el.tagName === 'p' && currentDay !== null) {
        const fullText = $el.text();

        // Skip hiatus/coming-soon entries
        if (HIATUS_RE.test(fullText)) return;

        // Detect Mixtape Bingo
        const isMixtape = /mixtape bingo/i.test(fullText);

        // Find venue anchor — for Mixtape Bingo, skip the first "Mixtape Bingo!" link
        const anchors = $el.find('a').toArray();
        let venueAnchor = null;
        let venueUrl = null;

        for (const a of anchors) {
          const href = $(a).attr('href') || '';
          const text = $(a).text().trim();
          // Skip the "Mixtape Bingo!" category link and non-venue links
          if (/mixtape bingo/i.test(text)) continue;
          if (href.includes('/listing-category/')) continue;
          if (href.includes('/listing-type/')) continue;
          // Found the venue link
          venueAnchor = a;
          venueUrl = href;
          break;
        }

        if (!venueAnchor) return;

        const venueName = $(venueAnchor).text().trim();
        if (!venueName) return;

        // Extract neighborhood and time from text after venue name
        // Format: "Venue Name</a>, Neighborhood, Time" or "Venue Name</a>, Time, Neighborhood"
        // Strip the venue link text + any Mixtape Bingo prefix to get ", Neighborhood, Time"
        let afterVenue = '';
        const venueIdx = fullText.indexOf(venueName);
        if (venueIdx >= 0) {
          afterVenue = fullText.slice(venueIdx + venueName.length);
        }

        // Clean: remove notes in ** markers and excess whitespace
        afterVenue = afterVenue
          .replace(/\*\*[^*]*\*\*/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        // Remove leading punctuation (comma, em-dash, etc.)
        afterVenue = afterVenue.replace(/^[,—–\-\s]+/, '').trim();

        // Parse "Neighborhood, Time" or "Time, Neighborhood"
        // Time patterns: "7pm", "6:30pm", "8pm start", etc.
        const timeMatch = afterVenue.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
        const time = timeMatch ? timeMatch[1] : null;

        // Neighborhood is whatever remains after removing the time part
        let neighborhood = afterVenue;
        if (time) {
          neighborhood = neighborhood.replace(time, '');
        }
        neighborhood = neighborhood
          .replace(/\bstart\b/i, '')
          .replace(/[,—–\-\s]+$/g, '')
          .replace(/^[,—–\-\s]+/g, '')
          .trim();

        if (!neighborhood || !time) return;

        listings.push({
          venueName,
          venueUrl,
          neighborhood,
          time,
          dayOfWeek: currentDay,
          isMixtape,
        });
      }
    });

    // Generate dated events for the next 7 days
    const days = getNextSevenDays();
    const events = [];
    const seen = new Set();
    const offset = getNycUtcOffset();

    for (const listing of listings) {
      // Find matching day(s) in the next 7 days
      for (const { dateStr, dayOfWeek } of days) {
        if (dayOfWeek !== listing.dayOfWeek) continue;

        const hhmm = parseTime(listing.time);
        const startTime = hhmm ? `${dateStr}T${hhmm}:00` : null;

        const name = listing.isMixtape
          ? `Mixtape Bingo at ${listing.venueName}`
          : `NYC Trivia League at ${listing.venueName}`;

        const id = makeEventId(name, listing.venueName, dateStr, 'nyctrivia', null, startTime);
        if (seen.has(id)) continue;
        seen.add(id);

        // Resolve neighborhood via venue lookup, fall back to page text
        const venue = lookupVenue(listing.venueName);
        const resolvedHood = venue
          ? resolveNeighborhood(listing.neighborhood, venue.lat, venue.lng)
          : listing.neighborhood;

        events.push({
          id,
          source_name: 'nyctrivia',
          source_type: 'aggregator',
          name,
          description_short: listing.isMixtape
            ? `Music bingo night at ${listing.venueName}`
            : `Bar trivia at ${listing.venueName}`,
          short_detail: `NYC Trivia League — ${listing.time}`,
          venue_name: listing.venueName,
          venue_address: null,
          neighborhood: resolvedHood,
          start_time_local: startTime,
          end_time_local: null,
          date_local: dateStr,
          time_window: null,
          is_free: true,
          price_display: 'Free to play',
          category: 'trivia',
          subcategory: listing.isMixtape ? 'mixtape_bingo' : null,
          ticket_url: null,
          source_url: listing.venueUrl || SOURCE_URL,
          map_url: null,
          map_hint: listing.venueName,
          _raw: {
            is_recurring: true,
            recurrence_day: listing.dayOfWeek,
            recurrence_time: hhmm,
          },
        });
      }
    }

    console.log(`NYC Trivia League: ${events.length} events (from ${listings.length} weekly listings)`);

    // Feed recurrence patterns into SQLite
    try {
      const { processRecurrencePatterns } = require('../db');
      processRecurrencePatterns(events, 'nyctrivia');
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') {
        console.warn('NYC Trivia League: failed to process recurrence patterns:', err.message);
      }
    }

    return events;
  } catch (err) {
    console.error('NYC Trivia League error:', err.message);
    return [];
  }
}

module.exports = { fetchNYCTriviaEvents };
