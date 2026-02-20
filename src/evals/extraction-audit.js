/**
 * Extraction Audit — validates that Claude-extracted events match their raw sources.
 *
 * Tier 1: Deterministic checks (free, instant) — runs on every scrape.
 * Tier 2: LLM judge (optional, ~$0.001/event via Haiku) — on-demand only.
 *
 * Each check returns { name, pass, detail }.
 */

const { getNycDateString } = require('../geo');

// Sources that use Claude extraction (unstructured HTML → JSON)
const CLAUDE_EXTRACTED_SOURCES = ['theskint', 'nonsensenyc', 'ohmyrockness', 'yutori', 'tavily'];

// ============================================================
// Tier 1: Deterministic checks
// ============================================================

/**
 * Check if an evidence quote appears in the raw source text.
 * Uses case-insensitive substring matching with whitespace normalization.
 */
function evidenceInSource(rawText, quote) {
  if (!rawText || !quote) return null; // can't check
  const normRaw = rawText.toLowerCase().replace(/\s+/g, ' ');
  const normQuote = quote.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normQuote) return null;
  return normRaw.includes(normQuote);
}

const tier1Checks = {
  evidence_name_in_source(event, rawText) {
    const quote = event.evidence?.name_quote;
    if (!quote) return { name: 'evidence_name_in_source', pass: true, detail: 'no name_quote (skipped)' };
    const found = evidenceInSource(rawText, quote);
    if (found === null) return { name: 'evidence_name_in_source', pass: true, detail: 'no raw text (skipped)' };
    return {
      name: 'evidence_name_in_source',
      pass: found,
      detail: found ? `found: '${quote.slice(0, 50)}'` : `NOT FOUND: '${quote.slice(0, 50)}'`,
    };
  },

  evidence_time_in_source(event, rawText) {
    const quote = event.evidence?.time_quote;
    if (!quote) return { name: 'evidence_time_in_source', pass: true, detail: 'no time_quote (skipped)' };
    const found = evidenceInSource(rawText, quote);
    if (found === null) return { name: 'evidence_time_in_source', pass: true, detail: 'no raw text (skipped)' };
    return {
      name: 'evidence_time_in_source',
      pass: found,
      detail: found ? `found: '${quote.slice(0, 50)}'` : `NOT FOUND: '${quote.slice(0, 50)}'`,
    };
  },

  evidence_location_in_source(event, rawText) {
    const quote = event.evidence?.location_quote;
    if (!quote) return { name: 'evidence_location_in_source', pass: true, detail: 'no location_quote (skipped)' };
    const found = evidenceInSource(rawText, quote);
    if (found === null) return { name: 'evidence_location_in_source', pass: true, detail: 'no raw text (skipped)' };
    return {
      name: 'evidence_location_in_source',
      pass: found,
      detail: found ? `found: '${quote.slice(0, 50)}'` : `NOT FOUND: '${quote.slice(0, 50)}'`,
    };
  },

  evidence_price_in_source(event, rawText) {
    const quote = event.evidence?.price_quote;
    if (!quote) return { name: 'evidence_price_in_source', pass: true, detail: 'no price_quote (skipped)' };
    const found = evidenceInSource(rawText, quote);
    if (found === null) return { name: 'evidence_price_in_source', pass: true, detail: 'no raw text (skipped)' };
    return {
      name: 'evidence_price_in_source',
      pass: found,
      detail: found ? `found: '${quote.slice(0, 50)}'` : `NOT FOUND: '${quote.slice(0, 50)}'`,
    };
  },

  has_evidence(event) {
    const ev = event.evidence || {};
    const fields = [ev.name_quote, ev.time_quote, ev.location_quote, ev.price_quote];
    const present = fields.filter(f => f && f.trim()).length;
    return {
      name: 'has_evidence',
      pass: present >= 2,
      detail: `${present}/4 evidence fields present`,
    };
  },

  confidence_calibrated(event) {
    const confidence = event.extraction_confidence;
    if (confidence == null) return { name: 'confidence_calibrated', pass: true, detail: 'no confidence score (skipped)' };

    const ev = event.evidence || {};
    const fields = [ev.name_quote, ev.time_quote, ev.location_quote, ev.price_quote];
    const present = fields.filter(f => f && f.trim()).length;
    const highConfidence = confidence > 0.8;
    const allEvidence = present === 4;

    if (highConfidence && !allEvidence) {
      return {
        name: 'confidence_calibrated',
        pass: false,
        detail: `confidence ${confidence} but only ${present}/4 evidence fields — overconfident`,
      };
    }
    return {
      name: 'confidence_calibrated',
      pass: true,
      detail: `confidence ${confidence}, ${present}/4 evidence fields`,
    };
  },

  date_not_past(event) {
    const dateLocal = event.date_local;
    if (!dateLocal) return { name: 'date_not_past', pass: true, detail: 'no date (skipped)' };

    const today = getNycDateString(0);
    const isPast = dateLocal < today;
    return {
      name: 'date_not_past',
      pass: !isPast,
      detail: isPast ? `${dateLocal} is before today (${today})` : `${dateLocal} (today or future)`,
    };
  },

  required_fields_present(event) {
    const hasName = !!event.name;
    const hasVenueOrHood = !!(event.venue_name && event.venue_name !== 'TBA') || !!event.neighborhood;
    const hasDateOrTime = !!event.date_local || !!event.time_window;
    const pass = hasName && hasVenueOrHood && hasDateOrTime;
    const missing = [];
    if (!hasName) missing.push('name');
    if (!hasVenueOrHood) missing.push('venue/neighborhood');
    if (!hasDateOrTime) missing.push('date/time_window');
    return {
      name: 'required_fields_present',
      pass,
      detail: pass ? 'all required fields present' : `missing: ${missing.join(', ')}`,
    };
  },
};

// ============================================================
// Tier 2: LLM judge (optional)
// ============================================================

async function runLlmAudit(event, rawText) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const extracted = {
    name: event.name,
    venue_name: event.venue_name,
    date_local: event.date_local,
    start_time_local: event.start_time_local,
    price_display: event.price_display,
    category: event.category,
  };

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are auditing an event extraction. Given the raw source text and extracted event fields, verify each field.

<raw_text>
${rawText.slice(0, 3000)}
</raw_text>

<extracted>
${JSON.stringify(extracted, null, 2)}
</extracted>

For each field (name, venue_name, date_local, start_time_local, price_display, category), respond with one of:
- CORRECT — the field matches the source
- WRONG — the field doesn't match (include correction)
- UNVERIFIABLE — can't determine from source text

Respond as JSON: { "verdicts": { "name": { "status": "CORRECT|WRONG|UNVERIFIABLE", "note": "..." }, ... } }`,
    }],
  }, { timeout: 10000 });

  const text = response.content?.[0]?.text || '';
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fall through */ }
  return { verdicts: {}, _raw: text };
}

// ============================================================
// Main audit runner
// ============================================================

/**
 * Run Tier 1 deterministic checks on all Claude-extracted events.
 * @param {Array} events - All events from the cache
 * @param {Object} extractionInputs - { sourceName: { rawText, sourceUrl, timestamp } }
 * @param {Object} opts - { llm: false } set llm:true for Tier 2
 * @returns {Object} Full audit report
 */
function runExtractionAudit(events, extractionInputs, opts = {}) {
  const claudeEvents = events.filter(e => CLAUDE_EXTRACTED_SOURCES.includes(e.source_name));

  const eventResults = [];
  const sourceStats = {};

  for (const event of claudeEvents) {
    const input = extractionInputs[event.source_name];
    const rawText = input?.rawText || '';

    const results = Object.values(tier1Checks).map(fn => fn(event, rawText));

    const passed = results.every(r => r.pass);
    const failures = results.filter(r => !r.pass);

    eventResults.push({
      source: event.source_name,
      event_id: event.id,
      event_name: event.name,
      passed,
      results,
    });

    // Aggregate per-source stats
    if (!sourceStats[event.source_name]) {
      sourceStats[event.source_name] = { total: 0, passed: 0, failures: {} };
    }
    const stats = sourceStats[event.source_name];
    stats.total++;
    if (passed) stats.passed++;
    for (const f of failures) {
      stats.failures[f.name] = (stats.failures[f.name] || 0) + 1;
    }
  }

  const totalEvents = eventResults.length;
  const totalPassed = eventResults.filter(r => r.passed).length;
  const totalIssues = totalEvents - totalPassed;

  return {
    timestamp: new Date().toISOString(),
    tier: 'deterministic',
    summary: {
      total: totalEvents,
      passed: totalPassed,
      issues: totalIssues,
      passRate: totalEvents > 0 ? (totalPassed / totalEvents * 100).toFixed(1) + '%' : 'N/A',
    },
    sourceStats,
    events: eventResults,
  };
}

/**
 * Run full audit including LLM tier on sampled events.
 * @param {Array} events - All events from the cache
 * @param {Object} extractionInputs - { sourceName: { rawText, sourceUrl, timestamp } }
 * @param {number} sampleSize - How many events to LLM-audit (default 10)
 * @returns {Object} Full audit report with LLM verdicts
 */
async function runFullAudit(events, extractionInputs, sampleSize = 10) {
  // First run deterministic checks
  const report = runExtractionAudit(events, extractionInputs);

  // Sample events for LLM audit (prioritize those that failed deterministic checks)
  const claudeEvents = events.filter(e => CLAUDE_EXTRACTED_SOURCES.includes(e.source_name));
  const failed = report.events.filter(r => !r.passed).map(r => r.event_id);
  const failedSet = new Set(failed);

  // Pick failed events first, then random others
  const sample = [];
  for (const event of claudeEvents) {
    if (sample.length >= sampleSize) break;
    if (failedSet.has(event.id)) sample.push(event);
  }
  for (const event of claudeEvents) {
    if (sample.length >= sampleSize) break;
    if (!failedSet.has(event.id)) sample.push(event);
  }

  // Run LLM audit on sample
  const llmResults = [];
  for (const event of sample) {
    const input = extractionInputs[event.source_name];
    if (!input?.rawText) continue;
    try {
      const verdict = await runLlmAudit(event, input.rawText);
      llmResults.push({
        event_id: event.id,
        event_name: event.name,
        source: event.source_name,
        verdicts: verdict.verdicts || {},
      });
    } catch (err) {
      llmResults.push({
        event_id: event.id,
        event_name: event.name,
        source: event.source_name,
        error: err.message,
      });
    }
  }

  report.tier = 'full';
  report.llmAudit = {
    sampleSize: sample.length,
    results: llmResults,
  };

  return report;
}

module.exports = { runExtractionAudit, runFullAudit, CLAUDE_EXTRACTED_SOURCES, tier1Checks, evidenceInSource };
