const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');

async function fetchNonsenseNYC() {
  console.log('Fetching Nonsense NYC...');
  try {
    const res = await fetch('https://nonsensenyc.com/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Nonsense NYC fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const entry = $('.entry-content, .post-content, article').first();
    if (!entry.length) {
      console.warn('Nonsense NYC: content container not found');
      return [];
    }

    const paragraphs = [];
    entry.find('p, li').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length >= 30) {
        paragraphs.push(text);
      }
    });

    let content = paragraphs.slice(0, 15).join('\n\n');
    if (content.length < 50) {
      content = entry.text().trim().slice(0, 5000);
    }

    if (content.length < 50) {
      console.warn('Nonsense NYC content too short, skipping extraction');
      return [];
    }

    console.log(`Nonsense NYC content: ${content.length} chars (${paragraphs.length} paragraphs)`);

    const result = await extractEvents(content, 'nonsensenyc', 'https://nonsensenyc.com/');
    const events = (result.events || [])
      .filter(e => e.name && e.confidence >= 0.3)
      .map(e => normalizeExtractedEvent(e, 'nonsensenyc', 'curated', 0.9));

    console.log(`Nonsense NYC: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Nonsense NYC error:', err.message);
    return [];
  }
}

module.exports = { fetchNonsenseNYC };
