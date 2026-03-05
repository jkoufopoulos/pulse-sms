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
check('picked_events_exist passes', findEval(goodResults, 'picked_events_exist').pass === true);
check('valid_urls passes', findEval(goodResults, 'valid_urls').pass === true);
check('response_not_empty passes', findEval(goodResults, 'response_not_empty').pass === true);
check('latency_under_10s passes', findEval(goodResults, 'latency_under_10s').pass === true);
check('returns 6 evals', goodResults.length === 6);

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

// ---- Mock trace: no picks (valid state) ----
const noPicks = {
  ...goodTrace,
  id: 'test-6',
  composition: { ...goodTrace.composition, picks: [], neighborhood_used: null },
};

console.log('\nCode evals (no picks):');
const noPickResults = runCodeEvals(noPicks);
check('picked_events_exist passes with no picks', findEval(noPickResults, 'picked_events_exist').pass === true);

// ---- Mock trace: URL validation ----
const urlTrace = {
  ...goodTrace,
  id: 'test-7',
  output_sms: 'Check this out: https://www.eventbrite.com/e/123456 and https://dice.fm/event/abc123',
};

console.log('\nCode evals (valid URLs):');
const urlResults = runCodeEvals(urlTrace);
check('valid_urls passes with good URLs', findEval(urlResults, 'valid_urls').pass === true);

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
      { rank: 1, event_id: 'e1', why: 'jazz', price_display: '$20' },
      { rank: 2, event_id: 'e3', why: 'punk', is_free: true },
    ],
  },
};
const priceBadResults = runCodeEvals(priceBadTrace);
check('price_transparency fails without price info', findEval(priceBadResults, 'price_transparency').pass === false);

const priceNaTrace = {
  ...goodTrace,
  id: 'test-price-na',
  output_intent: 'conversational',
  output_sms: "I only know events — tell me what vibe you're feeling!",
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

// ---- source-completeness eval ----
console.log('\nSource completeness evals:');

const { checkEvent, checkSourceCompleteness } = require('../src/evals/source-completeness');

const goodBamEvent = {
  id: 'bam_123', source_name: 'bam', source_type: 'venue_calendar', name: 'Film Night',
  venue_name: 'BAM', venue_address: '30 Lafayette Ave, Brooklyn, NY', neighborhood: 'Fort Greene',
  start_time_local: '2026-02-24T19:00:00', date_local: '2026-02-24', is_free: false,
  category: 'film', subcategory: null, price_display: null, map_hint: '30 Lafayette Ave, Brooklyn',
  extraction_confidence: null,
};
check('BAM good event passes', checkEvent(goodBamEvent, 'BAM').length === 0);

const badBamEvent = { ...goodBamEvent, neighborhood: null };
const bamIssues = checkEvent(badBamEvent, 'BAM');
check('BAM missing neighborhood fails', bamIssues.length > 0);
check('BAM failure mentions neighborhood', bamIssues.some(i => i.includes('neighborhood')));

const wrongBamEvent = { ...goodBamEvent, neighborhood: 'Williamsburg' };
const wrongBamIssues = checkEvent(wrongBamEvent, 'BAM');
check('BAM wrong neighborhood invariant fails', wrongBamIssues.some(i => i.includes('invariant')));

const goodSmallsEvent = {
  id: 'smalls_123', source_name: 'smallslive', source_type: 'venue_calendar', name: 'Jazz Set',
  venue_name: 'Smalls Jazz Club', venue_address: '183 W 10th St', neighborhood: 'West Village',
  description_short: 'Live jazz at Smalls Jazz Club', short_detail: '9:00 PM at Smalls Jazz Club',
  start_time_local: '2026-02-24T21:00:00', date_local: '2026-02-24', is_free: false,
  category: 'live_music', subcategory: 'jazz', map_hint: '183 W 10th St',
  extraction_confidence: null,
};
check('SmallsLIVE good event passes', checkEvent(goodSmallsEvent, 'SmallsLIVE').length === 0);

const badSmallsEvent = { ...goodSmallsEvent, subcategory: null };
check('SmallsLIVE missing subcategory fails', checkEvent(badSmallsEvent, 'SmallsLIVE').length > 0);

const noNameEvent = { ...goodBamEvent, name: null };
check('missing name fails universal check', checkEvent(noNameEvent, 'BAM').some(i => i.includes('"name"')));

const badFreeEvent = { ...goodBamEvent, is_free: null };
check('is_free null fails type check', checkEvent(badFreeEvent, 'BAM').some(i => i.includes('boolean')));

const badConfEvent = { ...goodBamEvent, extraction_confidence: 0.8 };
check('extraction_confidence on structured source fails', checkEvent(badConfEvent, 'BAM').some(i => i.includes('extraction_confidence')));

const mockFetchMap = {
  BAM: { events: [goodBamEvent, badBamEvent], status: 'ok' },
  Skint: { events: [{ id: 'x' }], status: 'ok' },
  RA: { events: [], status: 'ok' },
  Dice: { events: [], status: 'error', error: 'timeout' },
};
const completenessResults = checkSourceCompleteness(mockFetchMap);
check('BAM in results', 'BAM' in completenessResults);
check('Skint skipped (extracted)', !('Skint' in completenessResults));
check('RA skipped (empty)', !('RA' in completenessResults));
check('Dice skipped (error)', !('Dice' in completenessResults));
check('BAM: 1 passed, 1 failed', completenessResults.BAM.passed === 1 && completenessResults.BAM.failed === 1);

const goodParksEvent = {
  id: 'parks_1', source_name: 'nyc_parks', source_type: 'government', name: 'Concert in the Park',
  venue_name: 'Central Park', is_free: true, price_display: 'free', category: 'live_music',
  extraction_confidence: null,
};
check('NYC Parks good event passes', checkEvent(goodParksEvent, 'NYC Parks').length === 0);

const badParksEvent = { ...goodParksEvent, is_free: false };
check('NYC Parks paid event fails invariant', checkEvent(badParksEvent, 'NYC Parks').some(i => i.includes('invariant') && i.includes('is_free')));

// ---- scrape-audit evals ----
console.log('\nScrape audit evals:');

const { runScrapeAudit, checks: scrapeChecks } = require('../src/evals/scrape-audit');

function runCheck(checkName, event) {
  return scrapeChecks[checkName](event);
}

check('date_format_valid passes for YYYY-MM-DD', runCheck('date_format_valid', { date_local: '2026-03-01' }).pass === true);
check('date_format_valid passes for null', runCheck('date_format_valid', { date_local: null }).pass === true);
check('date_format_valid fails for bad format', runCheck('date_format_valid', { date_local: 'March 1, 2026' }).pass === false);
check('date_format_valid fails for partial', runCheck('date_format_valid', { date_local: '2026-3-1' }).pass === false);

check('time_format_valid passes for ISO datetime', runCheck('time_format_valid', { start_time_local: '2026-03-01T21:00' }).pass === true);
check('time_format_valid passes for ISO with seconds', runCheck('time_format_valid', { start_time_local: '2026-03-01T21:00:00' }).pass === true);
check('time_format_valid passes for null', runCheck('time_format_valid', { start_time_local: null }).pass === true);
check('time_format_valid fails for time only', runCheck('time_format_valid', { start_time_local: '21:00' }).pass === false);
check('time_format_valid passes for Z suffix', runCheck('time_format_valid', { start_time_local: '2026-03-01T21:00:00Z' }).pass === true);
check('time_format_valid passes for tz offset with colon', runCheck('time_format_valid', { start_time_local: '2026-03-01T21:00:00-05:00' }).pass === true);
check('time_format_valid passes for tz offset without colon', runCheck('time_format_valid', { start_time_local: '2026-03-01T21:00:00-0500' }).pass === true);
check('time_format_valid passes for milliseconds', runCheck('time_format_valid', { start_time_local: '2026-03-01T22:00:00.000' }).pass === true);
check('time_format_valid passes for ms + tz offset', runCheck('time_format_valid', { start_time_local: '2026-03-01T18:00:00.000-04:00' }).pass === true);
check('time_format_valid passes for no seconds + tz offset', runCheck('time_format_valid', { start_time_local: '2026-03-01T21:00-0500' }).pass === true);

check('time_present passes when time exists', runCheck('time_present', { start_time_local: '2026-03-01T21:00', category: 'nightlife' }).pass === true);
check('time_present passes for exempt category', runCheck('time_present', { start_time_local: null, category: 'art' }).pass === true);
check('time_present fails for nightlife without time', runCheck('time_present', { start_time_local: null, category: 'nightlife' }).pass === false);
check('time_present fails for comedy without time', runCheck('time_present', { start_time_local: null, category: 'comedy' }).pass === false);
check('time_present passes for null category', runCheck('time_present', { start_time_local: null, category: null }).pass === true);

check('venue_quality passes for real venue', runCheck('venue_quality', { venue_name: 'Smalls Jazz Club', name: 'Jazz Night' }).pass === true);
check('venue_quality fails for TBA', runCheck('venue_quality', { venue_name: 'TBA', name: 'Jazz Night' }).pass === false);
check('venue_quality fails for empty', runCheck('venue_quality', { venue_name: '', name: 'Jazz Night' }).pass === false);
check('venue_quality hints when name has "at"', runCheck('venue_quality', { venue_name: 'TBA', name: 'Jazz Night at Blue Note' }).pass === false);
check('venue_quality TBA with "at" mentions hint', runCheck('venue_quality', { venue_name: 'TBA', name: 'Jazz Night at Blue Note' }).detail.includes('hint'));

check('price_coverage passes for is_free', runCheck('price_coverage', { is_free: true }).pass === true);
check('price_coverage passes for price_display', runCheck('price_coverage', { is_free: false, price_display: '$20' }).pass === true);
check('price_coverage fails for neither', runCheck('price_coverage', { is_free: false, price_display: null }).pass === false);

check('category_valid passes for nightlife', runCheck('category_valid', { category: 'nightlife' }).pass === true);
check('category_valid passes for comedy', runCheck('category_valid', { category: 'comedy' }).pass === true);
check('category_valid fails for unknown', runCheck('category_valid', { category: 'sports' }).pass === false);
check('category_valid fails for null', runCheck('category_valid', { category: null }).pass === false);

check('has_url passes for ticket_url', runCheck('has_url', { ticket_url: 'https://example.com', source_url: null }).pass === true);
check('has_url passes for source_url', runCheck('has_url', { ticket_url: null, source_url: 'https://example.com' }).pass === true);
check('has_url fails for neither', runCheck('has_url', { ticket_url: null, source_url: null }).pass === false);

// -- runScrapeAudit integration --
console.log('\nScrape audit runner:');

const goodEvent = {
  id: 'e1', source_name: 'dice', name: 'Jazz Night',
  date_local: '2026-03-01', start_time_local: '2026-03-01T21:00',
  venue_name: 'Blue Note', is_free: false, price_display: '$20',
  category: 'live_music', ticket_url: 'https://dice.fm/e/123',
  source_url: null,
};
const badEvent = {
  id: 'e2', source_name: 'dice', name: 'Mystery Show at Secret Spot',
  date_local: 'March 1', start_time_local: null,
  venue_name: 'TBA', is_free: false, price_display: null,
  category: 'banana', ticket_url: null, source_url: null,
};

const mockFetchMap2 = {
  Dice: { events: [goodEvent, badEvent, {}, {}, {}, {}], status: 'ok' },
  Skint: { events: [{}, {}, {}, {}, {}], status: 'ok' },
  RA: { events: [{}, {}], status: 'ok' },
};

const report = runScrapeAudit([goodEvent, badEvent], mockFetchMap2);

check('report type is scrape-audit', report.type === 'scrape-audit');
check('report summary total is 2', report.summary.total === 2);
check('report summary passed is 1', report.summary.passed === 1);
check('report summary issues is 1', report.summary.issues === 1);
check('report has sourceStats', 'dice' in report.sourceStats);
check('report dice stats correct', report.sourceStats.dice.total === 2 && report.sourceStats.dice.passed === 1);
check('report bad event has failures', report.events.length === 1 && report.events[0].event_id === 'e2');

check('Dice count passes (6 >= 5)', report.sourceCountChecks.Dice.pass === true);
check('Skint count passes (5 >= 5)', report.sourceCountChecks.Skint.pass === true);
check('RA count fails (2 < 5)', report.sourceCountChecks.RA.pass === false);
const expectedBelow = Object.entries(report.sourceCountChecks).filter(([, v]) => !v.pass).length;
check('report sourcesBelow matches failing count checks', report.summary.sourcesBelow === expectedBelow);

const emptyReport = runScrapeAudit([], {});
check('empty report has 0 total', emptyReport.summary.total === 0);
check('empty report passRate is N/A', emptyReport.summary.passRate === 'N/A');

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
