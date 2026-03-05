const { makeEventId, isInsideNYC } = require('./shared');
const { getNycDateString, resolveNeighborhood } = require('../geo');
const { learnVenueCoords } = require('../venues');

const API_URL = 'https://api.lu.ma/discover/get-paginated-events';
const DETAIL_API_URL = 'https://api.lu.ma/event/get';
const PAGE_LIMIT = 50;
const MAX_PAGES = 20; // safety cap: 50 * 20 = 1000 events max
const DETAIL_BATCH_SIZE = 10;

/**
 * Extract plain text from ProseMirror JSON (Luma's description format).
 * Recursively walks nodes, extracts text content, joins with spaces.
 */
function extractTextFromProseMirror(node) {
  if (!node) return '';
  const parts = [];
  if (node.text) parts.push(node.text);
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      parts.push(extractTextFromProseMirror(child));
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * Map Luma category labels to our categories.
 */
const LUMA_CATEGORY_MAP = {
  music: 'live_music',
  comedy: 'comedy',
  nightlife: 'nightlife',
  film: 'film',
  theater: 'theater',
  arts: 'art',
  art: 'art',
  food: 'food_drink',
  fitness: 'community',
  wellness: 'community',
  tech: 'community',
  ai: 'community',
  crypto: 'community',
};

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
      const isJC = /\bjersey city\b/.test(geoText);
      if (!isJC && /\b(new jersey|nj\b|hoboken|hackensack|newark|clifton|montclair|englewood|bayonne|weehawken|union city|fort lee|westchester|yonkers|white plains|connecticut)\b/.test(geoText)) continue;

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

      // Social proof + capacity from API
      const ti = entry.ticket_info || {};
      const guestCount = entry.guest_count || 0;
      const isSoldOut = ti.is_sold_out === true;
      const isNearCapacity = ti.is_near_capacity === true;
      const spotsRemaining = ti.spots_remaining || null;
      const hostName = (entry.hosts || [])[0]?.name || null;

      // Build description from social/capacity signals (API doesn't include event descriptions)
      const descParts = [];
      if (hostName) descParts.push(`Hosted by ${hostName}`);
      if (isSoldOut) {
        descParts.push('SOLD OUT');
      } else if (isNearCapacity) {
        descParts.push(spotsRemaining ? `Almost full (${spotsRemaining} spots left)` : 'Almost full');
      }
      if (guestCount >= 20) descParts.push(`${guestCount} going`);
      const descShort = descParts.length > 0 ? descParts.join('. ') : null;

      // Price info
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
        _apiId: ev.api_id || null, // used by enrichFromDetailAPI, removed after
        id,
        source_name: 'Luma',
        source_type: 'aggregator',
        name,
        description_short: descShort,
        short_detail: descShort,
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

    // Editorial filter: drop professional/corporate events that don't fit the nightlife/discovery vibe
    const LUMA_NOISE_RE = /\b(networking|coworking|pitch\s+and|founders?\b|office hours|bootcamp|webinar|accelerator|hackathon|investor|startup|fundrais|venture|incubator|summit|conference|certification|training|demo\s+day|pre-seed|seed\s+round)\b/i;
    const beforeFilter = events.length;
    const filtered = events.filter(e => {
      // Drop keyword-matched professional events
      if (LUMA_NOISE_RE.test(e.name)) return false;
      // Drop weekday events starting before 5pm ET (21:00 UTC in EDT)
      const t = e.start_time_local;
      if (t) {
        const dt = new Date(t);
        const utcHour = dt.getUTCHours();
        const day = dt.getUTCDay(); // 0=Sun, 6=Sat
        const isWeekday = day >= 1 && day <= 5;
        if (isWeekday && utcHour >= 7 && utcHour < 21) return false;
      }
      return true;
    });
    console.log(`Luma: ${filtered.length} events (${beforeFilter} before editorial filter)`);

    // Enrich with descriptions from detail API
    await enrichFromDetailAPI(filtered);

    return filtered;
  } catch (err) {
    console.error('Luma error:', err.message);
    return [];
  }
}

/**
 * Fetch event detail pages from Luma's internal API to get descriptions.
 * The discover API doesn't include descriptions; the detail API returns
 * `description_mirror` (ProseMirror JSON) and `categories`.
 */
async function enrichFromDetailAPI(events) {
  const needsEnrich = events.filter(e => e._apiId);
  if (needsEnrich.length === 0) return;

  let enriched = 0;
  let catImproved = 0;

  for (let i = 0; i < needsEnrich.length; i += DETAIL_BATCH_SIZE) {
    const batch = needsEnrich.slice(i, i + DETAIL_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async evt => {
      const res = await fetch(`${DETAIL_API_URL}?event_api_id=${evt._apiId}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      return { evt, data: await res.json() };
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { evt, data } = r.value;

      // Extract description from ProseMirror JSON (top-level field, not inside data.event)
      if (data.description_mirror) {
        let text;
        try {
          const mirror = typeof data.description_mirror === 'string'
            ? JSON.parse(data.description_mirror)
            : data.description_mirror;
          text = extractTextFromProseMirror(mirror).replace(/\s+/g, ' ').trim();
        } catch { /* ignore parse errors */ }
        if (text && text.length > 10) {
          const desc = text.length > 180 ? text.slice(0, 177) + '...' : text;
          // Prepend social proof if we already have it, append description
          if (evt.description_short) {
            evt.description_short = evt.description_short + '. ' + desc;
            evt.short_detail = evt.description_short;
          } else {
            evt.description_short = desc;
            evt.short_detail = desc;
          }
          enriched++;
        }
      }

      // Use Luma's own categories to improve inference
      const cats = data.categories || [];
      if (cats.length > 0) {
        const lumaCat = (cats[0].slug || cats[0].name || '').toLowerCase();
        const mapped = LUMA_CATEGORY_MAP[lumaCat];
        if (mapped && evt.category === 'community') {
          evt.category = mapped;
          catImproved++;
        }
      }
    }
  }

  // Clean up internal field
  for (const evt of events) delete evt._apiId;

  if (enriched > 0 || catImproved > 0) {
    console.log(`Luma: enriched ${enriched} descriptions, ${catImproved} categories from ${needsEnrich.length} detail API calls`);
  }
}

module.exports = { fetchLumaEvents, inferCategory };
