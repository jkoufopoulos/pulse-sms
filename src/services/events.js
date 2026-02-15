const { getNeighborhoodCoords } = require('../utils/neighborhoods');

const TM_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';

async function fetchEvents(neighborhood) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    console.error('TICKETMASTER_API_KEY not set');
    return [];
  }

  const coords = getNeighborhoodCoords(neighborhood);
  if (!coords) {
    // Fall back to general Manhattan search
    return fetchByLatLng(40.7580, -73.9855, 3, apiKey);
  }

  return fetchByLatLng(coords.lat, coords.lng, Math.ceil(coords.radius_km * 1.5), apiKey);
}

async function fetchByLatLng(lat, lng, radiusKm, apiKey) {
  const now = new Date();
  const later = new Date(now.getTime() + 12 * 60 * 60 * 1000); // next 12 hours

  const params = new URLSearchParams({
    apikey: apiKey,
    latlong: `${lat},${lng}`,
    radius: String(Math.max(radiusKm, 1)),
    unit: 'km',
    startDateTime: formatTMDate(now),
    endDateTime: formatTMDate(later),
    size: '20',
    sort: 'date,asc',
    countryCode: 'US',
    stateCode: 'NY',
  });

  const url = `${TM_BASE}?${params}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Ticketmaster API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const events = data?._embedded?.events || [];
    return events.map(normalizeEvent);
  } catch (err) {
    console.error('Ticketmaster fetch failed:', err.message);
    return [];
  }
}

function normalizeEvent(event) {
  const venue = event._embedded?.venues?.[0] || {};
  const priceRanges = event.priceRanges?.[0];
  const startDate = event.dates?.start;

  let startTime = null;
  if (startDate?.dateTime) {
    startTime = new Date(startDate.dateTime);
  } else if (startDate?.localDate && startDate?.localTime) {
    startTime = new Date(`${startDate.localDate}T${startDate.localTime}`);
  }

  // Determine category from Ticketmaster classifications
  const classification = event.classifications?.[0] || {};
  const segment = classification.segment?.name || '';
  const genre = classification.genre?.name || '';
  const subGenre = classification.subGenre?.name || '';

  return {
    name: event.name,
    venue_name: venue.name || 'TBA',
    venue_address: [venue.address?.line1, venue.city?.name].filter(Boolean).join(', '),
    neighborhood: venue.city?.name || '',
    start_time: startTime,
    category: mapCategory(segment),
    subcategory: genre || subGenre || '',
    price_min: priceRanges?.min || null,
    price_max: priceRanges?.max || null,
    is_free: priceRanges ? priceRanges.min === 0 : false,
    ticket_url: event.url || null,
  };
}

function mapCategory(segment) {
  const map = {
    'Music': 'live_music',
    'Arts & Theatre': 'theater',
    'Sports': 'sports',
    'Film': 'film',
    'Miscellaneous': 'event',
  };
  return map[segment] || 'event';
}

// Ticketmaster wants: 2024-02-14T20:00:00Z
function formatTMDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function formatEventForPrompt(event) {
  const time = event.start_time
    ? event.start_time.toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'time TBA';

  let price = '';
  if (event.is_free) price = ' — FREE';
  else if (event.price_min) price = ` — $${event.price_min}+`;

  return `- ${event.name} at ${event.venue_name}, ${time}${price} (${event.category}/${event.subcategory})`;
}

module.exports = { fetchEvents, formatEventForPrompt };
