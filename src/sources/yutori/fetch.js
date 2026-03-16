const fs = require('fs');
const path = require('path');
const { extractYutoriEvents } = require('../../ai');
const { fetchYutoriEmails } = require('../../gmail');
const { normalizeExtractedEvent } = require('../shared');
const { captureExtractionInput } = require('../../extraction-capture');
const { getCachedExtraction, setCachedExtraction } = require('../../extraction-cache');
const { isEventEmail, isTriviaEmail } = require('./email-filter');
const { isGarbageName } = require('../../curation');
const { preprocessYutoriHtml } = require('./html-preprocess');
const { parseTriviaEvents } = require('./trivia-parser');
const { parseNonTriviaEvents, resolveDayOfWeekDate } = require('./general-parser');
const { parseStructuredYutoriHtml } = require('./structured-parser');
const {
  YUTORI_DIR, PROCESSED_DIR, CACHE_FILE,
  loadCachedEvents, saveCachedEvents,
  loadProcessedIds, saveProcessedIds,
  processRecurrencePatterns, makeFilename,
} = require('./cache');

/**
 * Fetch Yutori emails from Gmail and save new ones to data/yutori/ as .html files.
 * Returns the number of new emails saved.
 */
async function ingestFromGmail() {
  const emails = await fetchYutoriEmails(48);
  if (emails.length === 0) {
    console.log('[YUTORI] Gmail returned 0 emails — either no new mail in 48h window or credentials are broken');
    return 0;
  }

  const processedIds = loadProcessedIds();
  fs.mkdirSync(YUTORI_DIR, { recursive: true });

  let saved = 0;
  for (const email of emails) {
    if (processedIds.has(email.id)) {
      continue;
    }

    const filename = makeFilename(email.subject, email.date);
    const filepath = path.join(YUTORI_DIR, filename);

    // Skip if a file with this name already exists (from manual placement or prior run)
    if (fs.existsSync(filepath)) {
      processedIds.add(email.id);
      continue;
    }

    try {
      fs.writeFileSync(filepath, email.body, 'utf8');
      processedIds.add(email.id);
      saved++;
      console.log(`Yutori: saved Gmail email → ${filename}`);
    } catch (err) {
      console.warn(`Yutori: failed to save ${filename}:`, err.message);
    }
  }

  saveProcessedIds(processedIds);
  return saved;
}

async function fetchYutoriEvents({ reprocess = false } = {}) {
  console.log('Fetching Yutori agent briefings...');
  try {
    // Step 1: Try fetching from Gmail (no-op if credentials not configured)
    const gmailCount = await ingestFromGmail();
    if (gmailCount > 0) {
      console.log(`Yutori: ${gmailCount} new email(s) from Gmail`);
    }

    // Reprocess: move all processed files back and clear stale cache
    if (reprocess && fs.existsSync(PROCESSED_DIR)) {
      const processed = fs.readdirSync(PROCESSED_DIR).filter(f => /\.(txt|html?)$/i.test(f));
      if (processed.length > 0) {
        fs.mkdirSync(YUTORI_DIR, { recursive: true });
        console.log(`Yutori: reprocessing ${processed.length} files from processed/`);
        for (const f of processed) {
          fs.renameSync(path.join(PROCESSED_DIR, f), path.join(YUTORI_DIR, f));
        }
        if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
      }
    }

    // Step 2: Process files in data/yutori/ (from Gmail or manual placement)
    if (!fs.existsSync(YUTORI_DIR)) {
      console.log('Yutori: data/yutori/ directory not found, skipping');
      return [];
    }

    const files = fs.readdirSync(YUTORI_DIR)
      .filter(f => /\.(txt|html?)$/i.test(f))
      .sort();

    if (files.length === 0) {
      // No new files — return cached events from last extraction
      const cached = loadCachedEvents();
      if (cached?.events?.length > 0) {
        console.log(`Yutori: returning ${cached.events.length} cached events (no new files)`);
        return cached.events;
      }

      // No cache exists — bootstrap by re-processing most recent file from processed/
      if (fs.existsSync(PROCESSED_DIR)) {
        const processed = fs.readdirSync(PROCESSED_DIR)
          .filter(f => /\.(txt|html?)$/i.test(f))
          .sort();
        if (processed.length > 0) {
          const latest = processed[processed.length - 1];
          console.log(`Yutori: bootstrapping cache from processed/${latest}`);
          // Move latest back to main dir for processing
          fs.renameSync(path.join(PROCESSED_DIR, latest), path.join(YUTORI_DIR, latest));
          // Re-run — will find the file, process it, cache, and move back
          return fetchYutoriEvents({ reprocess: false });
        }
      }

      console.log('Yutori: no briefing files found and no cache');
      return [];
    }

    // Process each file individually to stay within extraction limits
    const fileContents = [];
    const triviaEvents = [];
    for (const file of files) {
      const raw = fs.readFileSync(path.join(YUTORI_DIR, file), 'utf8');

      // Skip non-event emails (fintech, sports, etc.)
      if (/\.html?$/i.test(file) && !isEventEmail(file, raw)) {
        console.log(`Yutori: skipping non-event email → ${file}`);
        continue;
      }

      // Trivia emails: deterministic parse (P6), skip LLM
      if (/\.html?$/i.test(file) && isTriviaEmail(file, raw)) {
        const content = preprocessYutoriHtml(raw);
        const parsed = parseTriviaEvents(content, file);
        if (parsed.length > 0) {
          console.log(`Yutori: deterministic trivia parse → ${parsed.length} events from ${file}`);
          captureExtractionInput('yutori', content, null);
          const normalized = parsed
            .map(e => normalizeExtractedEvent(e, 'yutori', 'aggregator', 0.8))
            .filter(e => e.name && e.completeness >= 0.35);
          triviaEvents.push(...normalized);
          continue;
        }
        // Fall through to LLM if deterministic parse found nothing
      }

      // Non-trivia event emails: try structured HTML parse first (P6)
      if (/\.html?$/i.test(file)) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        const parsed = parseStructuredYutoriHtml(raw, dateMatch ? dateMatch[1] : null);
        if (parsed.length > 0) {
          console.log(`Yutori: structured parse → ${parsed.length} events from ${file}`);
          captureExtractionInput('yutori', raw.slice(0, 2000), null);
          const normalized = parsed
            .map(e => normalizeExtractedEvent(e, 'yutori', 'aggregator', 0.85))
            .filter(e => e.name && e.completeness >= 0.25);
          // Fix day-of-week mismatches
          normalized.forEach(resolveDayOfWeekDate);
          triviaEvents.push(...normalized);
          continue;
        }
        // Fall through to LLM if structured parse found nothing
      }

      const content = /\.html?$/i.test(file) ? preprocessYutoriHtml(raw) : raw;
      if (content.length >= 50) {
        fileContents.push({ file, content });
      }
    }

    if (fileContents.length === 0 && triviaEvents.length === 0) {
      console.log('Yutori: all briefing files too short or empty, skipping');
      return [];
    }

    console.log(`Yutori: processing ${fileContents.length} files + ${triviaEvents.length} trivia-parsed events`);
    const events = [...triviaEvents];

    // Process files in parallel (max 3 concurrent to avoid rate limits)
    const CONCURRENCY = 3;
    for (let i = 0; i < fileContents.length; i += CONCURRENCY) {
      const batch = fileContents.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async ({ file, content }) => {
          console.log(`Yutori: LLM extracting ${file} (${content.length} chars)`);
          captureExtractionInput('yutori', content, null);
          const cacheKey = `yutori-sonnet:${file}`;
          const cachedFile = getCachedExtraction(cacheKey, content);
          if (cachedFile) return cachedFile;
          const result = await extractYutoriEvents(content, file);
          const raw = result.events || [];
          const normalized = raw.map(e => normalizeExtractedEvent(e, 'yutori', 'aggregator', 0.8));
          const passed = normalized.filter(e => e.name && e.completeness >= 0.25);
          // Drop prose advice/commentary with no structural event signals.
          // date_local alone doesn't count — the LLM assigns today's date to everything.
          // Require at least one of: specific time, real venue, or URL.
          // A venue that's a substring of the event name (or vice versa) is fabricated.
          const contentFiltered = passed.filter(e => {
            const hasTime = !!e.start_time_local;
            const hasUrl = !!e.ticket_url || !!e.source_url;
            let hasVenue = !!e.venue_name && e.venue_name !== 'TBA';
            if (hasVenue) {
              const vLow = e.venue_name.toLowerCase();
              const nLow = (e.name || '').toLowerCase();
              if (nLow.startsWith(vLow) || vLow.startsWith(nLow.split(':')[0])) {
                hasVenue = false;
              }
            }
            if (!hasTime && !hasVenue && !hasUrl) return false;
            if (isGarbageName(e.name)) return false;
            return true;
          });
          // Fix day-of-week mismatches (e.g. "Trivia Thursdays" assigned to Friday)
          contentFiltered.forEach(resolveDayOfWeekDate);
          const dropped = raw.length - contentFiltered.length;
          if (dropped > 0) {
            console.log(`Yutori: LLM extracted ${raw.length} from ${file}, ${contentFiltered.length} passed gates (${dropped} dropped)`);
          }
          setCachedExtraction(cacheKey, content, contentFiltered);
          return contentFiltered;
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          events.push(...r.value);
        } else {
          console.warn('Yutori: extraction failed for batch item:', r.reason?.message);
        }
      }
    }

    // Move processed files to processed/ directory
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
    for (const file of files) {
      const src = path.join(YUTORI_DIR, file);
      const dest = path.join(PROCESSED_DIR, file);
      try {
        fs.renameSync(src, dest);
      } catch (err) {
        console.warn(`Yutori: failed to move ${file}: ${err.message}`);
      }
    }

    // Detect recurring patterns and upsert to SQLite
    processRecurrencePatterns(events);

    saveCachedEvents(events);
    console.log(`Yutori: ${events.length} events from ${files.length} briefings`);
    return events;
  } catch (err) {
    console.error('Yutori error:', err.message);
    return [];
  }
}

module.exports = { fetchYutoriEvents, ingestFromGmail };
