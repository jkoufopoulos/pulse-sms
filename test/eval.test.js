/**
 * Tests for eval functions against mock traces.
 * Follows smoke.test.js pattern: no framework, node test/eval.test.js
 */

const { runCodeEvals } = require('../src/evals/code-evals');
const { runExpectationEvals } = require('../src/evals/expectation-evals');

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.error(`  FAIL: ${name}`);
  }
}

function findEval(results, name) {
  return results.find(r => r.name === name);
}

// ---- Mock trace: good trace ----
const goodTrace = {
  id: 'test-1',
  timestamp: new Date().toISOString(),
  phone_masked: '***0000',
  input_message: 'East Village tonight',
  session_before: { lastNeighborhood: null, lastPicks: null },
  routing: {
    pre_routed: true,
    result: { intent: 'events', neighborhood: 'East Village', confidence: 1.0 },
    latency_ms: 0,
    raw_response: null,
  },
  events: {
    cache_size: 15,
    candidates_count: 15,
    sent_to_claude: 8,
    candidate_ids: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15'],
    sent_ids: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'],
  },
  composition: {
    raw_response: null,
    latency_ms: 2500,
    picks: [
      { rank: 1, event_id: 'e1', why: 'great show' },
      { rank: 2, event_id: 'e3', why: 'cool venue' },
    ],
    not_picked_reason: 'Others were less relevant',
    neighborhood_used: 'East Village',
  },
  output_sms: 'Check out Jazz Night at Blue Note tonight 9pm — killer lineup. Also Punk Show at Bowery Ballroom 10pm if you want something loud. Want more info on either?',
  output_sms_length: 155,
  output_intent: 'events',
  total_latency_ms: 3200,
  annotation: null,
};

// ---- Code evals on good trace ----
console.log('\nCode evals (good trace):');

const goodResults = runCodeEvals(goodTrace);
check('char_limit passes', findEval(goodResults, 'char_limit').pass === true);
check('valid_intent passes', findEval(goodResults, 'valid_intent').pass === true);
check('valid_neighborhood passes', findEval(goodResults, 'valid_neighborhood').pass === true);
check('picked_events_exist passes', findEval(goodResults, 'picked_events_exist').pass === true);
check('valid_urls passes', findEval(goodResults, 'valid_urls').pass === true);
check('off_topic_redirect passes (not conversational)', findEval(goodResults, 'off_topic_redirect').pass === true);
check('response_not_empty passes', findEval(goodResults, 'response_not_empty').pass === true);
check('latency_under_10s passes', findEval(goodResults, 'latency_under_10s').pass === true);
check('day_label_accuracy passes', findEval(goodResults, 'day_label_accuracy').pass === true);
check('returns 9 eval results', goodResults.length === 9);

// ---- Mock trace: bad trace (over char limit, hallucinated pick, broken URL) ----
const badTrace = {
  ...goodTrace,
  id: 'test-2',
  output_sms: 'x'.repeat(500) + ' https://broken url here',
  output_sms_length: 525,
  output_intent: 'banana',
  total_latency_ms: 20000,
  composition: {
    ...goodTrace.composition,
    picks: [{ rank: 1, event_id: 'hallucinated_id', why: 'fake' }],
    neighborhood_used: 'Narnia',
  },
};

console.log('\nCode evals (bad trace):');

const badResults = runCodeEvals(badTrace);
check('char_limit fails for 525 chars', findEval(badResults, 'char_limit').pass === false);
check('valid_intent fails for "banana"', findEval(badResults, 'valid_intent').pass === false);
check('valid_neighborhood fails for "Narnia"', findEval(badResults, 'valid_neighborhood').pass === false);
check('picked_events_exist fails for hallucinated ID', findEval(badResults, 'picked_events_exist').pass === false);
check('latency_under_10s fails for 20s', findEval(badResults, 'latency_under_10s').pass === false);

// ---- Mock trace: empty response ----
const emptyTrace = {
  ...goodTrace,
  id: 'test-3',
  output_sms: '',
  output_sms_length: 0,
};

console.log('\nCode evals (empty trace):');
const emptyResults = runCodeEvals(emptyTrace);
check('response_not_empty fails', findEval(emptyResults, 'response_not_empty').pass === false);

// ---- Mock trace: conversational with redirect ----
const convGoodTrace = {
  ...goodTrace,
  id: 'test-4',
  output_intent: 'conversational',
  output_sms: "Ha — I only know events. Text a neighborhood and I'll hook you up.",
};

console.log('\nCode evals (conversational with redirect):');
const convResults = runCodeEvals(convGoodTrace);
check('off_topic_redirect passes with redirect', findEval(convResults, 'off_topic_redirect').pass === true);

// ---- Mock trace: conversational without redirect ----
const convBadTrace = {
  ...goodTrace,
  id: 'test-5',
  output_intent: 'conversational',
  output_sms: "The Knicks won 112-98 last night! LeBron had 30 points.",
};

console.log('\nCode evals (conversational without redirect):');
const convBadResults = runCodeEvals(convBadTrace);
check('off_topic_redirect fails without redirect', findEval(convBadResults, 'off_topic_redirect').pass === false);

// ---- Mock trace: no picks, no neighborhood (valid states) ----
const noPicks = {
  ...goodTrace,
  id: 'test-6',
  composition: { ...goodTrace.composition, picks: [], neighborhood_used: null },
  routing: { ...goodTrace.routing, result: { intent: 'help', neighborhood: null, confidence: 1.0 } },
};

console.log('\nCode evals (no picks, no neighborhood):');
const noPickResults = runCodeEvals(noPicks);
check('picked_events_exist passes with no picks', findEval(noPickResults, 'picked_events_exist').pass === true);
check('valid_neighborhood passes with null', findEval(noPickResults, 'valid_neighborhood').pass === true);

// ---- Mock trace: URL validation ----
const urlTrace = {
  ...goodTrace,
  id: 'test-7',
  output_sms: 'Check this out: https://www.eventbrite.com/e/123456 and https://dice.fm/event/abc123',
};

console.log('\nCode evals (valid URLs):');
const urlResults = runCodeEvals(urlTrace);
check('valid_urls passes with good URLs', findEval(urlResults, 'valid_urls').pass === true);

// ---- Expectation evals ----
console.log('\nExpectation evals (matching):');

const expected1 = { intent: 'events', neighborhood: 'East Village', has_events: true };
const expResults1 = runExpectationEvals(goodTrace, expected1);
check('expected_intent passes', findEval(expResults1, 'expected_intent').pass === true);
check('expected_neighborhood passes', findEval(expResults1, 'expected_neighborhood').pass === true);
check('expected_has_events passes', findEval(expResults1, 'expected_has_events').pass === true);

console.log('\nExpectation evals (mismatching):');

const expected2 = { intent: 'free', neighborhood: 'Williamsburg', has_events: false };
const expResults2 = runExpectationEvals(goodTrace, expected2);
check('expected_intent fails for wrong intent', findEval(expResults2, 'expected_intent').pass === false);
check('expected_neighborhood fails for wrong hood', findEval(expResults2, 'expected_neighborhood').pass === false);
check('expected_has_events fails when picks exist', findEval(expResults2, 'expected_has_events').pass === false);

console.log('\nExpectation evals (must_not):');

const traceWithBadContent = {
  ...goodTrace,
  id: 'test-8',
  output_sms: 'The weather today is sunny and 72 degrees. Also check out this event tonight.',
};
const expected3 = { must_not: ['weather'] };
const expResults3 = runExpectationEvals(traceWithBadContent, expected3);
check('must_not detects banned word', expResults3[0].pass === false);

const expected4 = { must_not: ['bitcoin'] };
const expResults4 = runExpectationEvals(goodTrace, expected4);
check('must_not passes when word absent', expResults4[0].pass === true);

// ---- char_limit exemption for details multi-SMS ----
console.log('\nCode evals (char_limit details exemption):');

const detailsLongTrace = {
  ...goodTrace,
  id: 'test-details-long',
  output_intent: 'details',
  output_sms: 'x'.repeat(600),
  output_sms_length: 600,
};
const detailsLongResults = runCodeEvals(detailsLongTrace);
check('char_limit passes for details intent over 480', findEval(detailsLongResults, 'char_limit').pass === true);
check('char_limit detail mentions multi-SMS exempt', findEval(detailsLongResults, 'char_limit').detail.includes('multi-SMS'));

const eventsLongTrace = {
  ...goodTrace,
  id: 'test-events-long',
  output_intent: 'events',
  output_sms: 'x'.repeat(500),
  output_sms_length: 500,
};
const eventsLongResults = runCodeEvals(eventsLongTrace);
check('char_limit fails for events intent over 480', findEval(eventsLongResults, 'char_limit').pass === false);

// ---- off_topic_redirect tighter matching ----
console.log('\nCode evals (off_topic_redirect tighter matching):');

const convTonightOnly = {
  ...goodTrace,
  id: 'test-conv-tonight',
  input_message: 'who won the knicks game?',
  output_intent: 'conversational',
  output_sms: 'The Knicks play tonight at MSG — should be a great game!',
};
const convTonightResults = runCodeEvals(convTonightOnly);
check('off_topic_redirect fails when only "tonight" without redirect phrase', findEval(convTonightResults, 'off_topic_redirect').pass === false);

const convWithRedirect = {
  ...goodTrace,
  id: 'test-conv-redirect',
  input_message: 'who won the knicks game?',
  output_intent: 'conversational',
  output_sms: "Ha — I only know events. Text me a neighborhood and I'll hook you up.",
};
const convRedirectResults = runCodeEvals(convWithRedirect);
check('off_topic_redirect passes with "text me a neighborhood"', findEval(convRedirectResults, 'off_topic_redirect').pass === true);

// ---- day_label_accuracy eval ----
console.log('\nCode evals (day_label_accuracy):');

const todayNyc = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const tomorrowNyc = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const dayLabelBadTrace = {
  ...goodTrace,
  id: 'test-day-bad',
  output_sms: 'Check out Jazz Night tonight at Smalls — great vibe',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', why: 'great show', date_local: tomorrowNyc },
    ],
  },
};
const dayLabelBadResults = runCodeEvals(dayLabelBadTrace);
check('day_label_accuracy fails: says tonight but event is tomorrow', findEval(dayLabelBadResults, 'day_label_accuracy').pass === false);

const dayLabelGoodTrace = {
  ...goodTrace,
  id: 'test-day-good',
  output_sms: 'Check out Jazz Night tonight at Smalls — great vibe',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', why: 'great show', date_local: todayNyc },
    ],
  },
};
const dayLabelGoodResults = runCodeEvals(dayLabelGoodTrace);
check('day_label_accuracy passes: says tonight and event is today', findEval(dayLabelGoodResults, 'day_label_accuracy').pass === true);

const dayLabelTmrwBadTrace = {
  ...goodTrace,
  id: 'test-day-tmrw-bad',
  output_sms: 'Tomorrow night hit up the jazz show at Smalls',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', why: 'great show', date_local: todayNyc },
    ],
  },
};
const dayLabelTmrwBadResults = runCodeEvals(dayLabelTmrwBadTrace);
check('day_label_accuracy fails: says tomorrow but event is today', findEval(dayLabelTmrwBadResults, 'day_label_accuracy').pass === false);

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
