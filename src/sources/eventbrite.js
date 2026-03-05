const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood, inferCategory } = require('../geo');
const { learnVenueCoords } = require('../venues');

async function fetchEventbriteEvents() {
  console.log('Fetching Eventbrite...');
  try {
    const res = await fetch('https://www.eventbrite.com/d/ny--new-york/events--this-week/', {
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

    const id = makeEventId(e.name, venue.name, e.start_date, 'eventbrite', null, startDateTime);

    const nameAndDesc = ((e.name || '') + ' ' + (e.summary || '')).toLowerCase();
    const tags = (e.tags || []).map(t => (t.display_name || t.tag || '').toLowerCase());
    const hasFreeTag = tags.some(t => t === 'free' || t === 'free_entry');
    const isFree = hasFreeTag || /\bfree\b/i.test(nameAndDesc);
    const category = inferCategory(nameAndDesc);

    let priceDisplay = null;
    if (isFree) {
      priceDisplay = 'free';
    } else {
      // Extract first dollar amount from name or summary
      const priceText = (e.name || '') + ' ' + (e.summary || '');
      const priceMatch = priceText.match(/\$(\d+(?:\.\d{2})?)/);
      if (priceMatch) priceDisplay = `$${priceMatch[1]}`;
    }

    events.push({
      id,
      source_name: 'eventbrite',
      source_type: 'aggregator',
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
      price_display: priceDisplay,
      category,
      subcategory: null,
      ticket_url: e.url || null,
      map_url: null,
      map_hint: addr.address_1 || null,
    });
  }

  // Editorial filter: drop professional/corporate events
  const EB_NOISE_RE = /\b(conference|summit|webinar|certification|training|sellers|B2B|enterprise|fundrais|investor|startup accelerator|bootcamp|masterclass|professional development)\b/i;
  const filtered = events.filter(e => !EB_NOISE_RE.test(e.name));
  console.log(`Eventbrite: parsed ${filtered.length} events from __SERVER_DATA__ (${events.length} before editorial filter)`);
  return filtered;
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

        const id = makeEventId(e.name, location.name, e.startDate, 'eventbrite', null, e.startDate);

        const offers = e.offers || {};
        const lowPrice = parseFloat(offers.lowPrice || offers.price || '');
        const nameAndDesc = ((e.name || '') + ' ' + (e.description || '')).toLowerCase();
        const isFree = lowPrice === 0 || /\bfree\b/i.test(nameAndDesc);
        const priceDisplay = isFree ? 'free' : (!isNaN(lowPrice) && lowPrice > 0 ? `$${lowPrice}+` : null);

        const category = inferCategory(nameAndDesc);

        events.push({
          id,
          source_name: 'eventbrite',
          source_type: 'aggregator',
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

async function fetchEventbritePage(url, label, categoryOverride, sourceName) {
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

    if (categoryOverride || sourceName) {
      events = events.map(e => ({
        ...e,
        ...(categoryOverride && { category: categoryOverride }),
        ...(sourceName && { source_name: sourceName }),
      }));
    }

    console.log(`Eventbrite ${label}: ${events.length} events`);
    return events;
  } catch (err) {
    console.error(`Eventbrite ${label} error:`, err.message);
    return [];
  }
}

async function fetchEventbriteComedy() {
  // Fetch 3 comedy-specific search pages in parallel — the old comedy--this-week
  // URL returned generic popular events, not comedy. These URLs return actual comedy.
  const pages = [
    ['comedy-shows', 'https://www.eventbrite.com/d/ny--new-york/comedy-shows/'],
    ['open-mic-comedy', 'https://www.eventbrite.com/d/ny--new-york/open-mic-comedy/'],
    ['stand-up-comedy', 'https://www.eventbrite.com/d/ny--new-york/stand-up-comedy/'],
  ];

  const results = await Promise.all(
    pages.map(([label, url]) => fetchEventbritePage(url, label, 'comedy', 'EventbriteComedy'))
  );

  // Deduplicate by event ID (same event may appear in multiple search pages)
  const seen = new Set();
  const events = [];
  for (const batch of results) {
    for (const e of batch) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        events.push(e);
      }
    }
  }

  console.log(`EventbriteComedy: ${events.length} unique events from ${pages.length} pages`);
  return events;
}

function fetchEventbriteArts() {
  return fetchEventbritePage(
    'https://www.eventbrite.com/d/ny--new-york/arts--this-week/',
    'Arts',
    'art',
    'EventbriteArts'
  );
}

module.exports = { fetchEventbriteEvents, fetchEventbriteComedy, fetchEventbriteArts };
