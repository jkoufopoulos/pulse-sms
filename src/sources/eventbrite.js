const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood, inferCategory } = require('../geo');
const { learnVenueCoords } = require('../venues');

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
    const events = parseEventbriteServerData(html) || parseEventbriteJsonLd(html);
    console.log(`Eventbrite: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Eventbrite error:', err.message);
    return [];
  }
}

function parseEventbriteServerData(html) {
  const match = html.match(/window\.__SERVER_DATA__\s*=\s*({[\s\S]*?})\s*;/);
  if (!match) return null;

  let serverData;
  try { serverData = JSON.parse(match[1]); } catch { return null; }

  const results = serverData?.search_data?.events?.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const events = [];
  for (const e of results) {
    if (e.is_online_event) continue;

    const venue = e.primary_venue || {};
    const addr = venue.address || {};

    const geoLat = parseFloat(addr.latitude);
    const geoLng = parseFloat(addr.longitude);
    if (venue.name && !isNaN(geoLat) && !isNaN(geoLng)) {
      learnVenueCoords(venue.name, geoLat, geoLng);
    }
    const neighborhood = (isNaN(geoLat) && /^(new york|brooklyn|manhattan|queens)$/i.test((addr.city || '').trim()))
      ? null
      : resolveNeighborhood(addr.city, geoLat, geoLng);

    const startDateTime = e.start_date && e.start_time
      ? `${e.start_date}T${e.start_time}:00`
      : e.start_date || null;
    const endDateTime = e.end_date && e.end_time
      ? `${e.end_date}T${e.end_time}:00`
      : e.end_date || null;

    const id = makeEventId(e.name, venue.name, e.start_date, 'eventbrite');

    const nameAndDesc = ((e.name || '') + ' ' + (e.summary || '')).toLowerCase();
    const isFree = nameAndDesc.includes('free admission') || nameAndDesc.includes('free entry') || nameAndDesc.includes('free event');
    const category = inferCategory(nameAndDesc);

    events.push({
      id,
      source_name: 'eventbrite',
      source_type: 'aggregator',
      source_weight: 0.7,
      name: e.name,
      description_short: (e.summary || '').slice(0, 180) || null,
      short_detail: (e.summary || '').slice(0, 180) || null,
      venue_name: venue.name || 'TBA',
      venue_address: addr.localized_address_display || [addr.address_1, addr.city].filter(Boolean).join(', '),
      neighborhood,
      start_time_local: startDateTime,
      end_time_local: endDateTime,
      date_local: e.start_date || null,
      time_window: null,
      is_free: isFree,
      price_display: isFree ? 'free' : null,
      category,
      subcategory: null,
      confidence: 0.85,
      ticket_url: e.url || null,
      map_url: null,
      map_hint: addr.address_1 || null,
    });
  }

  console.log(`Eventbrite: parsed ${events.length} events from __SERVER_DATA__`);
  return events;
}

function parseEventbriteJsonLd(html) {
  const $ = cheerio.load(html);
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

        const geoLat = parseFloat(geo.latitude);
        const geoLng = parseFloat(geo.longitude);
        if (location.name && !isNaN(geoLat) && !isNaN(geoLng)) {
          learnVenueCoords(location.name, geoLat, geoLng);
        }
        const neighborhood = (isNaN(geoLat) && /^(new york|brooklyn|manhattan|queens)$/i.test((address.addressLocality || '').trim()))
          ? null
          : resolveNeighborhood(address.addressLocality, geoLat, geoLng);

        const id = makeEventId(e.name, location.name, e.startDate, 'eventbrite');

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

  console.log(`Eventbrite: parsed ${events.length} events from JSON-LD (fallback)`);
  return events;
}

async function fetchEventbritePage(url, label, categoryOverride) {
  console.log(`Fetching Eventbrite ${label}...`);
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Eventbrite ${label} fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    let events = parseEventbriteServerData(html) || parseEventbriteJsonLd(html);
    if (!events || events.length === 0) {
      console.warn(`Eventbrite ${label}: no events parsed`);
      return [];
    }

    if (categoryOverride) {
      events = events.map(e => ({ ...e, category: categoryOverride }));
    }

    console.log(`Eventbrite ${label}: ${events.length} events`);
    return events;
  } catch (err) {
    console.error(`Eventbrite ${label} error:`, err.message);
    return [];
  }
}

function fetchEventbriteComedy() {
  return fetchEventbritePage(
    'https://www.eventbrite.com/d/ny--new-york/comedy--today/',
    'Comedy',
    'comedy'
  );
}

function fetchEventbriteArts() {
  return fetchEventbritePage(
    'https://www.eventbrite.com/d/ny--new-york/arts--today/',
    'Arts',
    'art'
  );
}

module.exports = { fetchEventbriteEvents, fetchEventbriteComedy, fetchEventbriteArts };
