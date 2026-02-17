const NEIGHBORHOODS = {
  'East Village': {
    lat: 40.7264, lng: -73.9818, radius_km: 0.8,
    aliases: ['east village', 'ev', 'e village', 'e.v.', 'e.v']
  },
  'West Village': {
    lat: 40.7336, lng: -73.9999, radius_km: 0.7,
    aliases: ['west village', 'wv', 'w village', 'the village']
  },
  'Lower East Side': {
    lat: 40.7150, lng: -73.9843, radius_km: 0.8,
    aliases: ['lower east side', 'les', 'lower east', 'chinatown', 'little italy']
  },
  'Williamsburg': {
    lat: 40.7081, lng: -73.9571, radius_km: 1.2,
    aliases: ['williamsburg', 'wburg', 'billyburg']
  },
  'Bushwick': {
    lat: 40.6944, lng: -73.9213, radius_km: 1.0,
    aliases: ['bushwick', 'east williamsburg', 'east wburg', 'ridgewood']
  },
  'Chelsea': {
    lat: 40.7465, lng: -74.0014, radius_km: 0.8,
    aliases: ['chelsea', 'meatpacking', 'meatpacking district']
  },
  'SoHo': {
    lat: 40.7233, lng: -73.9985, radius_km: 0.6,
    aliases: ['soho', 'so ho', 'nolita']
  },
  'NoHo': {
    lat: 40.7290, lng: -73.9937, radius_km: 0.4,
    aliases: ['noho', 'no ho']
  },
  'Tribeca': {
    lat: 40.7163, lng: -74.0086, radius_km: 0.6,
    aliases: ['tribeca', 'tri beca']
  },
  'Midtown': {
    lat: 40.7549, lng: -73.9840, radius_km: 1.5,
    aliases: ['midtown', 'midtown manhattan', 'times square', 'herald square', 'murray hill', 'kips bay']
  },
  'Upper West Side': {
    lat: 40.7870, lng: -73.9754, radius_km: 1.5,
    aliases: ['upper west side', 'uws', 'upper west']
  },
  'Upper East Side': {
    lat: 40.7736, lng: -73.9566, radius_km: 1.5,
    aliases: ['upper east side', 'ues', 'upper east']
  },
  'Harlem': {
    lat: 40.8116, lng: -73.9465, radius_km: 1.5,
    aliases: ['harlem']
  },
  'Astoria': {
    lat: 40.7723, lng: -73.9301, radius_km: 1.2,
    aliases: ['astoria']
  },
  'Long Island City': {
    lat: 40.7425, lng: -73.9561, radius_km: 1.0,
    aliases: ['long island city', 'lic']
  },
  'Greenpoint': {
    lat: 40.7274, lng: -73.9514, radius_km: 0.8,
    aliases: ['greenpoint', 'gpoint']
  },
  'Park Slope': {
    lat: 40.6710, lng: -73.9814, radius_km: 1.0,
    aliases: ['park slope', 'south slope']
  },
  'Downtown Brooklyn': {
    lat: 40.6934, lng: -73.9867, radius_km: 0.8,
    aliases: ['downtown brooklyn', 'downtown bk']
  },
  'DUMBO': {
    lat: 40.7033, lng: -73.9890, radius_km: 0.5,
    aliases: ['dumbo']
  },
  'Hell\'s Kitchen': {
    lat: 40.7638, lng: -73.9918, radius_km: 0.8,
    aliases: ["hell's kitchen", 'hells kitchen', 'hk', 'clinton']
  },
  'Greenwich Village': {
    lat: 40.7308, lng: -73.9973, radius_km: 0.7,
    aliases: ['greenwich village', 'greenwich']
  },
  'Flatiron': {
    lat: 40.7395, lng: -73.9903, radius_km: 0.6,
    aliases: ['flatiron', 'gramercy', 'union square', 'union sq']
  },
  'Financial District': {
    lat: 40.7075, lng: -74.0089, radius_km: 0.8,
    aliases: ['financial district', 'fidi', 'wall street', 'downtown manhattan']
  },
  'Crown Heights': {
    lat: 40.6694, lng: -73.9422, radius_km: 1.2,
    aliases: ['crown heights']
  },
  'Bed-Stuy': {
    lat: 40.6872, lng: -73.9418, radius_km: 1.2,
    aliases: ['bed-stuy', 'bed stuy', 'bedford stuyvesant', 'bedstuy']
  },
  'Fort Greene': {
    lat: 40.6892, lng: -73.9742, radius_km: 0.8,
    aliases: ['fort greene', 'clinton hill']
  },
  'Prospect Heights': {
    lat: 40.6775, lng: -73.9692, radius_km: 0.8,
    aliases: ['prospect heights']
  },
  'Cobble Hill': {
    lat: 40.6860, lng: -73.9957, radius_km: 0.8,
    aliases: ['cobble hill', 'boerum hill', 'carroll gardens']
  },
  'Gowanus': {
    lat: 40.6734, lng: -73.9880, radius_km: 0.8,
    aliases: ['gowanus']
  },
  'Red Hook': {
    lat: 40.6734, lng: -74.0080, radius_km: 0.8,
    aliases: ['red hook']
  },
  'Sunset Park': {
    lat: 40.6514, lng: -74.0027, radius_km: 1.2,
    aliases: ['sunset park', 'industry city']
  },
  'East Harlem': {
    lat: 40.7957, lng: -73.9389, radius_km: 1.2,
    aliases: ['east harlem', 'el barrio', 'spanish harlem']
  },
  'Washington Heights': {
    lat: 40.8417, lng: -73.9393, radius_km: 1.5,
    aliases: ['washington heights', 'wash heights', 'the heights', 'inwood']
  },
  'Jackson Heights': {
    lat: 40.7557, lng: -73.8831, radius_km: 1.2,
    aliases: ['jackson heights']
  },
  'Flushing': {
    lat: 40.7580, lng: -73.8317, radius_km: 1.5,
    aliases: ['flushing', 'downtown flushing']
  },
};

// Build a flat lookup: alias → neighborhood name
const ALIAS_MAP = new Map();
for (const [name, data] of Object.entries(NEIGHBORHOODS)) {
  for (const alias of data.aliases) {
    ALIAS_MAP.set(alias, name);
  }
}

// Sort aliases longest-first so "east village" matches before "east"
const SORTED_ALIASES = [...ALIAS_MAP.keys()].sort((a, b) => b.length - a.length);

// Precompile word-boundary regexes to prevent false positives
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Boroughs → list of neighborhoods (for "narrow it down" flow)
const BOROUGHS = {
  'brooklyn': ['Williamsburg', 'Bushwick', 'Park Slope', 'DUMBO', 'Crown Heights', 'Bed-Stuy', 'Fort Greene', 'Prospect Heights', 'Cobble Hill', 'Gowanus', 'Red Hook', 'Greenpoint', 'Downtown Brooklyn', 'Sunset Park'],
  'queens': ['Astoria', 'Long Island City', 'Jackson Heights', 'Flushing'],
  'manhattan': ['East Village', 'West Village', 'Lower East Side', 'Chelsea', 'SoHo', 'NoHo', 'Tribeca', 'Midtown', 'Upper West Side', 'Upper East Side', 'Harlem', "Hell's Kitchen", 'Greenwich Village', 'Flatiron', 'Financial District', 'East Harlem', 'Washington Heights'],
};

// Borough aliases
const BOROUGH_ALIASES = {
  'brooklyn': 'brooklyn', 'bk': 'brooklyn', 'bklyn': 'brooklyn',
  'queens': 'queens', 'qns': 'queens',
  'manhattan': 'manhattan', 'nyc': 'manhattan', 'the city': 'manhattan',
};

/**
 * Detect if a message refers to a borough (not a specific neighborhood).
 * Returns { borough, neighborhoods } or null.
 */
function detectBorough(message) {
  const lower = message.toLowerCase().trim();
  // Check against borough aliases using word boundaries
  for (const [alias, borough] of Object.entries(BOROUGH_ALIASES)) {
    const regex = new RegExp(`(?<!\\w)${escapeRegex(alias)}(?!\\w)`);
    if (regex.test(lower)) {
      return { borough, neighborhoods: BOROUGHS[borough] };
    }
  }
  return null;
}

// Landmark and subway stop map — maps to specific neighborhoods
const BOROUGH_MAP = {
  // Landmarks
  'prospect park': 'Park Slope',
  'central park': 'Midtown',
  'washington square': 'Greenwich Village',
  'wash sq': 'Greenwich Village',
  'bryant park': 'Midtown',
  'mccarren park': 'Williamsburg',
  'mccarren': 'Williamsburg',
  'tompkins square': 'East Village',
  'tompkins': 'East Village',
  'domino park': 'Williamsburg',
  'brooklyn bridge': 'DUMBO',
  'highline': 'Chelsea',
  'high line': 'Chelsea',
  'hudson yards': 'Chelsea',
  'barclays': 'Downtown Brooklyn',
  'barclays center': 'Downtown Brooklyn',
  'msg': 'Midtown',
  'madison square garden': 'Midtown',
  'rockefeller': 'Midtown',
  'rock center': 'Midtown',
  'lincoln center': 'Upper West Side',
  'carnegie hall': 'Midtown',
  // Subway references
  'bedford ave': 'Williamsburg',
  'bedford stop': 'Williamsburg',
  '1st ave': 'East Village',
  'first ave': 'East Village',
  '14th street': 'Flatiron',
  '14th st': 'Flatiron',
  'grand central': 'Midtown',
  'atlantic ave': 'Downtown Brooklyn',
  'atlantic terminal': 'Downtown Brooklyn',
  'dekalb': 'Downtown Brooklyn',
};

// Combine neighborhood aliases + borough shortcuts, sorted longest-first
const ALL_ENTRIES = [
  ...SORTED_ALIASES.map(alias => ({ key: alias, value: ALIAS_MAP.get(alias) })),
  ...Object.entries(BOROUGH_MAP).map(([key, value]) => ({ key, value })),
].sort((a, b) => b.key.length - a.key.length);

const EXTRACT_PATTERNS = ALL_ENTRIES.map(({ key, value }) => ({
  value,
  regex: new RegExp(`(?<!\\w)${escapeRegex(key)}(?!\\w)`),
}));

function extractNeighborhood(message) {
  const lower = message.toLowerCase();
  for (const { value, regex } of EXTRACT_PATTERNS) {
    if (regex.test(lower)) {
      return value;
    }
  }
  return null;
}

function getNeighborhoodCoords(name) {
  const data = NEIGHBORHOODS[name];
  if (!data) return null;
  return { lat: data.lat, lng: data.lng, radius_km: data.radius_km };
}

module.exports = { NEIGHBORHOODS, extractNeighborhood, detectBorough, getNeighborhoodCoords };
