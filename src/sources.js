const crypto = require('crypto');
const cheerio = require('cheerio');
const { extractEvents } = require('./ai');
const { resolveNeighborhood, getNycDateString, inferCategory, filterUpcomingEvents } = require('./geo');
const { lookupVenue, learnVenueCoords } = require('./venues');

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
      const venueCoords = lookupVenue(venueName);
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
// SOURCE 10: NYC Parks (Schema.org microdata — no Claude needed)
// ============================================================

async function fetchNYCParksEvents() {
  console.log('Fetching NYC Parks...');
  try {
    const today = getNycDateString(0);
    const tomorrow = getNycDateString(1);
    const events = [];
    const seen = new Set();

    // Fetch 2 pages (100 events, ~4 days of coverage)
    for (const page of [1, 2]) {
      const url = page === 1
        ? 'https://www.nycgovparks.org/events'
        : `https://www.nycgovparks.org/events/p${page}`;
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`NYC Parks page ${page} fetch failed: ${res.status}`);
        continue;
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      $('[itemscope][itemtype="http://schema.org/Event"]').each((i, el) => {
        const $el = $(el);

        const title = $el.find('[itemprop="name"] > a').first().text().trim()
          || $el.find('h3[itemprop="name"]').first().text().trim();
        const startDate = $el.find('meta[itemprop="startDate"]').attr('content') || null;
        const endDate = $el.find('meta[itemprop="endDate"]').attr('content') || null;
        const dateLocal = startDate ? startDate.slice(0, 10) : null;

        // Only keep today + tomorrow
        if (dateLocal && dateLocal !== today && dateLocal !== tomorrow) return;

        const venueName = $el.find('[itemprop="location"] [itemprop="name"]').first().text().trim() || null;
        const venueAddress = $el.find('meta[itemprop="streetAddress"]').attr('content') || null;
        const borough = $el.find('[itemprop="addressLocality"]').first().text().trim() || null;
        const description = $el.find('[itemprop="description"]').first().text().trim() || null;
        const eventUrl = $el.find('h3 a, [itemprop="name"] a').first().attr('href') || null;

        // Extract categories from links
        const categories = [];
        $el.find('a[href^="/events/"]').each((j, link) => {
          const href = $(link).attr('href');
          const cat = href.replace('/events/', '');
          if (cat && !cat.includes('/') && cat !== 'all') categories.push(cat);
        });

        if (!title) return;

        const neighborhood = resolveNeighborhood(borough, null, null);

        const id = makeEventId(title, venueName, dateLocal, 'nyc_parks');
        if (seen.has(id)) return;
        seen.add(id);

        const nameAndDesc = ((title || '') + ' ' + (description || '')).toLowerCase();
        const category = inferCategory(nameAndDesc);

        events.push({
          id,
          source_name: 'nyc_parks',
          source_type: 'government',
          source_weight: 0.75,
          name: title,
          description_short: description ? description.slice(0, 180) : null,
          short_detail: description ? description.slice(0, 180) : null,
          venue_name: venueName || 'NYC Park',
          venue_address: venueAddress || null,
          neighborhood,
          start_time_local: startDate || null,
          end_time_local: endDate || null,
          date_local: dateLocal,
          time_window: null,
          is_free: true,
          price_display: 'free',
          category,
          subcategory: categories[0] || null,
          confidence: 0.85,
          ticket_url: eventUrl ? `https://www.nycgovparks.org${eventUrl}` : null,
          source_url: eventUrl ? `https://www.nycgovparks.org${eventUrl}` : null,
          map_url: null,
          map_hint: venueAddress || null,
        });
      });
    }

    console.log(`NYC Parks: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('NYC Parks error:', err.message);
    return [];
  }
}

// ============================================================
// SOURCE 11: BrooklynVegan (DoStuff JSON API — no Claude needed)
// ============================================================

async function fetchBrooklynVeganEvents() {
  console.log('Fetching BrooklynVegan...');
  try {
    const events = [];
    const seen = new Set();

    for (const day of ['today', 'tomorrow']) {
      const url = `https://nyc-shows.brooklynvegan.com/events/${day}.json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': FETCH_HEADERS['User-Agent'], 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`BrooklynVegan ${day} fetch failed: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const items = Array.isArray(data) ? data : (data.events || []);

      for (const item of items) {
        if (!item.title || item.sold_out) continue;

        const venue = item.venue || {};
        const lat = parseFloat(venue.latitude);
        const lng = parseFloat(venue.longitude);
        const venueName = venue.title || null;

        // Auto-learn venue coords for other sources
        if (venueName && !isNaN(lat) && !isNaN(lng)) {
          learnVenueCoords(venueName, lat, lng);
        }

        const neighborhood = (!isNaN(lat) && !isNaN(lng))
          ? resolveNeighborhood(null, lat, lng)
          : resolveNeighborhood(venue.city, null, null);

        const startDate = item.tz_adjusted_begin_date || item.begin_date || null;
        const dateLocal = startDate ? startDate.slice(0, 10) : null;

        const artists = (item.artists || []).map(a => a.name).filter(Boolean);
        const desc = artists.length > 0
          ? artists.slice(0, 3).join(', ') + (artists.length > 3 ? ` + ${artists.length - 3} more` : '')
          : null;

        const nameAndDesc = ((item.title || '') + ' ' + (desc || '')).toLowerCase();
        const inferred = inferCategory(nameAndDesc);
        const apiCat = (item.category || '').toLowerCase();
        const category = (inferred === 'other' && apiCat === 'music') ? 'live_music'
          : (inferred === 'other' && apiCat === 'comedy') ? 'comedy'
          : (inferred === 'other' && apiCat === 'performing arts') ? 'theater'
          : inferred;

        const id = makeEventId(item.title, venueName, dateLocal, 'brooklynvegan');
        if (seen.has(id)) continue;
        seen.add(id);

        const isFree = item.is_free === true;
        const priceDisplay = isFree ? 'free' : (item.ticket_info || null);

        events.push({
          id,
          source_name: 'brooklynvegan',
          source_type: 'curated',
          source_weight: 0.8,
          name: item.title,
          description_short: desc ? desc.slice(0, 180) : null,
          short_detail: desc ? desc.slice(0, 180) : null,
          venue_name: venueName || 'TBA',
          venue_address: venue.full_address || venue.address || null,
          neighborhood,
          start_time_local: startDate || null,
          end_time_local: null,
          date_local: dateLocal,
          time_window: null,
          is_free: isFree,
          price_display: priceDisplay,
          category,
          subcategory: item.category || null,
          confidence: 0.9,
          ticket_url: item.buy_url || null,
          source_url: item.url ? `https://nyc-shows.brooklynvegan.com${item.url}` : null,
          map_url: null,
          map_hint: venue.full_address || venue.address || null,
        });
      }
    }

    console.log(`BrooklynVegan: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('BrooklynVegan error:', err.message);
    return [];
  }
}

// ============================================================
// Normalize a Claude-extracted event (used for Skint + Tavily)
// ============================================================

function normalizeExtractedEvent(e, sourceName, sourceType, sourceWeight) {
  const id = makeEventId(e.name, e.venue_name, e.date_local || e.start_time_local || '', sourceName);

  // Try venue lookup for coords when Claude didn't extract lat/lng
  let lat = parseFloat(e.latitude);
  let lng = parseFloat(e.longitude);
  let neighborhoodHint = e.neighborhood;
  if ((isNaN(lat) || isNaN(lng)) && e.venue_name) {
    const coords = lookupVenue(e.venue_name);
    if (coords) {
      lat = coords.lat;
      lng = coords.lng;
      neighborhoodHint = null; // trust venue coords over Claude's text guess
    }
  }

  // Validate Claude-extracted neighborhood against known neighborhoods, then fall back to geo
  const neighborhood = resolveNeighborhood(neighborhoodHint, lat, lng);

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
    source_url: e.source_url || null,
    map_url: null,
    map_hint: e.map_hint || null,
  };
}

// ============================================================
// Tavily web search fallback (on-demand, not in daily scrape)
// ============================================================

async function searchTavilyEvents(neighborhood, { query: customQuery } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const query = customQuery || `events tonight ${neighborhood} NYC ${today}`;

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`Tavily search failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const results = data.results || [];

    // Fix 5: Drop stale results — if Tavily returns a published_date older than 7 days, skip it
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const freshResults = results.filter(r => {
      if (!r.published_date) return true; // no date = assume fresh
      try {
        return new Date(r.published_date).getTime() > sevenDaysAgo;
      } catch { return true; }
    });
    if (freshResults.length < results.length) {
      console.log(`Tavily: dropped ${results.length - freshResults.length} stale results (>7 days old)`);
    }

    // Combine result content into a single text block for Claude extraction
    const rawText = freshResults
      .map(r => `[Source: ${r.url}]\n${r.title}\n${r.content}`)
      .join('\n\n---\n\n');

    if (!rawText.trim()) return [];

    const extracted = await extractEvents(rawText, 'tavily', query, { model: 'claude-haiku-4-5-20251001' });
    const events = (extracted.events || [])
      .map(raw => normalizeExtractedEvent(raw, 'tavily', 'search', 0.6))
      .filter(e => e.name && e.confidence >= 0.6); // Fix 2: tighter threshold for Tavily (was 0.4)

    // Fix 1: filter out past events — Tavily results skip the daily cache pipeline
    const upcoming = filterUpcomingEvents(events);
    if (upcoming.length < events.length) {
      console.log(`Tavily: dropped ${events.length - upcoming.length} past events`);
    }

    console.log(`Tavily: ${upcoming.length} events for ${neighborhood}`);
    return upcoming;
  } catch (err) {
    console.error('Tavily search error:', err.message);
    return [];
  }
}

/**
 * Batch Tavily search for free events across NYC — called during daily scrape.
 * Runs 2 broad searches and extracts with Haiku for speed.
 * Returns normalized event array (all marked is_free: true).
 */
async function fetchTavilyFreeEvents() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const queries = [
    `free events NYC tonight ${today} no cover`,
    `free things to do in New York City ${today} free entry`,
  ];

  try {
    // Run both searches in parallel
    const searchResults = await Promise.allSettled(
      queries.map(query =>
        fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: 'basic',
            max_results: 5,
            include_answer: false,
          }),
          signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.json() : { results: [] })
      )
    );

    // Combine all results, dedup by URL
    const seenUrls = new Set();
    const allResults = [];
    for (const sr of searchResults) {
      if (sr.status !== 'fulfilled') continue;
      for (const r of (sr.value.results || [])) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          allResults.push(r);
        }
      }
    }

    if (allResults.length === 0) return [];

    // Drop stale results
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const freshResults = allResults.filter(r => {
      if (!r.published_date) return true;
      try { return new Date(r.published_date).getTime() > sevenDaysAgo; } catch { return true; }
    });

    const rawText = freshResults
      .map(r => `[Source: ${r.url}]\n${r.title}\n${r.content}`)
      .join('\n\n---\n\n');

    if (!rawText.trim()) return [];

    // Use Haiku for fast extraction
    const extracted = await extractEvents(rawText, 'tavily-free', 'daily scrape', { model: 'claude-haiku-4-5-20251001' });
    const events = (extracted.events || [])
      .map(raw => {
        const e = normalizeExtractedEvent(raw, 'tavily', 'search', 0.6);
        e.is_free = true; // force free since that's what we searched for
        return e;
      })
      .filter(e => e.name && e.confidence >= 0.5);

    const upcoming = filterUpcomingEvents(events);
    console.log(`Tavily daily free: ${upcoming.length} events (from ${freshResults.length} search results)`);
    return upcoming;
  } catch (err) {
    console.error('Tavily daily free search error:', err.message);
    return [];
  }
}

// ============================================================
// SOURCE 6: Nonsense NYC (curated underground events newsletter)
// ============================================================

async function fetchNonsenseNYC() {
  console.log('Fetching Nonsense NYC...');
  try {
    const res = await fetch('https://nonsensenyc.com/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Nonsense NYC fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract the main newsletter content
    const entry = $('.entry-content, .post-content, article').first();
    if (!entry.length) {
      console.warn('Nonsense NYC: content container not found');
      return [];
    }

    // Grab all text paragraphs, filtering out very short ones
    const paragraphs = [];
    entry.find('p, li').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length >= 30) {
        paragraphs.push(text);
      }
    });

    // Cap to keep extraction fast
    let content = paragraphs.slice(0, 15).join('\n\n');
    if (content.length < 50) {
      content = entry.text().trim().slice(0, 5000);
    }

    if (content.length < 50) {
      console.warn('Nonsense NYC content too short, skipping extraction');
      return [];
    }

    console.log(`Nonsense NYC content: ${content.length} chars (${paragraphs.length} paragraphs)`);

    const result = await extractEvents(content, 'nonsensenyc', 'https://nonsensenyc.com/');
    const events = (result.events || [])
      .filter(e => e.name && e.confidence >= 0.3)
      .map(e => normalizeExtractedEvent(e, 'nonsensenyc', 'curated', 0.9));

    console.log(`Nonsense NYC: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Nonsense NYC error:', err.message);
    return [];
  }
}

// ============================================================
// SOURCE 7: Oh My Rockness (curated indie show listings)
// ============================================================

async function fetchOhMyRockness() {
  console.log('Fetching Oh My Rockness...');
  try {
    const res = await fetch('https://www.ohmyrockness.com/shows', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Oh My Rockness fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract show listings
    const paragraphs = [];
    $('article, .show, .event, .listing, .card').each((i, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length >= 20) {
        paragraphs.push(text);
      }
    });

    // Fallback: grab main content area
    if (paragraphs.length === 0) {
      const main = $('main, .content, .shows, #content').first();
      if (main.length) {
        main.find('p, li, div').each((i, el) => {
          const text = $(el).text().trim().replace(/\s+/g, ' ');
          if (text && text.length >= 20 && text.length < 500) {
            paragraphs.push(text);
          }
        });
      }
    }

    let content = paragraphs.slice(0, 20).join('\n\n');
    if (content.length < 50) {
      content = $('body').text().trim().replace(/\s+/g, ' ').slice(0, 5000);
    }

    if (content.length < 50) {
      console.warn('Oh My Rockness content too short, skipping extraction');
      return [];
    }

    console.log(`Oh My Rockness content: ${content.length} chars (${paragraphs.length} listings)`);

    // Use Haiku for cost savings — simpler listing format
    const result = await extractEvents(content, 'ohmyrockness', 'https://www.ohmyrockness.com/shows', { model: 'claude-haiku-4-5-20251001' });
    const events = (result.events || [])
      .filter(e => e.name && e.confidence >= 0.3)
      .map(e => normalizeExtractedEvent(e, 'ohmyrockness', 'curated', 0.85));

    console.log(`Oh My Rockness: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Oh My Rockness error:', err.message);
    return [];
  }
}

// ============================================================
// SOURCE 8 & 9: Eventbrite category pages (Comedy + Arts)
// Reuses existing Eventbrite parsers — no Claude needed
// ============================================================

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

    // Override category for these specialized pages
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

module.exports = {
  fetchSkintEvents,
  fetchEventbriteEvents,
  fetchSongkickEvents,
  fetchDiceEvents,
  fetchRAEvents,
  fetchNonsenseNYC,
  fetchOhMyRockness,
  fetchEventbriteComedy,
  fetchEventbriteArts,
  fetchNYCParksEvents,
  fetchBrooklynVeganEvents,
  normalizeExtractedEvent,
  makeEventId,
  searchTavilyEvents,
  fetchTavilyFreeEvents,
};
