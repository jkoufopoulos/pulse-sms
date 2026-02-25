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
check('returns expected eval count', goodResults.length >= 8);

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

// ---- price_transparency eval ----
console.log('\nCode evals (price_transparency):');

const priceGoodTrace = {
  ...goodTrace,
  id: 'test-price-good',
  output_sms: '1) Jazz Night at Smalls — $20, 9pm 2) Punk Show at Bowery — Free! 10pm',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', why: 'jazz' },
      { rank: 2, event_id: 'e3', why: 'punk' },
    ],
  },
};
const priceGoodResults = runCodeEvals(priceGoodTrace);
check('price_transparency passes with $20 and Free', findEval(priceGoodResults, 'price_transparency').pass === true);

const priceBadTrace = {
  ...goodTrace,
  id: 'test-price-bad',
  output_sms: '1) Jazz Night at Smalls 9pm 2) Punk Show at Bowery 10pm — both great vibes',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', why: 'jazz' },
      { rank: 2, event_id: 'e3', why: 'punk' },
    ],
  },
};
const priceBadResults = runCodeEvals(priceBadTrace);
check('price_transparency fails without price info', findEval(priceBadResults, 'price_transparency').pass === false);

const priceNaTrace = {
  ...goodTrace,
  id: 'test-price-na',
  output_intent: 'conversational',
  output_sms: "I only know events — text a neighborhood!",
  composition: { ...goodTrace.composition, picks: [] },
};
const priceNaResults = runCodeEvals(priceNaTrace);
check('price_transparency skips for non-event intent', findEval(priceNaResults, 'price_transparency').pass === true);

const priceNoCoverTrace = {
  ...goodTrace,
  id: 'test-price-nocover',
  output_sms: '1) Jazz Night at Smalls — no cover, 9pm 2) Punk at Bowery 10pm',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', why: 'jazz' },
      { rank: 2, event_id: 'e3', why: 'punk' },
    ],
  },
};
const priceNoCoverResults = runCodeEvals(priceNoCoverTrace);
check('price_transparency passes with "no cover"', findEval(priceNoCoverResults, 'price_transparency').pass === true);

// ---- schema_compliance eval ----
console.log('\nCode evals (schema_compliance):');

const schemaGoodTrace = {
  ...goodTrace,
  id: 'test-schema-good',
  composition: {
    ...goodTrace.composition,
    raw_response: '```json\n{"type":"event_picks","sms_text":"Check out Jazz Night","picks":[{"rank":1,"event_id":"e1"}],"clear_filters":false}\n```',
  },
};
const schemaGoodResults = runCodeEvals(schemaGoodTrace);
check('schema_compliance passes with valid JSON', findEval(schemaGoodResults, 'schema_compliance').pass === true);

const schemaBadTrace = {
  ...goodTrace,
  id: 'test-schema-bad',
  output_sms: "Having a moment — try again in a sec!",
  composition: {
    ...goodTrace.composition,
    raw_response: 'This is not JSON at all, just random text from Claude',
  },
};
const schemaBadResults = runCodeEvals(schemaBadTrace);
check('schema_compliance fails for fallback error', findEval(schemaBadResults, 'schema_compliance').pass === false);

const schemaNoJsonTrace = {
  ...goodTrace,
  id: 'test-schema-nojson',
  output_sms: 'Some response that worked anyway',
  composition: {
    ...goodTrace.composition,
    raw_response: 'Sure! Here are some picks for tonight in the East Village',
  },
};
const schemaNoJsonResults = runCodeEvals(schemaNoJsonTrace);
check('schema_compliance fails when no JSON object in response', findEval(schemaNoJsonResults, 'schema_compliance').pass === false);

const schemaPreRoutedTrace = {
  ...goodTrace,
  id: 'test-schema-prerouted',
  composition: {
    ...goodTrace.composition,
    raw_response: null,
  },
};
const schemaPreRoutedResults = runCodeEvals(schemaPreRoutedTrace);
check('schema_compliance passes for pre-routed (no LLM call)', findEval(schemaPreRoutedResults, 'schema_compliance').pass === true);

const schemaMissingSmsTrace = {
  ...goodTrace,
  id: 'test-schema-nosms',
  output_sms: 'Some text',
  composition: {
    ...goodTrace.composition,
    raw_response: '{"type":"event_picks","picks":[]}',
  },
};
const schemaMissingSmsResults = runCodeEvals(schemaMissingSmsTrace);
check('schema_compliance fails when sms_text missing', findEval(schemaMissingSmsResults, 'schema_compliance').pass === false);

// ---- category_adherence with subcategory mapping ----
console.log('\nCode evals (category_adherence subcategory mapping):');

const catSubTrace = {
  ...goodTrace,
  id: 'test-cat-sub',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', category: 'jazz' },
      { rank: 2, event_id: 'e2', category: 'rock' },
      { rank: 3, event_id: 'e3', category: 'live_music' },
    ],
    active_filters: { category: 'live_music' },
  },
};
const catSubResults = runCodeEvals(catSubTrace);
check('category_adherence passes: jazz+rock map to live_music (100%)', findEval(catSubResults, 'category_adherence').pass === true);

const catBorderlineTrace = {
  ...goodTrace,
  id: 'test-cat-borderline',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', category: 'comedy' },
      { rank: 2, event_id: 'e2', category: 'live_music' },
      { rank: 3, event_id: 'e3', category: 'nightlife' },
      { rank: 4, event_id: 'e4', category: 'art' },
    ],
    active_filters: { category: 'comedy' },
  },
};
const catBorderlineResults = runCodeEvals(catBorderlineTrace);
check('category_adherence fails: 1/4 comedy (25%) < 75%', findEval(catBorderlineResults, 'category_adherence').pass === false);

// ---- compound_filter_accuracy ----
console.log('\nCode evals (compound_filter_accuracy):');

const compoundPassTrace = {
  ...goodTrace,
  id: 'test-compound-pass',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', is_free: true, category: 'comedy' },
      { rank: 2, event_id: 'e2', is_free: true, category: 'standup' },
    ],
    active_filters: { free_only: true, category: 'comedy' },
  },
};
const compoundPassResults = runCodeEvals(compoundPassTrace);
check('compound_filter_accuracy passes: all picks are free + comedy', findEval(compoundPassResults, 'compound_filter_accuracy').pass === true);

const compoundFailTrace = {
  ...goodTrace,
  id: 'test-compound-fail',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', is_free: true, category: 'live_music' },
      { rank: 2, event_id: 'e2', is_free: true, category: 'nightlife' },
    ],
    active_filters: { free_only: true, category: 'comedy' },
  },
};
const compoundFailResults = runCodeEvals(compoundFailTrace);
check('compound_filter_accuracy fails: picks are free but not comedy', findEval(compoundFailResults, 'compound_filter_accuracy').pass === false);

const compoundSkipTrace = {
  ...goodTrace,
  id: 'test-compound-skip',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', is_free: true, category: 'comedy' },
    ],
    active_filters: { category: 'comedy' },
  },
};
const compoundSkipResults = runCodeEvals(compoundSkipTrace);
check('compound_filter_accuracy skips: only category filter (no free_only)', findEval(compoundSkipResults, 'compound_filter_accuracy').pass === true);

// ---- filter_match_alignment ----
console.log('\nCode evals (filter_match_alignment):');

const matchAlignPassTrace = {
  ...goodTrace,
  id: 'test-match-align-pass',
  events: {
    ...goodTrace.events,
    sent_pool: [
      { event_id: 'e1', filter_match: 'hard' },
      { event_id: 'e2', filter_match: 'soft' },
      { event_id: 'e3', filter_match: false },
    ],
  },
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1' },
      { rank: 2, event_id: 'e2' },
    ],
    pool_meta: { matchCount: 2 },
  },
};
const matchAlignPassResults = runCodeEvals(matchAlignPassTrace);
check('filter_match_alignment passes: picks from matched pool', findEval(matchAlignPassResults, 'filter_match_alignment').pass === true);

const matchAlignFailTrace = {
  ...goodTrace,
  id: 'test-match-align-fail',
  events: {
    ...goodTrace.events,
    sent_pool: [
      { event_id: 'e1', filter_match: 'hard' },
      { event_id: 'e2', filter_match: false },
      { event_id: 'e3', filter_match: false },
    ],
  },
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e2' },
      { rank: 2, event_id: 'e3' },
    ],
    pool_meta: { matchCount: 1 },
  },
};
const matchAlignFailResults = runCodeEvals(matchAlignFailTrace);
check('filter_match_alignment fails: picks from unmatched despite matches', findEval(matchAlignFailResults, 'filter_match_alignment').pass === false);

const matchAlignSkipTrace = {
  ...goodTrace,
  id: 'test-match-align-skip',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1' },
    ],
  },
};
const matchAlignSkipResults = runCodeEvals(matchAlignSkipTrace);
check('filter_match_alignment skips: no pool_meta', findEval(matchAlignSkipResults, 'filter_match_alignment').pass === true);

// ---- time_filter_accuracy ----
console.log('\nCode evals (time_filter_accuracy):');

const timePassTrace = {
  ...goodTrace,
  id: 'test-time-pass',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', start_time_local: '2026-02-25T22:00:00' },
      { rank: 2, event_id: 'e2', start_time_local: '2026-02-25T23:30:00' },
    ],
    active_filters: { time_after: '21:00' },
  },
};
const timePassResults = runCodeEvals(timePassTrace);
check('time_filter_accuracy passes: picks after 21:00', findEval(timePassResults, 'time_filter_accuracy').pass === true);

const timeFailTrace = {
  ...goodTrace,
  id: 'test-time-fail',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', start_time_local: '2026-02-25T18:00:00' },
      { rank: 2, event_id: 'e2', start_time_local: '2026-02-25T19:00:00' },
    ],
    active_filters: { time_after: '21:00' },
  },
};
const timeFailResults = runCodeEvals(timeFailTrace);
check('time_filter_accuracy fails: picks before 21:00', findEval(timeFailResults, 'time_filter_accuracy').pass === false);

const timeSkipTrace = {
  ...goodTrace,
  id: 'test-time-skip',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', start_time_local: '2026-02-25T22:00:00' },
    ],
  },
};
const timeSkipResults = runCodeEvals(timeSkipTrace);
check('time_filter_accuracy skips: no time filter', findEval(timeSkipResults, 'time_filter_accuracy').pass === true);

// After-midnight wrapping: 1am event should pass a 21:00 filter (it's late-night, not early morning)
const timeWrapTrace = {
  ...goodTrace,
  id: 'test-time-wrap',
  composition: {
    ...goodTrace.composition,
    picks: [
      { rank: 1, event_id: 'e1', start_time_local: '2026-02-26T01:00:00' },
      { rank: 2, event_id: 'e2', start_time_local: '2026-02-25T23:00:00' },
    ],
    active_filters: { time_after: '21:00' },
  },
};
const timeWrapResults = runCodeEvals(timeWrapTrace);
check('time_filter_accuracy passes with after-midnight wrapping (1am > 21:00)', findEval(timeWrapResults, 'time_filter_accuracy').pass === true);

// ---- neighborhood_expansion_transparency ----
console.log('\nCode evals (neighborhood_expansion_transparency):');

const expansionPassTrace = {
  ...goodTrace,
  id: 'test-expansion-pass',
  output_sms: 'Not much in Greenpoint tonight — checking nearby Williamsburg: 1) Jazz Night 9pm 2) Punk Show 10pm',
  composition: {
    ...goodTrace.composition,
    neighborhood_used: 'Greenpoint',
    picks: [
      { rank: 1, event_id: 'e1', neighborhood: 'Williamsburg' },
      { rank: 2, event_id: 'e2', neighborhood: 'Williamsburg' },
    ],
  },
};
const expansionPassResults = runCodeEvals(expansionPassTrace);
check('neighborhood_expansion_transparency passes: different hood, SMS acknowledges', findEval(expansionPassResults, 'neighborhood_expansion_transparency').pass === true);

const expansionFailTrace = {
  ...goodTrace,
  id: 'test-expansion-fail',
  output_sms: 'Greenpoint tonight: 1) Jazz Night 9pm 2) Punk Show 10pm',
  composition: {
    ...goodTrace.composition,
    neighborhood_used: 'Greenpoint',
    picks: [
      { rank: 1, event_id: 'e1', neighborhood: 'Williamsburg' },
      { rank: 2, event_id: 'e2', neighborhood: 'Williamsburg' },
    ],
  },
};
const expansionFailResults = runCodeEvals(expansionFailTrace);
check('neighborhood_expansion_transparency fails: different hood, no acknowledgment', findEval(expansionFailResults, 'neighborhood_expansion_transparency').pass === false);

const expansionSkipTrace = {
  ...goodTrace,
  id: 'test-expansion-skip',
  composition: {
    ...goodTrace.composition,
    neighborhood_used: 'East Village',
    picks: [
      { rank: 1, event_id: 'e1', neighborhood: 'East Village' },
      { rank: 2, event_id: 'e2', neighborhood: 'East Village' },
    ],
  },
};
const expansionSkipResults = runCodeEvals(expansionSkipTrace);
check('neighborhood_expansion_transparency skips: picks in claimed hood', findEval(expansionSkipResults, 'neighborhood_expansion_transparency').pass === true);

// ---- source-completeness eval ----
console.log('\nSource completeness evals:');

const { checkEvent, checkSourceCompleteness } = require('../src/evals/source-completeness');

// Good BAM event — should pass all checks
const goodBamEvent = {
  id: 'bam_123', source_name: 'bam', source_type: 'venue_calendar', name: 'Film Night',
  venue_name: 'BAM', venue_address: '30 Lafayette Ave, Brooklyn, NY', neighborhood: 'Fort Greene',
  start_time_local: '2026-02-24T19:00:00', date_local: '2026-02-24', is_free: false,
  category: 'film', subcategory: null, price_display: null, map_hint: '30 Lafayette Ave, Brooklyn',
  extraction_confidence: null,
};
check('BAM good event passes', checkEvent(goodBamEvent, 'BAM').length === 0);

// BAM event missing neighborhood — should fail
const badBamEvent = { ...goodBamEvent, neighborhood: null };
const bamIssues = checkEvent(badBamEvent, 'BAM');
check('BAM missing neighborhood fails', bamIssues.length > 0);
check('BAM failure mentions neighborhood', bamIssues.some(i => i.includes('neighborhood')));

// BAM event with wrong invariant
const wrongBamEvent = { ...goodBamEvent, neighborhood: 'Williamsburg' };
const wrongBamIssues = checkEvent(wrongBamEvent, 'BAM');
check('BAM wrong neighborhood invariant fails', wrongBamIssues.some(i => i.includes('invariant')));

// SmallsLIVE good event
const goodSmallsEvent = {
  id: 'smalls_123', source_name: 'smallslive', source_type: 'venue_calendar', name: 'Jazz Set',
  venue_name: 'Smalls Jazz Club', venue_address: '183 W 10th St', neighborhood: 'West Village',
  description_short: 'Live jazz at Smalls Jazz Club', short_detail: '9:00 PM at Smalls Jazz Club',
  start_time_local: '2026-02-24T21:00:00', date_local: '2026-02-24', is_free: false,
  category: 'live_music', subcategory: 'jazz', map_hint: '183 W 10th St',
  extraction_confidence: null,
};
check('SmallsLIVE good event passes', checkEvent(goodSmallsEvent, 'SmallsLIVE').length === 0);

// SmallsLIVE missing subcategory — should fail
const badSmallsEvent = { ...goodSmallsEvent, subcategory: null };
check('SmallsLIVE missing subcategory fails', checkEvent(badSmallsEvent, 'SmallsLIVE').length > 0);

// Universal field check — missing name
const noNameEvent = { ...goodBamEvent, name: null };
check('missing name fails universal check', checkEvent(noNameEvent, 'BAM').some(i => i.includes('"name"')));

// is_free wrong type
const badFreeEvent = { ...goodBamEvent, is_free: null };
check('is_free null fails type check', checkEvent(badFreeEvent, 'BAM').some(i => i.includes('boolean')));

// Structured source should not have extraction_confidence
const badConfEvent = { ...goodBamEvent, extraction_confidence: 0.8 };
check('extraction_confidence on structured source fails', checkEvent(badConfEvent, 'BAM').some(i => i.includes('extraction_confidence')));

// checkSourceCompleteness integration
const mockFetchMap = {
  BAM: { events: [goodBamEvent, badBamEvent], status: 'ok' },
  Skint: { events: [{ id: 'x' }], status: 'ok' },  // extracted source — should be skipped
  RA: { events: [], status: 'ok' },  // empty — should be skipped
  Dice: { events: [], status: 'error', error: 'timeout' },  // failed — should be skipped
};
const completenessResults = checkSourceCompleteness(mockFetchMap);
check('BAM in results', 'BAM' in completenessResults);
check('Skint skipped (extracted)', !('Skint' in completenessResults));
check('RA skipped (empty)', !('RA' in completenessResults));
check('Dice skipped (error)', !('Dice' in completenessResults));
check('BAM: 1 passed, 1 failed', completenessResults.BAM.passed === 1 && completenessResults.BAM.failed === 1);

// NYC Parks invariant — always free
const goodParksEvent = {
  id: 'parks_1', source_name: 'nyc_parks', source_type: 'government', name: 'Concert in the Park',
  venue_name: 'Central Park', is_free: true, price_display: 'free', category: 'live_music',
  extraction_confidence: null,
};
check('NYC Parks good event passes', checkEvent(goodParksEvent, 'NYC Parks').length === 0);

const badParksEvent = { ...goodParksEvent, is_free: false };
check('NYC Parks paid event fails invariant', checkEvent(badParksEvent, 'NYC Parks').some(i => i.includes('invariant') && i.includes('is_free')));

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
