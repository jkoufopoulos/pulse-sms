const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../extraction-cache');
const { startRun, recordStage, endRun } = require('../scrape-telemetry');

/**
 * Get NYC date context.
 */
function getNycDayContext() {
  const now = new Date();
  const nycStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, d, y] = nycStr.split('/').map(Number);
  const todayIso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { todayIso };
}

/**
 * Extract event-relevant text from Skint HTML, split by day section.
 * Returns array of { label, content } chunks small enough for LLM extraction.
 */
function extractSkintSections(html) {
  const $ = cheerio.load(html);
  const dayHeaderPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|ongoing)$/i;

  const allEntries = $('.entry-content');
  if (!allEntries.length) return [];

  const eventEntries = [];
  allEntries.each((i, el) => {
    let hasDayHeader = false;
    $(el).find('p').each((j, p) => {
      if (dayHeaderPattern.test($(p).text().trim())) {
        hasDayHeader = true;
        return false;
      }
    });
    if (hasDayHeader) eventEntries.push($(el));
  });

  if (eventEntries.length === 0) return [];

  // Split into day sections
  const sections = [];
  let currentSection = null;

  for (const entry of eventEntries) {
    // Get post heading for date context
    const heading = entry.closest('article').find('.entry-title, h1, h2').first();
    const postHeading = heading.length ? heading.text().trim() : '';

    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text) return;

      // Day header starts a new section. Must run BEFORE the length filter
      // because Skint's current format uses bare-word day labels ("friday",
      // "saturday", etc.) all under the 10-char minimum applied to event text.
      // The original ordering silently collapsed every post into one 'intro'
      // chunk and stripped the date context the LLM extractor relies on.
      if (dayHeaderPattern.test(text)) {
        if (currentSection && currentSection.paragraphs.length > 0) {
          sections.push(currentSection);
        }
        currentSection = {
          label: text,
          postHeading,
          paragraphs: [],
        };
        return;
      }

      if (text.length < 10) return;
      if (text.toLowerCase().startsWith('sponsored')) return;

      if (!currentSection) {
        currentSection = { label: 'intro', postHeading, paragraphs: [] };
      }

      // Preserve last link as [Source: url]
      const links = [];
      $(el).find('a').each((j, a) => {
        const href = $(a).attr('href');
        if (href && !href.includes('theskint.com')) links.push(href);
      });

      if (links.length > 0) {
        currentSection.paragraphs.push(`${text} [Source: ${links[links.length - 1]}]`);
      } else {
        currentSection.paragraphs.push(text);
      }
    });
  }

  if (currentSection && currentSection.paragraphs.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

async function fetchSkintEvents() {
  console.log('Fetching The Skint...');
  // Telemetry: one run per scrape, with per-stage metrics + run_id stamped on
  // each returned event so the merge phase can persist provenance. Failure to
  // record telemetry never blocks the scrape (see scrape-telemetry.js guards).
  const runId = startRun('Skint');
  try {
    const fetchStart = Date.now();
    const res = await fetch('https://theskint.com/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const fetchMs = Date.now() - fetchStart;

    if (!res.ok) {
      recordStage(runId, 'fetch', { status_code: res.status, ok: false }, fetchMs);
      console.error(`Skint fetch failed: ${res.status}`);
      endRun(runId, 'error', 0, `HTTP ${res.status}`);
      return [];
    }

    const html = await res.text();
    recordStage(runId, 'fetch', { status_code: res.status, ok: true, bytes: html.length }, fetchMs);

    const parseStart = Date.now();
    const sections = extractSkintSections(html);
    const paragraphsTotal = sections.reduce((a, s) => a + s.paragraphs.length, 0);
    recordStage(runId, 'parse', {
      sections: sections.length,
      paragraphs_total: paragraphsTotal,
      section_labels: sections.map(s => s.label),
    }, Date.now() - parseStart);

    if (sections.length === 0) {
      console.warn('Skint: no event content found');
      endRun(runId, 'empty', 0);
      return [];
    }

    // Split large sections into chunks of ~15 paragraphs to avoid LLM truncation
    const MAX_PARAGRAPHS = 15;
    const chunks = [];
    for (const section of sections) {
      if (section.paragraphs.length <= MAX_PARAGRAPHS) {
        chunks.push(section);
      } else {
        for (let j = 0; j < section.paragraphs.length; j += MAX_PARAGRAPHS) {
          chunks.push({
            label: section.label + (j > 0 ? ` (part ${Math.floor(j / MAX_PARAGRAPHS) + 1})` : ''),
            postHeading: section.postHeading,
            paragraphs: section.paragraphs.slice(j, j + MAX_PARAGRAPHS),
          });
        }
      }
    }

    console.log(`Skint: ${sections.length} day sections → ${chunks.length} chunks`);

    const allEvents = [];
    const CONCURRENCY = 3;
    const llmStart = Date.now();
    let llmCalls = 0;
    let cacheHits = 0;
    let chunkFailures = 0;
    let eventsPreFilter = 0;

    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (section) => {
          const content = `POST HEADING: ${section.postHeading}\n${section.label.toUpperCase()}\n\n` +
            section.paragraphs.join('\n\n');

          const cacheKey = `theskint:${section.label}`;
          const cached = getCachedExtraction(cacheKey, content);
          if (cached) {
            cacheHits++;
            return cached;
          }

          captureExtractionInput('theskint', content, 'https://theskint.com/');
          const result = await extractEvents(content, 'theskint', 'https://theskint.com/');
          llmCalls++;
          const rawCount = (result.events || []).length;
          eventsPreFilter += rawCount;
          const events = (result.events || [])
            .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9))
            .filter(e => e.name && e.completeness >= 0.5);

          setCachedExtraction(cacheKey, content, events);
          console.log(`Skint: ${section.label} → ${events.length} events`);
          return events;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          allEvents.push(...r.value);
        } else {
          chunkFailures++;
          console.warn('Skint: extraction failed:', r.reason?.message);
        }
      }
    }
    recordStage(runId, 'llm_extract', {
      chunks: chunks.length,
      llm_calls: llmCalls,
      cache_hits: cacheHits,
      chunk_failures: chunkFailures,
      events_pre_filter: eventsPreFilter,
      events_post_filter: allEvents.length,
    }, Date.now() - llmStart);

    // Stamp the run id on every event so insertScrapedEvents (and any future
    // merge-phase consumer) can persist provenance back to this scrape pass.
    if (runId) {
      for (const e of allEvents) e.scrape_run_id = runId;
    }

    console.log(`Skint: ${allEvents.length} total events (LLM)`);
    endRun(runId, allEvents.length > 0 ? 'ok' : 'empty', allEvents.length);
    // Attach the run id as a non-enumerable property so the caller (timedFetch
    // -> refreshCache) can associate downstream merge/cache stages with THIS
    // run rather than guessing via latestRunIdForSource — which races under
    // concurrent scrapes from sibling processes.
    if (runId) Object.defineProperty(allEvents, '__scrapeRunId', { value: runId, enumerable: false });
    return allEvents;
  } catch (err) {
    console.error('Skint error:', err.message);
    endRun(runId, 'error', 0, err.message);
    const empty = [];
    if (runId) Object.defineProperty(empty, '__scrapeRunId', { value: runId, enumerable: false });
    return empty;
  }
}

async function fetchSkintOngoingEvents() {
  console.log('Fetching The Skint ongoing events...');
  try {
    const res = await fetch('https://theskint.com/ongoing-events/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Skint ongoing fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const entry = $('.entry-content').first();
    if (!entry.length) {
      console.warn('Skint ongoing: .entry-content not found');
      return [];
    }

    const { todayIso } = getNycDayContext();

    const paragraphs = [];
    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text || text.length < 30) return;
      if (text.toLowerCase().startsWith('sponsored')) return;

      const lastLink = $(el).find('a').last();
      const linkHref = lastLink.length ? lastLink.attr('href') : null;

      if (linkHref) {
        paragraphs.push(`${text} [Source: ${linkHref}]`);
      } else {
        paragraphs.push(text);
      }
    });

    if (paragraphs.length === 0) {
      console.warn('Skint ongoing: no content found');
      return [];
    }

    const content = `Today: ${todayIso}\nOngoing NYC events:\n\n` + paragraphs.join('\n\n');
    captureExtractionInput('theskint', content, 'https://theskint.com/ongoing-events/');

    const cached = getCachedExtraction('theskint-ongoing', content);
    if (cached) {
      console.log(`Skint ongoing: ${cached.length} events (cached)`);
      return cached;
    }

    const result = await extractEvents(content, 'theskint', 'https://theskint.com/ongoing-events/');
    const events = (result.events || [])
      .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9))
      .filter(e => e.name && e.completeness >= 0.5);

    setCachedExtraction('theskint-ongoing', content, events);
    console.log(`Skint ongoing: ${events.length} events (LLM)`);
    return events;
  } catch (err) {
    console.error('Skint ongoing error:', err.message);
    return [];
  }
}

module.exports = { fetchSkintEvents, fetchSkintOngoingEvents, extractSkintSections };
