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
  { slug: 'film-screenings', categoryOverride: 'film' },
  { slug: 'lgbtq', categoryOverride: null },              // mix of nightlife, community, drag — infer per card
];

const MAX_PAGES = 3;
const PAGE_DELAY_MS = 200;
const SCRAPE_BUDGET_MS = 45000; // bail out before the 60s global timeout

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
      if (cardCat === 'dj-parties' || cardCat === 'dance-parties' || cardCat === 'club-nights') {
        category = 'nightlife';
      } else if (cardCat === 'performing-arts' || cardCat === 'theatre-performing-arts' || cardCat === 'theater' || cardCat === 'theatre') {
        category = 'theater';
      } else if (cardCat === 'art' || cardCat === 'art-design' || cardCat === 'design') {
        category = 'art';
      } else if (cardCat === 'film' || cardCat === 'film-screenings' || cardCat === 'screenings') {
        category = 'film';
      } else if (cardCat === 'comedy' || cardCat === 'stand-up') {
        category = 'comedy';
      } else if (cardCat === 'music' || cardCat === 'concerts' || cardCat === 'live-music') {
        category = 'live_music';
      } else if (cardCat === 'food-drink' || cardCat === 'food' || cardCat === 'nightlife') {
        category = cardCat === 'nightlife' ? 'nightlife' : 'food_drink';
      } else if (cardCat === 'community' || cardCat === 'talks-lectures' || cardCat === 'workshops') {
        category = 'community';
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

async function fetchCategoryDates(slug, categoryOverride, dates, startTime) {
  const events = [];
  for (let di = 0; di < dates.length; di++) {
    // Bail if we've used most of the time budget
    if (Date.now() - startTime > SCRAPE_BUDGET_MS) {
      console.warn(`DoNYC: ${slug} time budget hit after ${di} dates, returning ${events.length} events`);
      break;
    }

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
          signal: AbortSignal.timeout(8000),
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

function extractDetailsFromPage(html) {
  const $ = cheerio.load(html);

  // Price extraction
  let price = null;
  const schemaPrice = $('[itemprop="price"]').attr('content') || $('[itemprop="price"]').text().trim();
  if (schemaPrice) {
    const m = schemaPrice.match(/\$?(\d+(?:\.\d{2})?)/);
    if (m && parseFloat(m[1]) > 0) price = `$${m[1]}`;
    else if (m && parseFloat(m[1]) === 0) price = 'free';
  }
  if (!price) {
    const detailText = $('.ds-event-detail, .ds-event-description-inner, .ds-detail-description, .ds-event-details').text();
    if (/\bfree\b/i.test(detailText)) {
      price = 'free';
    } else {
      const rangeMatch = detailText.match(/\$(\d+(?:\.\d{2})?)\s*[-–]\s*\$?(\d+(?:\.\d{2})?)/);
      if (rangeMatch) price = `$${rangeMatch[1]}-$${rangeMatch[2]}`;
      else {
        const match = detailText.match(/\$(\d+(?:\.\d{2})?)/);
        if (match) price = `$${match[1]}`;
      }
    }
  }

  // Description extraction — prefer .ds-event-description-inner, fall back to .ds-detail-description
  let description = null;
  const descEl = ($('.ds-event-description-inner').first().length
    ? $('.ds-event-description-inner').first()
    : $('.ds-detail-description').first());
  if (descEl.length) {
    let text = descEl.text().trim();
    // Strip leading whitespace/newlines and collapse internal whitespace
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 10) {
      description = text.length > 180 ? text.slice(0, 177) + '...' : text;
    }
  }
  if (!description) {
    // Fallback: og:description meta tag (clean summary)
    const ogDesc = $('meta[property="og:description"]').attr('content');
    if (ogDesc && ogDesc.length > 10) {
      description = ogDesc.length > 180 ? ogDesc.slice(0, 177) + '...' : ogDesc;
    }
  }

  return { price, description };
}

async function enrichFromDetailPages(events, startTime) {
  const needsEnrich = events.filter(e =>
    e.source_url && ((!e.price_display && !e.is_free) || !e.description_short)
  );
  if (needsEnrich.length === 0) return;

  // Cap enrichment to leave headroom under the global timeout
  const MAX_ENRICH = 30;
  const toEnrich = needsEnrich.slice(0, MAX_ENRICH);

  let priceEnriched = 0;
  let descEnriched = 0;
  for (let i = 0; i < toEnrich.length; i += PRICE_BATCH_SIZE) {
    // Bail if time budget is nearly exhausted
    if (Date.now() - startTime > SCRAPE_BUDGET_MS) {
      console.warn(`DoNYC: enrichment time budget hit after ${i} detail pages`);
      break;
    }

    const batch = toEnrich.slice(i, i + PRICE_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async evt => {
      const res = await fetch(evt.source_url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return { evt, html: await res.text() };
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { evt, html } = r.value;
      const details = extractDetailsFromPage(html);
      if (details.price && !evt.price_display && !evt.is_free) {
        evt.price_display = details.price;
        if (details.price === 'free') evt.is_free = true;
        priceEnriched++;
      }
      if (details.description && !evt.description_short) {
        evt.description_short = details.description;
        evt.short_detail = details.description;
        descEnriched++;
      }
    }
  }
  if (priceEnriched > 0 || descEnriched > 0) {
    console.log(`DoNYC: enriched ${priceEnriched} prices, ${descEnriched} descriptions from ${toEnrich.length} detail pages`);
  }
}

async function fetchDoNYCEvents() {
  console.log('Fetching DoNYC...');
  const startTime = Date.now();
  try {
    const dates = Array.from({length: 7}, (_, i) => getNycDateString(i));
    const seen = new Set();

    const results = await Promise.allSettled(
      CATEGORIES.map(({ slug, categoryOverride }) =>
        fetchCategoryDates(slug, categoryOverride, dates, startTime)
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

    // Enrich prices + descriptions from detail pages (time-budgeted)
    await enrichFromDetailPages(events, startTime);

    console.log(`DoNYC: ${events.length} events (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
    return events;
  } catch (err) {
    console.error('DoNYC error:', err.message);
    return [];
  }
}

module.exports = { fetchDoNYCEvents };
