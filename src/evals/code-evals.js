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
    // Multi-pick details responses can exceed 480 chars (intentional multi-SMS)
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
    const input = (trace.input_message || '').toLowerCase();
    // Goodbyes and thanks don't need a redirect — they're natural conversation endings
    const isFarewell = /^(bye|later|peace|gn|good night|night|see ya|cya|deuces|thanks|thank you|thx|ty|appreciate it|cheers)$/i.test(input.trim());
    if (isFarewell) {
      return { name: 'off_topic_redirect', pass: true, detail: 'farewell/thanks (no redirect needed)' };
    }
    // Check that the response contains a redirect to neighborhoods/events
    const hasRedirect = /text (me )?a neighborhood|text me a|drop me a|go out|tonight.s picks|when you.re ready/i.test(sms);
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
   * Day-label accuracy: "tonight" must not refer to a tomorrow event, and vice versa.
   * Requires trace.composition.picks to include date_local (enriched in composeAndSend).
   */
  day_label_accuracy(trace) {
    const picks = trace.composition.picks || [];
    const sms = (trace.output_sms || '').toLowerCase();
    if (picks.length === 0 || !sms) {
      return { name: 'day_label_accuracy', pass: true, detail: 'no picks or no SMS' };
    }

    // Determine today/tomorrow at trace time
    const traceDate = trace.timestamp ? new Date(trace.timestamp) : new Date();
    const todayStr = traceDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const tomorrowDate = new Date(traceDate.getTime() + 86400000);
    const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const saysTonight = /\btonight\b|\btoday\b/.test(sms);
    const saysTomorrow = /\btomorrow\b/.test(sms);

    // Categorize picks by date
    const todayPicks = picks.filter(p => p.date_local === todayStr);
    const tomorrowPicks = picks.filter(p => p.date_local === tomorrowStr);

    // Mixed-date response: SMS mentions both "tonight" and "tomorrow" and has
    // picks on both days — Claude is correctly distinguishing them.
    if (saysTonight && saysTomorrow && todayPicks.length > 0 && tomorrowPicks.length > 0) {
      return { name: 'day_label_accuracy', pass: true, detail: 'mixed-date response with both labels (correct)' };
    }

    const errors = [];

    // "tonight"/"today" in SMS but ALL picks are tomorrow (none are today)
    if (saysTonight && tomorrowPicks.length > 0 && todayPicks.length === 0) {
      errors.push(`says "tonight" but all picks are tomorrow: ${tomorrowPicks.map(p => p.event_id).join(', ')}`);
    }

    // "tomorrow" in SMS but ALL picks are today (none are tomorrow)
    if (saysTomorrow && todayPicks.length > 0 && tomorrowPicks.length === 0) {
      errors.push(`says "tomorrow" but all picks are today: ${todayPicks.map(p => p.event_id).join(', ')}`);
    }

    return {
      name: 'day_label_accuracy',
      pass: errors.length === 0,
      detail: errors.length > 0 ? errors.join('; ') : 'day labels correct',
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
