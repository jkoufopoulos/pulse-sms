const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');

const VENUE_URL = 'https://donyc.com/venues/sofar-sounds-secret-location';

/**
 * Extract neighborhood from Sofar event name.
 * "Sofar Sounds - Meatpacking District" → "Meatpacking District"
 */
function extractNeighborhood(name) {
  const m = name.match(/^Sofar Sounds\s*[-–—]\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

async function fetchSofarSoundsEvents() {
  console.log('Fetching Sofar Sounds...');
  try {
    // Fetch up to 3 pages from DoNYC venue page
    const paragraphs = ['Sofar Sounds secret concerts in NYC. Venues are revealed day-of.'];

    for (let page = 1; page <= 3; page++) {
      const url = page === 1 ? VENUE_URL : `${VENUE_URL}?page=${page}`;
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) break;

      const html = await res.text();
      const $ = cheerio.load(html);
      const cards = $('.ds-listing.event-card');

      if (cards.length === 0) break;

      cards.each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const link = $(el).find('a[itemprop="url"]').attr('href');
        const sourceUrl = link ? `https://donyc.com${link}` : null;
        if (text && text.length > 10) {
          paragraphs.push(sourceUrl ? `${text} [Source: ${sourceUrl}]` : text);
        }
      });

      const hasNext = $('a[href*="page="]').filter((_, a) =>
        /next\s*page/i.test($(a).text())
      ).length > 0;
      if (!hasNext) break;
    }

    if (paragraphs.length <= 1) {
      console.log('SofarSounds: no events found');
      return [];
    }

    const content = paragraphs.join('\n\n');
    captureExtractionInput('sofarsounds', content, VENUE_URL);

    const cached = getCachedExtraction('sofarsounds', content);
    if (cached) {
      console.log(`SofarSounds: ${cached.length} events (cached)`);
      return cached;
    }

    const result = await extractEvents(content, 'SofarSounds', VENUE_URL);
    const events = (result.events || [])
      .map(e => normalizeExtractedEvent(e, 'SofarSounds', 'venue', 0.9))
      .filter(e => e.name && e.completeness >= 0.5);

    setCachedExtraction('sofarsounds', content, events);
    console.log(`SofarSounds: ${events.length} events (LLM)`);
    return events;
  } catch (err) {
    console.error('SofarSounds error:', err.message);
    return [];
  }
}

module.exports = { fetchSofarSoundsEvents, extractNeighborhood };
