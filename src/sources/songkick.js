const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString, resolveNeighborhood } = require('../geo');
const { learnVenueCoords } = require('../venues');

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

          const geoLat = parseFloat(geo.latitude);
          const geoLng = parseFloat(geo.longitude);
          if (location.name && !isNaN(geoLat) && !isNaN(geoLng)) {
            learnVenueCoords(location.name, geoLat, geoLng);
          }
          const neighborhood = (isNaN(geoLat) && /^(new york|brooklyn|manhattan|queens)$/i.test((address.addressLocality || '').trim()))
            ? null
            : resolveNeighborhood(address.addressLocality, geoLat, geoLng);

          const id = makeEventId(e.name, location.name, startDate, 'songkick', null, e.startDate);

          // Description — performer names only (e.description is just name+venue, not useful)
          const performers = Array.isArray(e.performer)
            ? e.performer.map(p => p.name).filter(Boolean)
            : e.performer?.name ? [e.performer.name] : [];
          const desc = performers.length > 0
            ? performers.slice(0, 3).join(', ') + (performers.length > 3 ? ` + ${performers.length - 3} more` : '')
            : null;

          const offers = e.offers || {};
          const skPrice = parseFloat(offers.lowPrice || offers.price || '');
          const skName = (e.name || '').toLowerCase();
          const skFree = skPrice === 0 || skName.includes('free');

          events.push({
            id,
            source_name: 'songkick',
            source_type: 'aggregator',
            name: e.name,
            description_short: desc,
            short_detail: desc,
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

module.exports = { fetchSongkickEvents };
