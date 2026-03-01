const fs = require('fs');
const path = require('path');
const { SOURCES, SOURCE_TIERS, SOURCE_LABELS, ENDPOINT_URLS, MERGE_ORDER } = require('./source-registry');
const { sourceHealth, saveHealthData, updateSourceHealth, updateEndpointStatus, updateScrapeStats, alertOnFailingSources, checkEndpoints, computeEventMix, getHealthStatus: _getHealthStatus } = require('./source-health');
const { rankEventsByProximity, filterUpcomingEvents, getNycDateString, getEventDate } = require('./geo');
const { batchGeocodeEvents, exportLearnedVenues, importLearnedVenues } = require('./venues');
const { filterIncomplete, filterKidsEvents } = require('./curation');
const { eventMatchesFilters, failsTimeGate } = require('./pipeline');
const { computeCompleteness, backfillEvidence, backfillDateTimes } = require('./sources/shared');
const { runExtractionAudit } = require('./evals/extraction-audit');
const { checkSourceCompleteness } = require('./evals/source-completeness');
const { captureExtractionInput, getExtractionInputs, clearExtractionInputs } = require('./extraction-capture');

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
  const { getEventsInRange, generateOccurrences, importFromJsonCache } = require('./db');
  // Auto-import JSON cache on first boot with SQLite
  importFromJsonCache(CACHE_FILE);
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

async function timedFetch(fetchFn, label, weight) {
  const start = Date.now();
  try {
    const events = await fetchFn();
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

    // Run endpoint checks and source fetches in parallel
    // SOURCES drives the fetch array — no positional coupling
    const [endpointResults, ...fetchResults] = await Promise.allSettled([
      checkEndpoints(),
      ...SOURCES.map(s => timedFetch(s.fetch, s.label, s.weight)),
    ]);

    // Store endpoint check results
    const endpoints = endpointResults.status === 'fulfilled' ? endpointResults.value : {};
    for (const [label, data] of Object.entries(endpoints)) {
      updateEndpointStatus(label, data.httpStatus);
    }

    const allEvents = [];
    const seen = new Set();

    // Map fetch results back to labels — SOURCES[i] corresponds to fetchResults[i]
    const fetchMap = {};
    for (let i = 0; i < SOURCES.length; i++) {
      const settled = fetchResults[i];
      fetchMap[SOURCES[i].label] = settled.status === 'fulfilled'
        ? settled.value
        : { events: [], durationMs: 0, status: 'error', error: settled.reason?.message || 'unknown' };
    }

    let sourcesOk = 0, sourcesFailed = 0, sourcesEmpty = 0;
    let totalRaw = 0;

    // Merge in priority order (highest weight first, then mergeRank)
    for (const label of MERGE_ORDER) {
      const { events, durationMs, status, error } = fetchMap[label];
      totalRaw += events.length;

      for (const e of events) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }

      if (status === 'error' || status === 'timeout') {
        console.error(`${label} failed:`, error);
      }

      updateSourceHealth(label, { events, durationMs, status, error });

      if (status === 'ok') sourcesOk++;
      else if (status === 'empty') sourcesEmpty++;
      else sourcesFailed++;
    }

    // Filter out stale/far-future events and kids events at scrape time
    // Include yesterday so Friday newsletter events survive Saturday's scrape;
    // serving-time filterUpcomingEvents handles actual expiry (end_time + 2hr grace)
    const yesterday = getNycDateString(-1);
    const today = getNycDateString(0);
    const monthOut = getNycDateString(30);
    const dateFiltered = allEvents.filter(e => {
      const d = getEventDate(e);
      if (!d) return true; // keep undated events (perennials, venues)
      return d >= yesterday && d <= monthOut;
    });
    const validEvents = filterKidsEvents(dateFiltered);
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

    // Persist learned venues to disk for next restart
    const learned = exportLearnedVenues();
    const learnedCount = Object.keys(learned).length;
    if (learnedCount > 0) {
      try {
        fs.writeFileSync(path.join(__dirname, '../data/venues-learned.json'), JSON.stringify(learned, null, 2));
        console.log(`Persisted ${learnedCount} learned venues`);
      } catch (err) { console.error('Failed to persist venues:', err.message); }
    }

    // Write all 30-day events to SQLite, then rebuild 7-day serving cache
    const weekOut = getNycDateString(7);
    try {
      const db = require('./db');
      db.upsertEvents(validEvents);
      db.pruneOldEvents(getNycDateString(-30));
      // Rebuild serving cache from SQLite (7-day window) + recurring patterns
      const dbEvents = db.getEventsInRange(today, weekOut);
      const occurrences = db.generateOccurrences(today, weekOut);
      const seenIds = new Set(dbEvents.map(e => e.id));
      const freshOccurrences = occurrences.filter(o => !seenIds.has(o.id));
      eventCache = filterKidsEvents([...dbEvents, ...freshOccurrences]);
      backfillDateTimes(eventCache);
      cacheTimestamp = Date.now();
      console.log(`SQLite: ${validEvents.length} events stored, serving ${eventCache.length} (${dbEvents.length} scraped + ${freshOccurrences.length} recurring)`);
    } catch (err) {
      // SQLite failed — fall back to 7-day in-memory cache
      console.warn('SQLite write failed, using in-memory cache:', err.message);
      const weekFiltered = validEvents.filter(e => {
        const d = getEventDate(e);
        if (!d) return true;
        return d >= yesterday && d <= weekOut;
      });
      eventCache = weekFiltered;
      cacheTimestamp = Date.now();
    }

    // Persist JSON cache for backward compat / fallback
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ events: eventCache, timestamp: cacheTimestamp }));
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
    });

    // Alert on sources that have been failing for 3+ consecutive scrapes
    alertOnFailingSources();

    // Run extraction audit (deterministic tier only — fast, free)
    try {
      const auditReport = runExtractionAudit(validEvents, getExtractionInputs());
      if (auditReport.summary.total > 0) {
        console.log(`Extraction audit: ${auditReport.summary.passed}/${auditReport.summary.total} events pass (${auditReport.summary.passRate}), ${auditReport.summary.issues} issues`);
        // Save report to disk
        const reportsDir = path.join(__dirname, '../data/reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const reportFile = path.join(reportsDir, `extraction-audit-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(reportFile, JSON.stringify(auditReport, null, 2));
      }
    } catch (err) {
      console.error('Extraction audit failed:', err.message);
    }

    // Run source field-completeness checks (structured sources only)
    try {
      checkSourceCompleteness(fetchMap);
    } catch (err) {
      console.error('Source completeness check failed:', err.message);
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
    const d = getEventDate(e);
    if (!d) return true;
    return d >= yesterday && d <= monthOut;
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
    // Rebuild from SQLite
    const dbEvents = db.getEventsInRange(today, weekOut);
    const occurrences = db.generateOccurrences(today, weekOut);
    const seenIds = new Set(dbEvents.map(e => e.id));
    const freshOccurrences = occurrences.filter(o => !seenIds.has(o.id));
    eventCache = filterKidsEvents([...dbEvents, ...freshOccurrences]);
    cacheTimestamp = Date.now();
  } catch (err) {
    // SQLite failed — fall back to in-memory merge
    console.warn('SQLite selective refresh failed, using in-memory:', err.message);
    const weekFiltered = validNew.filter(e => {
      const d = getEventDate(e);
      if (!d) return true;
      return d >= today && d <= weekOut;
    });
    eventCache = [...kept, ...weekFiltered];
    cacheTimestamp = Date.now();
  }

  // Persist JSON cache for backward compat
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ events: eventCache, timestamp: cacheTimestamp }, null, 2));
  } catch (err) {
    console.warn('Failed to persist cache after selective refresh:', err.message);
  }

  saveHealthData();
  console.log(`Selective refresh done: ${validNew.length} new events merged, ${eventCache.length} total`);
}

// ============================================================
// Main entry: get events for a neighborhood (reads from cache)
// ============================================================

/**
 * Quality-gate filter — shared between getEvents and getEventsCitywide.
 */
function applyQualityGates(events) {
  const upcoming = filterUpcomingEvents(events);
  return filterIncomplete(
    upcoming.filter(e => {
      if (e.needs_review === true) return false;
      if (e.extraction_confidence !== null && e.extraction_confidence !== undefined && e.extraction_confidence < 0.4) return false;
      return true;
    }),
    0.4
  );
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
    const d = getEventDate(e);
    if (!d) return true; // keep undated events
    return d >= rangeStart && d <= rangeEnd;
  });

  console.log(`${filtered.length} events near ${neighborhood} (range ${rangeStart}..${rangeEnd}, cache: ${eventCache.length})`);
  return filtered.slice(0, 20);
}

/**
 * Get events citywide — no geographic anchor. Returns best events across all neighborhoods.
 * Applies same quality gates as getEvents.
 */
async function getEventsCitywide({ dateRange } = {}) {
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
    const d = getEventDate(e);
    if (!d) return true;
    return d >= rangeStart && d <= rangeEnd;
  });

  // Rank by: date proximity (today first) x source tier quality
  const tierOrder = { unstructured: 0, primary: 1, secondary: 2 };
  const sorted = dateFiltered.sort((a, b) => {
    const dateA = getEventDate(a) || rangeEnd;
    const dateB = getEventDate(b) || rangeEnd;
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    const tierA = tierOrder[a.source_tier] ?? 2;
    const tierB = tierOrder[b.source_tier] ?? 2;
    if (tierA !== tierB) return tierA - tierB;
    const confA = a.extraction_confidence ?? 1;
    const confB = b.extraction_confidence ?? 1;
    return confB - confA;
  });

  console.log(`Citywide: ${sorted.length} events (range ${rangeStart}..${rangeEnd}, cache: ${eventCache.length})`);
  return sorted.slice(0, 30);
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

function getCacheStatus() {
  return {
    cache_size: eventCache.length,
    cache_age_minutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
    cache_fresh: eventCache.length > 0,
    sources: { ...sourceHealth },
  };
}

function getHealthStatus() {
  const result = _getHealthStatus({ size: eventCache.length, timestamp: cacheTimestamp });
  // Attach eventMix computed from live cache
  result.eventMix = computeEventMix(eventCache);
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
    const d = getEventDate(e);
    if (!d) return true;
    return d >= rangeStart && d <= rangeEnd;
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

module.exports = { SOURCES, SOURCE_TIERS, refreshCache, refreshSources, getEvents, getEventsCitywide, getEventById, getCacheStatus, getHealthStatus, getRawCache, isCacheFresh, scheduleDailyScrape, clearSchedule, captureExtractionInput, getExtractionInputs, scanCityWide };
