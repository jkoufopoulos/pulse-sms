const { makeEventId, isInsideNYC } = require('./shared');
const { getNycDateString, resolveNeighborhood } = require('../geo');
const { learnVenueCoords } = require('../venues');

const API_URL = 'https://api.lu.ma/discover/get-paginated-events';
const PAGE_LIMIT = 50;
const MAX_PAGES = 20; // safety cap: 50 * 20 = 1000 events max

/**
 * Infer event category from name keywords.
 * Luma's API doesn't include categories, so we use name-based heuristics.
 */
function inferCategory(name) {
  const lower = (name || '').toLowerCase();

  // Music / DJ / concert
  if (/\b(dj|concert|live music|open mic|karaoke|jazz|hip hop|r&b)\b/.test(lower)) return 'live_music';
  if (/\b(comedy|stand-up|standup|improv|open mic comedy)\b/.test(lower)) return 'comedy';
  if (/\b(film|screening|movie|cinema|documentary)\b/.test(lower)) return 'film';
  if (/\b(theater|theatre|play|musical|performance|dance show|ballet|opera)\b/.test(lower)) return 'theater';
  if (/\b(trivia|quiz night|pub quiz)\b/.test(lower)) return 'trivia';
  if (/\b(gallery|art opening|exhibition|art show|art walk|museum)\b/.test(lower)) return 'art';
  if (/\b(party|club night|rave|dance party|afterparty|after party|dayparty|day party|brunch party)\b/.test(lower)) return 'nightlife';
  if (/\b(pop-?up|market|bazaar|flea|food fest|tasting|wine|cocktail|supper club|dinner party)\b/.test(lower)) return 'food_drink';
  if (/\b(workshop|class|masterclass|bootcamp|seminar|tutorial|studio)\b/.test(lower)) return 'community';
  if (/\b(meetup|meet-up|mixer|networking|social|happy hour|hangout)\b/.test(lower)) return 'community';
  if (/\b(yoga|meditation|breathwork|sound bath|wellness|fitness|run club|pilates)\b/.test(lower)) return 'community';
  if (/\b(hackathon|demo day|pitch|startup|founder|ai |crypto|web3|blockchain|tech)\b/.test(lower)) return 'community';
  if (/\b(book club|reading|poetry|spoken word|literary|author|book discussion)\b/.test(lower)) return 'community';
  if (/\b(dinner|supper|brunch|cooking|dumpling|baking|chef|food|pizza|chai)\b/.test(lower)) return 'food_drink';
  if (/\b(craft|paint|drawing|ceramic|pottery|sewing|knit|collage|zine)\b/.test(lower)) return 'art';
  if (/\b(talk|panel|discussion|lecture|fireside|q&a|conversation|salon)\b/.test(lower)) return 'community';
  if (/\b(ceremony|ritual|circle|cacao|ecstatic|kirtan|healing)\b/.test(lower)) return 'community';
  if (/\b(game night|board game|mahjong|chess|bingo|arcade)\b/.test(lower)) return 'community';
  if (/\b(tour|walk|bike ride|run |hike)\b/.test(lower)) return 'community';
  if (/\b(open house|launch|anniversary|celebration|fest|festival)\b/.test(lower)) return 'community';
  if (/\b(purim|shabbat|seder|church|prayer|worship)\b/.test(lower)) return 'community';

  return 'community';
}

/**
 * Extract a venue name from Luma's geo_address_info.
 * Prefers the `address` field (often a venue name like "Industry City"),
 * falls back to sublocality or short_address.
 */
function extractVenueName(geo) {
  if (!geo) return 'TBA';
  // `address` is often a named venue; `sublocality` is sometimes the venue
  // `short_address` is a street address fallback
  const name = geo.address || geo.sublocality || null;
  if (name && name.length > 2 && name.length < 100) return name;
  if (geo.short_address) return geo.short_address;
  return 'TBA';
}

async function fetchLumaEvents() {
  console.log('Fetching Luma...');
  try {
    const today = getNycDateString(0);
    const endDate = getNycDateString(7);

    const allEntries = [];
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        city: 'New York',
        geo_latitude: '40.7128',
        geo_longitude: '-74.0060',
        pagination_limit: String(PAGE_LIMIT),
      });
      if (cursor) params.set('pagination_cursor', cursor);

      const res = await fetch(`${API_URL}?${params}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.error(`Luma fetch failed: ${res.status}`);
        break;
      }

      const data = await res.json();
      const entries = data.entries || [];
      allEntries.push(...entries);

      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    console.log(`Luma: ${allEntries.length} raw entries fetched`);

    const events = [];
    const seen = new Set();

    for (const entry of allEntries) {
      const ev = entry.event;
      if (!ev || !ev.name) continue;

      // Skip virtual/online events
      if (ev.location_type !== 'offline') continue;

      // Skip obfuscated locations (no usable venue info)
      const geo = ev.geo_address_info;
      const coord = ev.coordinate;
      if (geo?.mode === 'obfuscated' && !coord) continue;

      // NYC bounding box filter — the API's city param isn't strict
      const cLat = parseFloat(coord?.latitude);
      const cLng = parseFloat(coord?.longitude);
      if (!isNaN(cLat) && !isNaN(cLng) && !isInsideNYC(cLat, cLng)) continue;

      // Address/city filter — bbox includes parts of NJ (Jersey City, Hoboken)
      const geoCity = (geo?.city_state || geo?.city || '').toLowerCase();
      const geoAddr = (geo?.full_address || geo?.short_address || '').toLowerCase();
      const geoText = geoCity + ' ' + geoAddr;
      if (/\b(new jersey|new jersey|nj\b|jersey city|hoboken|hackensack|newark|clifton|montclair|englewood|bayonne|weehawken|union city|fort lee|westchester|yonkers|white plains|connecticut)\b/.test(geoText)) continue;

      // Extract date in NYC timezone
      if (!ev.start_at) continue;
      const startAt = new Date(ev.start_at);
      if (isNaN(startAt.getTime())) continue;
      const dateLocal = startAt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

      // Date filter: only keep events within 7-day window
      if (dateLocal < today || dateLocal > endDate) continue;
      const startTimeLocal = ev.start_at; // already ISO 8601

      let endTimeLocal = null;
      if (ev.end_at) {
        endTimeLocal = ev.end_at;
      }

      const venueName = extractVenueName(geo);
      const venueAddress = geo?.full_address || geo?.short_address || null;

      // Learn venue coords for other sources
      const lat = coord?.latitude;
      const lng = coord?.longitude;
      if (venueName && venueName !== 'TBA' && lat && lng) {
        learnVenueCoords(venueName, lat, lng);
      }

      const neighborhood = resolveNeighborhood(null, lat, lng);

      const name = ev.name.trim();
      const id = makeEventId(name, venueName, dateLocal, 'luma', `https://lu.ma/${ev.url}`, startTimeLocal);
      if (seen.has(id)) continue;
      seen.add(id);

      // Note: Luma discover API doesn't include descriptions (only on per-event detail endpoint)

      // Price info
      const ti = entry.ticket_info || {};
      const isFree = ti.is_free === true;
      let priceDisplay = null;
      if (isFree) {
        priceDisplay = 'free';
      } else if (ti.price?.cents) {
        const dollars = Math.round(ti.price.cents / 100);
        if (ti.max_price?.cents && ti.max_price.cents !== ti.price.cents) {
          const maxDollars = Math.round(ti.max_price.cents / 100);
          priceDisplay = `$${dollars}-$${maxDollars}`;
        } else {
          priceDisplay = `$${dollars}`;
        }
      }

      events.push({
        id,
        source_name: 'Luma',
        source_type: 'aggregator',
        name,
        description_short: null,
        short_detail: null,
        venue_name: venueName,
        venue_address: venueAddress,
        neighborhood,
        start_time_local: startTimeLocal,
        end_time_local: endTimeLocal,
        date_local: dateLocal,
        time_window: null,
        is_free: isFree,
        price_display: priceDisplay,
        category: inferCategory(name),
        subcategory: null,
        ticket_url: `https://lu.ma/${ev.url}`,
        source_url: `https://lu.ma/${ev.url}`,
        map_url: null,
        map_hint: geo?.short_address || null,
      });
    }

    console.log(`Luma: ${events.length} events (after date/location filter)`);
    return events;
  } catch (err) {
    console.error('Luma error:', err.message);
    return [];
  }
}

module.exports = { fetchLumaEvents, inferCategory };
