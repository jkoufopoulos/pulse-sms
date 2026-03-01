const { makeEventId, FETCH_HEADERS, isInsideNYC } = require('./shared');
const { resolveNeighborhood, inferCategory, getNycDateString } = require('../geo');
const { learnVenueCoords } = require('../venues');

async function fetchBrooklynVeganEvents() {
  console.log('Fetching BrooklynVegan...');
  try {
    const events = [];
    const seen = new Set();

    // Build 7-day date list; fall back to today/tomorrow if date URLs 404
    const days = [];
    for (let i = 0; i < 7; i++) days.push(getNycDateString(i));

    for (const day of days) {
      const url = `https://nyc-shows.brooklynvegan.com/events.json?date=${day}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': FETCH_HEADERS['User-Agent'], 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`BrooklynVegan ${day} fetch failed: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const groups = data.event_groups || [];
      const items = groups.flatMap(g => g.events || []);

      for (const item of items) {
        if (!item.title || item.sold_out) continue;

        const venue = item.venue || {};
        const lat = parseFloat(venue.latitude);
        const lng = parseFloat(venue.longitude);
        const venueName = venue.title || null;

        // Filter: outside NYC bounding box
        if (!isNaN(lat) && !isNaN(lng) && !isInsideNYC(lat, lng)) continue;

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
        let priceDisplay = null;
        if (isFree) {
          priceDisplay = 'free';
        } else if (item.ticket_info) {
          // Extract lowest dollar amount from ticket_info (may contain "$20", "$43.26, $48.41, 18+", "21+", etc.)
          const prices = [...item.ticket_info.matchAll(/\$(\d+(?:\.\d{2})?)/g)].map(m => parseFloat(m[1]));
          if (prices.length > 0) {
            priceDisplay = `$${Math.min(...prices)}`;
          } else if (/\bfree\b/i.test(item.ticket_info)) {
            priceDisplay = 'free';
          }
        }

        events.push({
          id,
          source_name: 'brooklynvegan',
          source_type: 'curated',
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
