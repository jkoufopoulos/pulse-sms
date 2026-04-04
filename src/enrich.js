/**
 * Scrape-time enrichment pipeline.
 * Fills missing URLs, times, and descriptions by searching the web.
 * Runs after extraction, before cache persistence.
 */

/**
 * Identify which events have data gaps worth filling.
 * Returns a Map<event, string[]> of gap types.
 */
function identifyGaps(events) {
  const gaps = new Map();
  for (const e of events) {
    const missing = [];
    if (!e.source_url && !e.ticket_url) missing.push('url');
    if (!e.start_time_local) missing.push('time');
    if (!e.description_short && !e.description) missing.push('description');
    if (missing.length > 0 && e.name && e.venue_name) {
      gaps.set(e, missing);
    }
  }
  return gaps;
}

/**
 * Build a search query for an event with missing data.
 */
function buildSearchQuery(event) {
  const parts = [`"${event.name}"`];
  if (event.venue_name) parts.push(`"${event.venue_name}"`);
  parts.push('NYC');
  return parts.join(' ');
}

const ENRICHMENT_CONCURRENCY = 5;
const ENRICHMENT_TIMEOUT_MS = 10_000;
const MAX_ENRICH_PER_SCRAPE = 50;

/**
 * Enrich events with missing data by searching the web.
 * Called after extraction, before cache persistence.
 * Modifies events in-place. Returns count of events enriched.
 */
async function enrichEvents(events) {
  const gaps = identifyGaps(events);
  if (gaps.size === 0) {
    console.log('[ENRICH] No events need enrichment');
    return 0;
  }

  const toEnrich = [];
  for (const [event, missing] of gaps) {
    if (event.enrichment_attempted) continue;
    toEnrich.push({ event, missing });
  }

  if (toEnrich.length === 0) {
    console.log('[ENRICH] All gap events already attempted');
    return 0;
  }

  const batch = toEnrich.slice(0, MAX_ENRICH_PER_SCRAPE);
  console.log(`[ENRICH] Enriching ${batch.length}/${toEnrich.length} events (${gaps.size} total with gaps)`);

  let enriched = 0;

  for (let i = 0; i < batch.length; i += ENRICHMENT_CONCURRENCY) {
    const chunk = batch.slice(i, i + ENRICHMENT_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(({ event, missing }) => enrichSingleEvent(event, missing))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) enriched++;
    }
  }

  console.log(`[ENRICH] Enriched ${enriched}/${batch.length} events`);
  return enriched;
}

/**
 * Enrich a single event via Tavily search.
 * Modifies event in-place. Returns true if any field was filled.
 */
async function enrichSingleEvent(event, missing) {
  event.enrichment_attempted = true;

  try {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return false;

    const query = buildSearchQuery(event);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENRICHMENT_TIMEOUT_MS);

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        max_results: 3,
        include_answer: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return false;

    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) return false;

    let filled = false;
    const searchUrl = results[0].url;
    const searchDescription = results[0].content?.slice(0, 300) || null;

    if (missing.includes('url') && searchUrl) {
      event.source_url = searchUrl;
      event.enrichment_source = 'tavily';
      filled = true;
    }
    if (missing.includes('description') && searchDescription) {
      event.description_short = searchDescription;
      event.enrichment_source = 'tavily';
      filled = true;
    }

    return filled;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn(`[ENRICH] Failed for "${event.name}":`, err.message);
    }
    return false;
  }
}

module.exports = { identifyGaps, buildSearchQuery, enrichEvents };
