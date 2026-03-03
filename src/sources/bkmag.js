const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood } = require('../geo');
const { lookupVenue } = require('../venues');
const { getNycDateString } = require('../geo');

const CACHE_DIR = path.join(__dirname, '../../data/bkmag');
const CACHE_FILE = path.join(CACHE_DIR, 'cached-events.json');
const RSS_URL = 'https://www.bkmag.com/feed/';
const GUIDE_SLUG = 'what-to-do-in-brooklyn-this-weekend';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse "Thursday, February 26" + year → "2026-02-26"
 */
function parseDateHeader(text, year) {
  const m = text.match(/(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+(\w+)\s+(\d{1,2})/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (!month || !day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse "6:30 p.m." or "10 a.m." → "HH:MM". Returns null for "All day" or unparseable.
 */
function parseTime(raw) {
  if (/all\s*day/i.test(raw)) return null;
  const m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] || '00';
  const period = m[3].replace(/\./g, '').toLowerCase();
  if (period === 'pm' && h < 12) h += 12;
  if (period === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/**
 * Infer category from event name + description.
 */
function inferCategory(text) {
  const lower = text.toLowerCase();
  if (/\b(comedy|stand-?up|improv|open mic)\b/.test(lower)) return 'comedy';
  if (/\b(dj set|techno|house music|electronic|rave|dance party|club night)\b/.test(lower)) return 'nightlife';
  if (/\b(jazz|concert|live music|live band)\b/.test(lower)) return 'live_music';
  if (/\b(film|movie|screening|cinema)\b/.test(lower)) return 'film';
  if (/\b(art|exhibition|gallery|museum|opening reception)\b/.test(lower)) return 'art';
  if (/\b(food|brunch|dinner|tasting|cook|supper)\b/.test(lower)) return 'food_drink';
  if (/\b(trivia|bingo)\b/.test(lower)) return 'trivia';
  if (/\b(market|flea|vintage|shop|pop-?up)\b/.test(lower)) return 'market';
  if (/\b(book|reading|literary|poetry|author)\b/.test(lower)) return 'community';
  if (/\b(watch party|viewing)\b/.test(lower)) return 'community';
  if (/\b(fest|festival)\b/.test(lower)) return 'community';
  return 'community';
}

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

    // 2. Check cache — same URL means same guide, skip re-parse
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

    // Extract year from URL: /2026/02/26/...
    const yearMatch = guideUrl.match(/\/(\d{4})\//);
    const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());

    // 4. Parse events from article body
    // BK Mag uses .main-content-wrap; fall back to common WordPress selectors
    const $content = $('.main-content-wrap, .entry-content, .post-content').first();
    if (!$content.length) {
      console.log('BKMag: no article content container found');
      return cached?.events || [];
    }

    const events = [];
    const seen = new Set();
    const today = getNycDateString(0);
    const maxDate = getNycDateString(10);
    let currentDate = null;

    // Walk all direct children: h2 for dates, p for events
    $content.children().each((_, el) => {
      const $el = $(el);
      const tag = el.tagName?.toLowerCase();

      // Date headers in h2: "Thursday, February 26"
      if (tag === 'h2') {
        const parsed = parseDateHeader($el.text().trim(), year);
        if (parsed) currentDate = parsed;
        return;
      }

      if (!currentDate) return;
      if (currentDate < today || currentDate > maxDate) return;
      if (tag !== 'p') return;

      // Event entries have two HTML patterns:
      //   <strong><a href="url">Event @ Venue</a></strong>
      //   <a href="url"><strong>Event @ Venue</strong></a>
      // Sometimes with <span style="font-weight:400"> wrappers
      const hasStrongA = $el.find('strong a').length > 0;
      const hasAStrong = $el.find('a strong').length > 0;
      if (!hasStrongA && !hasAStrong) return;

      // Get the link element (could be parent or child of strong)
      let $link;
      if (hasStrongA) {
        $link = $el.find('strong a').first();
      } else {
        $link = $el.find('a:has(strong)').first();
      }
      if (!$link.length) return;

      const eventUrl = $link.attr('href') || null;
      // Get text from the strong element to avoid extra whitespace
      const rawName = ($el.find('strong').first().text() || $link.text()).trim();
      if (!rawName || rawName.length < 3) return;

      // Split "Event Name @ Venue"
      let eventName = rawName;
      let venueName = 'TBA';
      const atMatch = rawName.match(/^(.+?)\s+[@＠]\s+(.+)$/);
      if (atMatch) {
        eventName = atMatch[1].trim();
        venueName = atMatch[2].trim();
      }

      // Time extraction: <em> may wrap film titles (italic), not times.
      // Only use <em> text if it matches a time pattern; also check bare text after <br>.
      const TIME_RE = /\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|all\s*day/i;
      let timeStr = null;
      const $em = $el.find('em').first();
      if ($em.length && TIME_RE.test($em.text())) {
        timeStr = $em.text().trim();
      }
      if (!timeStr) {
        // Check bare text after <br> (time not in <em>)
        const rawHtml = $el.html() || '';
        const afterBr = rawHtml.split(/<br\s*\/?>/i).slice(1).join(' ');
        const bareText = afterBr.replace(/<[^>]*>/g, '').trim();
        if (TIME_RE.test(bareText)) {
          const tm = bareText.match(TIME_RE);
          if (tm) timeStr = tm[0].trim();
        }
      }
      if (!timeStr) {
        // Check next sibling paragraph for standalone time in <em>
        const $next = $el.next('p');
        if ($next.length) {
          const $nextEm = $next.find('em').first();
          if ($nextEm.length && TIME_RE.test($nextEm.text())) {
            timeStr = $nextEm.text().trim();
          }
        }
      }

      const hhmm = timeStr ? parseTime(timeStr) : null;
      const startTime = hhmm ? `${currentDate}T${hhmm}:00` : null;

      // Resolve neighborhood via venue lookup
      const venueCoords = lookupVenue(venueName);
      const neighborhood = venueCoords
        ? resolveNeighborhood(null, venueCoords.lat, venueCoords.lng)
        : null;

      const id = makeEventId(eventName, venueName, currentDate, 'bkmag', eventUrl, startTime);
      if (seen.has(id)) return;
      seen.add(id);

      // Description from the next non-event paragraph
      let description = null;
      let $sib = $el.next();
      while ($sib.length) {
        // Stop at next event or date header
        if ($sib.find('strong a, a strong').length || $sib.is('h2')) break;
        // Skip ad divs, images, short time-only paragraphs
        if ($sib.is('div, figure')) { $sib = $sib.next(); continue; }
        const text = $sib.text().trim();
        if (text.length > 20 && !/^\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?$/i.test(text)) {
          description = text.length > 200 ? text.slice(0, 197) + '...' : text;
          break;
        }
        $sib = $sib.next();
      }

      events.push({
        id,
        source_name: 'bkmag',
        source_type: 'curated',
        name: eventName,
        description_short: description,
        short_detail: description,
        venue_name: venueName,
        venue_address: null,
        neighborhood,
        date_local: currentDate,
        start_time_local: startTime,
        end_time_local: null,
        time_window: null,
        is_free: false,
        price_display: null,
        category: inferCategory(rawName + (description || '')),
        subcategory: null,
        ticket_url: eventUrl,
        source_url: guideUrl,
        map_url: null,
        map_hint: venueName !== 'TBA' ? venueName : null,
      });
    });

    saveCachedEvents(guideUrl, events);
    console.log(`BKMag: ${events.length} events from weekend guide`);
    return events;
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
