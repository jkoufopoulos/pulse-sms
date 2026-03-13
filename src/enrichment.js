const { extractEvents } = require('./ai');
const { normalizeExtractedEvent } = require('./sources/shared');

/**
 * Collect all events that have _rawText but are missing start_time_local.
 * Excludes ongoing/series events (they legitimately lack times).
 */
function collectIncompleteEvents(events) {
  return events.filter(e => e._rawText && !e.start_time_local && !e.series_end);
}

/**
 * Post-scrape enrichment: send any event with _rawText and missing
 * start_time through LLM extraction, merge results back.
 * Mutates events in place. Returns enrichment stats.
 */
async function enrichIncompleteEvents(events) {
  const incomplete = collectIncompleteEvents(events);

  if (incomplete.length === 0) {
    return { sent: 0, enriched: 0 };
  }

  console.log(`[ENRICHMENT] ${incomplete.length} events missing start_time — sending to LLM`);

  try {
    const today = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const content = `Published: ${today}\n\n` + incomplete.map(e => e._rawText).join('\n\n');
    const result = await extractEvents(content, 'enrichment', 'enrichment:post-scrape');
    const llmEvents = (result.events || [])
      .map(e => normalizeExtractedEvent(e, 'enrichment', 'curated', 0.9))
      .filter(e => e.name && e.start_time_local);

    let enriched = 0;
    for (const llmEvent of llmEvents) {
      const llmName = llmEvent.name.toLowerCase().slice(0, 30);
      const match = incomplete.find(e =>
        e.name.toLowerCase().slice(0, 30) === llmName
      );
      if (match) {
        match.start_time_local = llmEvent.start_time_local;
        if (llmEvent.end_time_local) match.end_time_local = llmEvent.end_time_local;
        if ((!match.venue_name || match.venue_name === 'TBA') && llmEvent.venue_name && llmEvent.venue_name !== 'TBA') {
          match.venue_name = llmEvent.venue_name;
        }
        if (!match.neighborhood && llmEvent.neighborhood) {
          match.neighborhood = llmEvent.neighborhood;
        }
        enriched++;
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
