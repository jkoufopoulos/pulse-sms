const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString, resolveNeighborhood, inferCategory } = require('../geo');
const { learnVenueCoords } = require('../venues');

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
      if (venue.name && !isNaN(geoLat) && !isNaN(geoLng)) {
        learnVenueCoords(venue.name, geoLat, geoLng);
      }
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

module.exports = { fetchDiceEvents };
