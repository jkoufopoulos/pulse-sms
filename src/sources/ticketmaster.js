const { makeEventId } = require('./shared');
const { getNycDateString, resolveNeighborhood, inferCategory } = require('../geo');
const { learnVenueCoords } = require('../venues');

const LARGE_VENUE_BLOCKLIST = new Set([
  'madison square garden',
  'barclays center',
  'ubs arena',
  'citi field',
  'yankee stadium',
  'metlife stadium',
  'radio city music hall',
  'beacon theatre',
  'carnegie hall',
  'united palace',
  'kings theatre',
  'forest hills stadium',
  'the theater at madison square garden',
  'hulu theater at madison square garden',
  'terminal 5',
]);

const MAX_PRICE = 100;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;

// Ticketmaster segment IDs: Music, Arts & Theatre, Miscellaneous
const SEGMENT_IDS = 'KZFzniwnSyZfZ7v7nJ,KZFzniwnSyZfZ7v7na,KZFzniwnSyZfZ7v7n1';

function mapTicketmasterCategory(classifications) {
  const genre = classifications?.[0]?.genre?.name?.toLowerCase() || '';
  const subGenre = classifications?.[0]?.subGenre?.name?.toLowerCase() || '';
  const segment = classifications?.[0]?.segment?.name?.toLowerCase() || '';

  if (genre.includes('comedy') || subGenre.includes('comedy')) return 'comedy';
  if (genre.includes('jazz')) return 'live_music';
  if (genre.includes('theatre') || genre.includes('theater') || segment === 'arts & theatre') return 'theater';
  if (genre.includes('dance') || genre.includes('electronic') || genre.includes('club')) return 'nightlife';
  if (segment === 'music') return 'live_music';
  return 'other';
}

function isBlockedVenue(venueName) {
  return LARGE_VENUE_BLOCKLIST.has((venueName || '').toLowerCase().trim());
}

function isPriceTooHigh(priceRanges) {
  if (!Array.isArray(priceRanges) || priceRanges.length === 0) return false;
  const minPrice = priceRanges[0].min;
  return typeof minPrice === 'number' && minPrice > MAX_PRICE;
}

async function fetchTicketmasterEvents() {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    console.log('Ticketmaster: skipped (no API key)');
    return [];
  }

  console.log('Fetching Ticketmaster...');
  try {
    const today = getNycDateString(0);
    const dayAfterTomorrow = getNycDateString(2);
    const startDateTime = today + 'T00:00:00Z';
    const endDateTime = dayAfterTomorrow + 'T06:00:00Z';

    const allEvents = [];
    let page = 0;

    while (page < MAX_PAGES) {
      const params = new URLSearchParams({
        apikey: apiKey,
        latlong: '40.7128,-74.0060',
        radius: '12',
        unit: 'miles',
        segmentId: SEGMENT_IDS,
        startDateTime,
        endDateTime,
        size: String(PAGE_SIZE),
        sort: 'date,asc',
        page: String(page),
      });

      const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, {
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.error(`Ticketmaster fetch failed: ${res.status}`);
        break;
      }

      const data = await res.json();
      const embedded = data._embedded;
      if (!embedded || !Array.isArray(embedded.events)) break;

      for (const e of embedded.events) {
        const venue = e._embedded?.venues?.[0] || {};
        const venueName = venue.name || '';

        // Filter: large venue blocklist
        if (isBlockedVenue(venueName)) continue;

        // Filter: price too high
        if (isPriceTooHigh(e.priceRanges)) continue;

        // Filter: no confirmed date
        if (e.dates?.start?.dateTBD || e.dates?.start?.dateTBA) continue;

        const localDate = e.dates?.start?.localDate;
        if (!localDate) continue;

        const localTime = e.dates?.start?.localTime || '20:00:00';
        const startTimeLocal = localDate + 'T' + localTime;

        const geoLat = parseFloat(venue.location?.latitude);
        const geoLng = parseFloat(venue.location?.longitude);
        if (venueName && !isNaN(geoLat) && !isNaN(geoLng)) {
          learnVenueCoords(venueName, geoLat, geoLng);
        }
        const neighborhood = resolveNeighborhood(venue.city?.name, geoLat, geoLng);

        const priceMin = e.priceRanges?.[0]?.min;
        const isFree = priceMin === 0;
        const nameAndDesc = ((e.name || '') + ' ' + (e.info || '')).toLowerCase();
        const category = mapTicketmasterCategory(e.classifications) || inferCategory(nameAndDesc);

        allEvents.push({
          id: makeEventId(e.name, venueName, localDate, 'ticketmaster'),
          source_name: 'ticketmaster',
          source_type: 'aggregator',
          source_weight: 0.75,
          name: e.name,
          description_short: e.info ? e.info.slice(0, 180) : null,
          short_detail: e.info ? e.info.slice(0, 180) : null,
          venue_name: venueName || 'TBA',
          venue_address: venue.address?.line1 || null,
          neighborhood,
          start_time_local: startTimeLocal,
          end_time_local: null,
          date_local: localDate,
          time_window: null,
          is_free: isFree,
          price_display: isFree ? 'free' : (typeof priceMin === 'number' && priceMin > 0 ? `$${priceMin}+` : null),
          category,
          subcategory: e.classifications?.[0]?.subGenre?.name || null,
          ticket_url: e.url || null,
          map_url: null,
          map_hint: venue.address?.line1 || null,
        });
      }

      // Check if there are more pages
      const totalPages = data.page?.totalPages || 1;
      page++;
      if (page >= totalPages) break;
    }

    console.log(`Ticketmaster: ${allEvents.length} events`);
    return allEvents;
  } catch (err) {
    console.error('Ticketmaster error:', err.message);
    return [];
  }
}

module.exports = { fetchTicketmasterEvents };
