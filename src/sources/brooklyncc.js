const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');

async function fetchBrooklynCCEvents() {
  console.log('Fetching Brooklyn Comedy Collective...');
  try {
    const res = await fetch('https://www.brooklyncc.com/show-schedule', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`BCC fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract just the event list text (page is 1MB+, need to trim)
    const paragraphs = [];
    paragraphs.push('Venue: Brooklyn Comedy Collective, 167 Graham Ave, Brooklyn, NY 11206 (East Williamsburg). All events are comedy (stand-up, improv, sketch, variety).');
    $('.eventlist-event').each((_, el) => {
      const $e = $(el);
      const title = $e.find('.eventlist-title-link').text().trim();
      const date = $e.find('.eventlist-meta-item').first().text().trim();
      const time = $e.find('.event-time-24hr').first().text().trim() || $e.find('.event-time-localized').first().text().trim();
      const link = $e.find('a[href*="eventbrite"]').first().attr('href') ||
                   $e.find('.eventlist-title-link').attr('href');
      const url = link ? (link.startsWith('http') ? link : `https://www.brooklyncc.com${link}`) : null;
      if (!title) return;
      const line = [title, date, time].filter(Boolean).join(' | ');
      paragraphs.push(url ? `${line} [Source: ${url}]` : line);
    });

    if (paragraphs.length <= 1) {
      console.log('BCC: no events found on page');
      return [];
    }

    // Chunk — BCC lists 200+ shows
    const MAX_PARAGRAPHS = 25;
    const allEvents = [];
    const CONCURRENCY = 3;

    const chunks = [];
    for (let i = 0; i < paragraphs.length; i += MAX_PARAGRAPHS) {
      chunks.push(paragraphs.slice(i, i + MAX_PARAGRAPHS).join('\n\n'));
    }

    console.log(`BCC: ${paragraphs.length - 1} shows → ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (chunk, j) => {
          const cacheKey = `brooklyncc:chunk${i + j}`;
          const cached = getCachedExtraction(cacheKey, chunk);
          if (cached) return cached;

          captureExtractionInput('brooklyncc', chunk, 'https://www.brooklyncc.com/show-schedule');
          const result = await extractEvents(chunk, 'brooklyncc', 'https://www.brooklyncc.com/show-schedule');
          const events = (result.events || [])
            .map(e => normalizeExtractedEvent(e, 'brooklyncc', 'venue_calendar', 0.9))
            .filter(e => e.name && e.completeness >= 0.5);

          setCachedExtraction(cacheKey, chunk, events);
          return events;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') allEvents.push(...r.value);
        else console.warn('BCC chunk failed:', r.reason?.message);
      }
    }

    console.log(`BCC: ${allEvents.length} events (LLM)`);
    return allEvents;
  } catch (err) {
    console.error('Brooklyn Comedy Collective error:', err.message);
    return [];
  }
}

module.exports = { fetchBrooklynCCEvents };
