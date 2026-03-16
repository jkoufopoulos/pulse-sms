const fs = require('fs');
const path = require('path');
const { generate: llmGenerate } = require('./llm');
const { MODELS } = require('./model-config');

const CLASSIFICATION_LOG_FILE = path.join(__dirname, '..', 'data', 'classification-log.json');
const CLASSIFICATION_LOG_MAX = 5000;

const CLASSIFY_CATEGORIES = [
  'comedy', 'live_music', 'nightlife', 'art', 'theater', 'community',
  'trivia', 'film', 'food_drink', 'spoken_word', 'tours', 'dance', 'other',
];

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
 */
function logClassification(entries) {
  try {
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(CLASSIFICATION_LOG_FILE, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    } catch { /* file doesn't exist yet */ }

    const combined = [...existing, ...entries];
    const trimmed = combined.length > CLASSIFICATION_LOG_MAX
      ? combined.slice(combined.length - CLASSIFICATION_LOG_MAX)
      : combined;

    fs.writeFileSync(CLASSIFICATION_LOG_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.warn(`[LLM-CLASSIFY] Failed to write classification log: ${err.message}`);
  }
}

module.exports = {
  classifyOtherEvents,
  logClassification,
  CLASSIFY_CATEGORIES,
};
