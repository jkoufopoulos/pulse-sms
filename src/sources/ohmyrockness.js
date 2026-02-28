const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood, inferCategory } = require('../geo');
const { learnVenueCoords } = require('../venues');

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

    // Show data is embedded as JSON in data-shows attributes on div elements
    const allShows = [];
    $('[data-shows]').each((_, el) => {
      try {
        const data = JSON.parse($(el).attr('data-shows'));
        if (Array.isArray(data)) allShows.push(...data);
      } catch (e) { /* skip malformed */ }
    });

    if (allShows.length === 0) {
      console.warn('Oh My Rockness: no data-shows elements found');
      return [];
    }

    const events = [];
    const seen = new Set();

    for (const show of allShows) {
      if (!show.cached_bands?.length || show.sold_out) continue;

      const venue = show.venue || {};
      const lat = parseFloat(venue.latitude);
      const lng = parseFloat(venue.longitude);
      const venueName = venue.name || null;

      if (venueName && !isNaN(lat) && !isNaN(lng)) {
        learnVenueCoords(venueName, lat, lng);
      }

      const neighborhood = (!isNaN(lat) && !isNaN(lng))
        ? resolveNeighborhood(null, lat, lng)
        : resolveNeighborhood(null, null, null);

      const startsAt = show.starts_at || null;
      const dateLocal = startsAt ? startsAt.slice(0, 10) : null;

      const bandNames = show.cached_bands.map(b => b.name).filter(Boolean);
      const name = bandNames.join(', ') || 'Unknown Show';
      const desc = bandNames.length > 3
        ? bandNames.slice(0, 3).join(', ') + ` + ${bandNames.length - 3} more`
        : bandNames.join(', ');

      const inferred = inferCategory(name.toLowerCase());
      const category = inferred === 'other' ? 'live_music' : inferred;

      const id = makeEventId(name, venueName, dateLocal, 'ohmyrockness');
      if (seen.has(id)) continue;
      seen.add(id);

      const isFree = /free/i.test(show.price || '');
      const priceDisplay = show.price || null;

      const sourceUrl = show.url
        ? show.url.replace('http://ohmyrockness.com', 'https://www.ohmyrockness.com')
        : null;

      events.push({
        id,
        source_name: 'ohmyrockness',
        source_type: 'curated',
        name,
        description_short: desc ? desc.slice(0, 180) : null,
        short_detail: desc ? desc.slice(0, 180) : null,
        venue_name: venueName || 'TBA',
        venue_address: venue.full_address || null,
        neighborhood,
        start_time_local: startsAt || null,
        end_time_local: null,
        date_local: dateLocal,
        time_window: null,
        is_free: isFree,
        price_display: priceDisplay,
        category,
        subcategory: null,
        ticket_url: show.tickets_url || null,
        source_url: sourceUrl,
        map_url: null,
        map_hint: venue.full_address || null,
      });
    }

    console.log(`Oh My Rockness: ${events.length} events (from ${allShows.length} shows)`);
    return events;
  } catch (err) {
    console.error('Oh My Rockness error:', err.message);
    return [];
  }
}

module.exports = { fetchOhMyRockness };
