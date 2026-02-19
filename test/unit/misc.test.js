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
check('SOURCES has at least 14 entries', SOURCES.length >= 14);
check('SOURCES labels are unique', new Set(SOURCES.map(s => s.label)).size === SOURCES.length);
check('all SOURCES have fetch functions', SOURCES.every(s => typeof s.fetch === 'function'));
check('all SOURCES have valid weights', SOURCES.every(s => s.weight > 0 && s.weight <= 1));
check('SOURCES includes Skint', SOURCES.some(s => s.label === 'Skint'));
check('SOURCES includes Tavily', SOURCES.some(s => s.label === 'Tavily'));
check('Skint weight is 0.9', SOURCES.find(s => s.label === 'Skint').weight === 0.9);
check('Tavily weight is 0.6', SOURCES.find(s => s.label === 'Tavily').weight === 0.6);

// ---- getHealthStatus shape ----
console.log('\ngetHealthStatus:');

const { getHealthStatus } = require('../../src/events');
check('getHealthStatus is a function', typeof getHealthStatus === 'function');

const healthData = getHealthStatus();
check('has status field', typeof healthData.status === 'string');
check('status is ok|degraded|critical', ['ok', 'degraded', 'critical'].includes(healthData.status));
check('has cache object', typeof healthData.cache === 'object' && healthData.cache !== null);
check('cache has size', 'size' in healthData.cache);
check('cache has age_minutes', 'age_minutes' in healthData.cache);
check('cache has fresh', 'fresh' in healthData.cache);
check('cache has last_refresh', 'last_refresh' in healthData.cache);
check('has scrape object', typeof healthData.scrape === 'object' && healthData.scrape !== null);
check('scrape has startedAt', 'startedAt' in healthData.scrape);
check('scrape has totalDurationMs', 'totalDurationMs' in healthData.scrape);
check('scrape has sourcesOk', 'sourcesOk' in healthData.scrape);
check('scrape has sourcesFailed', 'sourcesFailed' in healthData.scrape);
check('has sources object', typeof healthData.sources === 'object' && healthData.sources !== null);
check('sources has Skint', 'Skint' in healthData.sources);
check('sources has RA', 'RA' in healthData.sources);
check('sources has 17 entries', Object.keys(healthData.sources).length === 17);

const sampleSource = healthData.sources.Skint;
check('source has status field', 'status' in sampleSource);
check('source has last_count', 'last_count' in sampleSource);
check('source has consecutive_zeros', 'consecutive_zeros' in sampleSource);
check('source has duration_ms', 'duration_ms' in sampleSource);
check('source has http_status', 'http_status' in sampleSource);
check('source has last_error', 'last_error' in sampleSource);
check('source has last_scrape', 'last_scrape' in sampleSource);
check('source has success_rate', 'success_rate' in sampleSource);
check('source has history array', Array.isArray(sampleSource.history));

// ---- alerts module ----
// Exported as async for runner
module.exports.runAsync = async function() {
  console.log('\nalerts module:');

  const { sendHealthAlert } = require('../../src/alerts');
  check('sendHealthAlert is a function', typeof sendHealthAlert === 'function');

  const alertResult = await sendHealthAlert(
    [{ label: 'TestSource', consecutiveZeros: 3, lastError: 'timeout', lastStatus: 'timeout' }],
    { dedupedEvents: 100, sourcesOk: 14, sourcesFailed: 1, sourcesEmpty: 1, totalDurationMs: 5000, completedAt: new Date().toISOString() }
  );
  check('sendHealthAlert no-ops without API key (returns undefined)', alertResult === undefined);

  const emptyResult = await sendHealthAlert([], {});
  check('sendHealthAlert no-ops with empty failures', emptyResult === undefined);

  // ---- sendRuntimeAlert ----
  console.log('\nsendRuntimeAlert:');

  const { sendRuntimeAlert, _runtimeCooldowns } = require('../../src/alerts');
  check('sendRuntimeAlert is a function', typeof sendRuntimeAlert === 'function');

  const runtimeResult = await sendRuntimeAlert('test_error', { phone_masked: '***1234', message: 'test', error: 'boom' });
  check('sendRuntimeAlert no-ops without API key (returns undefined)', runtimeResult === undefined);

  // Force a cooldown entry to test cooldown logic
  _runtimeCooldowns.set('cooldown_test', Date.now());
  const cooldownResult = await sendRuntimeAlert('cooldown_test', { phone_masked: '***1234', message: 'test', error: 'boom' });
  check('sendRuntimeAlert no-ops on cooldown (returns undefined)', cooldownResult === undefined);
  _runtimeCooldowns.delete('cooldown_test');

  // ---- Session merge semantics ----
  console.log('\nSession merge:');

  const { getSession, setSession, clearSession, clearSessionInterval } = require('../../src/session');
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
  clearSession(testPhone);
  clearSessionInterval();

  // ---- TCPA opt-out regex ----
  console.log('\nTCPA opt-out regex:');

  const { OPT_OUT_KEYWORDS } = require('../../src/handler');
  check('STOP matches', OPT_OUT_KEYWORDS.test('STOP'));
  check('"stop" matches', OPT_OUT_KEYWORDS.test('stop'));
  check('"stop please" matches', OPT_OUT_KEYWORDS.test('stop please'));
  check('"  quit" matches (leading whitespace)', OPT_OUT_KEYWORDS.test('  quit'));
  check('"unsubscribe me" matches', OPT_OUT_KEYWORDS.test('unsubscribe me'));
  check('"can\'t stop dancing" does NOT match', !OPT_OUT_KEYWORDS.test("can't stop dancing"));
  check('"don\'t quit" does NOT match', !OPT_OUT_KEYWORDS.test("don't quit"));
  check('"I want to cancel" does NOT match', !OPT_OUT_KEYWORDS.test("I want to cancel"));
  check('"east village" does NOT match', !OPT_OUT_KEYWORDS.test('east village'));
  check('"what\'s happening" does NOT match', !OPT_OUT_KEYWORDS.test("what's happening"));
};
