const crypto = require('crypto');
const cheerio = require('cheerio');
const { extractEvents } = require('./ai');
const { resolveNeighborhood, getNycDateString, inferCategory } = require('./geo');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html',
};

/**
 * Generate a stable event ID from name + venue + date.
 */
function makeEventId(name, venue, date, source) {
  const raw = `${(name || '').toLowerCase().trim()}|${(venue || '').toLowerCase().trim()}|${(date || '').trim()}|${(source || '').trim()}`;
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

    // Extract individual event paragraphs from The Skint's editorial format.
    // Each event is a <p> starting with a date/time pattern (e.g. "fri 8pm:", "thru 2/19:").
    // Filter out sponsored content and non-event paragraphs to reduce Claude token cost.
    const entry = $('.entry-content').first();
    if (!entry.length) {
      console.warn('Skint: .entry-content not found');
      return [];
    }

    const eventPattern = /^(mon|tue|wed|thu|fri|sat|sun|thru|today|tonight|daily|\d{1,2}\/\d{1,2})/i;
    const eventParagraphs = [];
    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text || text.length < 30) return;
      if (text.toLowerCase().startsWith('sponsored')) return;
      if (eventPattern.test(text)) {
        eventParagraphs.push(text);
      }
    });

    // Cap at 12 paragraphs to keep Claude extraction fast (today + tomorrow is enough)
    let content = eventParagraphs.slice(0, 12).join('\n\n');
    if (content.length < 50) {
      // Fallback to full text if pattern matching fails
      content = entry.text().trim().slice(0, 5000);
    }

    if (content.length < 50) {
      console.warn('Skint content too short, skipping extraction');
      return [];
    }

    console.log(`Skint content: ${content.length} chars (${eventParagraphs.length} event paragraphs)`);

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
    const events = parseEventbriteServerData(html) || parseEventbriteJsonLd(html);
    console.log(`Eventbrite: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Eventbrite error:', err.message);
    return [];
  }
}

/**
 * Parse events from Eventbrite's __SERVER_DATA__ embedded JSON (primary method).
 * Returns array of normalized events, or null if __SERVER_DATA__ not found.
 */
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
    const neighborhood = (isNaN(geoLat) && /^(new york|brooklyn|manhattan|queens)$/i.test((addr.city || '').trim()))
      ? null
      : resolveNeighborhood(addr.city, geoLat, geoLng);

    // Build full ISO datetime from separate date + time fields
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

/**
 * Fallback: parse events from JSON-LD blocks (older Eventbrite format, no times).
 */
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

          const geoLat = parseFloat(geo.latitude);
          const geoLng = parseFloat(geo.longitude);
          const neighborhood = (isNaN(geoLat) && /^(new york|brooklyn|manhattan|queens)$/i.test((address.addressLocality || '').trim()))
            ? null
            : resolveNeighborhood(address.addressLocality, geoLat, geoLng);

          const id = makeEventId(e.name, location.name, startDate, 'songkick');

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
// SOURCE 4: Dice (embedded __NEXT_DATA__ JSON — no Claude needed)
// ============================================================

function mapDiceCategory(tagTypes) {
  if (!Array.isArray(tagTypes) || tagTypes.length === 0) return null;
  const all = tagTypes.map(t => (t.value || t.title || '').toLowerCase()).join(' ');
  if (/dj|club|techno|house|electronic|dance/.test(all)) return 'nightlife';
  if (/comedy|stand.?up|improv/.test(all)) return 'comedy';
  if (/gig|live|concert|band|acoustic|jazz|singer/.test(all)) return 'live_music';
  if (/art|gallery|exhibit/.test(all)) return 'art';
  if (/theatre|theater|musical|play/.test(all)) return 'theater';
  if (/food|drink|wine|beer|tasting/.test(all)) return 'food_drink';
  if (/community|workshop|market|festival/.test(all)) return 'community';
  if (/music/.test(all)) return 'live_music';
  return null;
}

async function fetchDiceEvents() {
  console.log('Fetching Dice...');
  try {
    const res = await fetch('https://dice.fm/browse/new_york-5bbf4db0f06331478e9b2c59', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Dice fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
      console.warn('Dice: __NEXT_DATA__ not found');
      return [];
    }

    let nextData;
    try { nextData = JSON.parse(match[1]); } catch { return []; }

    const rawEvents = nextData?.props?.pageProps?.events;
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
      console.warn('Dice: no events found in __NEXT_DATA__');
      return [];
    }

    const today = getNycDateString(0);
    const tomorrow = getNycDateString(1);
    const events = [];

    for (const e of rawEvents) {
      if (!e.name || !e.dates) continue;
      if (e.status === 'sold-out' || e.status === 'off-sale') continue;

      const startDate = e.dates.event_start_date;
      const dateLocal = startDate ? startDate.slice(0, 10) : null;
      if (dateLocal && dateLocal !== today && dateLocal !== tomorrow) continue;

      const venue = (e.venues || [])[0] || {};
      const loc = venue.location || {};
      const geoLat = parseFloat(loc.lat);
      const geoLng = parseFloat(loc.lng);
      const neighborhood = resolveNeighborhood(venue.city?.name, geoLat, geoLng);

      const isFree = e.price?.amount_from === 0;
      const priceFrom = e.price?.amount_from;
      const priceDollars = priceFrom > 0 ? (priceFrom / 100).toFixed(0) : null;
      const nameAndDesc = ((e.name || '') + ' ' + (e.about?.description || '')).toLowerCase();
      const category = mapDiceCategory(e.tags_types) || inferCategory(nameAndDesc);

      const artists = (e.summary_lineup?.top_artists || []).map(a => a.name).filter(Boolean);
      const desc = e.about?.description
        || (artists.length > 0 ? artists.slice(0, 3).join(', ') + (artists.length > 3 ? ` + ${artists.length - 3} more` : '') : null);

      events.push({
        id: makeEventId(e.name, venue.name, dateLocal, 'dice'),
        source_name: 'dice',
        source_type: 'aggregator',
        source_weight: 0.8,
        name: e.name,
        description_short: desc ? desc.slice(0, 180) : null,
        short_detail: desc ? desc.slice(0, 180) : null,
        venue_name: venue.name || 'TBA',
        venue_address: venue.address || null,
        neighborhood,
        start_time_local: startDate || null,
        end_time_local: e.dates.event_end_date || null,
        date_local: dateLocal,
        time_window: null,
        is_free: isFree,
        price_display: isFree ? 'free' : (priceDollars ? `$${priceDollars}+` : null),
        category,
        subcategory: (e.tags_types || [])[0]?.title || null,
        confidence: 0.85,
        ticket_url: e.perm_name ? `https://dice.fm/event/${e.perm_name}` : null,
        map_url: null,
        map_hint: venue.address || null,
      });
    }

    console.log(`Dice: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Dice error:', err.message);
    return [];
  }
}

// ============================================================
// SOURCE 5: Resident Advisor (GraphQL API — no Claude needed)
// ============================================================

const RA_NYC_AREA_ID = 8;

// Hardcoded venue coordinates for neighborhood resolution (RA doesn't return geo data in listings)
const RA_VENUE_MAP = {
  'Nowadays': { lat: 40.7061, lng: -73.9212 },
  'Elsewhere': { lat: 40.7013, lng: -73.9225 },
  'Good Room': { lat: 40.7268, lng: -73.9516 },
  'Basement': { lat: 40.7127, lng: -73.9570 },
  'Knockdown Center': { lat: 40.7150, lng: -73.9135 },
  'Brooklyn Mirage': { lat: 40.7060, lng: -73.9225 },
  'Avant Gardner': { lat: 40.7060, lng: -73.9225 },
  'The Brooklyn Mirage': { lat: 40.7060, lng: -73.9225 },
  'Public Records': { lat: 40.6807, lng: -73.9576 },
  'Jupiter Disco': { lat: 40.7013, lng: -73.9207 },
  'Bossa Nova Civic Club': { lat: 40.7065, lng: -73.9214 },
  'Le Bain': { lat: 40.7408, lng: -74.0078 },
  'Paragon': { lat: 40.7187, lng: -73.9904 },
  'House of Yes': { lat: 40.7048, lng: -73.9230 },
  'Mood Ring': { lat: 40.7053, lng: -73.9211 },
  'Mansions': { lat: 40.7112, lng: -73.9565 },
  'Baby\'s All Right': { lat: 40.7095, lng: -73.9591 },
  'Market Hotel': { lat: 40.7058, lng: -73.9216 },
  'Superior Ingredients': { lat: 40.7119, lng: -73.9538 },
  'Sustain': { lat: 40.7028, lng: -73.9273 },
  'Lot Radio': { lat: 40.7116, lng: -73.9383 },
  'The Lot Radio': { lat: 40.7116, lng: -73.9383 },
  'H0L0': { lat: 40.7087, lng: -73.9246 },
  'Rubulad': { lat: 40.6960, lng: -73.9270 },
  'Purgatory': { lat: 40.7099, lng: -73.9428 },
  'Quantum Brooklyn': { lat: 40.6888, lng: -73.9785 },
  'Under the K Bridge Park': { lat: 40.7032, lng: -73.9887 },
  'The Sultan Room': { lat: 40.7058, lng: -73.9216 },
  'Brooklyn Steel': { lat: 40.7115, lng: -73.9505 },
  'Webster Hall': { lat: 40.7318, lng: -73.9897 },
  'Bowery Ballroom': { lat: 40.7203, lng: -73.9935 },
  'Terminal 5': { lat: 40.7690, lng: -73.9930 },
  'Cielo': { lat: 40.7410, lng: -74.0056 },
  'Schimanski': { lat: 40.7115, lng: -73.9618 },
  'Brooklyn Hangar': { lat: 40.6780, lng: -73.9980 },
  'The Meadows': { lat: 40.7058, lng: -73.9216 },
  'Rumi': { lat: 40.7243, lng: -73.9543 },
  'Signal': { lat: 40.7058, lng: -73.9216 },
  'The Parkside Lounge': { lat: 40.7228, lng: -73.9845 },
  'Green Room NYC': { lat: 40.7424, lng: -73.9927 },
  'Outer Heaven': { lat: 40.7058, lng: -73.9216 },
  // Lowercase fallbacks for common mismatches
  'public records': { lat: 40.6807, lng: -73.9576 },
  'good room': { lat: 40.7268, lng: -73.9516 },
  'elsewhere': { lat: 40.7013, lng: -73.9225 },
  'nowadays': { lat: 40.7061, lng: -73.9212 },
  'house of yes': { lat: 40.7048, lng: -73.9230 },
  'le bain': { lat: 40.7408, lng: -74.0078 },
};

const RA_QUERY = `query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $filterOptions: FilterOptionsInputDtoInput, $page: Int, $pageSize: Int) {
  eventListings(filters: $filters, filterOptions: $filterOptions, pageSize: $pageSize, page: $page) {
    data {
      id
      listingDate
      event {
        id title date startTime endTime contentUrl isTicketed
        venue { id name contentUrl }
        artists { id name }
        pick { blurb }
      }
    }
    totalResults
  }
}`;

async function fetchRAEvents() {
  console.log('Fetching Resident Advisor...');
  try {
    const today = getNycDateString(0);
    const tomorrow = getNycDateString(1);

    const payload = {
      operationName: 'GET_EVENT_LISTINGS',
      variables: {
        filters: {
          areas: { eq: RA_NYC_AREA_ID },
          listingDate: {
            gte: `${today}T00:00:00.000Z`,
            lte: `${tomorrow}T23:59:59.000Z`,
          },
        },
        filterOptions: { genre: true },
        pageSize: 30,
        page: 1,
      },
      query: RA_QUERY,
    };

    const res = await fetch('https://ra.co/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://ra.co/events/us/newyorkcity',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`RA fetch failed: ${res.status}`);
      return [];
    }

    const data = await res.json();

    if (data.errors) {
      console.error('RA GraphQL errors:', data.errors[0]?.message);
      return [];
    }

    const listings = data?.data?.eventListings?.data;
    if (!Array.isArray(listings) || listings.length === 0) {
      console.warn('RA: no event listings returned');
      return [];
    }

    const events = [];
    for (const listing of listings) {
      const e = listing.event;
      if (!e || !e.title) continue;

      const dateLocal = e.date ? e.date.slice(0, 10) : (listing.listingDate ? listing.listingDate.slice(0, 10) : null);
      if (dateLocal && dateLocal !== today && dateLocal !== tomorrow) continue;

      const venueName = e.venue?.name;
      const venueCoords = venueName
        ? (RA_VENUE_MAP[venueName] || RA_VENUE_MAP[venueName.toLowerCase()])
        : null;
      const neighborhood = venueCoords
        ? resolveNeighborhood(null, venueCoords.lat, venueCoords.lng)
        : null;

      const artists = (e.artists || []).map(a => a.name).filter(Boolean);
      const desc = e.pick?.blurb
        || (artists.length > 0 ? artists.slice(0, 3).join(', ') + (artists.length > 3 ? ` + ${artists.length - 3} more` : '') : null);

      // Build ISO datetime from RA's date + time fields
      const startTime = e.startTime
        ? (e.startTime.includes('T') ? e.startTime : `${dateLocal}T${e.startTime}:00`)
        : null;
      const endTime = e.endTime
        ? (e.endTime.includes('T') ? e.endTime : `${dateLocal}T${e.endTime}:00`)
        : null;

      events.push({
        id: makeEventId(e.title, venueName, dateLocal, 'ra'),
        source_name: 'ra',
        source_type: 'aggregator',
        source_weight: 0.85,
        name: e.title,
        description_short: desc ? desc.slice(0, 180) : null,
        short_detail: desc ? desc.slice(0, 180) : null,
        venue_name: venueName || 'TBA',
        venue_address: null,
        neighborhood,
        start_time_local: startTime,
        end_time_local: endTime,
        date_local: dateLocal,
        time_window: null,
        is_free: e.isTicketed === false,
        price_display: e.isTicketed === false ? 'free' : null,
        category: 'nightlife',
        subcategory: null,
        confidence: 0.85,
        ticket_url: e.contentUrl ? `https://ra.co${e.contentUrl}` : null,
        map_url: null,
        map_hint: null,
      });
    }

    console.log(`RA: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('RA error:', err.message);
    return [];
  }
}

// ============================================================
// Normalize a Claude-extracted event (used for Skint + Tavily)
// ============================================================

function normalizeExtractedEvent(e, sourceName, sourceType, sourceWeight) {
  const id = makeEventId(e.name, e.venue_name, e.date_local || e.start_time_local || '', sourceName);

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
    is_free: e.is_free === true,
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
  fetchDiceEvents,
  fetchRAEvents,
  normalizeExtractedEvent,
  makeEventId,
};
