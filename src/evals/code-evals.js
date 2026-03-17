/**
 * Code-based evals — deterministic checks on traces.
 * Each returns { name, pass, detail }
 *
 * Trimmed to 6 structural invariants (2026-03-05 eval redesign).
 * Subjective quality is handled by the LLM judge in run-quality-evals.js.
 */

const evals = {
  /**
   * SMS must be <= 480 chars
   */
  char_limit(trace) {
    const len = trace.output_sms_length || 0;
    if (trace.output_intent === 'details' && len > 480) {
      return { name: 'char_limit', pass: true, detail: `${len} chars (multi-SMS details, exempt)` };
    }
    return {
      name: 'char_limit',
      pass: len <= 480,
      detail: `${len} chars${len > 480 ? ` (${len - 480} over)` : ''}`,
    };
  },

  /**
   * Response must not be empty
   */
  response_not_empty(trace) {
    const sms = (trace.output_sms || '').trim();
    return {
      name: 'response_not_empty',
      pass: sms.length > 0,
      detail: sms.length > 0 ? `${sms.length} chars` : 'empty response',
    };
  },

  /**
   * Every picked event_id must be in the sent_ids list
   */
  picked_events_exist(trace) {
    const picks = trace.composition.picks || [];
    const sentIds = new Set(trace.events.sent_ids || []);
    if (picks.length === 0) return { name: 'picked_events_exist', pass: true, detail: 'no picks' };
    const missing = picks.filter(p => !sentIds.has(p.event_id));
    return {
      name: 'picked_events_exist',
      pass: missing.length === 0,
      detail: missing.length > 0 ? `missing: ${missing.map(p => p.event_id).join(', ')}` : `${picks.length} picks all valid`,
    };
  },

  /**
   * Total latency should be under 10s
   */
  latency_under_10s(trace) {
    const ms = trace.total_latency_ms || 0;
    return {
      name: 'latency_under_10s',
      pass: ms < 10000,
      detail: `${ms}ms`,
    };
  },

  /**
   * All URLs in SMS are parseable (no truncation)
   */
  valid_urls(trace) {
    const sms = trace.output_sms || '';
    const urlPattern = /https?:\/\/[^\s)]+/g;
    const urls = sms.match(urlPattern) || [];
    if (urls.length === 0) return { name: 'valid_urls', pass: true, detail: 'no URLs' };
    const broken = urls.filter(u => {
      try { new URL(u); return false; } catch { return true; }
    });
    return {
      name: 'valid_urls',
      pass: broken.length === 0,
      detail: broken.length > 0 ? `broken: ${broken.join(', ')}` : `${urls.length} URLs valid`,
    };
  },

  /**
   * Price transparency: event picks in SMS should mention price or "free".
   */
  price_transparency(trace) {
    const picks = trace.composition.picks || [];
    const sms = trace.output_sms || '';
    const intent = trace.output_intent;
    if (!['events', 'more'].includes(intent) || picks.length === 0) {
      return { name: 'price_transparency', pass: true, detail: 'not applicable' };
    }
    const isActionablePrice = (p) => {
      if (p.is_free === true) return true;
      if (!p.price_display) return false;
      const pd = p.price_display.toLowerCase();
      if (/\$\d/.test(pd)) return true;
      if (/\bfree\b/.test(pd)) return true;
      return false;
    };
    const picksWithPrice = picks.filter(isActionablePrice);
    if (picksWithPrice.length === 0) {
      return { name: 'price_transparency', pass: true, detail: 'no actionable price data on picked events (source gap)' };
    }
    const pricePattern = /\$\d|free\b|no cover|cover charge|\bcover\b|ticketed|\bpaid\b|price TBD/i;
    const hasPrice = pricePattern.test(sms);
    return {
      name: 'price_transparency',
      pass: hasPrice,
      detail: hasPrice ? 'price info found in SMS' : `no price mention in SMS (${picksWithPrice.length}/${picks.length} picks have price data)`,
    };
  },
};

// --- Multi-turn evals (run across a conversation, not per-trace) ---

const multiTurnEvals = {
  /**
   * Filters set in one turn should persist in subsequent turns unless explicitly cleared.
   * Checks brain_tool_calls for search params.filters across consecutive pulse turns.
   */
  filter_state_preserved(conversation) {
    const pulseTurns = conversation.filter(t => t.sender === 'pulse' && (t.trace || t.trace_debug));
    if (pulseTurns.length < 2) return { name: 'filter_state_preserved', pass: true, detail: 'single turn, n/a' };

    const drops = [];
    let prevFilters = null;
    let prevTurnIndex = 0;

    for (let i = 0; i < pulseTurns.length; i++) {
      const turn = pulseTurns[i];
      const trace = turn.trace || {};

      // Extract filters from tool call params (agent-loop path)
      const toolCalls = trace.brain_tool_calls || [];
      const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search');
      const currentFilters = lastSearch?.params?.filters || null;
      const intent = lastSearch?.params?.intent;

      // Skip non-search turns (respond-only) and details/more
      if (!lastSearch || intent === 'details') {
        continue;
      }

      if (prevFilters && currentFilters) {
        // Check: if prev had a category filter and current doesn't, that's a drop
        const prevCats = prevFilters.categories || (prevFilters.category ? [prevFilters.category] : []);
        const currCats = currentFilters.categories || (currentFilters.category ? [currentFilters.category] : []);

        if (prevCats.length > 0 && currCats.length === 0 && intent !== 'discover') {
          // Only flag if the user didn't explicitly start a new search
          drops.push({
            turn: i + 1,
            dropped: `categories: [${prevCats.join(', ')}]`,
            prevTurn: prevTurnIndex + 1,
          });
        }

        // Check free_only persistence
        if (prevFilters.free_only && !currentFilters.free_only && intent !== 'discover') {
          drops.push({
            turn: i + 1,
            dropped: 'free_only',
            prevTurn: prevTurnIndex + 1,
          });
        }
      }

      prevFilters = currentFilters;
      prevTurnIndex = i;
    }

    return {
      name: 'filter_state_preserved',
      pass: drops.length === 0,
      detail: drops.length > 0
        ? `${drops.length} filter drop(s): ${drops.map(d => `turn ${d.prevTurn}→${d.turn} lost ${d.dropped}`).join('; ')}`
        : `filters stable across ${pulseTurns.length} turns`,
    };
  },
};

/**
 * Run all code evals on a trace.
 * @param {Object} trace
 * @returns {Array<{name, pass, detail}>}
 */
function runCodeEvals(trace) {
  return Object.values(evals).map(fn => fn(trace));
}

/**
 * Run multi-turn evals on a full conversation.
 * @param {Array} conversation - Array of { sender, message, trace, trace_debug }
 * @returns {Array<{name, pass, detail}>}
 */
function runMultiTurnEvals(conversation) {
  return Object.values(multiTurnEvals).map(fn => fn(conversation));
}

module.exports = { runCodeEvals, runMultiTurnEvals, evals, multiTurnEvals };
