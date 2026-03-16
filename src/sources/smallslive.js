const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { getNycDateString } = require('../geo');
const { captureExtractionInput } = require('../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');

async function fetchSmallsLiveEvents() {
  console.log('Fetching SmallsLIVE...');
  try {
    const today = getNycDateString(0);
    const url = `https://www.smallslive.com/search/upcoming-ajax/?page=1&venue=all&starting_date=${today}`;

    const res = await fetch(url, {
      headers: { ...FETCH_HEADERS, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`SmallsLIVE fetch failed: ${res.status}`);
      return [];
    }

    const json = await res.json();
    const html = json.template;
    if (!html) {
      console.error('SmallsLIVE: no template in response');
      return [];
    }

    // Extract text from HTML template (79KB raw — need to trim)
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    const preamble = 'SmallsLIVE upcoming jazz events. Venues: Smalls Jazz Club (183 W 10th St, West Village) and Mezzrow (163 W 10th St, West Village). All events are live jazz.';
    const paragraphs = [preamble];

    $('.flex-column.day-list').each((_, dayGroup) => {
      const dateHeader = $(dayGroup).find('.title1[data-date]').attr('data-date') || '';
      paragraphs.push(`\n--- ${dateHeader} ---`);
      $(dayGroup).find('.flex-column.day-event').each((_, evt) => {
        const name = $(evt).find('.day_event_title').text().trim();
        const venue = $(evt).find('div:first-child').text().trim();
        const time = $(evt).find('.text-grey').text().trim();
        const href = $(evt).find('a').attr('href');
        const url = href ? `https://www.smallslive.com${href}` : null;
        if (!name) return;
        const line = [name, venue, time].filter(Boolean).join(' | ');
        paragraphs.push(url ? `${line} [Source: ${url}]` : line);
      });
    });

    if (paragraphs.length <= 1) {
      console.log('SmallsLIVE: no events in template');
      return [];
    }

    // Chunk by 20 events
    const MAX_PARAGRAPHS = 20;
    const allEvents = [];

    for (let i = 0; i < paragraphs.length; i += MAX_PARAGRAPHS) {
      const chunk = paragraphs.slice(i, i + MAX_PARAGRAPHS).join('\n');
      const cacheKey = `smallslive:chunk${Math.floor(i / MAX_PARAGRAPHS)}`;

      const cached = getCachedExtraction(cacheKey, chunk);
      if (cached) { allEvents.push(...cached); continue; }

      captureExtractionInput('smallslive', chunk, 'https://www.smallslive.com');
      const result = await extractEvents(chunk, 'smallslive', 'https://www.smallslive.com');
      const events = (result.events || [])
        .map(e => normalizeExtractedEvent(e, 'smallslive', 'venue_calendar', 0.9))
        .filter(e => e.name && e.completeness >= 0.5);

      setCachedExtraction(cacheKey, chunk, events);
      allEvents.push(...events);
    }

    console.log(`SmallsLIVE: ${allEvents.length} events (LLM)`);
    return allEvents;
  } catch (err) {
    console.error('SmallsLIVE error:', err.message);
    return [];
  }
}

module.exports = { fetchSmallsLiveEvents };
