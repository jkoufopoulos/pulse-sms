const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString, resolveNeighborhood, inferCategory } = require('../geo');
const { lookupVenue, learnVenueCoords } = require('../venues');

const CATEGORIES = [
  { slug: 'music', categoryOverride: null },              // infer from name (live_music vs nightlife)
  { slug: 'comedy', categoryOverride: 'comedy' },
  { slug: 'theatre-art-design', categoryOverride: null },  // mix of theater + art — infer per card
];

const MAX_PAGES = 3;
const PAGE_DELAY_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseCards($, cards, dateStr, categoryOverride) {
  const parsed = [];
  cards.each((i, el) => {
    const card = $(el);

    const name = card.find('.ds-listing-event-title-text').text().trim();
    if (!name) return;

    const eventPath = card.find('a[itemprop="url"]').attr('href');
    const sourceUrl = eventPath ? `https://donyc.com${eventPath}` : null;

    // Venue
    const venueName = card.find('.ds-venue-name [itemprop="name"]').text().trim() || null;
    const venueAddress = card.find('meta[itemprop="streetAddress"]').attr('content') || null;

    // Geo — DoNYC has Schema.org GeoCoordinates for some venues
    let lat = parseFloat(card.find('meta[itemprop="latitude"]').attr('content'));
    let lng = parseFloat(card.find('meta[itemprop="longitude"]').attr('content'));

    if (venueName && !isNaN(lat) && !isNaN(lng)) {
      learnVenueCoords(venueName, lat, lng);
    }

    // Fall back to venue map if no coords on page
    if ((isNaN(lat) || isNaN(lng)) && venueName) {
      const coords = lookupVenue(venueName);
      if (coords) { lat = coords.lat; lng = coords.lng; }
    }

    const neighborhood = (!isNaN(lat) && !isNaN(lng))
      ? resolveNeighborhood(null, lat, lng)
      : resolveNeighborhood(
          card.find('meta[itemprop="addressLocality"]').attr('content') || null,
          null, null
        );

    // Time — prefer actual startDate over page date (DoNYC sometimes lists
    // next-day events on the prior day's page)
    const startDate = card.find('meta[itemprop="startDate"]').attr('content') || null;
    let dateLocal = dateStr;
    if (startDate) {
      const m = startDate.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) dateLocal = m[1];
    }

    // Free detection
    const cardText = card.text();
    const isFree = /\bfree\b/i.test(cardText);

    // Category — use card CSS class, then infer from name
    let category = categoryOverride;
    if (!category) {
      const catClass = (card.attr('class') || '').match(/ds-event-category-(\S+)/);
      const cardCat = catClass ? catClass[1] : '';
      if (cardCat === 'dj-parties') {
        category = 'nightlife';
      } else if (cardCat === 'performing-arts' || cardCat === 'theatre-performing-arts') {
        category = 'theater';
      } else if (cardCat === 'art') {
        category = 'art';
      } else {
        category = inferCategory(name.toLowerCase());
      }
    }

    parsed.push({
      id: makeEventId(name, venueName, dateLocal, 'donyc'),
      source_name: 'donyc',
      source_type: 'aggregator',
      source_weight: 0.75,
      name,
      description_short: null,
      short_detail: null,
      venue_name: venueName || 'TBA',
      venue_address: venueAddress || null,
      neighborhood,
      start_time_local: startDate || null,
      end_time_local: null,
      date_local: dateLocal,
      time_window: null,
      is_free: isFree,
      price_display: isFree ? 'free' : null,
      category,
      subcategory: null,
      ticket_url: sourceUrl,
      source_url: sourceUrl,
      map_url: null,
      map_hint: venueAddress || null,
    });
  });
  return parsed;
}

async function fetchCategoryDates(slug, categoryOverride, dates) {
  const events = [];
  for (const dateStr of dates) {
    const [yyyy, mm, dd] = dateStr.split('-');
    const month = String(parseInt(mm, 10));
    const day = String(parseInt(dd, 10));

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://donyc.com/events/${slug}/${yyyy}/${month}/${day}?page=${page}`;

      let res;
      try {
        res = await fetch(url, {
          headers: FETCH_HEADERS,
          signal: AbortSignal.timeout(10000),
        });
      } catch (err) {
        console.error(`DoNYC fetch error ${slug} ${dateStr} p${page}:`, err.message);
        break;
      }

      if (!res.ok) {
        console.error(`DoNYC ${slug} ${dateStr} p${page}: ${res.status}`);
        break;
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      const cards = $('.ds-listing.event-card');

      if (cards.length === 0) break;

      events.push(...parseCards($, cards, dateStr, categoryOverride));

      if (page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
    }
  }
  return events;
}

async function fetchDoNYCEvents() {
  console.log('Fetching DoNYC...');
  try {
    const dates = [getNycDateString(0), getNycDateString(1)];
    const seen = new Set();

    const results = await Promise.allSettled(
      CATEGORIES.map(({ slug, categoryOverride }) =>
        fetchCategoryDates(slug, categoryOverride, dates)
      )
    );

    const events = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        console.error('DoNYC category fetch failed:', result.reason?.message);
        continue;
      }
      for (const evt of result.value) {
        if (seen.has(evt.id)) continue;
        seen.add(evt.id);
        events.push(evt);
      }
    }

    console.log(`DoNYC: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('DoNYC error:', err.message);
    return [];
  }
}

module.exports = { fetchDoNYCEvents };
