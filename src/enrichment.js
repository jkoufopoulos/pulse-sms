const { extractEvents } = require('./ai');
const { normalizeExtractedEvent } = require('./sources/shared');

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
          match.category = llmEvent.category;
          changed = true;
        }
        if (changed) enriched++;
      }
    }

    console.log(`[ENRICHMENT] Enriched ${enriched}/${incomplete.length} events`);
    return { sent: incomplete.length, enriched };
  } catch (err) {
    console.warn(`[ENRICHMENT] Failed (non-fatal): ${err.message}`);
    return { sent: incomplete.length, enriched: 0, error: err.message };
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

module.exports = { collectIncompleteEvents, enrichIncompleteEvents, stripRawText };
