const crypto = require('crypto');
const cheerio = require('cheerio');
const { extractEvents } = require('./ai');
const { resolveNeighborhood, getNycDateString, inferCategory } = require('../utils/geo');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html',
};

/**
 * Generate a stable event ID from name + venue + date.
 */
function makeEventId(name, venue, date) {
  const raw = `${(name || '').toLowerCase().trim()}|${(venue || '').toLowerCase().trim()}|${(date || '').trim()}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

// ============================================================
// SOURCE 1: The Skint (curated editorial — needs Claude extraction)
// ============================================================

async function fetchSkintEvents() {
  console.log('Fetching The Skint...');
  try {
    const res = await fetch('https://theskint.com/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Skint fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // The Skint's main content
    let content = '';
    const selectors = ['.entry-content', '.post-content', 'article', '.content', 'main'];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length && el.text().trim().length > 200) {
        content = el.text().trim();
        break;
      }
    }

    if (!content || content.length < 200) {
      content = $('body').text().trim();
    }

    // Truncate to avoid token limits (Sonnet handles 200K tokens; 15K chars is safe)
    if (content.length > 15000) {
      content = content.slice(0, 15000);
    }

    if (content.length < 50) {
      console.warn('Skint content too short, skipping extraction');
      return [];
    }

    console.log(`Skint content: ${content.length} chars`);

    const result = await extractEvents(content, 'theskint', 'https://theskint.com/');
    const events = (result.events || [])
      .filter(e => e.name && e.confidence >= 0.3)
      .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9));

    console.log(`Skint: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Skint error:', err.message);
    return [];
  }
}

// ============================================================
// SOURCE 2: Eventbrite (JSON-LD structured data — no Claude needed)
// ============================================================

async function fetchEventbriteEvents() {
  console.log('Fetching Eventbrite...');
  try {
    const res = await fetch('https://www.eventbrite.com/d/ny--new-york/events--today/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Eventbrite fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const jsonLdCount = $('script[type="application/ld+json"]').length;
    const events = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = data.itemListElement || (Array.isArray(data) ? data : [data]);
        for (const item of items) {
          const e = item.item || item;
          if (e['@type'] !== 'Event') continue;

          const location = e.location || {};
          const address = location.address || {};
          const geo = location.geo || {};

          const neighborhood = resolveNeighborhood(
            address.addressLocality,
            parseFloat(geo.latitude),
            parseFloat(geo.longitude)
          );

          const id = makeEventId(e.name, location.name, e.startDate);

          const offers = e.offers || {};
          const lowPrice = parseFloat(offers.lowPrice || offers.price || '');
          const nameAndDesc = ((e.name || '') + ' ' + (e.description || '')).toLowerCase();
          const isFree = lowPrice === 0 || nameAndDesc.includes('free admission') || nameAndDesc.includes('free entry');
          const priceDisplay = !isNaN(lowPrice) ? (lowPrice === 0 ? 'free' : `$${lowPrice}+`) : null;

          const category = inferCategory(nameAndDesc);

          events.push({
            id,
            source_name: 'eventbrite',
            source_type: 'aggregator',
            source_weight: 0.7,
            name: e.name,
            description_short: (e.description || '').slice(0, 180) || null,
            short_detail: (e.description || '').slice(0, 180) || null,
            venue_name: location.name || 'TBA',
            venue_address: [address.streetAddress, address.addressLocality].filter(Boolean).join(', '),
            neighborhood,
            start_time_local: e.startDate || null,
            end_time_local: e.endDate || null,
            date_local: e.startDate ? e.startDate.slice(0, 10) : null,
            time_window: null,
            is_free: isFree,
            price_display: priceDisplay,
            category,
            subcategory: null,
            confidence: 0.85,
            ticket_url: e.url || null,
            map_url: null,
            map_hint: address.streetAddress || null,
          });
        }
      } catch (err) { console.warn('Skipped malformed JSON-LD block:', err.message); }
    });

    if (events.length === 0 && jsonLdCount > 0) {
      console.warn(`Eventbrite: found ${jsonLdCount} JSON-LD blocks but extracted 0 events — page structure may have changed`);
    }
    console.log(`Eventbrite: ${events.length} events (from ${jsonLdCount} JSON-LD blocks)`);
    return events;
  } catch (err) {
    console.error('Eventbrite error:', err.message);
    return [];
  }
}

// ============================================================
// SOURCE 3: Songkick (JSON-LD structured data — no Claude needed)
// ============================================================

async function fetchSongkickEvents() {
  console.log('Fetching Songkick...');
  try {
    const res = await fetch('https://www.songkick.com/metro-areas/7644-us-new-york', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Songkick fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const today = getNycDateString(0);
    const tomorrow = getNycDateString(1);
    const events = [];

    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = Array.isArray(data) ? data : [data];
        for (const e of items) {
          if (e['@type'] !== 'MusicEvent') continue;

          const location = e.location || {};
          const address = location.address || {};
          const geo = location.geo || {};

          const startDate = e.startDate ? e.startDate.slice(0, 10) : null;
          if (startDate && startDate !== today && startDate !== tomorrow) continue;

          const neighborhood = resolveNeighborhood(
            address.addressLocality,
            parseFloat(geo.latitude),
            parseFloat(geo.longitude)
          );

          const id = makeEventId(e.name, location.name, startDate);

          const offers = e.offers || {};
          const skPrice = parseFloat(offers.lowPrice || offers.price || '');
          const skName = (e.name || '').toLowerCase();
          const skFree = skPrice === 0 || skName.includes('free');

          events.push({
            id,
            source_name: 'songkick',
            source_type: 'aggregator',
            source_weight: 0.75,
            name: e.name,
            description_short: null,
            short_detail: null,
            venue_name: location.name || 'TBA',
            venue_address: [address.streetAddress, address.addressLocality].filter(Boolean).join(', '),
            neighborhood,
            start_time_local: e.startDate || null,
            end_time_local: e.endDate || null,
            date_local: startDate,
            time_window: null,
            is_free: skFree,
            price_display: skFree ? 'free' : (!isNaN(skPrice) && skPrice > 0 ? `$${skPrice}+` : null),
            category: 'live_music',
            subcategory: null,
            confidence: 0.85,
            ticket_url: e.url || null,
            map_url: null,
            map_hint: address.streetAddress || null,
          });
        }
      } catch (err) { console.warn('Skipped malformed JSON-LD block:', err.message); }
    });

    console.log(`Songkick: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Songkick error:', err.message);
    return [];
  }
}

// ============================================================
// Normalize a Claude-extracted event (used for Skint + Tavily)
// ============================================================

function normalizeExtractedEvent(e, sourceName, sourceType, sourceWeight) {
  const id = makeEventId(e.name, e.venue_name, e.date_local || e.start_time_local || '');

  // Validate Claude-extracted neighborhood against known neighborhoods, then fall back to geo
  const neighborhood = resolveNeighborhood(e.neighborhood, parseFloat(e.latitude), parseFloat(e.longitude));

  return {
    id,
    source_name: sourceName,
    source_type: sourceType,
    source_weight: sourceWeight,
    name: e.name,
    description_short: e.description_short || null,
    short_detail: e.description_short || null,
    venue_name: e.venue_name || 'TBA',
    venue_address: e.venue_address || null,
    neighborhood,
    start_time_local: e.start_time_local || null,
    end_time_local: e.end_time_local || null,
    date_local: e.date_local || null,
    time_window: e.time_window || null,
    is_free: e.is_free != null ? e.is_free : false,
    price_display: e.price_display || null,
    category: e.category || 'other',
    subcategory: e.subcategory || null,
    confidence: e.confidence || 0.5,
    ticket_url: e.ticket_url || null,
    map_url: null,
    map_hint: e.map_hint || null,
  };
}

module.exports = {
  fetchSkintEvents,
  fetchEventbriteEvents,
  fetchSongkickEvents,
  normalizeExtractedEvent,
  makeEventId,
};
