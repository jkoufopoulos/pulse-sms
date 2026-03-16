const fs = require('fs');
const path = require('path');
const { SOURCES, SOURCE_TIERS, SOURCE_LABELS, SOURCE_DB_NAMES, MERGE_ORDER, EMAIL_SOURCES } = require('./source-registry');
const { sourceHealth, saveHealthData, updateSourceHealth, updateScrapeStats, computeEventMix, getHealthStatus: _getHealthStatus, isSourceDisabled, shouldProbeDisabled } = require('./source-health');
const { rankEventsByProximity, filterUpcomingEvents, getNycDateString, getEventDate, isEventInDateRange, parseAsNycTime } = require('./geo');
const { batchGeocodeEvents, exportLearnedVenues, importLearnedVenues, lookupVenue, lookupVenueSize } = require('./venues');
const { filterIncomplete, filterKidsEvents, isGarbageName, hasValidNeighborhood, isGarbageVenue } = require('./curation');
const { eventMatchesFilters, failsTimeGate } = require('./pipeline');
const { computeCompleteness, backfillEvidence, backfillDateTimes } = require('./sources/shared');
const { captureExtractionInput, getExtractionInputs, clearExtractionInputs } = require('./extraction-capture');
const { checkBaseline } = require('./scrape-guard');

// ============================================================
// Category remap + canonicalization (must be above boot code)
// ============================================================

const OTHER_REMAP_RULES = [
  { pattern: /\b(sound bath|meditation|breathwork|yoga|wellness|healing|reiki)\b/i, category: 'community' },
  { pattern: /\b(zine|popup market|pop-?up market|flea market|flea|vintage market|craft fair|bazaar|swap meet|sample sale|makers?\s*market)\b/i, category: 'community' },
  { pattern: /\b(workshop|class(?:es)?|seminar|lecture|talk(?:s)?|panel|discussion|meetup|networking|open house|fundrais|benefit|gala|rally|activism)\b/i, category: 'community' },
  { pattern: /\b(immersive|performance art|cabaret|burlesque|variety show|drag show|drag|circus|acrobat|puppet|one[- ]?(?:wo)?man show)\b/i, category: 'theater' },
  { pattern: /\b(film|movie|screening|cinema|documentary|short films|premiere|repertory)\b/i, category: 'film' },
  { pattern: /\b(vinyl night|dance party|disco|dj\b|dj set|club night|rave|techno night|house night|afterparty|after[- ]?party|party)\b/i, category: 'nightlife' },
  { pattern: /\b(jazz|acoustic|live band|songwriter|bluegrass|folk music|orchestra|ensemble|quartet|trio|opera|recital|philharmonic|symphony|choir|choral)\b/i, category: 'live_music' },
  { pattern: /\b(concert|live music|in concert)\b/i, category: 'live_music' },
  { pattern: /\b(trivia|quiz|game night|board game|bingo|karaoke|pub quiz)\b/i, category: 'trivia' },
  { pattern: /\b(gallery|exhibition|art show|art opening|mural|sculpture|retrospective|art walk|photo(?:graphy)?\s*(?:show|exhibit|opening))\b/i, category: 'art' },
  { pattern: /\b(book reading|poetry|spoken word|storytelling|literary|book launch|reading series|open mic.*poet|poetry slam|author)\b/i, category: 'spoken_word' },
  { pattern: /\b(wine tasting|supper club|food popup|food pop-?up|tasting|beer fest|cocktail|brunch|dinner party|pop-?up dinner|food festival)\b/i, category: 'food_drink' },
];

function remapOtherCategory(event) {
  if (event.category !== 'other') return event;
  const text = `${event.name || ''} ${event.description_short || event.short_detail || ''}`.toLowerCase();
  for (const rule of OTHER_REMAP_RULES) {
    if (rule.pattern.test(text)) {
      event.category = rule.category;
      return event;
    }
  }
  return event;
}

const CATEGORY_CANON = {
  music: 'live_music',
  dance: 'nightlife',
  market: 'community',
  literature: 'spoken_word',
};

function remapOtherCategories(events) {
  let remapped = 0;
  let canonicalized = 0;
  for (const e of events) {
    if (e.category && CATEGORY_CANON[e.category]) {
      if (!e.subcategory) e.subcategory = e.category;
      e.category = CATEGORY_CANON[e.category];
      canonicalized++;
    }
    const before = e.category;
    remapOtherCategory(e);
    if (e.category !== before) remapped++;
  }
  if (remapped > 0) console.log(`Category remap: ${remapped} events moved from "other" to specific categories`);
  if (canonicalized > 0) console.log(`Category canonicalization: ${canonicalized} non-standard categories normalized`);
}

/**
 * Stamp is_recurring + recurrence_label on events that match active recurring patterns.
 * Uses a Set lookup of pattern_keys — no per-event DB query.
 */
function stampRecurrence(events) {
  try {
    const { getActivePatternKeys, makePatternKey, normalizePatternName, DAY_NAMES } = require('./db');
    const patternKeys = getActivePatternKeys();
    if (patternKeys.size === 0) return;

    let stamped = 0;
    for (const e of events) {
      // Events from generateOccurrences already have source_type: 'recurring'
      if (e.source_type === 'recurring') {
        e.is_recurring = true;
        const dayIdx = e.date_local ? new Date(e.date_local + 'T12:00:00').getDay() : null;
        e.recurrence_label = dayIdx != null ? `every ${DAY_NAMES[dayIdx].charAt(0).toUpperCase() + DAY_NAMES[dayIdx].slice(1)}` : null;
        if (e.name && e.venue_name && dayIdx != null) {
          e.recurrence_pattern_key = makePatternKey(e.name, e.venue_name, dayIdx);
        }
        stamped++;
        continue;
      }
      // Check scraped events against pattern keys
      if (!e.name || !e.venue_name || !e.date_local) continue;
      const dayIdx = new Date(e.date_local + 'T12:00:00').getDay();
      const key = makePatternKey(e.name, e.venue_name, dayIdx);
      if (patternKeys.has(key)) {
        e.is_recurring = true;
        e.recurrence_label = `every ${DAY_NAMES[dayIdx].charAt(0).toUpperCase() + DAY_NAMES[dayIdx].slice(1)}`;
        e.recurrence_pattern_key = key;
        stamped++;
      }
    }
    if (stamped > 0) {
      console.log(`Recurrence stamping: ${stamped} events marked as recurring`);
    }
  } catch (err) {
    // SQLite not available — skip stamping
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.warn('Recurrence stamping failed:', err.message);
    }
  }
}

/**
 * Stamp venue_size on events using the VENUE_SIZE classification map.
 * Sets venue_size to 'intimate', 'medium', 'large', 'massive', or leaves undefined.
 */
function stampVenueSize(events) {
  let stamped = 0;
  for (const e of events) {
    if (!e.venue_name) continue;
    const size = lookupVenueSize(e.venue_name);
    if (size) {
      e.venue_size = size;
      stamped++;
    }
  }
  if (stamped > 0) {
    console.log(`Venue size stamping: ${stamped} events classified`);
  }
}

/**
 * Classify interaction format from category + subcategory + event name keywords.
 * Three tiers: interactive (stranger interaction built in), participatory (active audience),
 * passive (audience faces stage). Returns null if unclear.
 */
function classifyInteractionFormat(event) {
  const name = (event.name || '').toLowerCase();
  const cat = event.category;
  const subcat = (event.subcategory || '').toLowerCase();

  // --- Interactive: structure forces stranger interaction ---
  if (cat === 'trivia') return 'interactive';
  if (/\btrivia\b/.test(name)) return 'interactive';
  if (/\bboard\s*game|game\s*night/.test(name)) return 'interactive';
  if (/\bworkshop\b/.test(name) || (/\bclass\b/.test(name) && /\b(?:dance|salsa|bachata|swing|pottery|painting|cooking|craft)\b/.test(name))) return 'interactive';
  if (/\b(?:salsa|bachata|swing)\s+(?:night|social|class|dancing)\b/.test(name)) return 'interactive';
  if (/\brun\s*club\b|\brunning\s*club\b/.test(name)) return 'interactive';
  if (/\bpotluck\b/.test(name)) return 'interactive';
  if (/\bdrink\s*(?:and|&|n)\s*draw\b/.test(name)) return 'interactive';
  if (/\bpaint\s*(?:and|&|n)\s*sip\b/.test(name)) return 'interactive';
  if (/\bmeetup\b/.test(name)) return 'interactive';
  if (/\bkaraoke\b/.test(name)) return 'interactive';
  if (/\bbingo\b/.test(name)) return 'interactive';
  if (subcat === 'mixtape_bingo') return 'interactive';
  if (/\bcommunal\s*din/.test(name) || /\bsupper\s*club\b/.test(name)) return 'interactive';
  if (/\bspeed\s*dat/.test(name)) return 'interactive';
  if (/\bbook\s*club\b/.test(name)) return 'interactive';
  if (/\bsocial\s*mixer\b|\bnetworking\s*mixer\b/.test(name)) return 'interactive';
  if (/\bnewcomer\b|\bwelcome\s*night\b/.test(name)) return 'interactive';

  // --- Participatory: you might perform, audience is active ---
  if (/\bopen\s*mic\b/.test(name)) return 'participatory';
  if (/\bjam\s*session\b/.test(name)) return 'participatory';
  if (/\bdrag\s*(show|brunch|night|race|bingo)\b/.test(name)) return 'participatory';
  if (/\bart\s*opening\b|\bgallery\s*opening\b|\bopening\s*reception\b/.test(name)) return 'participatory';
  if (/\btasting\b/.test(name) && /\b(?:food|wine|beer|whiskey|cocktail|spirit)\b/.test(name)) return 'participatory';
  if (subcat === 'literary' || /\bbook\s*launch\b|\breading\b.*\bsigning\b/.test(name)) return 'participatory';

  // --- Category-level defaults (passive unless overridden above) ---
  if (cat === 'comedy') return 'participatory'; // comedy audiences are active
  if (cat === 'live_music' || cat === 'music') return 'passive';
  if (cat === 'nightlife') return 'passive';
  if (cat === 'theater') return 'passive';
  if (cat === 'film') return 'passive';
  if (cat === 'art') return /\bexhibit|installation|gallery\b/.test(name) ? 'passive' : null;
  if (cat === 'dance') return /\bclass|lesson|social\b/.test(name) ? 'interactive' : 'passive';
  if (cat === 'literature') return 'participatory'; // readings have Q&A, signings

  return null;
}

/**
 * Score an event for "interestingness" — how likely it is to impress a first-time user.
 * Deterministic, $0. Used to rank citywide pools for first-message and "surprise me" queries.
 * Score range: -3 (recurring mainstream at massive venue) to 6 (one-off discovery at intimate venue).
 */
const VIBE_SCORES = { discovery: 3, niche: 2, platform: 0, mainstream: -2 };
const VENUE_SCORES = { intimate: 1, medium: 0, large: -1, massive: -1 };

function scoreInterestingness(event) {
  const vibeScore = VIBE_SCORES[event.source_vibe] ?? 0;
  const rarityScore = !event.is_recurring ? 2
    : (event.interaction_format === 'interactive' ? 1 : 0);
  const venueScore = VENUE_SCORES[event.venue_size] ?? 0;
  const editorialBonus = event.editorial_signal ? 2 : 0;
  const scarcityBonus = event.scarcity ? 2 : 0;
  return vibeScore + rarityScore + venueScore + editorialBonus + scarcityBonus;
}

/**
 * Select N picks from a scored pool, maximizing category diversity.
 * Takes the highest-scored event, then picks from unseen categories, then fills remaining slots.
 */
function selectDiversePicks(scoredPool, count = 3) {
  if (scoredPool.length === 0) return [];
  const sorted = [...scoredPool].sort((a, b) => b.interestingness - a.interestingness);
  const picks = [];
  const usedCategories = new Set();

  // First pass: one per category
  for (const event of sorted) {
    if (picks.length >= count) break;
    if (!usedCategories.has(event.category)) {
      picks.push(event);
      usedCategories.add(event.category);
    }
  }

  // Second pass: fill remaining slots with best available
  if (picks.length < count) {
    const pickIds = new Set(picks.map(p => p.id));
    for (const event of sorted) {
      if (picks.length >= count) break;
      if (!pickIds.has(event.id)) picks.push(event);
    }
  }

  return picks;
}

/**
 * Get the top interestingness-ranked events for first-message / "surprise me" queries.
 * Returns up to `count` events with category diversity enforced.
 * Uses today+tomorrow date gate by default, widens to 7 days if pool is thin.
 */
async function getTopPicks(count = 10) {
  if (eventCache.length === 0) {
    await refreshCache();
  }

  const qualityFiltered = applyQualityGates(eventCache);
  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);

  // First try: today + tomorrow only (includes ongoing multi-day events)
  let dateFiltered = qualityFiltered.filter(e => {
    const active = isEventInDateRange(e, todayNyc, tomorrowNyc);
    return active === null ? false : active;
  });

  // Widen to 7 days if pool is thin (< 5 scoreable events)
  if (dateFiltered.length < 5) {
    const weekOutNyc = getNycDateString(7);
    dateFiltered = qualityFiltered.filter(e => {
      const active = isEventInDateRange(e, todayNyc, weekOutNyc);
      return active === null ? false : active;
    });
  }

  // Drop events that already started 2+ hours ago
  const upcoming = filterUpcomingEvents(dateFiltered);

  // Time-window filter: prefer events starting soon. Widen if pool is thin.
  const now = Date.now();
  function withinHours(events, hours) {
    return events.filter(e => {
      if (!e.start_time_local) return true; // no time → keep
      const startMs = parseAsNycTime(e.start_time_local);
      if (isNaN(startMs)) return true;
      return (startMs - now) / (1000 * 60 * 60) <= hours;
    });
  }
  let timeFiltered = withinHours(upcoming, 6);
  if (timeFiltered.length < 5) timeFiltered = withinHours(upcoming, 12);
  if (timeFiltered.length < 5) timeFiltered = upcoming;

  const scored = timeFiltered.map(e => {
    const base = scoreInterestingness(e);
    // Penalize events with no start time — we can't verify they're actually soon
    const timePenalty = e.start_time_local ? 0 : -2;
    return { ...e, interestingness: base + timePenalty };
  });

  return selectDiversePicks(scored, count);
}

/**
 * Source vibe signal — classifies source_name into discovery-factor tiers.
 * discovery: editorial picks, underground — the stuff your coolest friend knows about.
 * niche: focused, known but specific venues/orgs.
 * platform: broad coverage, mixed quality, some gems.
 * mainstream: fills gaps, generic/commercial listings.
 */
const SOURCE_VIBE = {
  // Discovery: editorial picks, underground, curated newsletters
  'theskint': 'discovery', 'nonsensenyc': 'discovery',
  'brooklynvegan': 'discovery', 'ScreenSlate': 'discovery', 'bkmag': 'discovery',
  'yutori': 'discovery', 'SofarSounds': 'discovery',
  // Niche: focused, known but specific
  'tinycupboard': 'niche', 'brooklyncc': 'niche',
  'bam': 'niche', 'nypl': 'niche', 'nyctrivia': 'niche', 'nyc_parks': 'niche',
  // Platform: broad aggregators, mixed quality
  'ra': 'platform', 'dice': 'platform', 'donyc': 'platform', 'songkick': 'platform',
  // Mainstream: fills gaps, generic/commercial
  'ticketmaster': 'mainstream', 'eventbrite': 'mainstream',
  // Luma is niche — community panels, creative meetups, food events, not generic commercial
  'Luma': 'niche',
};

/**
 * Stamp source_vibe on events from the SOURCE_VIBE map.
 */
function stampSourceVibe(events) {
  let stamped = 0;
  for (const e of events) {
    const tier = SOURCE_VIBE[e.source_name];
    if (tier) {
      e.source_vibe = tier;
      // Discovery sources are inherently editorial — every event is a curated pick
      if (tier === 'discovery' && !e.editorial_signal) {
        e.editorial_signal = true;
      }
      stamped++;
    }
  }
  if (stamped > 0) {
    console.log(`Source vibe: ${stamped} events classified`);
  }
}

/**
 * Stamp interaction_format on events using keyword + category classification.
 * Sets interaction_format to 'interactive', 'participatory', 'passive', or leaves undefined.
 */
function stampInteractionFormat(events) {
  let counts = { interactive: 0, participatory: 0, passive: 0 };
  for (const e of events) {
    const fmt = classifyInteractionFormat(e);
    if (fmt) {
      e.interaction_format = fmt;
      counts[fmt]++;
    }
  }
  const total = counts.interactive + counts.participatory + counts.passive;
  if (total > 0) {
    console.log(`Interaction format: ${total} classified (${counts.interactive} interactive, ${counts.participatory} participatory, ${counts.passive} passive)`);
  }
}

function atomicWriteSync(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// Load persisted learned venues on boot
try {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/venues-learned.json'), 'utf8'));
  importLearnedVenues(data);
  console.log(`Loaded ${Object.keys(data).length} persisted venues`);
} catch { /* file doesn't exist yet */ }

// --- Daily event cache ---
let eventCache = [];
let cacheTimestamp = 0;
let refreshPromise = null; // mutex to prevent concurrent refreshes

const CACHE_FILE = path.join(__dirname, '../data/events-cache.json');

// Load persisted event cache on boot — try SQLite first, fall back to JSON
try {
  const { getEventsInRange, generateOccurrences, importFromJsonCache, pruneInactiveSources } = require('./db');
  // Auto-import JSON cache on first boot with SQLite
  importFromJsonCache(CACHE_FILE);
  pruneInactiveSources(SOURCE_DB_NAMES);
  const today = getNycDateString(0);
  const weekOut = getNycDateString(7);
  const dbEvents = getEventsInRange(today, weekOut);
  if (dbEvents.length > 0) {
    const occurrences = generateOccurrences(today, weekOut);
    const seenIds = new Set(dbEvents.map(e => e.id));
    const fresh = occurrences.filter(o => !seenIds.has(o.id));
    eventCache = filterKidsEvents([...dbEvents, ...fresh]);
    backfillEvidence(eventCache);
    backfillDateTimes(eventCache);
    stampRecurrence(eventCache);
    stampVenueSize(eventCache);
    stampInteractionFormat(eventCache);
    stampSourceVibe(eventCache);
    remapOtherCategories(eventCache);
    cacheTimestamp = Date.now();
    console.log(`Loaded ${eventCache.length} events from SQLite (${dbEvents.length} scraped + ${fresh.length} recurring)`);
  }
} catch (err) {
  // SQLite not available or failed — fall through to JSON
  if (err.code !== 'MODULE_NOT_FOUND') {
    console.warn('SQLite boot failed, falling back to JSON:', err.message);
  }
}
// JSON fallback (also serves as cache for non-SQLite deployments)
if (eventCache.length === 0) {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached.events?.length > 0) {
      backfillEvidence(cached.events);
      backfillDateTimes(cached.events);
      remapOtherCategories(cached.events);
      eventCache = cached.events;
      cacheTimestamp = cached.timestamp || 0;
      const ageMin = cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : '?';
      console.log(`Loaded ${eventCache.length} persisted events from JSON (${ageMin}min old)`);
    }
  } catch { /* file doesn't exist yet — first deploy */ }
}

// ============================================================
// Timed fetch wrapper — captures duration + status per source
// ============================================================

const SCRAPER_TIMEOUT_MS = 60000;

async function timedFetch(fetchFn, label, weight) {
  const start = Date.now();
  try {
    const events = await Promise.race([
      fetchFn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} scraper timeout`)), SCRAPER_TIMEOUT_MS)
      ),
    ]);
    const durationMs = Date.now() - start;
    // Stamp canonical weight + new fields from registry
    for (const e of events) {
      e.source_weight = weight;
      e.source_tier = SOURCE_TIERS[label] || 'secondary';
      if (e.completeness === undefined) e.completeness = computeCompleteness(e);
      if (e.extraction_confidence === undefined) e.extraction_confidence = null;
    }
    return { events, durationMs, status: events.length > 0 ? 'ok' : 'empty', error: null };
  } catch (err) {
    const durationMs = Date.now() - start;
    const status = err.name === 'AbortError' || err.message?.includes('timeout') ? 'timeout' : 'error';
    return { events: [], durationMs, status, error: err.message };
  }
}

// ============================================================
// Cache refresh — fetches all sources in parallel
// ============================================================

async function refreshCache() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const scrapeStart = new Date();
    clearExtractionInputs(); // Clear for this scrape cycle
    console.log('Refreshing event cache (all sources)...');

    // Determine which sources to skip (disabled, not due for probe)
    const disabledSkipped = new Set();
    const disabledProbing = new Set();
    for (const s of SOURCES) {
      if (isSourceDisabled(s.label)) {
        if (shouldProbeDisabled(s.label)) {
          disabledProbing.add(s.label);
        } else {
          disabledSkipped.add(s.label);
        }
      }
    }
    if (disabledSkipped.size > 0) {
      console.log(`[HEALTH] Skipping ${disabledSkipped.size} disabled source(s): ${[...disabledSkipped].join(', ')}`);
    }
    if (disabledProbing.size > 0) {
      console.log(`[HEALTH] Probing ${disabledProbing.size} disabled source(s): ${[...disabledProbing].join(', ')}`);
    }

    const activeSources = SOURCES.filter(s => !disabledSkipped.has(s.label));

    // SOURCES drives the fetch array — no positional coupling
    const fetchResults = await Promise.allSettled(
      activeSources.map(s => timedFetch(s.fetch, s.label, s.weight)),
    );

    const allEvents = [];
    const seen = new Set();

    // Map fetch results back to labels — activeSources[i] corresponds to fetchResults[i]
    const fetchMap = {};
    for (let i = 0; i < activeSources.length; i++) {
      const settled = fetchResults[i];
      fetchMap[activeSources[i].label] = settled.status === 'fulfilled'
        ? settled.value
        : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message || 'unknown' };
    }

    let sourcesOk = 0, sourcesFailed = 0, sourcesEmpty = 0, sourcesQuarantined = 0;
    let totalRaw = 0;

    // Merge in priority order (highest weight first, then mergeRank)
    for (const label of MERGE_ORDER) {
      if (disabledSkipped.has(label)) continue;
      const result = fetchMap[label];
      if (!result) continue;
      totalRaw += result.events.length;

      // Record health BEFORE baseline check (so history accumulates)
      updateSourceHealth(label, result);

      // Update probe timestamp (only if still disabled after health update)
      if (disabledProbing.has(label) && isSourceDisabled(label)) {
        sourceHealth[label].lastProbeAt = new Date().toISOString();
      }
      const sourceEntry = SOURCES.find(s => s.label === label);
      if (sourceEntry?.volatile) sourceHealth[label].volatile = true;

      if (result.status === 'error' || result.status === 'timeout') {
        console.error(`${label} failed:`, result.error);
        sourcesFailed++;
        continue;
      }

      // Baseline gate: quarantine sources with suspicious output
      if (result.status === 'ok') {
        const verdict = checkBaseline(label, result.events);
        if (verdict.quarantined) {
          console.warn(`[SCRAPE-GUARD] Quarantined ${label}: ${verdict.reason}`);
          result.status = 'quarantined';
          result.quarantineReason = verdict.reason;
          sourceHealth[label].lastStatus = 'quarantined';
          sourceHealth[label].lastQuarantineReason = verdict.reason;
          sourcesQuarantined++;
          continue; // skip merge — cache retains yesterday's events for this source
        } else {
          // Clear stale quarantine reason on pass
          sourceHealth[label].lastQuarantineReason = null;
        }
      }

      for (const e of result.events) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }

      if (result.status === 'ok') sourcesOk++;
      else if (result.status === 'empty') sourcesEmpty++;
    }

    if (sourcesQuarantined > 0) {
      console.warn(`[SCRAPE-GUARD] ${sourcesQuarantined} source(s) quarantined this scrape`);
    }

    // Filter out stale/far-future events and kids events at scrape time
    // Include yesterday so Friday newsletter events survive Saturday's scrape;
    // serving-time filterUpcomingEvents handles actual expiry (end_time + 2hr grace)
    const yesterday = getNycDateString(-1);
    const today = getNycDateString(0);
    const monthOut = getNycDateString(30);
    const dateFiltered = allEvents.filter(e => {
      const active = isEventInDateRange(e, yesterday, monthOut);
      return active === null ? true : active; // keep undated events (perennials, venues)
    });
    let validEvents = filterKidsEvents(dateFiltered);
    const staleCount = allEvents.length - dateFiltered.length;
    const kidsCount = dateFiltered.length - validEvents.length;
    if (staleCount > 0 || kidsCount > 0) {
      console.log(`Scrape filter: removed ${staleCount} stale + ${kidsCount} kids events`);
    }

    // Geocode events that still have no neighborhood (venue map miss)
    // Wrapped in try-catch so geocoding failure doesn't block cache update
    try {
      await batchGeocodeEvents(validEvents);
    } catch (err) {
      console.error('Geocoding failed, continuing with un-geocoded events:', err.message);
    }

    // Drop events with resolved venue coordinates outside NYC bounding box
    // Events with NO coordinates are kept (might be unlisted NYC venues)
    const NYC_BOUNDS = { latMin: 40.49, latMax: 40.92, lngMin: -74.27, lngMax: -73.68 };
    const beforeGeoGate = validEvents.length;
    const droppedBySource = {};
    validEvents = validEvents.filter(e => {
      const coords = lookupVenue(e.venue_name);
      if (!coords) return true; // no coordinates — keep
      const { lat, lng } = coords;
      if (lat >= NYC_BOUNDS.latMin && lat <= NYC_BOUNDS.latMax &&
          lng >= NYC_BOUNDS.lngMin && lng <= NYC_BOUNDS.lngMax) return true;
      // Outside NYC — drop and track
      droppedBySource[e.source_name || 'unknown'] = (droppedBySource[e.source_name || 'unknown'] || 0) + 1;
      return false;
    });
    const geoDropped = beforeGeoGate - validEvents.length;
    if (geoDropped > 0) {
      const breakdown = Object.entries(droppedBySource).map(([s, n]) => `${s}:${n}`).join(', ');
      console.log(`Geo gate: dropped ${geoDropped} out-of-NYC events (${breakdown})`);
    }

    // Persist learned venues to disk for next restart
    const learned = exportLearnedVenues();
    const learnedCount = Object.keys(learned).length;
    if (learnedCount > 0) {
      try {
        fs.writeFileSync(path.join(__dirname, '../data/venues-learned.json'), JSON.stringify(learned, null, 2));
        console.log(`Persisted ${learnedCount} learned venues`);
      } catch (err) { console.error('Failed to persist venues:', err.message); }
    }

    // Strip _rawText if any sources still set it (transient field, not persisted)
    for (const e of validEvents) delete e._rawText;

    // Write all 30-day events to SQLite, then rebuild 7-day serving cache
    const weekOut = getNycDateString(7);
    try {
      const db = require('./db');
      db.upsertEvents(validEvents);
      // Persist to historical scraped_events (append-only, never pruned)
      try { db.insertScrapedEvents(validEvents); } catch (err) {
        console.warn('scraped_events insert failed:', err.message);
      }
      db.pruneOldEvents(getNycDateString(-30));
      db.pruneInactiveSources(SOURCE_DB_NAMES);
      // Detect recurring patterns from historical data
      try {
        db.detectRecurringPatterns();
      } catch (err) {
        console.warn('Recurrence detection failed:', err.message);
      }
      // Rebuild serving cache from SQLite (7-day window) + recurring patterns
      const dbEvents = db.getEventsInRange(today, weekOut);
      const occurrences = db.generateOccurrences(today, weekOut);
      const seenIds = new Set(dbEvents.map(e => e.id));
      const freshOccurrences = occurrences.filter(o => !seenIds.has(o.id));
      eventCache = filterKidsEvents([...dbEvents, ...freshOccurrences]);
      backfillDateTimes(eventCache);
      stampRecurrence(eventCache);
      stampVenueSize(eventCache);
      stampInteractionFormat(eventCache);
      remapOtherCategories(eventCache);

      // LLM classification for remaining "other" events (non-fatal)
      try {
        const { classifyOtherEvents } = require('./enrichment');
        await classifyOtherEvents(eventCache);
      } catch (err) {
        console.warn('[LLM-CLASSIFY] Classification failed (non-fatal):', err.message);
      }

      cacheTimestamp = Date.now();
      console.log(`SQLite: ${validEvents.length} events stored, serving ${eventCache.length} (${dbEvents.length} scraped + ${freshOccurrences.length} recurring)`);
    } catch (err) {
      // SQLite failed — fall back to 7-day in-memory cache
      console.warn('SQLite write failed, using in-memory cache:', err.message);
      const weekFiltered = validEvents.filter(e => {
        const active = isEventInDateRange(e, yesterday, weekOut);
        return active === null ? true : active;
      });
      eventCache = weekFiltered;
      cacheTimestamp = Date.now();
    }

    // Persist JSON cache for backward compat / fallback
    try {
      atomicWriteSync(CACHE_FILE, JSON.stringify({ events: eventCache, timestamp: cacheTimestamp }));
      console.log(`Persisted ${eventCache.length} events to cache file`);
    } catch (err) { console.error('Failed to persist event cache:', err.message); }

    // Update scrape-level stats
    const scrapeEnd = new Date();
    updateScrapeStats({
      startedAt: scrapeStart.toISOString(),
      completedAt: scrapeEnd.toISOString(),
      totalDurationMs: scrapeEnd - scrapeStart,
      totalEvents: totalRaw,
      dedupedEvents: validEvents.length,
      sourcesOk,
      sourcesFailed,
      sourcesEmpty,
      sourcesQuarantined,
    });

    // Generate daily digest and email if yellow/red
    try {
      const { generateDigest } = require('./daily-digest');
      const digest = generateDigest(eventCache, {
        totalDurationMs: scrapeEnd - scrapeStart,
        sourcesOk,
        sourcesFailed,
      });
      const db = require('./db');
      db.saveDigest(digest.id, digest.status, digest);
      console.log(`Daily digest: ${digest.status} — ${digest.summary}`);

      if (digest.status !== 'green') {
        const { sendGraduatedAlert } = require('./alerts');
        sendGraduatedAlert(digest).catch(err =>
          console.error('[ALERT] Graduated alert failed:', err.message)
        );
      }
    } catch (err) {
      console.error('Daily digest generation failed:', err.message);
    }

    // Post-scrape audit: completeness + extraction quality checks with alerting
    try {
      const { postScrapeAudit } = require('./scrape-guard');
      const auditResult = postScrapeAudit(fetchMap, validEvents, getExtractionInputs());
      if (auditResult.extraction?.summary?.total > 0) {
        console.log(`Extraction audit: ${auditResult.extraction.summary.passed}/${auditResult.extraction.summary.total} events pass (${auditResult.extraction.summary.passRate})`);
        const reportsDir = path.join(__dirname, '../data/reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const reportFile = path.join(reportsDir, `extraction-audit-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(reportFile, JSON.stringify(auditResult.extraction, null, 2));
      }
    } catch (err) {
      console.error('Post-scrape audit failed:', err.message);
    }

    // Run scrape audit (all sources — format, completeness, counts)
    try {
      const { runScrapeAudit } = require('./evals/scrape-audit');
      const scrapeReport = runScrapeAudit(validEvents, fetchMap);
      console.log(`Scrape audit: ${scrapeReport.summary.passRate} pass (${scrapeReport.summary.passed}/${scrapeReport.summary.total}), ${scrapeReport.summary.sourcesBelow} sources below minimum`);
      const reportsDir = path.join(__dirname, '../data/reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      const reportFile = path.join(reportsDir, `scrape-audit-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(reportFile, JSON.stringify(scrapeReport, null, 2));
    } catch (err) {
      console.error('Scrape audit failed:', err.message);
    }

    saveHealthData();
    console.log(`Cache refreshed: ${validEvents.length} events (${totalRaw} raw, ${allEvents.length} deduped, ${staleCount} stale removed | ${sourcesOk} ok / ${sourcesFailed} failed / ${sourcesEmpty} empty)`);
    return eventCache;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

// ============================================================
// Incremental email-only refresh — poll email sources between
// full scrapes so newsletter events appear within minutes.
// ============================================================

let emailRefreshPromise = null;

async function refreshEmailSources() {
  if (emailRefreshPromise) return emailRefreshPromise;
  // Skip if a full refresh is already running — it covers email sources
  if (refreshPromise) {
    console.log('Full scrape in progress, skipping email-only poll');
    return;
  }

  emailRefreshPromise = (async () => {
    // Filter out disabled sources (probe if due)
    const emailDisabledProbing = new Set();
    const activeEmailSources = EMAIL_SOURCES.filter(s => {
      if (!isSourceDisabled(s.label)) return true;
      if (shouldProbeDisabled(s.label)) {
        emailDisabledProbing.add(s.label);
        console.log(`[EMAIL-POLL] Probing disabled source: ${s.label}`);
        return true;
      }
      console.log(`[EMAIL-POLL] Skipping disabled source: ${s.label}`);
      return false;
    });

    console.log(`Polling ${activeEmailSources.length} email sources...`);
    const start = Date.now();

    const fetchResults = await Promise.allSettled(
      activeEmailSources.map(s => timedFetch(s.fetch, s.label, s.weight)),
    );

    const existingIds = new Set(eventCache.map(e => e.id));
    let added = 0;

    for (let i = 0; i < activeEmailSources.length; i++) {
      const label = activeEmailSources[i].label;
      const settled = fetchResults[i];
      const result = settled.status === 'fulfilled'
        ? settled.value
        : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message || 'unknown' };

      // Update health tracking
      updateSourceHealth(label, result);

      // Update probe timestamp (only if still disabled after health update)
      if (emailDisabledProbing.has(label) && isSourceDisabled(label)) {
        sourceHealth[label].lastProbeAt = new Date().toISOString();
      }

      if (result.status === 'error' || result.status === 'timeout') {
        console.error(`[EMAIL-POLL] ${label} failed:`, result.error);
        continue;
      }

      // Baseline gate (same as full scrape)
      if (result.status === 'ok') {
        const verdict = checkBaseline(label, result.events);
        if (verdict.quarantined) {
          console.warn(`[EMAIL-POLL] Quarantined ${label}: ${verdict.reason}`);
          sourceHealth[label].lastStatus = 'quarantined';
          sourceHealth[label].lastQuarantineReason = verdict.reason;
          continue;
        }
      }

      // Quality gates on new events
      const gated = applyQualityGates(result.events);

      for (const e of gated) {
        if (!existingIds.has(e.id)) {
          existingIds.add(e.id);
          eventCache.push(e);
          added++;
        }
      }

      console.log(`[EMAIL-POLL] ${label}: ${result.events.length} fetched, ${gated.length} after gates`);
    }

    // Persist if we added anything
    if (added > 0) {
      try {
        const db = require('./db');
        const newEvents = eventCache.filter(e => EMAIL_SOURCES.some(s => s.label === e.source_name));
        if (newEvents.length > 0) {
          db.upsertEvents(newEvents);
          try { db.insertScrapedEvents(newEvents); } catch (e2) {
            console.warn('[EMAIL-POLL] scraped_events insert failed:', e2.message);
          }
        }
      } catch (err) {
        console.warn('[EMAIL-POLL] SQLite upsert failed:', err.message);
      }

      try {
        atomicWriteSync(CACHE_FILE, JSON.stringify({ events: eventCache, timestamp: cacheTimestamp }));
      } catch (err) {
        console.error('[EMAIL-POLL] Cache persist failed:', err.message);
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[EMAIL-POLL] Done in ${elapsed}s — ${added} new events added (cache: ${eventCache.length})`);
  })();

  try {
    await emailRefreshPromise;
  } finally {
    emailRefreshPromise = null;
  }
}

// ============================================================
// Selective source refresh — re-scrape specific sources only
// ============================================================

async function refreshSources(sourceNames, { reprocess = false } = {}) {
  // Match flexibly: strip non-alpha so "nyc_parks", "nyc-parks", "nycparks" all match "NYCParks"
  const normalize = s => s.toLowerCase().replace(/[^a-z]/g, '');
  const normalizedInputs = sourceNames.map(normalize);
  const targets = SOURCES.filter(s => normalizedInputs.includes(normalize(s.label)));
  if (targets.length === 0) {
    console.warn(`refreshSources: no matching sources for [${sourceNames.join(', ')}]`);
    return;
  }

  console.log(`Refreshing ${targets.length} source(s): ${targets.map(s => s.label).join(', ')}`);

  // Fetch only the targeted sources — pass reprocess to Yutori if requested
  const results = await Promise.allSettled(
    targets.map(s => {
      const fetchFn = (reprocess && s.label === 'Yutori') ? () => s.fetch({ reprocess }) : s.fetch;
      return timedFetch(fetchFn, s.label, s.weight);
    })
  );

  // Remove old events from targeted sources, keep everything else
  const targetNorms = new Set(targets.map(t => normalize(t.label)));
  const kept = eventCache.filter(e => !targetNorms.has(normalize(e.source_name)));

  // Merge in new events
  const seen = new Set(kept.map(e => e.id));
  const newEvents = [];

  for (let i = 0; i < targets.length; i++) {
    const label = targets[i].label;
    const settled = results[i];
    const { events, durationMs, status, error } = settled.status === 'fulfilled'
      ? settled.value
      : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message };

    updateSourceHealth(label, { events, durationMs, status, error });
    const sourceEntry = SOURCES.find(s => s.label === label);
    if (sourceEntry?.volatile) sourceHealth[label].volatile = true;

    for (const e of events) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        newEvents.push(e);
      }
    }

    console.log(`  ${label}: ${events.length} events (${status})`);
  }

  // Apply 30-day date filter + kids filter to new events
  // Include yesterday so newsletter events survive next-day scrape
  const yesterday = getNycDateString(-1);
  const today = getNycDateString(0);
  const monthOut = getNycDateString(30);
  const dateFiltered = newEvents.filter(e => {
    const active = isEventInDateRange(e, yesterday, monthOut);
    return active === null ? true : active;
  });
  const validNew = filterKidsEvents(dateFiltered);

  // Resolve neighborhoods for new events via venue map + geocoding
  await batchGeocodeEvents(validNew);

  // Write to SQLite and rebuild 7-day serving cache
  const weekOut = getNycDateString(7);
  try {
    const db = require('./db');
    db.deleteEventsBySource(targets.map(s => s.label));
    db.upsertEvents(validNew);
    // Persist to historical scraped_events (append-only)
    try { db.insertScrapedEvents(validNew); } catch (err) {
      console.warn('scraped_events insert failed (selective refresh):', err.message);
    }
    // Rebuild from SQLite
    const dbEvents = db.getEventsInRange(today, weekOut);
    const occurrences = db.generateOccurrences(today, weekOut);
    const seenIds = new Set(dbEvents.map(e => e.id));
    const freshOccurrences = occurrences.filter(o => !seenIds.has(o.id));
    eventCache = filterKidsEvents([...dbEvents, ...freshOccurrences]);
    stampRecurrence(eventCache);
    stampVenueSize(eventCache);
    stampInteractionFormat(eventCache);
    stampSourceVibe(eventCache);
    remapOtherCategories(eventCache);
    cacheTimestamp = Date.now();
  } catch (err) {
    // SQLite failed — fall back to in-memory merge
    console.warn('SQLite selective refresh failed, using in-memory:', err.message);
    const weekFiltered = validNew.filter(e => {
      const active = isEventInDateRange(e, today, weekOut);
      return active === null ? true : active;
    });
    eventCache = [...kept, ...weekFiltered];
    cacheTimestamp = Date.now();
  }

  // Persist JSON cache for backward compat
  try {
    atomicWriteSync(CACHE_FILE, JSON.stringify({ events: eventCache, timestamp: cacheTimestamp }, null, 2));
  } catch (err) {
    console.warn('Failed to persist cache after selective refresh:', err.message);
  }

  saveHealthData();
  console.log(`Selective refresh done: ${validNew.length} new events merged, ${eventCache.length} total`);
}

// ============================================================
// Main entry: get events for a neighborhood (reads from cache)
// ============================================================

/* remapOtherCategory / remapOtherCategories moved above boot code — see top of file */

/**
 * Backfill neighborhood from venue coords for events that have a known venue
 * but no neighborhood (common with Yutori film events where venue names have
 * date suffixes that prevented matching during scrape-time geocoding).
 */
function backfillNeighborhoodFromVenue(events) {
  const { resolveNeighborhood } = require('./geo');
  let filled = 0;
  for (const e of events) {
    if (e.neighborhood || !e.venue_name) continue;
    const coords = lookupVenue(e.venue_name);
    if (coords) {
      const hood = resolveNeighborhood(null, coords.lat, coords.lng);
      if (hood) {
        e.neighborhood = hood;
        filled++;
      }
    }
  }
  if (filled > 0) {
    console.log(`Backfilled ${filled} neighborhoods from venue coords`);
  }
}

/**
 * Quality-gate filter — shared between getEvents and getEventsCitywide.
 */
function applyQualityGates(events) {
  const upcoming = filterUpcomingEvents(events);
  backfillNeighborhoodFromVenue(upcoming);
  return filterIncomplete(
    upcoming.filter(e => {
      if (e.needs_review === true) return false;
      if (e.extraction_confidence !== null && e.extraction_confidence !== undefined && e.extraction_confidence < 0.4) return false;
      if (isGarbageName(e.name)) return false;
      if (!hasValidNeighborhood(e)) return false;
      if (isGarbageVenue(e.venue_name)) return false;
      return true;
    }),
    0.4
  );
}

/**
 * Sort events with filter awareness: matching events first, padded with unmatched.
 * When no filters are active, falls back to plain sortFn.
 * Only checks category and free_only — time/vibe are handled downstream by buildTaggedPool.
 */
function filterAwareSort(events, filters, sortFn) {
  const hasCat = filters?.category;
  const hasFree = filters?.free_only;
  if (!hasCat && !hasFree) return [...events].sort(sortFn);

  const matching = [];
  const rest = [];
  for (const e of events) {
    const catOk = !hasCat || e.category === hasCat;
    const freeOk = !hasFree || e.is_free;
    if (catOk && freeOk) matching.push(e);
    else rest.push(e);
  }
  matching.sort(sortFn);
  rest.sort(sortFn);
  return [...matching, ...rest];
}

async function getEvents(neighborhood, { dateRange } = {}) {
  if (eventCache.length === 0) {
    await refreshCache();
  }

  const qualityFiltered = applyQualityGates(eventCache);
  const ranked = rankEventsByProximity(qualityFiltered, neighborhood);

  // Filter by date range (defaults to 7-day window)
  const todayNyc = getNycDateString(0);
  const weekOutNyc = getNycDateString(7);
  const rangeStart = dateRange?.start || todayNyc;
  const rangeEnd = dateRange?.end || weekOutNyc;
  const filtered = ranked.filter(e => {
    const active = isEventInDateRange(e, rangeStart, rangeEnd);
    return active === null ? true : active; // keep undated events
  });

  console.log(`${filtered.length} events near ${neighborhood} (range ${rangeStart}..${rangeEnd}, cache: ${eventCache.length})`);
  return filtered.slice(0, 100);
}

/**
 * Creates a sort comparator for events: date proximity → source tier → source vibe → confidence.
 * @param {string} rangeEnd - fallback date for undated events
 */
function createEventSortFn(rangeEnd) {
  const tierOrder = { unstructured: 0, primary: 1, secondary: 2 };
  const vibeOrder = { discovery: 0, niche: 1, platform: 2, mainstream: 3 };
  return (a, b) => {
    const dateA = getEventDate(a) || rangeEnd;
    const dateB = getEventDate(b) || rangeEnd;
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    const tierA = tierOrder[a.source_tier] ?? 2;
    const tierB = tierOrder[b.source_tier] ?? 2;
    if (tierA !== tierB) return tierA - tierB;
    const va = vibeOrder[a.source_vibe] ?? 2;
    const vb = vibeOrder[b.source_vibe] ?? 2;
    if (va !== vb) return va - vb;
    const confA = a.extraction_confidence ?? 1;
    const confB = b.extraction_confidence ?? 1;
    return confB - confA;
  };
}

/**
 * Get events for a borough — filters to neighborhoods within the borough.
 * Applies quality gates, date filtering, and neighborhood diversity (max 3 per hood).
 */
async function getEventsForBorough(borough, { dateRange, filters } = {}) {
  if (eventCache.length === 0) {
    await refreshCache();
  }

  const { BOROUGHS } = require('./neighborhoods');
  const hoodSet = new Set(BOROUGHS[borough] || []);
  const qualityFiltered = applyQualityGates(eventCache);
  const inBorough = qualityFiltered.filter(e => hoodSet.has(e.neighborhood));

  // Filter by date range (defaults to 7-day window)
  const todayNyc = getNycDateString(0);
  const weekOutNyc = getNycDateString(7);
  const rangeStart = dateRange?.start || todayNyc;
  const rangeEnd = dateRange?.end || weekOutNyc;
  const dateFiltered = inBorough.filter(e => {
    const active = isEventInDateRange(e, rangeStart, rangeEnd);
    return active === null ? true : active;
  });

  // Sort by date proximity x source tier x source vibe (discovery first)
  const sortFn = createEventSortFn(rangeEnd);

  // Filter-aware pool: matching events first, padded with unmatched
  const sorted = filterAwareSort(dateFiltered, filters, sortFn);

  // Apply neighborhood diversity: max 3 per hood
  const diverse = [];
  const hoodCounts = {};
  for (const e of sorted) {
    const hood = e.neighborhood || 'unknown';
    hoodCounts[hood] = (hoodCounts[hood] || 0) + 1;
    if (hoodCounts[hood] <= 3) diverse.push(e);
    if (diverse.length >= 30) break;
  }

  console.log(`Borough ${borough}: ${diverse.length} events (${dateFiltered.length} total, range ${rangeStart}..${rangeEnd}, cache: ${eventCache.length})`);
  return diverse;
}

/**
 * Get events citywide — no geographic anchor. Returns best events across all neighborhoods.
 * Applies same quality gates as getEvents.
 */
async function getEventsCitywide({ dateRange, filters } = {}) {
  if (eventCache.length === 0) {
    await refreshCache();
  }

  const qualityFiltered = applyQualityGates(eventCache);

  // Filter by date range (defaults to 7-day window)
  const todayNyc = getNycDateString(0);
  const weekOutNyc = getNycDateString(7);
  const rangeStart = dateRange?.start || todayNyc;
  const rangeEnd = dateRange?.end || weekOutNyc;
  const dateFiltered = qualityFiltered.filter(e => {
    const active = isEventInDateRange(e, rangeStart, rangeEnd);
    return active === null ? true : active;
  });

  // Rank by: date proximity (today first) x source tier x source vibe (discovery first)
  const sortFn = createEventSortFn(rangeEnd);

  // Filter-aware pool: matching events first, padded with unmatched
  const sorted = filterAwareSort(dateFiltered, filters, sortFn);

  console.log(`Citywide: ${sorted.length} events (range ${rangeStart}..${rangeEnd}, cache: ${eventCache.length})`);
  return sorted.slice(0, 100);
}

// ============================================================
// Daily scheduler — runs scrape at target hour in NYC timezone
// ============================================================

const SCRAPE_HOURS = [10, 18]; // 10am ET + 6pm ET (catches same-day newsletters)

function msUntilNextScrape() {
  const now = new Date();
  // Get current NYC time components
  const nycStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [datePart, timePart] = nycStr.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);

  const nowSeconds = hour * 3600 + minute * 60 + second;

  // Find next scrape hour that's still in the future
  let bestMs = Infinity;
  let bestHour = SCRAPE_HOURS[0];
  for (const h of SCRAPE_HOURS) {
    let diffSeconds = h * 3600 - nowSeconds;
    if (diffSeconds <= 0) diffSeconds += 24 * 3600; // wrap to tomorrow
    const ms = diffSeconds * 1000;
    if (ms < bestMs) {
      bestMs = ms;
      bestHour = h;
    }
  }

  return { ms: bestMs, hour: bestHour };
}

let dailyTimer = null;

function scheduleDailyScrape() {
  const { ms, hour } = msUntilNextScrape();
  const hours = (ms / 3600000).toFixed(1);
  console.log(`Next scrape scheduled in ${hours} hours (${hour}:00 ET)`);

  dailyTimer = setTimeout(async () => {
    try {
      await refreshCache();
      // Post-scrape hook: proactive outreach
      try {
        const { processProactiveMessages } = require('./proactive');
        const cache = getRawCache();
        await processProactiveMessages(cache);
      } catch (proactiveErr) {
        console.error('[PROACTIVE] Post-scrape hook error:', proactiveErr.message);
      }
    } catch (err) {
      console.error('Scheduled scrape failed:', err.message);
    }
    // Schedule next one (repeats daily)
    scheduleDailyScrape();
  }, ms);
}

function clearSchedule() {
  if (dailyTimer) clearTimeout(dailyTimer);
}

// ============================================================
// Email-only poll scheduler — catches newsletters between full scrapes
// ============================================================

const EMAIL_POLL_HOURS = [6, 14, 22]; // ET hours not covered by full scrape (10, 18)

function msUntilNextEmailPoll() {
  const now = new Date();
  const nycStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [datePart, timePart] = nycStr.split(', ');
  const [hour, minute, second] = timePart.split(':').map(Number);
  const nowSeconds = hour * 3600 + minute * 60 + second;

  let bestMs = Infinity;
  let bestHour = EMAIL_POLL_HOURS[0];
  for (const h of EMAIL_POLL_HOURS) {
    let diffSeconds = h * 3600 - nowSeconds;
    if (diffSeconds <= 0) diffSeconds += 24 * 3600;
    const ms = diffSeconds * 1000;
    if (ms < bestMs) {
      bestMs = ms;
      bestHour = h;
    }
  }
  return { ms: bestMs, hour: bestHour };
}

let emailPollTimer = null;

function scheduleEmailPolls() {
  const { ms, hour } = msUntilNextEmailPoll();
  const hours = (ms / 3600000).toFixed(1);
  console.log(`Next email poll in ${hours} hours (${hour}:00 ET)`);

  emailPollTimer = setTimeout(async () => {
    try {
      await refreshEmailSources();
    } catch (err) {
      console.error('[EMAIL-POLL] Scheduled poll failed:', err.message);
    }
    scheduleEmailPolls();
  }, ms);
}

function clearEmailSchedule() {
  if (emailPollTimer) clearTimeout(emailPollTimer);
}

function getCacheStatus() {
  const nextEmail = msUntilNextEmailPoll();
  return {
    cache_size: eventCache.length,
    cache_age_minutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
    cache_fresh: eventCache.length > 0,
    sources: { ...sourceHealth },
    next_email_poll_hours: parseFloat((nextEmail.ms / 3600000).toFixed(1)),
    next_email_poll_hour_et: nextEmail.hour,
  };
}

function getHealthStatus() {
  const result = _getHealthStatus({ size: eventCache.length, timestamp: cacheTimestamp });
  // Attach eventMix computed from live cache
  result.eventMix = computeEventMix(eventCache);
  // Attach recurring pattern count
  try {
    const { getPatternCount } = require('./db');
    result.recurringPatterns = getPatternCount();
  } catch {
    result.recurringPatterns = 0;
  }
  return result;
}

function getRawCache() {
  return { events: [...eventCache], timestamp: cacheTimestamp };
}

const STALE_THRESHOLD_MS = 20 * 60 * 60 * 1000; // 20 hours

function isCacheFresh() {
  return eventCache.length > 0 && cacheTimestamp > 0 && (Date.now() - cacheTimestamp) < STALE_THRESHOLD_MS;
}

function getEventById(id) {
  return eventCache.find(e => e.id === id) || null;
}

// ============================================================
// City-wide scan — find which neighborhoods have filter-matching events
// ============================================================

function scanCityWide(filters) {
  const qualityFiltered = applyQualityGates(eventCache);

  const todayNyc = getNycDateString(0);
  const tomorrowNyc = getNycDateString(1);
  const rangeStart = filters.date_range?.start || todayNyc;
  const rangeEnd = filters.date_range?.end || tomorrowNyc;
  const dateFiltered = qualityFiltered.filter(e => {
    const active = isEventInDateRange(e, rangeStart, rangeEnd);
    return active === null ? true : active;
  });

  let candidates = dateFiltered;
  if (filters.time_after && /^\d{2}:\d{2}$/.test(filters.time_after)) {
    candidates = dateFiltered.filter(e => !failsTimeGate(e, filters.time_after));
  }

  const hoodCounts = {};
  for (const e of candidates) {
    if (eventMatchesFilters(e, filters) && e.neighborhood) {
      hoodCounts[e.neighborhood] = (hoodCounts[e.neighborhood] || 0) + 1;
    }
  }

  return Object.entries(hoodCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([neighborhood, matchCount]) => ({ neighborhood, matchCount }));
}

module.exports = { SOURCES, SOURCE_TIERS, refreshCache, refreshSources, refreshEmailSources, getEvents, getEventsForBorough, getEventsCitywide, getEventById, getCacheStatus, getHealthStatus, getRawCache, isCacheFresh, scheduleDailyScrape, clearSchedule, scheduleEmailPolls, clearEmailSchedule, captureExtractionInput, getExtractionInputs, scanCityWide, scoreInterestingness, selectDiversePicks, getTopPicks, isGarbageName, remapOtherCategory };
