const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString } = require('../geo');

const GENRE_MAP = {
  'film': 'film',
  'theater': 'theater',
  'theatre': 'theater',
  'dance': 'theater',
  'music': 'live_music',
  'opera': 'theater',
  'visual art': 'art',
  'talk': 'other',
};

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&(#?\w+);/g, (match, entity) => {
      const map = { rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C', eacute: '\u00E9', ndash: '\u2013', mdash: '\u2014', nbsp: ' ', amp: '&', lt: '<', gt: '>' };
      if (entity.startsWith('#')) return String.fromCharCode(parseInt(entity.slice(1), 10));
      return map[entity] || match;
    });
}

function mapCategory(genre) {
  if (!genre) return 'other';
  const lower = genre.toLowerCase();
  for (const [key, cat] of Object.entries(GENRE_MAP)) {
    if (lower.includes(key)) return cat;
  }
  return 'other';
}

async function fetchBAMEvents() {
  console.log('Fetching BAM...');
  try {
    const today = getNycDateString(0);
    const tomorrow = getNycDateString(1);
    const url = `https://www.bam.org/api/BAMApi/GetCalendarEventsByDayWithOnGoing?start=${today}&end=${tomorrow}`;

    const res = await fetch(url, {
      headers: { ...FETCH_HEADERS, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`BAM fetch failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      console.error('BAM: unexpected response format');
      return [];
    }

    const events = [];
    const seen = new Set();

    for (const item of data) {
      const name = (item.name || '').trim();
      if (!name) continue;

      const dateLocal = item.day || today;
      const category = mapCategory(item.genres);

      // Use first performance time as start_time_local
      const startTime = item.performances?.[0] || null;
      const description = decodeEntities((item.desc || '').trim()).slice(0, 180) || null;
      const ticketUrl = item.buyLink || null;
      const moreLink = item.moreLink ? `https://www.bam.org${item.moreLink}` : null;

      const id = makeEventId(name, 'BAM', dateLocal, 'bam');
      if (seen.has(id)) continue;
      seen.add(id);

      events.push({
        id,
        source_name: 'bam',
        source_type: 'venue_calendar',
        source_weight: 0.8,
        name,
        description_short: description,
        short_detail: description,
        venue_name: 'BAM',
        venue_address: '30 Lafayette Ave, Brooklyn, NY',
        neighborhood: 'Fort Greene',
        start_time_local: startTime,
        end_time_local: null,
        date_local: dateLocal,
        time_window: null,
        is_free: false,
        price_display: null,
        category,
        subcategory: item.genres || null,
        confidence: 0.9,
        ticket_url: ticketUrl,
        source_url: moreLink || ticketUrl,
        map_url: null,
        map_hint: '30 Lafayette Ave, Brooklyn',
      });
    }

    console.log(`BAM: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('BAM error:', err.message);
    return [];
  }
}

module.exports = { fetchBAMEvents };
