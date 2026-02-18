const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');

async function fetchOhMyRockness() {
  console.log('Fetching Oh My Rockness...');
  try {
    const res = await fetch('https://www.ohmyrockness.com/shows', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Oh My Rockness fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const paragraphs = [];
    $('article, .show, .event, .listing, .card').each((i, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length >= 20) {
        paragraphs.push(text);
      }
    });

    if (paragraphs.length === 0) {
      const main = $('main, .content, .shows, #content').first();
      if (main.length) {
        main.find('p, li, div').each((i, el) => {
          const text = $(el).text().trim().replace(/\s+/g, ' ');
          if (text && text.length >= 20 && text.length < 500) {
            paragraphs.push(text);
          }
        });
      }
    }

    let content = paragraphs.slice(0, 20).join('\n\n');
    if (content.length < 50) {
      content = $('body').text().trim().replace(/\s+/g, ' ').slice(0, 5000);
    }

    if (content.length < 50) {
      console.warn('Oh My Rockness content too short, skipping extraction');
      return [];
    }

    console.log(`Oh My Rockness content: ${content.length} chars (${paragraphs.length} listings)`);

    const result = await extractEvents(content, 'ohmyrockness', 'https://www.ohmyrockness.com/shows', { model: 'claude-haiku-4-5-20251001' });
    const events = (result.events || [])
      .filter(e => e.name && e.confidence >= 0.5)
      .map(e => normalizeExtractedEvent(e, 'ohmyrockness', 'curated', 0.85));

    console.log(`Oh My Rockness: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Oh My Rockness error:', err.message);
    return [];
  }
}

module.exports = { fetchOhMyRockness };
