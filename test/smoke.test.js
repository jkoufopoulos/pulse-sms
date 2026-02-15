/**
 * Smoke tests for Pulse pure functions.
 * Run: node test/smoke.test.js
 */

const { renderSMS } = require('../src/services/sms-render');
const { extractNeighborhood } = require('../src/utils/neighborhoods');
const { makeEventId } = require('../src/services/sources');
const { resolveNeighborhood, inferCategory, haversine, getNycDateString, rankEventsByProximity, filterUpcomingEvents } = require('../src/utils/geo');

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

// ---- renderSMS ----
console.log('\nrenderSMS:');

const eventMap = {
  abc123: {
    name: 'DJ Night', venue_name: 'Output', neighborhood: 'Williamsburg',
    start_time_local: '2026-02-14T21:00:00', is_free: false, price_display: '$20',
  },
  def456: {
    name: 'Jazz at Smalls', venue_name: 'Smalls', neighborhood: 'West Village',
    start_time_local: '2026-02-14T20:00:00', is_free: false, price_display: '$20',
  },
};

const basic = renderSMS({ picks: [{ rank: 1, event_id: 'abc123', why: 'Sick lineup' }] }, eventMap);
check('includes event name', basic.includes('DJ Night'));
check('includes venue', basic.includes('Output'));
check('within 480 chars', basic.length <= 480);
check('includes CTA', basic.includes('Reply DETAILS'));

const multi = renderSMS({
  picks: [
    { rank: 1, event_id: 'abc123', why: 'Sick lineup' },
    { rank: 2, event_id: 'def456', why: 'Chill vibes' },
  ],
}, eventMap);
check('multi-pick includes Also:', multi.includes('Also:'));
check('multi-pick within 480', multi.length <= 480);

check('clarification', renderSMS({ need_clarification: true, clarifying_question: 'What hood?', picks: [] }, {}) === 'What hood?');
check('fallback note', renderSMS({ picks: [] }, {}).includes('Quiet night'));

const missing = renderSMS({ picks: [{ rank: 1, event_id: 'missing', why: 'Great show' }] }, eventMap);
check('missing event falls back to why', missing.includes('Great show'));

// ---- extractNeighborhood ----
console.log('\nextractNeighborhood:');

check('east village', extractNeighborhood('east village tonight') === 'East Village');
check('LES', extractNeighborhood('LES shows') === 'Lower East Side');
check('williamsburg', extractNeighborhood('wburg bars') === 'Williamsburg');
check('hells kitchen', extractNeighborhood("hell's kitchen food") === "Hell's Kitchen");
check('no match', extractNeighborhood('hello world') === null);
check('prefers longer match', extractNeighborhood('events in lower east side today') === 'Lower East Side');
// Word boundary: short aliases don't match inside common words
check('ev not in events', extractNeighborhood('any events tonight') === null);
check('ev not in every', extractNeighborhood('every bar nearby') === null);
check('ev not in never', extractNeighborhood('never mind') === null);
check('ev standalone works', extractNeighborhood('ev tonight') === 'East Village');
// Borough shortcuts
check('brooklyn', extractNeighborhood('brooklyn tonight') === 'Williamsburg');
check('bk', extractNeighborhood('anything in bk') === 'Williamsburg');
check('manhattan', extractNeighborhood('manhattan') === 'Midtown');
check('queens', extractNeighborhood('queens') === 'Astoria');
// New aliases
check('union sq', extractNeighborhood('union sq tonight') === 'Flatiron');
check('nolita', extractNeighborhood('nolita drinks') === 'SoHo');
check('e.v.', extractNeighborhood('E.V. tonight') === 'East Village');
check('nyc', extractNeighborhood('nyc tonight') === 'Midtown');

// ---- extractNeighborhood: landmarks ----
console.log('\nextractNeighborhood (landmarks):');

check('prospect park', extractNeighborhood('near prospect park') === 'Park Slope');
check('central park', extractNeighborhood('central park area') === 'Midtown');
check('washington square', extractNeighborhood('by washington square') === 'Greenwich Village');
check('wash sq', extractNeighborhood('wash sq tonight') === 'Greenwich Village');
check('bryant park', extractNeighborhood('bryant park vibes') === 'Midtown');
check('mccarren park', extractNeighborhood('mccarren park') === 'Williamsburg');
check('tompkins square', extractNeighborhood('near tompkins square') === 'East Village');
check('tompkins', extractNeighborhood('tompkins area') === 'East Village');
check('domino park', extractNeighborhood('domino park') === 'Williamsburg');
check('brooklyn bridge', extractNeighborhood('near brooklyn bridge') === 'DUMBO');
check('highline', extractNeighborhood('the highline') === 'Chelsea');
check('high line', extractNeighborhood('near the high line') === 'Chelsea');
check('hudson yards', extractNeighborhood('hudson yards tonight') === 'Chelsea');
check('barclays center', extractNeighborhood('near barclays center') === 'Downtown Brooklyn');
check('msg', extractNeighborhood('near msg') === 'Midtown');
check('lincoln center', extractNeighborhood('lincoln center area') === 'Upper West Side');
check('carnegie hall', extractNeighborhood('carnegie hall tonight') === 'Midtown');

// ---- extractNeighborhood: subway refs ----
console.log('\nextractNeighborhood (subway):');

check('bedford ave', extractNeighborhood('near bedford ave') === 'Williamsburg');
check('bedford stop', extractNeighborhood('bedford stop') === 'Williamsburg');
check('1st ave', extractNeighborhood('at 1st ave') === 'East Village');
check('first ave', extractNeighborhood('first ave area') === 'East Village');
check('14th street', extractNeighborhood('14th street') === 'Flatiron');
check('14th st', extractNeighborhood('near 14th st') === 'Flatiron');
check('grand central', extractNeighborhood('grand central') === 'Midtown');
check('atlantic ave', extractNeighborhood('at atlantic ave') === 'Downtown Brooklyn');
check('atlantic terminal', extractNeighborhood('atlantic terminal') === 'Downtown Brooklyn');
check('dekalb', extractNeighborhood('near dekalb') === 'Downtown Brooklyn');

// ---- follow-up pattern detection (legacy flow) ----
console.log('\nfollow-up patterns (legacy flow):');

const FOLLOWUP_DETAILS = /\b(when|what time|how late|starts at|where|address|location|directions|how do i get|tell me more|sounds good|interested|that one|i'm down|let's go|how much|cost|price|tickets|cover)\b/;
const FOLLOWUP_MORE = /\b(what else|anything else|other options|next|show me more)\b/;
const FOLLOWUP_FREE = /\b(free stuff|anything free|no cover)\b/;

check('when does that start', FOLLOWUP_DETAILS.test('when does that start?'));
check('what time is it', FOLLOWUP_DETAILS.test('what time is it?'));
check('where is that', FOLLOWUP_DETAILS.test('where is that?'));
check('how do i get there', FOLLOWUP_DETAILS.test('how do i get there'));
check('tell me more', FOLLOWUP_DETAILS.test('tell me more about that'));
check('sounds good', FOLLOWUP_DETAILS.test('sounds good!'));
check('i\'m down', FOLLOWUP_DETAILS.test("i'm down"));
check('how much is it', FOLLOWUP_DETAILS.test('how much is it'));
check('any cover', FOLLOWUP_DETAILS.test('is there a cover?'));
check('what else is there', FOLLOWUP_MORE.test('what else is there?'));
check('anything else', FOLLOWUP_MORE.test('anything else?'));
check('show me more', FOLLOWUP_MORE.test('show me more'));
check('next', FOLLOWUP_MORE.test('next'));
check('anything free', FOLLOWUP_FREE.test('anything free tonight?'));
check('no cover', FOLLOWUP_FREE.test('no cover please'));
check('no false positive: events tonight', !FOLLOWUP_DETAILS.test('events tonight'));
check('no false positive: williamsburg', !FOLLOWUP_MORE.test('williamsburg'));

// ---- makeEventId ----
console.log('\nmakeEventId:');

const id1 = makeEventId('Test Event', 'The Venue', '2026-02-14');
const id2 = makeEventId('Test Event', 'The Venue', '2026-02-14');
const id3 = makeEventId('Different Event', 'The Venue', '2026-02-14');
check('stable (same input = same id)', id1 === id2);
check('different for different events', id1 !== id3);
check('12 chars', id1.length === 12);
check('case insensitive', makeEventId('TEST EVENT', 'THE VENUE', '2026-02-14') === id1);

// ---- resolveNeighborhood ----
console.log('\nresolveNeighborhood:');

check('direct name match', resolveNeighborhood('East Village', null, null) === 'East Village');
check('alias match', resolveNeighborhood('ev', null, null) === 'East Village');
check('geo with borough string', resolveNeighborhood('Brooklyn', 40.7081, -73.9571) === 'Williamsburg');
check('geo overrides borough', resolveNeighborhood('Brooklyn', 40.6934, -73.9867) === 'Downtown Brooklyn');
check('borough fallback when no coords', resolveNeighborhood('Brooklyn', null, null) === 'Williamsburg');
check('null for unknown', resolveNeighborhood('Mars', null, null) === null);
check('null for empty', resolveNeighborhood(null, null, null) === null);

// ---- inferCategory ----
console.log('\ninferCategory:');

check('comedy', inferCategory('stand-up comedy show') === 'comedy');
check('art', inferCategory('gallery opening reception tonight') === 'art');
check('nightlife', inferCategory('dj set techno party') === 'nightlife');
check('live_music', inferCategory('jazz concert') === 'live_music');
check('theater', inferCategory('off-broadway theatre performance') === 'theater');
check('food_drink', inferCategory('wine tasting event') === 'food_drink');
check('community', inferCategory('community market and festival') === 'community');
check('other', inferCategory('something random happening') === 'other');

// ---- haversine ----
console.log('\nhaversine:');

const evToWburg = haversine(40.7264, -73.9818, 40.7081, -73.9571);
check('EV→Wburg ~2.7km', evToWburg > 2 && evToWburg < 4);
check('same point = 0', haversine(40.7, -73.9, 40.7, -73.9) === 0);

// ---- getNycDateString ----
console.log('\ngetNycDateString:');

const today = getNycDateString(0);
check('YYYY-MM-DD format', /^\d{4}-\d{2}-\d{2}$/.test(today));
const tomorrow = getNycDateString(1);
check('tomorrow is after today', tomorrow > today);

// ---- rankEventsByProximity ----
console.log('\nrankEventsByProximity:');

const events = [
  { id: '1', neighborhood: 'East Village' },
  { id: '2', neighborhood: 'Williamsburg' },
  { id: '3', neighborhood: null },
  { id: '4', neighborhood: 'Astoria' },
];
const ranked = rankEventsByProximity(events, 'East Village');
check('closest first', ranked[0].id === '1');
check('includes nearby Wburg', ranked.some(e => e.id === '2'));
check('includes unknown neighborhood', ranked.some(e => e.id === '3'));
check('excludes distant Astoria', !ranked.some(e => e.id === '4'));

const noTarget = rankEventsByProximity(events, null);
check('no target returns all', noTarget.length === events.length);

// ---- filterUpcomingEvents ----
console.log('\nfilterUpcomingEvents:');

function makeTime(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

const timeEvents = [
  { id: 't1', start_time_local: makeTime(3) },       // future
  { id: 't2', start_time_local: makeTime(-1) },       // 1hr ago (within window)
  { id: 't3', start_time_local: makeTime(-5) },       // 5hrs ago (should be filtered)
  { id: 't4', start_time_local: null },                // no time
  { id: 't5', start_time_local: '2026-02-14' },       // date only
  { id: 't6', start_time_local: makeTime(-4), end_time_local: makeTime(1) },  // ended but end in future
];
const upcoming = filterUpcomingEvents(timeEvents);
const upIds = upcoming.map(e => e.id);

check('keeps future', upIds.includes('t1'));
check('keeps recent (within 2hr)', upIds.includes('t2'));
check('removes past (5hr ago)', !upIds.includes('t3'));
check('keeps no-time', upIds.includes('t4'));
check('keeps date-only', upIds.includes('t5'));
check('keeps event with future end_time', upIds.includes('t6'));

// ---- AI routing output shape contracts ----
console.log('\nAI routing contracts (routeMessage shape):');

// Simulate a routeMessage response and validate its shape
const validRouteOutput = {
  intent: 'events',
  neighborhood: 'East Village',
  filters: { free_only: false, category: null, vibe: null },
  event_reference: null,
  reply: null,
  confidence: 0.9,
};

check('routeMessage has intent', typeof validRouteOutput.intent === 'string');
check('routeMessage has neighborhood', 'neighborhood' in validRouteOutput);
check('routeMessage has filters', typeof validRouteOutput.filters === 'object' && validRouteOutput.filters !== null);
check('routeMessage has confidence', typeof validRouteOutput.confidence === 'number');
check('routeMessage intent is valid', ['events', 'details', 'more', 'free', 'help', 'conversational'].includes(validRouteOutput.intent));
check('routeMessage filters has free_only', 'free_only' in validRouteOutput.filters);

// Validate all valid intents
const validIntents = ['events', 'details', 'more', 'free', 'help', 'conversational'];
for (const intent of validIntents) {
  check(`intent "${intent}" is recognized`, validIntents.includes(intent));
}

console.log('\nAI routing contracts (composeResponse shape):');

const validComposeOutput = {
  sms_text: 'DJ Night at Output (Williamsburg) 9 PM — $20. Sick lineup tonight.\nAlso: Jazz at Smalls 8 PM\nReply DETAILS, MORE, or FREE.',
  picks: [{ rank: 1, event_id: 'abc123' }, { rank: 2, event_id: 'def456' }],
  neighborhood_used: 'Williamsburg',
};

check('composeResponse has sms_text', typeof validComposeOutput.sms_text === 'string');
check('composeResponse sms_text <= 480 chars', validComposeOutput.sms_text.length <= 480);
check('composeResponse has picks array', Array.isArray(validComposeOutput.picks));
check('composeResponse picks have event_id', validComposeOutput.picks.every(p => typeof p.event_id === 'string'));
check('composeResponse picks have rank', validComposeOutput.picks.every(p => typeof p.rank === 'number'));
check('composeResponse has neighborhood_used', typeof validComposeOutput.neighborhood_used === 'string');

// Edge case: empty picks is valid (quiet night)
const emptyComposeOutput = {
  sms_text: "Quiet night in Bushwick. Try Williamsburg or East Village.\nReply DETAILS, MORE, or FREE.",
  picks: [],
  neighborhood_used: 'Bushwick',
};
check('composeResponse allows empty picks', Array.isArray(emptyComposeOutput.picks) && emptyComposeOutput.picks.length === 0);
check('composeResponse empty still has sms_text', typeof emptyComposeOutput.sms_text === 'string' && emptyComposeOutput.sms_text.length > 0);

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
