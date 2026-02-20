const { extractEvents } = require('../ai');
const { normalizeExtractedEvent } = require('./shared');
const { filterUpcomingEvents } = require('../geo');

async function searchTavilyEvents(neighborhood, { query: customQuery } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const query = customQuery || `events tonight ${neighborhood} NYC ${today}`;

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`Tavily search failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const results = data.results || [];

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const freshResults = results.filter(r => {
      if (!r.published_date) return true;
      try {
        return new Date(r.published_date).getTime() > sevenDaysAgo;
      } catch { return true; }
    });
    if (freshResults.length < results.length) {
      console.log(`Tavily: dropped ${results.length - freshResults.length} stale results (>7 days old)`);
    }

    const rawText = freshResults
      .map(r => `[Source: ${r.url}]\n${r.title}\n${r.content}`)
      .join('\n\n---\n\n');

    if (!rawText.trim()) return [];

    const extracted = await extractEvents(rawText, 'tavily', query, { model: 'claude-haiku-4-5-20251001' });
    const events = (extracted.events || [])
      .map(raw => normalizeExtractedEvent(raw, 'tavily', 'search', 0.6))
      .filter(e => e.name && e.completeness >= 0.5);

    const upcoming = filterUpcomingEvents(events);
    if (upcoming.length < events.length) {
      console.log(`Tavily: dropped ${events.length - upcoming.length} past events`);
    }

    console.log(`Tavily: ${upcoming.length} events for ${neighborhood}`);
    return upcoming;
  } catch (err) {
    console.error('Tavily search error:', err.message);
    return [];
  }
}

async function fetchTavilyFreeEvents() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const queries = [
    `free events NYC tonight ${today} no cover`,
    `free things to do in New York City ${today} free entry`,
  ];

  try {
    const searchResults = await Promise.allSettled(
      queries.map(query =>
        fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: 'basic',
            max_results: 5,
            include_answer: false,
          }),
          signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.json() : { results: [] })
      )
    );

    const seenUrls = new Set();
    const allResults = [];
    for (const sr of searchResults) {
      if (sr.status !== 'fulfilled') continue;
      for (const r of (sr.value.results || [])) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          allResults.push(r);
        }
      }
    }

    if (allResults.length === 0) return [];

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const freshResults = allResults.filter(r => {
      if (!r.published_date) return true;
      try { return new Date(r.published_date).getTime() > sevenDaysAgo; } catch { return true; }
    });

    const rawText = freshResults
      .map(r => `[Source: ${r.url}]\n${r.title}\n${r.content}`)
      .join('\n\n---\n\n');

    if (!rawText.trim()) return [];

    const extracted = await extractEvents(rawText, 'tavily-free', 'daily scrape', { model: 'claude-haiku-4-5-20251001' });
    const events = (extracted.events || [])
      .map(raw => {
        const e = normalizeExtractedEvent(raw, 'tavily', 'search', 0.6);
        e.is_free = true;
        return e;
      })
      .filter(e => e.name && e.completeness >= 0.5);

    const upcoming = filterUpcomingEvents(events);
    console.log(`Tavily daily free: ${upcoming.length} events (from ${freshResults.length} search results)`);
    return upcoming;
  } catch (err) {
    console.error('Tavily daily free search error:', err.message);
    return [];
  }
}

module.exports = { searchTavilyEvents, fetchTavilyFreeEvents };
