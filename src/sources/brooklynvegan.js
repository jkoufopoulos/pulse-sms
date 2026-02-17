const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood, inferCategory } = require('../geo');
const { learnVenueCoords } = require('../venues');

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

module.exports = { fetchBrooklynVeganEvents };
