const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS, isInsideNYC } = require('./shared');
const { getNycDateString, resolveNeighborhood, inferCategory } = require('../geo');
const { lookupVenue, learnVenueCoords } = require('../venues');

// Venues DoNYC lists that are outside NYC — no coords to bbox-filter
const NON_NYC_VENUES = new Set([
  'the paramount',           // Huntington, Long Island
  'ubs arena',               // Elmont, Long Island
  'nassau coliseum',         // Uniondale, Long Island
  'tilles center for the performing arts', // Brookville, Long Island
  'paramount hudson valley theater', // Peekskill, NY
  'hard rock hotel & casino', // Atlantic City, NJ
  'ritz theatre',            // Elizabeth, NJ
  'flagstar at westbury music fair', // Westbury, Long Island
]);

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

    // Filter: outside NYC bounding box
    if (!isNaN(lat) && !isNaN(lng) && !isInsideNYC(lat, lng)) return;

    // Filter: known non-NYC venues (no coords to bbox-filter)
    if (venueName && NON_NYC_VENUES.has(venueName.toLowerCase().trim())) return;

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

    // Free + price detection
    const cardText = card.text();
    const isFree = /\bfree\b/i.test(cardText) || /\$0(?:\.00)?/.test(cardText);
    let priceDisplay = isFree ? 'free' : null;
    if (!isFree) {
      const rangeMatch = cardText.match(/\$(\d+(?:\.\d{2})?)\s*[-–]\s*\$?(\d+(?:\.\d{2})?)/);
      if (rangeMatch) {
        priceDisplay = `$${rangeMatch[1]}-$${rangeMatch[2]}`;
      } else {
        const priceMatch = cardText.match(/\$(\d+)/);
        if (priceMatch) priceDisplay = `$${priceMatch[1]}`;
      }
    }

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
      id: makeEventId(name, venueName, dateLocal, 'donyc', null, startDate),
      source_name: 'donyc',
      source_type: 'aggregator',
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
      price_display: priceDisplay,
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
  for (let di = 0; di < dates.length; di++) {
    const dateStr = dates[di];
    const [yyyy, mm, dd] = dateStr.split('-');
    const month = String(parseInt(mm, 10));
    const day = String(parseInt(dd, 10));
    // Limit future days (3+) to 1 page to control fetch count
    const maxPages = di < 2 ? MAX_PAGES : 1;

    for (let page = 1; page <= maxPages; page++) {
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

const PRICE_BATCH_SIZE = 10;

function extractPriceFromDetailPage(html) {
  const $ = cheerio.load(html);
  // 1. Schema.org itemprop="price"
  const schemaPrice = $('[itemprop="price"]').attr('content') || $('[itemprop="price"]').text().trim();
  if (schemaPrice) {
    const m = schemaPrice.match(/\$(\d+(?:\.\d{2})?)/);
    if (m) return `$${m[1]}`;
  }
  // 2. Dollar amount in event detail area
  const detailText = $('.ds-event-detail, .ds-event-description, .ds-event-details').text();
  if (/\bfree\b/i.test(detailText)) return 'free';
  const rangeMatch = detailText.match(/\$(\d+(?:\.\d{2})?)\s*[-–]\s*\$?(\d+(?:\.\d{2})?)/);
  if (rangeMatch) return `$${rangeMatch[1]}-$${rangeMatch[2]}`;
  const match = detailText.match(/\$(\d+(?:\.\d{2})?)/);
  if (match) return `$${match[1]}`;
  return null;
}

async function enrichPrices(events) {
  const needsPrice = events.filter(e => !e.price_display && !e.is_free && e.source_url);
  if (needsPrice.length === 0) return;

  let enriched = 0;
  for (let i = 0; i < needsPrice.length; i += PRICE_BATCH_SIZE) {
    const batch = needsPrice.slice(i, i + PRICE_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async evt => {
      const res = await fetch(evt.source_url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      return { evt, html: await res.text() };
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { evt, html } = r.value;
      const price = extractPriceFromDetailPage(html);
      if (price) {
        evt.price_display = price;
        if (price === 'free') evt.is_free = true;
        enriched++;
      }
    }
  }
  if (enriched > 0) console.log(`DoNYC: enriched ${enriched}/${needsPrice.length} events with price from detail pages`);
}

async function fetchDoNYCEvents() {
  console.log('Fetching DoNYC...');
  try {
    const dates = Array.from({length: 7}, (_, i) => getNycDateString(i));
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

    // Enrich prices from detail pages for events missing price
    await enrichPrices(events);

    console.log(`DoNYC: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('DoNYC error:', err.message);
    return [];
  }
}

module.exports = { fetchDoNYCEvents };
