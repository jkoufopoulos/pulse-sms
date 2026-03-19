/**
 * places.js — Google Maps Places API client with neighborhood-level caching.
 *
 * Fetches bars and restaurants via Places API (New), normalizes to internal schema,
 * caches in SQLite with 24hr TTL. Feature disabled if GOOGLE_MAPS_API_KEY is missing.
 */

const { getDb } = require('./db');
const { NEIGHBORHOODS } = require('./neighborhoods');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Google Places type mapping
const PLACE_TYPE_MAP = {
  bar: ['bar'],
  restaurant: ['restaurant'],
};

// Vibe filter → attribute mapping
const VIBE_FILTERS = {
  dive: { filter: (p) => (p.price_level ?? 2) <= 1 },
  cocktail: { filter: (p) => p.serves_cocktails },
  wine: { filter: (p) => p.serves_wine },
  rooftop: { filter: (p) => p.outdoor_seating },
  date_night: { filter: (p) => (p.price_level ?? 2) >= 2 && (p.rating ?? 0) >= 4.0 },
  group_friendly: { filter: (p) => p.good_for_groups },
  outdoor: { filter: (p) => p.outdoor_seating },
  live_music: { filter: (p) => p.live_music },
  casual: { filter: (p) => (p.price_level ?? 2) <= 2 },
  upscale: { filter: (p) => (p.price_level ?? 2) >= 3 },
};

/**
 * Main entry point. Checks cache, falls back to API.
 * Returns scored pool of up to 8 places.
 */
async function searchPlaces(neighborhood, placeType, options = {}) {
  if (!GOOGLE_MAPS_API_KEY) return [];

  const hoodData = NEIGHBORHOODS[neighborhood];
  if (!hoodData) return [];

  const neighborhoodKey = `${neighborhood.toLowerCase()}|${placeType}`;

  // Check cache
  const cached = getCachedPlaces(neighborhoodKey);
  if (cached.length > 0) {
    let pool = cached;
    if (options.vibe) {
      pool = filterByVibe(pool, options.vibe);
    }
    pool.sort((a, b) => scorePlaceInterestingness(b, options.vibe) - scorePlaceInterestingness(a, options.vibe));
    return pool.slice(0, 8);
  }

  // Fetch from API
  const radiusKm = hoodData.radius_km || 1.0;
  let places;
  try {
    places = await fetchFromGoogleMaps(hoodData.lat, hoodData.lng, radiusKm, placeType);
  } catch (err) {
    console.error(`[places] Google Maps API error: ${err.message}`);
    return [];
  }

  if (!places || places.length === 0) return [];

  // Normalize and cache
  const normalized = places.map(p => normalizePlace(p, neighborhood));
  cachePlaces(normalized, neighborhoodKey);

  // Filter and score
  let pool = normalized;
  if (options.vibe) {
    pool = filterByVibe(pool, options.vibe);
  }
  pool.sort((a, b) => scorePlaceInterestingness(b, options.vibe) - scorePlaceInterestingness(a, options.vibe));
  return pool.slice(0, 8);
}

/**
 * Call Google Maps Nearby Search (New) API.
 * Uses POST https://places.googleapis.com/v1/places:searchNearby
 */
async function fetchFromGoogleMaps(lat, lng, radiusKm, placeType) {
  const radiusMeters = Math.round(radiusKm * 1000);
  const includedTypes = PLACE_TYPE_MAP[placeType] || ['restaurant'];

  const body = {
    includedTypes,
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radiusMeters,
      },
    },
  };

  const fieldMask = [
    'places.id', 'places.displayName', 'places.formattedAddress',
    'places.location', 'places.priceLevel', 'places.rating',
    'places.userRatingCount', 'places.googleMapsUri',
    'places.editorialSummary', 'places.servesWine', 'places.servesBeer',
    'places.servesCocktails', 'places.outdoorSeating', 'places.goodForGroups',
    'places.liveMusic', 'places.regularOpeningHours',
  ].join(',');

  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Places API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.places || [];
}

/**
 * Get cached places for a neighborhood key within TTL.
 */
function getCachedPlaces(neighborhoodKey, ttlMs = CACHE_TTL_MS) {
  const d = getDb();
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const rows = d.prepare(
    'SELECT * FROM places WHERE neighborhood_key = ? AND cached_at > ?'
  ).all(neighborhoodKey, cutoff);
  return rows.map(rowToPlace);
}

/**
 * Batch upsert places into cache.
 */
function cachePlaces(places, neighborhoodKey) {
  const d = getDb();
  const now = new Date().toISOString();

  const insert = d.prepare(`
    INSERT OR REPLACE INTO places (
      place_id, name, address, neighborhood, lat, lng, place_type,
      price_level, rating, user_ratings_total, google_maps_url,
      editorial_summary, serves_beer, serves_wine, serves_cocktails,
      outdoor_seating, good_for_groups, live_music, open_hours_json,
      cached_at, neighborhood_key
    ) VALUES (
      @place_id, @name, @address, @neighborhood, @lat, @lng, @place_type,
      @price_level, @rating, @user_ratings_total, @google_maps_url,
      @editorial_summary, @serves_beer, @serves_wine, @serves_cocktails,
      @outdoor_seating, @good_for_groups, @live_music, @open_hours_json,
      @cached_at, @neighborhood_key
    )
  `);

  const tx = d.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  tx(places.map(p => ({
    place_id: p.place_id,
    name: p.name,
    address: p.address || null,
    neighborhood: p.neighborhood || null,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    place_type: p.place_type || null,
    price_level: p.price_level ?? null,
    rating: p.rating ?? null,
    user_ratings_total: p.user_ratings_total ?? null,
    google_maps_url: p.google_maps_url || null,
    editorial_summary: p.editorial_summary || null,
    serves_beer: p.serves_beer ? 1 : 0,
    serves_wine: p.serves_wine ? 1 : 0,
    serves_cocktails: p.serves_cocktails ? 1 : 0,
    outdoor_seating: p.outdoor_seating ? 1 : 0,
    good_for_groups: p.good_for_groups ? 1 : 0,
    live_music: p.live_music ? 1 : 0,
    open_hours_json: p.open_hours_json ? JSON.stringify(p.open_hours_json) : null,
    cached_at: now,
    neighborhood_key: neighborhoodKey,
  })));
}

/**
 * Convert Google Places API response to internal schema.
 */
function normalizePlace(googlePlace, neighborhood) {
  const priceLevelMap = {
    'PRICE_LEVEL_FREE': 0,
    'PRICE_LEVEL_INEXPENSIVE': 1,
    'PRICE_LEVEL_MODERATE': 2,
    'PRICE_LEVEL_EXPENSIVE': 3,
    'PRICE_LEVEL_VERY_EXPENSIVE': 4,
  };

  return {
    place_id: googlePlace.id || '',
    name: googlePlace.displayName?.text || googlePlace.displayName || '',
    address: googlePlace.formattedAddress || null,
    neighborhood,
    lat: googlePlace.location?.latitude ?? null,
    lng: googlePlace.location?.longitude ?? null,
    place_type: (googlePlace.includedTypes || googlePlace.types || []).includes('bar') ? 'bar' : 'restaurant',
    price_level: priceLevelMap[googlePlace.priceLevel] ?? (typeof googlePlace.priceLevel === 'number' ? googlePlace.priceLevel : null),
    rating: googlePlace.rating ?? null,
    user_ratings_total: googlePlace.userRatingCount ?? null,
    google_maps_url: googlePlace.googleMapsUri || null,
    editorial_summary: googlePlace.editorialSummary?.text || null,
    serves_beer: !!googlePlace.servesBeer,
    serves_wine: !!googlePlace.servesWine,
    serves_cocktails: !!googlePlace.servesCocktails,
    outdoor_seating: !!googlePlace.outdoorSeating,
    good_for_groups: !!googlePlace.goodForGroups,
    live_music: !!googlePlace.liveMusic,
    open_hours_json: googlePlace.regularOpeningHours?.weekdayDescriptions || null,
  };
}

/**
 * Convert SQLite row to place object.
 */
function rowToPlace(row) {
  return {
    ...row,
    serves_beer: !!row.serves_beer,
    serves_wine: !!row.serves_wine,
    serves_cocktails: !!row.serves_cocktails,
    outdoor_seating: !!row.outdoor_seating,
    good_for_groups: !!row.good_for_groups,
    live_music: !!row.live_music,
    open_hours_json: row.open_hours_json ? JSON.parse(row.open_hours_json) : null,
  };
}

/**
 * Score a place's interestingness for ranking.
 * Higher = more interesting. Factors: rating, review count, vibe match.
 */
function scorePlaceInterestingness(place, vibeFilter) {
  const rating = place.rating ?? 3.0;
  const reviews = place.user_ratings_total ?? 10;
  let score = rating * Math.log10(Math.max(reviews, 1) + 1);

  // Bonus for vibe match
  if (vibeFilter && VIBE_FILTERS[vibeFilter]) {
    if (VIBE_FILTERS[vibeFilter].filter(place)) {
      score += 1.5;
    }
  }

  // Bonus for editorial summary (richer data = more interesting to describe)
  if (place.editorial_summary) score += 0.5;

  return score;
}

/**
 * Filter places by vibe. Returns subset matching the vibe attributes.
 * Falls back to full list if no matches.
 */
function filterByVibe(places, vibe) {
  if (!vibe || !VIBE_FILTERS[vibe]) return places;
  const filtered = places.filter(VIBE_FILTERS[vibe].filter);
  return filtered.length > 0 ? filtered : places;
}

/**
 * Serialize place pool for LLM context (compact format).
 */
function serializePlacePoolForContinuation(places, neighborhood, placeType, vibe) {
  const priceLabelMap = { 0: 'Free', 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };
  return {
    neighborhood: neighborhood || 'NYC',
    place_type: placeType,
    vibe: vibe || undefined,
    match_count: places.length,
    places: places.map(p => ({
      place_id: p.place_id,
      name: p.name,
      neighborhood: p.neighborhood,
      place_type: p.place_type,
      price_level: priceLabelMap[p.price_level] ?? null,
      rating: p.rating,
      review_count: p.user_ratings_total,
      editorial_summary: (p.editorial_summary || '').slice(0, 100) || undefined,
      serves_cocktails: p.serves_cocktails || undefined,
      serves_wine: p.serves_wine || undefined,
      outdoor_seating: p.outdoor_seating || undefined,
      good_for_groups: p.good_for_groups || undefined,
      live_music: p.live_music || undefined,
    })),
  };
}

// --- Single-venue Google Places lookup with JSON file cache ---

const venuesCachePath = require('path').join(__dirname, '../data/venue-places-cache.json');
let venuePlacesCache = {};
try {
  venuePlacesCache = JSON.parse(require('fs').readFileSync(venuesCachePath, 'utf8'));
  console.log(`Loaded ${Object.keys(venuePlacesCache).length} cached venue lookups`);
} catch {
  console.log('No venue places cache found, starting fresh');
}

function normalizeVenueName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function getVenuePlacesCache() {
  return venuePlacesCache;
}

function clearVenuePlacesCache() {
  venuePlacesCache = {};
}

function saveVenuePlacesCache() {
  try {
    require('fs').writeFileSync(venuesCachePath, JSON.stringify(venuePlacesCache, null, 2));
  } catch (err) {
    console.warn('[places] Failed to save venue places cache:', err.message);
  }
}

/**
 * Look up a single venue by name via Google Places Text Search API.
 * Checks JSON file cache first, then calls API if needed.
 * Returns structured venue data or { not_found: true } on failure.
 */
async function lookupVenueFromGoogle(venueName, neighborhood) {
  const cacheKey = normalizeVenueName(venueName);
  if (!cacheKey) return { not_found: true, message: "No venue name provided." };

  // Cache hit
  if (venuePlacesCache[cacheKey]) {
    return venuePlacesCache[cacheKey];
  }

  // No API key — graceful fallback
  if (!GOOGLE_MAPS_API_KEY) {
    return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
  }

  try {
    const query = `${venueName} ${neighborhood || 'NYC'}`;
    const fieldMask = [
      'places.id', 'places.displayName', 'places.formattedAddress',
      'places.priceLevel', 'places.rating', 'places.googleMapsUri',
      'places.editorialSummary', 'places.regularOpeningHours',
      'places.currentOpeningHours',
    ].join(',');

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });

    if (!response.ok) {
      console.warn(`[places] Venue lookup API error: ${response.status}`);
      return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
    }

    const data = await response.json();
    const place = data.places?.[0];
    if (!place) {
      return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
    }

    const priceLevelMap = {
      'PRICE_LEVEL_FREE': 0, 'PRICE_LEVEL_INEXPENSIVE': 1,
      'PRICE_LEVEL_MODERATE': 2, 'PRICE_LEVEL_EXPENSIVE': 3,
      'PRICE_LEVEL_VERY_EXPENSIVE': 4,
    };

    const hours = place.regularOpeningHours?.weekdayDescriptions;
    const isOpenNow = place.currentOpeningHours?.openNow ?? null;

    const result = {
      name: place.displayName?.text || venueName,
      address: place.formattedAddress || null,
      rating: place.rating ?? null,
      price_level: priceLevelMap[place.priceLevel] ?? null,
      hours: hours ? hours.join(', ') : null,
      editorial_summary: place.editorialSummary?.text || null,
      open_now: isOpenNow,
      google_maps_url: place.googleMapsUri || null,
      fetched_at: new Date().toISOString(),
    };

    // Cache and persist
    venuePlacesCache[cacheKey] = result;
    saveVenuePlacesCache();

    return result;
  } catch (err) {
    console.warn(`[places] Venue lookup failed: ${err.message}`);
    return { not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." };
  }
}

module.exports = {
  searchPlaces,
  fetchFromGoogleMaps,
  getCachedPlaces,
  cachePlaces,
  normalizePlace,
  scorePlaceInterestingness,
  filterByVibe,
  serializePlacePoolForContinuation,
  VIBE_FILTERS,
  lookupVenueFromGoogle,
  getVenuePlacesCache,
  clearVenuePlacesCache,
};
