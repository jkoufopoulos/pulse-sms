const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { extractEvents } = require('../ai');
const { normalizeExtractedEvent, FETCH_HEADERS } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');

const CACHE_DIR = path.join(__dirname, '../../data/bkmag');
const CACHE_FILE = path.join(CACHE_DIR, 'cached-events.json');
const RSS_URL = 'https://www.bkmag.com/feed/';
const GUIDE_SLUG = 'what-to-do-in-brooklyn-this-weekend';

function loadCachedEvents() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('BKMag: failed to load cache:', err.message);
  }
  return null;
}

function saveCachedEvents(url, events) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ url, events }, null, 2));
  } catch (err) {
    console.warn('BKMag: failed to save cache:', err.message);
  }
}

async function fetchBKMagEvents() {
  console.log('Fetching BK Mag Weekend Guide...');
  try {
    // 1. Find latest weekend guide URL from RSS
    const rssRes = await fetch(RSS_URL, {
      headers: { ...FETCH_HEADERS, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(10000),
    });
    if (!rssRes.ok) {
      console.error(`BKMag: RSS fetch failed (${rssRes.status})`);
      const cached = loadCachedEvents();
      return cached?.events || [];
    }

    const rssXml = await rssRes.text();
    const $rss = cheerio.load(rssXml, { xmlMode: true });

    let guideUrl = null;
    $rss('item').each((_, item) => {
      if (guideUrl) return;
      const link = $rss(item).find('link').text().trim();
      if (link.includes(GUIDE_SLUG)) {
        guideUrl = link;
      }
    });

    if (!guideUrl) {
      console.log('BKMag: no weekend guide found in RSS feed');
      const cached = loadCachedEvents();
      return cached?.events || [];
    }

    // 2. Check cache — same URL means same guide
    const cached = loadCachedEvents();
    if (cached && cached.url === guideUrl) {
      console.log(`BKMag: returning ${cached.events.length} cached events`);
      return cached.events;
    }

    // 3. Fetch the guide page
    console.log(`BKMag: fetching ${guideUrl}`);
    const pageRes = await fetch(guideUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!pageRes.ok) {
      console.error(`BKMag: page fetch failed (${pageRes.status})`);
      return cached?.events || [];
    }

    const html = await pageRes.text();
    const $ = cheerio.load(html);

    // 4. Extract article content text with links preserved
    const $content = $('.main-content-wrap, .entry-content, .post-content').first();
    if (!$content.length) {
      console.log('BKMag: no article content container found');
      return cached?.events || [];
    }

    const paragraphs = [];
    $content.children().each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if (!text || text.length < 10) return;

      // Preserve event links
      const links = [];
      $el.find('a').each((_, a) => {
        const href = $(a).attr('href');
        if (href && !href.includes('bkmag.com')) links.push(href);
      });

      if (links.length > 0) {
        paragraphs.push(`${text} [Source: ${links[0]}]`);
      } else {
        paragraphs.push(text);
      }
    });

    if (paragraphs.length === 0) {
      console.log('BKMag: no content extracted');
      return cached?.events || [];
    }

    // 5. Send to LLM in chunks
    const MAX_PARAGRAPHS = 15;
    const chunks = [];
    for (let i = 0; i < paragraphs.length; i += MAX_PARAGRAPHS) {
      chunks.push(paragraphs.slice(i, i + MAX_PARAGRAPHS).join('\n\n'));
    }

    console.log(`BKMag: ${paragraphs.length} paragraphs → ${chunks.length} chunks`);

    const allEvents = [];
    const CONCURRENCY = 3;

    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (content, j) => {
          const chunkLabel = `bkmag:chunk${i + j}`;
          const cachedChunk = getCachedExtraction(chunkLabel, content);
          if (cachedChunk) return cachedChunk;

          captureExtractionInput('bkmag', content, guideUrl);
          const result = await extractEvents(content, 'bkmag', guideUrl);
          const events = (result.events || [])
            .map(e => normalizeExtractedEvent(e, 'bkmag', 'curated', 0.9))
            .filter(e => e.name && e.completeness >= 0.5);

          setCachedExtraction(chunkLabel, content, events);
          return events;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') allEvents.push(...r.value);
        else console.warn('BKMag: chunk extraction failed:', r.reason?.message);
      }
    }

    saveCachedEvents(guideUrl, allEvents);
    console.log(`BKMag: ${allEvents.length} events from weekend guide (LLM)`);
    return allEvents;
  } catch (err) {
    console.error('BKMag error:', err.message);
    const cached = loadCachedEvents();
    if (cached?.events?.length) {
      console.log(`BKMag: error recovery, returning ${cached.events.length} cached events`);
      return cached.events;
    }
    return [];
  }
}

module.exports = { fetchBKMagEvents };
