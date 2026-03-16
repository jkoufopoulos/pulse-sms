const fs = require('fs');
const path = require('path');
const { extractEvents } = require('./ai');
const { normalizeExtractedEvent } = require('./sources/shared');
const { generate: llmGenerate } = require('./llm');
const { MODELS } = require('./model-config');

const CLASSIFICATION_LOG_FILE = path.join(__dirname, '..', 'data', 'classification-log.json');
const CLASSIFICATION_LOG_MAX = 5000;

// Valid categories for LLM classification (post-canonicalization values)
const CLASSIFY_CATEGORIES = [
  'comedy', 'live_music', 'nightlife', 'art', 'theater', 'community',
  'trivia', 'film', 'food_drink', 'spoken_word', 'tours', 'dance', 'other',
];

/**
 * Collect all events that have _rawText and are missing critical fields.
 * An event is "incomplete" if it's missing start_time_local (non-series),
 * OR has TBA/missing venue_name, OR has missing neighborhood.
 */
function collectIncompleteEvents(events) {
  return events.filter(e => {
    if (!e._rawText) return false;
    const missingTime = !e.start_time_local && !e.series_end;
    const missingVenue = !e.venue_name || e.venue_name === 'TBA';
    const missingHood = !e.neighborhood;
    return missingTime || missingVenue || missingHood;
  });
}

/**
 * Post-scrape enrichment: send any event with _rawText and missing
 * critical fields through LLM extraction, merge results back.
 * Mutates events in place. Returns enrichment stats.
 */
async function enrichIncompleteEvents(events) {
  const incomplete = collectIncompleteEvents(events);

  if (incomplete.length === 0) {
    return { sent: 0, enriched: 0 };
  }

  const missingTime = incomplete.filter(e => !e.start_time_local && !e.series_end).length;
  const missingVenue = incomplete.filter(e => !e.venue_name || e.venue_name === 'TBA').length;
  console.log(`[ENRICHMENT] ${incomplete.length} incomplete events (${missingTime} no time, ${missingVenue} no venue) — sending to LLM`);

  try {
    const today = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    // Batch in groups of 10 to avoid truncated JSON from maxTokens limits
    const BATCH_SIZE = 10;
    const llmEvents = [];
    for (let i = 0; i < incomplete.length; i += BATCH_SIZE) {
      const batch = incomplete.slice(i, i + BATCH_SIZE);
      const content = `Published: ${today}\n\n` + batch.map(e => e._rawText).join('\n\n');
      const result = await extractEvents(content, 'enrichment', 'enrichment:post-scrape');
      const batchEvents = (result.events || [])
        .map(e => normalizeExtractedEvent(e, 'enrichment', 'curated', 0.9))
        .filter(e => e.name);
      llmEvents.push(...batchEvents);
    }

    let enriched = 0;
    const enrichLogEntries = [];
    for (const llmEvent of llmEvents) {
      const llmName = llmEvent.name.toLowerCase().slice(0, 30);
      const match = incomplete.find(e =>
        e.name.toLowerCase().slice(0, 30) === llmName ||
        e.name.toLowerCase().includes(llmName) ||
        llmName.includes(e.name.toLowerCase().slice(0, 20))
      );
      if (match) {
        let changed = false;
        if (!match.start_time_local && llmEvent.start_time_local) {
          match.start_time_local = llmEvent.start_time_local;
          changed = true;
        }
        if (llmEvent.end_time_local && !match.end_time_local) {
          match.end_time_local = llmEvent.end_time_local;
          changed = true;
        }
        if ((!match.venue_name || match.venue_name === 'TBA') && llmEvent.venue_name && llmEvent.venue_name !== 'TBA') {
          match.venue_name = llmEvent.venue_name;
          changed = true;
        }
        if (!match.neighborhood && llmEvent.neighborhood) {
          match.neighborhood = llmEvent.neighborhood;
          changed = true;
        }
        if (match.category === 'other' && llmEvent.category && llmEvent.category !== 'other') {
          const originalCategory = match.category;
          match.category = llmEvent.category;
          changed = true;
          enrichLogEntries.push({
            event_name: match.name,
            source_name: match.source_name || '',
            original_category: originalCategory,
            new_category: llmEvent.category,
            method: 'enrichment',
            timestamp: new Date().toISOString(),
          });
        }
        if (changed) enriched++;
      }
    }

    if (enrichLogEntries.length > 0) {
      logClassification(enrichLogEntries);
    }

    console.log(`[ENRICHMENT] Enriched ${enriched}/${incomplete.length} events`);
    return { sent: incomplete.length, enriched };
  } catch (err) {
    console.warn(`[ENRICHMENT] Failed (non-fatal): ${err.message}`);
    return { sent: incomplete.length, enriched: 0, error: err.message };
  }
}

/**
 * Classify remaining "other" events using LLM.
 * Runs after remapOtherCategories() regex pass.
 * Mutates events in place. Returns classification stats.
 */
async function classifyOtherEvents(events) {
  const otherEvents = events.filter(e => e.category === 'other');

  if (otherEvents.length === 0) {
    return { classified: 0, total: 0 };
  }

  console.log(`[LLM-CLASSIFY] ${otherEvents.length} "other" events — sending to LLM for classification`);

  const BATCH_SIZE = 30;
  const validSet = new Set(CLASSIFY_CATEGORIES);
  let classified = 0;
  const logEntries = [];

  try {
    for (let i = 0; i < otherEvents.length; i += BATCH_SIZE) {
      const batch = otherEvents.slice(i, i + BATCH_SIZE);

      const eventList = batch.map((e, idx) => {
        const desc = e.description_short || e.short_detail || '';
        return `${idx + 1}. name: ${e.name}${desc ? `\n   description: ${desc}` : ''}`;
      }).join('\n');

      const systemPrompt = `You are an event classifier for NYC nightlife and cultural events. Classify each event into exactly one category.

Valid categories: ${CLASSIFY_CATEGORIES.join(', ')}

Rules:
- Use "nightlife" for DJ sets, dance parties, club nights, raves
- Use "live_music" for concerts, live bands, singer-songwriters
- Use "comedy" for stand-up, sketch, improv shows
- Use "theater" for plays, musicals, immersive theater, cabaret, burlesque, drag shows
- Use "art" for gallery openings, exhibitions, art shows
- Use "community" for workshops, meetups, markets, fundraisers, wellness events
- Use "film" for screenings, movie nights, film festivals
- Use "food_drink" for tastings, supper clubs, food popups
- Use "spoken_word" for poetry, book readings, storytelling
- Use "trivia" for quiz nights, game nights, bingo, karaoke
- Use "tours" for walking tours, guided tours
- Use "dance" for dance performances, ballet, contemporary dance
- Only use "other" if the event truly does not fit any category

Return a JSON array: [{"name": "...", "category": "..."}]`;

      const userPrompt = `Classify these events:\n\n${eventList}`;

      const result = await llmGenerate(MODELS.extract, systemPrompt, userPrompt, {
        maxTokens: 2048, temperature: 0, json: true, timeout: 30000,
      });

      let classifications;
      try {
        const parsed = JSON.parse(result.text);
        classifications = Array.isArray(parsed) ? parsed : (parsed.events || parsed.classifications || []);
      } catch {
        // Try to extract JSON array from response
        const match = result.text.match(/\[[\s\S]*\]/);
        if (match) {
          try { classifications = JSON.parse(match[0]); } catch { classifications = []; }
        } else {
          classifications = [];
        }
      }

      for (const cls of classifications) {
        if (!cls.name || !cls.category) continue;
        if (!validSet.has(cls.category)) continue;
        if (cls.category === 'other') continue;

        const clsName = cls.name.toLowerCase().slice(0, 30);
        const match = batch.find(e =>
          e.name.toLowerCase().slice(0, 30) === clsName ||
          e.name.toLowerCase().includes(clsName) ||
          clsName.includes(e.name.toLowerCase().slice(0, 20))
        );

        if (match) {
          logEntries.push({
            event_name: match.name,
            source_name: match.source_name || '',
            original_category: 'other',
            new_category: cls.category,
            method: 'llm_classify',
            timestamp: new Date().toISOString(),
          });
          match.category = cls.category;
          classified++;
        }
      }
    }

    console.log(`[LLM-CLASSIFY] Reclassified ${classified}/${otherEvents.length} "other" events`);

    if (logEntries.length > 0) {
      logClassification(logEntries);
    }

    return { classified, total: otherEvents.length };
  } catch (err) {
    console.warn(`[LLM-CLASSIFY] Failed (non-fatal): ${err.message}`);
    return { classified: 0, total: otherEvents.length, error: err.message };
  }
}

/**
 * Append classification log entries to data/classification-log.json.
 * Caps at CLASSIFICATION_LOG_MAX entries (oldest trimmed first).
 */
function logClassification(entries) {
  try {
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(CLASSIFICATION_LOG_FILE, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    } catch { /* file doesn't exist yet */ }

    const combined = [...existing, ...entries];
    // Keep only the most recent entries
    const trimmed = combined.length > CLASSIFICATION_LOG_MAX
      ? combined.slice(combined.length - CLASSIFICATION_LOG_MAX)
      : combined;

    fs.writeFileSync(CLASSIFICATION_LOG_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.warn(`[LLM-CLASSIFY] Failed to write classification log: ${err.message}`);
  }
}

/**
 * Strip _rawText from all events (call after enrichment, before persistence).
 */
function stripRawText(events) {
  for (const e of events) {
    delete e._rawText;
  }
}

module.exports = {
  collectIncompleteEvents,
  enrichIncompleteEvents,
  classifyOtherEvents,
  logClassification,
  stripRawText,
  CLASSIFY_CATEGORIES,
};
