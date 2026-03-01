const NEIGHBORHOODS = {
  // === MANHATTAN ===
  'East Village': {
    lat: 40.7264, lng: -73.9818, radius_km: 0.8,
    aliases: ['east village', 'ev', 'e village', 'e.v.', 'e.v', 'alphabet city']
  },
  'West Village': {
    lat: 40.7336, lng: -73.9999, radius_km: 0.7,
    aliases: ['west village', 'wv', 'w village', 'the village']
  },
  'Lower East Side': {
    lat: 40.7150, lng: -73.9843, radius_km: 0.8,
    aliases: ['lower east side', 'les', 'lower east', 'chinatown', 'little italy', 'bowery', 'the bowery', 'two bridges']
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
    aliases: ['midtown', 'midtown manhattan', 'times square', 'herald square', 'midtown west']
  },
  'Midtown East': {
    lat: 40.7527, lng: -73.9723, radius_km: 0.8,
    aliases: ['midtown east', 'turtle bay', 'sutton place']
  },
  'Murray Hill': {
    lat: 40.7486, lng: -73.9773, radius_km: 0.7,
    aliases: ['murray hill']
  },
  'Kips Bay': {
    lat: 40.7428, lng: -73.9800, radius_km: 0.7,
    aliases: ['kips bay', "kip's bay", 'kipsbay']
  },
  'Gramercy': {
    lat: 40.7382, lng: -73.9860, radius_km: 0.6,
    aliases: ['gramercy', 'gramercy park']
  },
  'Flatiron': {
    lat: 40.7395, lng: -73.9903, radius_km: 0.6,
    aliases: ['flatiron', 'flatiron district', 'union square', 'union sq']
  },
  'Upper West Side': {
    lat: 40.7870, lng: -73.9754, radius_km: 1.5,
    aliases: ['upper west side', 'uws', 'upper west']
  },
  'Upper East Side': {
    lat: 40.7736, lng: -73.9566, radius_km: 1.5,
    aliases: ['upper east side', 'ues', 'upper east', 'yorkville', 'lenox hill']
  },
  'Carnegie Hill': {
    lat: 40.7845, lng: -73.9562, radius_km: 0.5,
    aliases: ['carnegie hill']
  },
  'Harlem': {
    lat: 40.8116, lng: -73.9465, radius_km: 1.5,
    aliases: ['harlem', 'west harlem', 'central harlem']
  },
  'East Harlem': {
    lat: 40.7957, lng: -73.9389, radius_km: 1.2,
    aliases: ['east harlem', 'el barrio', 'spanish harlem']
  },
  'Hamilton Heights': {
    lat: 40.8256, lng: -73.9481, radius_km: 0.8,
    aliases: ['hamilton heights', 'sugar hill']
  },
  'Morningside Heights': {
    lat: 40.8097, lng: -73.9625, radius_km: 0.8,
    aliases: ['morningside heights', 'morningside']
  },
  'Washington Heights': {
    lat: 40.8417, lng: -73.9393, radius_km: 1.5,
    aliases: ['washington heights', 'wash heights', 'the heights', 'inwood', 'fort tryon']
  },
  "Hell's Kitchen": {
    lat: 40.7638, lng: -73.9918, radius_km: 0.8,
    aliases: ["hell's kitchen", 'hells kitchen', 'hk', 'clinton']
  },
  'Greenwich Village': {
    lat: 40.7308, lng: -73.9973, radius_km: 0.7,
    aliases: ['greenwich village', 'greenwich']
  },
  'Financial District': {
    lat: 40.7075, lng: -74.0089, radius_km: 0.8,
    aliases: ['financial district', 'fidi', 'wall street', 'downtown manhattan']
  },
  'Battery Park City': {
    lat: 40.7115, lng: -74.0167, radius_km: 0.6,
    aliases: ['battery park city', 'battery park']
  },

  // === BROOKLYN ===
  'Williamsburg': {
    lat: 40.7081, lng: -73.9571, radius_km: 1.2,
    aliases: ['williamsburg', 'wburg', 'billyburg', 'east williamsburg', 'east wburg']
  },
  'Bushwick': {
    lat: 40.6944, lng: -73.9213, radius_km: 1.0,
    aliases: ['bushwick']
  },
  'Greenpoint': {
    lat: 40.7274, lng: -73.9514, radius_km: 0.8,
    aliases: ['greenpoint', 'gpoint']
  },
  'Park Slope': {
    lat: 40.6710, lng: -73.9814, radius_km: 1.0,
    aliases: ['park slope']
  },
  'South Slope': {
    lat: 40.6604, lng: -73.9868, radius_km: 0.7,
    aliases: ['south slope']
  },
  'Downtown Brooklyn': {
    lat: 40.6934, lng: -73.9867, radius_km: 0.8,
    aliases: ['downtown brooklyn', 'downtown bk']
  },
  'DUMBO': {
    lat: 40.7033, lng: -73.9890, radius_km: 0.5,
    aliases: ['dumbo', 'vinegar hill']
  },
  'Fort Greene': {
    lat: 40.6892, lng: -73.9742, radius_km: 0.8,
    aliases: ['fort greene']
  },
  'Clinton Hill': {
    lat: 40.6891, lng: -73.9654, radius_km: 0.8,
    aliases: ['clinton hill']
  },
  'Prospect Heights': {
    lat: 40.6775, lng: -73.9692, radius_km: 0.8,
    aliases: ['prospect heights']
  },
  'Crown Heights': {
    lat: 40.6694, lng: -73.9422, radius_km: 1.2,
    aliases: ['crown heights']
  },
  'Bed-Stuy': {
    lat: 40.6872, lng: -73.9418, radius_km: 1.2,
    aliases: ['bed-stuy', 'bed stuy', 'bedford stuyvesant', 'bedstuy', 'bedford-stuyvesant']
  },
  'Cobble Hill': {
    lat: 40.6860, lng: -73.9957, radius_km: 0.7,
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
  'Brooklyn Heights': {
    lat: 40.6958, lng: -73.9936, radius_km: 0.7,
    aliases: ['brooklyn heights', 'bk heights']
  },
  'Sunset Park': {
    lat: 40.6514, lng: -74.0027, radius_km: 1.2,
    aliases: ['sunset park', 'industry city', 'greenwood', 'greenwood heights']
  },
  'Windsor Terrace': {
    lat: 40.6534, lng: -73.9781, radius_km: 0.6,
    aliases: ['windsor terrace']
  },
  'Prospect Lefferts Gardens': {
    lat: 40.6596, lng: -73.9560, radius_km: 0.8,
    aliases: ['prospect lefferts gardens', 'plg', 'lefferts gardens', 'prospect lefferts']
  },
  'Flatbush': {
    lat: 40.6530, lng: -73.9577, radius_km: 1.2,
    aliases: ['flatbush', 'east flatbush']
  },
  'Ditmas Park': {
    lat: 40.6390, lng: -73.9588, radius_km: 0.8,
    aliases: ['ditmas park', 'victorian flatbush']
  },
  'Kensington': {
    lat: 40.6397, lng: -73.9727, radius_km: 0.8,
    aliases: ['kensington']
  },
  'Bay Ridge': {
    lat: 40.6340, lng: -74.0287, radius_km: 1.2,
    aliases: ['bay ridge']
  },
  'Borough Park': {
    lat: 40.6338, lng: -73.9931, radius_km: 1.2,
    aliases: ['borough park', 'boro park']
  },
  'Bensonhurst': {
    lat: 40.6039, lng: -73.9936, radius_km: 1.2,
    aliases: ['bensonhurst']
  },
  'Midwood': {
    lat: 40.6236, lng: -73.9576, radius_km: 1.0,
    aliases: ['midwood']
  },
  'Brighton Beach': {
    lat: 40.5776, lng: -73.9617, radius_km: 0.8,
    aliases: ['brighton beach']
  },
  'Coney Island': {
    lat: 40.5755, lng: -73.9707, radius_km: 1.0,
    aliases: ['coney island']
  },
  'Sheepshead Bay': {
    lat: 40.5867, lng: -73.9442, radius_km: 1.0,
    aliases: ['sheepshead bay']
  },

  // === QUEENS ===
  'Astoria': {
    lat: 40.7723, lng: -73.9301, radius_km: 1.2,
    aliases: ['astoria']
  },
  'Long Island City': {
    lat: 40.7425, lng: -73.9561, radius_km: 1.0,
    aliases: ['long island city', 'lic']
  },
  'Sunnyside': {
    lat: 40.7434, lng: -73.9180, radius_km: 0.8,
    aliases: ['sunnyside']
  },
  'Woodside': {
    lat: 40.7454, lng: -73.9030, radius_km: 0.8,
    aliases: ['woodside']
  },
  'Jackson Heights': {
    lat: 40.7557, lng: -73.8831, radius_km: 1.2,
    aliases: ['jackson heights']
  },
  'Elmhurst': {
    lat: 40.7352, lng: -73.8780, radius_km: 1.0,
    aliases: ['elmhurst']
  },
  'Corona': {
    lat: 40.7448, lng: -73.8631, radius_km: 1.0,
    aliases: ['corona']
  },
  'Flushing': {
    lat: 40.7580, lng: -73.8317, radius_km: 1.5,
    aliases: ['flushing', 'downtown flushing']
  },
  'Forest Hills': {
    lat: 40.7186, lng: -73.8441, radius_km: 1.0,
    aliases: ['forest hills']
  },
  'Rego Park': {
    lat: 40.7260, lng: -73.8605, radius_km: 0.8,
    aliases: ['rego park']
  },
  'Kew Gardens': {
    lat: 40.7075, lng: -73.8310, radius_km: 0.8,
    aliases: ['kew gardens']
  },
  'Jamaica': {
    lat: 40.7025, lng: -73.7904, radius_km: 1.5,
    aliases: ['jamaica']
  },
  'Ridgewood': {
    lat: 40.7043, lng: -73.9056, radius_km: 1.0,
    aliases: ['ridgewood']
  },
  'Bayside': {
    lat: 40.7647, lng: -73.7700, radius_km: 1.2,
    aliases: ['bayside']
  },

  // === BRONX ===
  'Mott Haven': {
    lat: 40.8089, lng: -73.9214, radius_km: 1.2,
    aliases: ['mott haven', 'south bronx']
  },
  'Fordham': {
    lat: 40.8585, lng: -73.8963, radius_km: 1.2,
    aliases: ['fordham', 'fordham road']
  },
  'Belmont': {
    lat: 40.8563, lng: -73.8875, radius_km: 0.8,
    aliases: ['belmont', 'arthur avenue', 'arthur ave']
  },
  'Concourse': {
    lat: 40.8272, lng: -73.9182, radius_km: 1.2,
    aliases: ['concourse', 'grand concourse', 'concourse village']
  },
  'Riverdale': {
    lat: 40.8988, lng: -73.9121, radius_km: 1.5,
    aliases: ['riverdale']
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
  'brooklyn': [
    'Williamsburg', 'Bushwick', 'Greenpoint', 'Park Slope', 'South Slope',
    'Downtown Brooklyn', 'DUMBO', 'Fort Greene', 'Clinton Hill',
    'Prospect Heights', 'Crown Heights', 'Bed-Stuy', 'Cobble Hill',
    'Gowanus', 'Red Hook',
    'Brooklyn Heights', 'Sunset Park', 'Windsor Terrace',
    'Prospect Lefferts Gardens', 'Flatbush', 'Ditmas Park', 'Kensington',
    'Bay Ridge', 'Borough Park', 'Bensonhurst', 'Midwood',
    'Brighton Beach', 'Coney Island', 'Sheepshead Bay',
  ],
  'queens': [
    'Astoria', 'Long Island City', 'Sunnyside', 'Woodside',
    'Jackson Heights', 'Elmhurst', 'Corona', 'Flushing',
    'Forest Hills', 'Rego Park', 'Kew Gardens', 'Jamaica',
    'Ridgewood', 'Bayside',
  ],
  'manhattan': [
    'East Village', 'West Village', 'Lower East Side', 'Chelsea',
    'SoHo', 'NoHo', 'Tribeca', 'Midtown', 'Midtown East',
    'Murray Hill', 'Kips Bay', 'Gramercy', 'Flatiron',
    'Upper West Side', 'Upper East Side', 'Carnegie Hill',
    'Harlem', 'East Harlem', 'Hamilton Heights', 'Morningside Heights',
    'Washington Heights', "Hell's Kitchen", 'Greenwich Village',
    'Financial District', 'Battery Park City',
  ],
  'bronx': [
    'Mott Haven', 'Fordham', 'Belmont', 'Concourse', 'Riverdale',
  ],
};

// Borough aliases
const BOROUGH_ALIASES = {
  'brooklyn': 'brooklyn', 'bk': 'brooklyn', 'bklyn': 'brooklyn',
  'queens': 'queens', 'qns': 'queens',
  'manhattan': 'manhattan', 'nyc': 'manhattan', 'the city': 'manhattan',
  'bronx': 'bronx', 'the bronx': 'bronx', 'bx': 'bronx',
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
const LANDMARK_MAP = {
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
  'bam': 'Fort Greene',
  'brooklyn heights promenade': 'Brooklyn Heights',
  'industry city': 'Sunset Park',
};

// Combine neighborhood aliases + borough shortcuts, sorted longest-first
const ALL_ENTRIES = [
  ...SORTED_ALIASES.map(alias => ({ key: alias, value: ALIAS_MAP.get(alias) })),
  ...Object.entries(LANDMARK_MAP).map(([key, value]) => ({ key, value })),
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

// Known NYC-adjacent areas we don't cover — map to nearest alternatives
const UNSUPPORTED_HOODS = {
  'roosevelt island': ['Upper East Side', 'Astoria'],
  'staten island': [],
  'st george': [],
  'hoboken': [],
  'jersey city': [],
};

/**
 * Detect if a message refers to a real NYC place we don't support yet.
 * Returns { name, nearby } or null.
 */
function detectUnsupported(message) {
  const lower = message.toLowerCase().trim();
  for (const [name, nearby] of Object.entries(UNSUPPORTED_HOODS)) {
    const regex = new RegExp(`(?<!\\w)${escapeRegex(name)}(?!\\w)`);
    if (regex.test(lower)) {
      const title = name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      return { name: title, nearby };
    }
  }
  return null;
}

module.exports = { NEIGHBORHOODS, BOROUGHS, extractNeighborhood, detectBorough, detectUnsupported, getNeighborhoodCoords };
