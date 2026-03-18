const { check } = require('../helpers');

// ---- fetchNYCParksEvents export ----
console.log('\nfetchNYCParksEvents:');
check('fetchNYCParksEvents exported', typeof require('../../src/sources').fetchNYCParksEvents === 'function');

// ---- fetchDoNYCEvents export ----
console.log('\nfetchDoNYCEvents:');
check('fetchDoNYCEvents exported', typeof require('../../src/sources').fetchDoNYCEvents === 'function');

// ---- fetchBAMEvents export ----
console.log('\nfetchBAMEvents:');
check('fetchBAMEvents exported', typeof require('../../src/sources').fetchBAMEvents === 'function');

// ---- fetchSmallsLiveEvents export ----
console.log('\nfetchSmallsLiveEvents:');
check('fetchSmallsLiveEvents exported', typeof require('../../src/sources').fetchSmallsLiveEvents === 'function');

// ---- fetchNYPLEvents export ----
console.log('\nfetchNYPLEvents:');
check('fetchNYPLEvents exported', typeof require('../../src/sources').fetchNYPLEvents === 'function');

// ---- RA source: is_free should always be false ----
console.log('\nRA source (is_free):');
const raSource = require('../../src/sources/ra');
check('fetchRAEvents is exported', typeof raSource.fetchRAEvents === 'function');

// ---- msUntilNextScrape logic (boundary test) ----
console.log('\nmsUntilNextScrape logic:');

const SCRAPE_HOUR = 10;
function testMsUntilNextScrape(hour, minute, second) {
  let hoursUntil = SCRAPE_HOUR - hour;
  if (hoursUntil < 0) hoursUntil += 24;
  return (hoursUntil * 3600 - minute * 60 - second) * 1000;
}
check('at 10:00 AM: triggers soon (not 24h)', testMsUntilNextScrape(10, 0, 0) === 0);
check('at 10:00:30 AM: triggers soon', testMsUntilNextScrape(10, 0, 30) < 0);
check('at 09:59 AM: ~60s away', testMsUntilNextScrape(9, 59, 0) === 60000);
check('at 11:00 AM: schedules for tomorrow', testMsUntilNextScrape(11, 0, 0) === 23 * 3600000);
check('at 09:00 AM: 1 hour away', testMsUntilNextScrape(9, 0, 0) === 3600000);

// ---- SOURCES registry ----
console.log('\nSOURCES registry:');

const { SOURCES } = require('../../src/events');
check('SOURCES has editorial sources', SOURCES.length >= 5);
check('SOURCES labels are unique', new Set(SOURCES.map(s => s.label)).size === SOURCES.length);
check('all SOURCES have fetch functions', SOURCES.every(s => typeof s.fetch === 'function'));
check('all SOURCES have valid weights', SOURCES.every(s => s.weight > 0 && s.weight <= 1));
check('SOURCES includes Skint', SOURCES.some(s => s.label === 'Skint'));
check('Skint weight is 0.9', SOURCES.find(s => s.label === 'Skint').weight === 0.9);
check('Tavily not in daily scrape SOURCES', !SOURCES.some(s => s.label === 'Tavily'));

// ---- Email source channel ----
console.log('\nEmail source channel:');
const { EMAIL_SOURCES } = require('../../src/source-registry');
check('EMAIL_SOURCES is an array', Array.isArray(EMAIL_SOURCES));
check('EMAIL_SOURCES has 3 entries', EMAIL_SOURCES.length === 3);
check('NonsenseNYC is email channel', EMAIL_SOURCES.some(s => s.label === 'NonsenseNYC'));
check('Yutori is email channel', EMAIL_SOURCES.some(s => s.label === 'Yutori'));
check('ScreenSlate is email channel', EMAIL_SOURCES.some(s => s.label === 'ScreenSlate'));
check('RA is NOT email channel', !EMAIL_SOURCES.some(s => s.label === 'RA'));
check('all email sources have fetch functions', EMAIL_SOURCES.every(s => typeof s.fetch === 'function'));

// ---- refreshEmailSources ----
console.log('\nrefreshEmailSources:');
const { refreshEmailSources } = require('../../src/events');
check('refreshEmailSources is exported', typeof refreshEmailSources === 'function');

// ---- Email poll scheduler ----
console.log('\nEmail poll scheduler:');
const { scheduleEmailPolls, clearEmailSchedule } = require('../../src/events');
check('scheduleEmailPolls is exported', typeof scheduleEmailPolls === 'function');
check('clearEmailSchedule is exported', typeof clearEmailSchedule === 'function');


// Exported as async for runner
module.exports.runAsync = async function() {
  // ---- Session merge semantics ----
  console.log('\nSession merge:');

  const { getSession, setSession, setResponseState, clearSession, clearSessionInterval } = require('../../src/session');
  const testPhone = '+15555550000';
  clearSession(testPhone);
  setSession(testPhone, { lastNeighborhood: 'Williamsburg', lastPicks: [{ event_id: 'abc' }] });
  const s1 = getSession(testPhone);
  check('initial session has neighborhood', s1.lastNeighborhood === 'Williamsburg');
  check('initial session has picks', s1.lastPicks.length === 1);

  setSession(testPhone, { pendingFilters: { free_only: true } });
  const s2 = getSession(testPhone);
  check('partial update preserves neighborhood', s2.lastNeighborhood === 'Williamsburg');
  check('partial update preserves picks', s2.lastPicks.length === 1);
  check('partial update adds new field', s2.pendingFilters.free_only === true);

  setSession(testPhone, { lastNeighborhood: 'Bushwick', lastPicks: [] });
  const s3 = getSession(testPhone);
  check('full update overwrites neighborhood', s3.lastNeighborhood === 'Bushwick');
  check('full update overwrites picks', s3.lastPicks.length === 0);
  check('full update preserves merged field', s3.pendingFilters.free_only === true);

  // ---- setResponseState atomic replacement ----
  console.log('\nsetResponseState atomic replacement:');

  // Set up a full session with merge semantics first
  clearSession(testPhone);
  setSession(testPhone, { lastNeighborhood: 'Williamsburg', lastPicks: [{ event_id: 'abc' }], pendingNearby: 'Greenpoint', pendingFilters: { free_only: true }, conversationHistory: [{ role: 'user', content: 'hi' }] });

  // setResponseState should atomically replace everything except conversationHistory
  setResponseState(testPhone, { picks: [{ event_id: 'xyz' }], neighborhood: 'Bushwick', filters: { category: 'comedy' } });
  const s4 = getSession(testPhone);
  check('atomic: picks replaced', s4.lastPicks.length === 1 && s4.lastPicks[0].event_id === 'xyz');
  check('atomic: neighborhood replaced', s4.lastNeighborhood === 'Bushwick');
  check('atomic: filters replaced', s4.lastFilters?.category === 'comedy');
  check('atomic: pendingNearby cleared', s4.pendingNearby === null);
  check('atomic: pendingFilters cleared', s4.pendingFilters === null);
  check('atomic: conversationHistory preserved', s4.conversationHistory?.length === 1);
  check('atomic: allOfferedIds defaulted to empty', Array.isArray(s4.allOfferedIds) && s4.allOfferedIds.length === 0);
  check('atomic: visitedHoods defaulted to empty', Array.isArray(s4.visitedHoods) && s4.visitedHoods.length === 0);

  // Verify transition (no picks) clears old state
  setResponseState(testPhone, { neighborhood: 'LES', pendingNearby: 'East Village' });
  const s5 = getSession(testPhone);
  check('transition: picks cleared', s5.lastPicks.length === 0);
  check('transition: neighborhood set', s5.lastNeighborhood === 'LES');
  check('transition: pendingNearby set', s5.pendingNearby === 'East Village');
  check('transition: old filters cleared', s5.lastFilters === null);
  check('transition: conversationHistory still preserved', s5.conversationHistory?.length === 1);

  clearSession(testPhone);
  clearSessionInterval();

  // ---- TCPA opt-out regex ----
  console.log('\nTCPA opt-out regex:');

  const { OPT_OUT_KEYWORDS } = require('../../src/handler');
  check('STOP matches', OPT_OUT_KEYWORDS.test('STOP'));
  check('"stop" matches', OPT_OUT_KEYWORDS.test('stop'));
  check('"  quit" matches (leading whitespace)', OPT_OUT_KEYWORDS.test('  quit'));
  check('"stop please" does NOT match (not exact)', !OPT_OUT_KEYWORDS.test('stop please'));
  check('"unsubscribe me" does NOT match (not exact)', !OPT_OUT_KEYWORDS.test('unsubscribe me'));
  check('"stop showing me comedy" does NOT match', !OPT_OUT_KEYWORDS.test('stop showing me comedy'));
  check('"can\'t stop dancing" does NOT match', !OPT_OUT_KEYWORDS.test("can't stop dancing"));
  check('"don\'t quit" does NOT match', !OPT_OUT_KEYWORDS.test("don't quit"));
  check('"I want to cancel" does NOT match', !OPT_OUT_KEYWORDS.test("I want to cancel"));
  check('"east village" does NOT match', !OPT_OUT_KEYWORDS.test('east village'));
  check('"what\'s happening" does NOT match', !OPT_OUT_KEYWORDS.test("what's happening"));
};
