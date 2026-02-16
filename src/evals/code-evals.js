/**
 * Code-based evals — deterministic checks on traces.
 * Each returns { name, pass, detail }
 */

const { NEIGHBORHOODS } = require('../neighborhoods');

const VALID_INTENTS = ['events', 'details', 'more', 'free', 'help', 'conversational'];
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

const evals = {
  /**
   * SMS must be <= 480 chars
   */
  char_limit(trace) {
    const len = trace.output_sms_length || 0;
    return {
      name: 'char_limit',
      pass: len <= 480,
      detail: `${len} chars${len > 480 ? ` (${len - 480} over)` : ''}`,
    };
  },

  /**
   * Intent must be one of the 6 valid intents
   */
  valid_intent(trace) {
    const intent = trace.output_intent;
    return {
      name: 'valid_intent',
      pass: VALID_INTENTS.includes(intent),
      detail: intent || 'null',
    };
  },

  /**
   * If a neighborhood was resolved, it must be in the NEIGHBORHOODS map
   */
  valid_neighborhood(trace) {
    const hood = trace.composition.neighborhood_used || trace.routing.result?.neighborhood;
    if (!hood) return { name: 'valid_neighborhood', pass: true, detail: 'no neighborhood (ok)' };
    return {
      name: 'valid_neighborhood',
      pass: NEIGHBORHOOD_NAMES.includes(hood),
      detail: hood,
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
   * Conversational intent should redirect to events, not answer off-topic
   */
  off_topic_redirect(trace) {
    if (trace.output_intent !== 'conversational') {
      return { name: 'off_topic_redirect', pass: true, detail: 'not conversational' };
    }
    const sms = (trace.output_sms || '').toLowerCase();
    // Check that the response contains a redirect to neighborhoods/events
    const hasRedirect = /neighborhood|text me|text a|go out|tonight|picks/.test(sms);
    return {
      name: 'off_topic_redirect',
      pass: hasRedirect,
      detail: hasRedirect ? 'redirects to events' : 'may answer off-topic without redirect',
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
   * Total latency should be under 15s
   */
  latency_under_15s(trace) {
    const ms = trace.total_latency_ms || 0;
    return {
      name: 'latency_under_15s',
      pass: ms < 15000,
      detail: `${ms}ms`,
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

module.exports = { runCodeEvals, evals };
