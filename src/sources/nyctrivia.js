const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');

const SOURCE_URL = 'https://nyctrivialeague.com/';

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

    // Extract text from the main content area with day headers
    const paragraphs = [];
    paragraphs.push('NYC Trivia League weekly trivia listings. All events are recurring weekly and free to play.');

    const $content = $('#entry-content-anchor');
    $content.children('h3, p').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!text) return;

      // Preserve venue links
      const links = [];
      $(el).find('a').each((_, a) => {
        const href = $(a).attr('href');
        if (href && !href.includes('/listing-category/') && !href.includes('/listing-type/')) {
          links.push(href);
        }
      });

      if (links.length > 0) {
        paragraphs.push(`${text} [Source: ${links[0]}]`);
      } else {
        paragraphs.push(text);
      }
    });

    if (paragraphs.length <= 1) {
      console.log('NYC Trivia League: no content found');
      return [];
    }

    // Chunk if large (trivia pages can list 100+ venues)
    const MAX_PARAGRAPHS = 20;
    const allEvents = [];

    for (let i = 0; i < paragraphs.length; i += MAX_PARAGRAPHS) {
      const chunk = paragraphs.slice(i, i + MAX_PARAGRAPHS).join('\n\n');
      const cacheKey = `nyctrivia:chunk${Math.floor(i / MAX_PARAGRAPHS)}`;
      const cached = getCachedExtraction(cacheKey, chunk);
      if (cached) {
        allEvents.push(...cached);
        continue;
      }

      captureExtractionInput('nyctrivia', chunk, SOURCE_URL);
      const result = await extractEvents(chunk, 'nyctrivia', SOURCE_URL);
      const events = (result.events || [])
        .map(e => normalizeExtractedEvent(e, 'nyctrivia', 'aggregator', 0.9))
        .filter(e => e.name && e.completeness >= 0.4);

      setCachedExtraction(cacheKey, chunk, events);
      allEvents.push(...events);
    }

    console.log(`NYC Trivia League: ${allEvents.length} events (LLM)`);
    return allEvents;
  } catch (err) {
    console.error('NYC Trivia League error:', err.message);
    return [];
  }
}

module.exports = { fetchNYCTriviaEvents };
