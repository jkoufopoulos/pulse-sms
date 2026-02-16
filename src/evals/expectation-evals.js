/**
 * Expectation evals — checks trace against synthetic case `expected` fields.
 * Each returns { name, pass, detail }
 */

/**
 * Run expectation evals comparing a trace against a test case's expected fields.
 * @param {Object} trace - the trace from the pipeline
 * @param {Object} expected - { intent, neighborhood, has_events, must_not }
 * @returns {Array<{name, pass, detail}>}
 */
function runExpectationEvals(trace, expected) {
  const results = [];

  if (expected.intent) {
    const actual = trace.output_intent;
    results.push({
      name: 'expected_intent',
      pass: actual === expected.intent,
      detail: actual === expected.intent ? actual : `expected ${expected.intent}, got ${actual}`,
    });
  }

  if (expected.neighborhood) {
    // Check both routing and composition neighborhoods — pass if either matches
    // (compose may legitimately pick events from adjacent neighborhoods)
    const routeHood = trace.routing.result?.neighborhood;
    const composeHood = trace.composition.neighborhood_used;
    const match = routeHood === expected.neighborhood || composeHood === expected.neighborhood;
    const actual = composeHood || routeHood;
    results.push({
      name: 'expected_neighborhood',
      pass: match,
      detail: match ? (composeHood || routeHood) : `expected ${expected.neighborhood}, got route=${routeHood}, compose=${composeHood}`,
    });
  }

  if (expected.has_events !== undefined) {
    const picks = trace.composition.picks || [];
    const hasEvents = picks.length > 0;
    results.push({
      name: 'expected_has_events',
      pass: hasEvents === expected.has_events,
      detail: hasEvents === expected.has_events
        ? `has_events=${hasEvents}`
        : `expected has_events=${expected.has_events}, got ${hasEvents} (${picks.length} picks)`,
    });
  }

  if (expected.must_not) {
    const sms = (trace.output_sms || '').toLowerCase();
    for (const banned of expected.must_not) {
      const found = sms.includes(banned.toLowerCase());
      results.push({
        name: `must_not_contain_${banned.replace(/\s+/g, '_')}`,
        pass: !found,
        detail: found ? `SMS contains "${banned}"` : `ok`,
      });
    }
  }

  return results;
}

module.exports = { runExpectationEvals };
