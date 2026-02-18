const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood, inferCategory } = require('../geo');
const { learnVenueCoords } = require('../venues');

// NYPL branch name → neighborhood fallback (when geo data unavailable)
const BRANCH_NEIGHBORHOOD = {
  'nypl for the performing arts': 'Upper West Side',
  'new york public library for the performing arts': 'Upper West Side',
  'bruno walter auditorium': 'Upper West Side',
  'lincoln center': 'Upper West Side',
  'stephen a. schwarzman building': 'Midtown',
  'stavros niarchos foundation library': 'Midtown',
  'schwarzman building': 'Midtown',
};

const ORGANIZER_URLS = [
  'https://www.eventbrite.com/o/new-york-public-library-for-the-performing-arts-5993389089',
  'https://www.eventbrite.com/o/the-new-york-public-library-5644957019',
];

function lookupBranchNeighborhood(venueName) {
  if (!venueName) return null;
  const lower = venueName.toLowerCase().trim();
  for (const [key, hood] of Object.entries(BRANCH_NEIGHBORHOOD)) {
    if (lower.includes(key)) return hood;
  }
  return null;
}

function parseOrganizerServerData(html) {
  const match = html.match(/window\.__SERVER_DATA__\s*=\s*({[\s\S]*?})\s*;/);
  if (!match) return null;

  let serverData;
  try { serverData = JSON.parse(match[1]); } catch { return null; }

  // Organizer pages may use different paths than search pages
  const results =
    serverData?.organizer_profile?.upcoming_events ||
    serverData?.search_data?.events?.results ||
    null;

  if (!Array.isArray(results) || results.length === 0) return null;
  return results;
}

function parseOrganizerJsonLd(html) {
  const $ = cheerio.load(html);
  const events = [];

  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = data.itemListElement || (Array.isArray(data) ? data : [data]);
      for (const item of items) {
        const e = item.item || item;
        if (e['@type'] !== 'Event') continue;

        // Skip online events
        const attendance = e.eventAttendanceMode || '';
        if (attendance.includes('Online')) continue;

        const location = e.location || {};
        const address = location.address || {};
        const geo = location.geo || {};

        const geoLat = parseFloat(geo.latitude);
        const geoLng = parseFloat(geo.longitude);
        if (location.name && !isNaN(geoLat) && !isNaN(geoLng)) {
          learnVenueCoords(location.name, geoLat, geoLng);
        }

        const branchHood = lookupBranchNeighborhood(location.name);
        const neighborhood = resolveNeighborhood(
          branchHood || address.addressLocality,
          isNaN(geoLat) ? null : geoLat,
          isNaN(geoLng) ? null : geoLng
        );

        const nameAndDesc = ((e.name || '') + ' ' + (e.description || '')).toLowerCase();
        const category = inferCategory(nameAndDesc);

        const id = makeEventId(e.name, location.name, e.startDate, 'nypl');

        events.push({
          id,
          source_name: 'nypl',
          source_type: 'institution',
          source_weight: 0.7,
          name: e.name,
          description_short: (e.description || '').slice(0, 180) || null,
          short_detail: (e.description || '').slice(0, 180) || null,
          venue_name: location.name || 'NYPL',
          venue_address: [address.streetAddress, address.addressLocality].filter(Boolean).join(', '),
          neighborhood,
          start_time_local: e.startDate || null,
          end_time_local: e.endDate || null,
          date_local: e.startDate ? e.startDate.slice(0, 10) : null,
          time_window: null,
          is_free: true,
          price_display: 'free',
          category,
          subcategory: null,
          confidence: 0.85,
          ticket_url: e.url || null,
          source_url: e.url || null,
          map_url: null,
          map_hint: address.streetAddress || null,
        });
      }
    } catch (err) { console.warn('NYPL: skipped malformed JSON-LD block:', err.message); }
  });

  return events;
}

function parseServerDataEvents(results) {
  const events = [];
  for (const e of results) {
    // Skip online/virtual events
    if (e.is_online_event) continue;

    const venue = e.primary_venue || {};
    const addr = venue.address || {};

    const geoLat = parseFloat(addr.latitude);
    const geoLng = parseFloat(addr.longitude);
    if (venue.name && !isNaN(geoLat) && !isNaN(geoLng)) {
      learnVenueCoords(venue.name, geoLat, geoLng);
    }

    const branchHood = lookupBranchNeighborhood(venue.name);
    const neighborhood = resolveNeighborhood(
      branchHood || addr.city,
      isNaN(geoLat) ? null : geoLat,
      isNaN(geoLng) ? null : geoLng
    );

    const startDateTime = e.start_date && e.start_time
      ? `${e.start_date}T${e.start_time}:00`
      : e.start_date || null;
    const endDateTime = e.end_date && e.end_time
      ? `${e.end_date}T${e.end_time}:00`
      : e.end_date || null;

    const id = makeEventId(e.name, venue.name, e.start_date, 'nypl');
    const nameAndDesc = ((e.name || '') + ' ' + (e.summary || '')).toLowerCase();
    const category = inferCategory(nameAndDesc);

    events.push({
      id,
      source_name: 'nypl',
      source_type: 'institution',
      source_weight: 0.7,
      name: e.name,
      description_short: (e.summary || '').slice(0, 180) || null,
      short_detail: (e.summary || '').slice(0, 180) || null,
      venue_name: venue.name || 'NYPL',
      venue_address: addr.localized_address_display || [addr.address_1, addr.city].filter(Boolean).join(', '),
      neighborhood,
      start_time_local: startDateTime,
      end_time_local: endDateTime,
      date_local: e.start_date || null,
      time_window: null,
      is_free: true,
      price_display: 'free',
      category,
      subcategory: null,
      confidence: 0.85,
      ticket_url: e.url || null,
      source_url: e.url || null,
      map_url: null,
      map_hint: addr.address_1 || null,
    });
  }
  return events;
}

async function fetchOrganizerPage(url) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    console.error(`NYPL fetch failed (${url}): ${res.status}`);
    return [];
  }

  const html = await res.text();

  // Try __SERVER_DATA__ first, then JSON-LD fallback
  const serverResults = parseOrganizerServerData(html);
  if (serverResults) {
    return parseServerDataEvents(serverResults);
  }

  return parseOrganizerJsonLd(html);
}

async function fetchNYPLEvents() {
  console.log('Fetching NYPL...');
  try {
    const pages = await Promise.allSettled(
      ORGANIZER_URLS.map(url => fetchOrganizerPage(url))
    );

    const allEvents = [];
    const seen = new Set();

    for (const result of pages) {
      const events = result.status === 'fulfilled' ? result.value : [];
      for (const e of events) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }
    }

    console.log(`NYPL: ${allEvents.length} events`);
    return allEvents;
  } catch (err) {
    console.error('NYPL error:', err.message);
    return [];
  }
}

module.exports = { fetchNYPLEvents };
