const { check } = require('../helpers');
const { sanitizeForLLM, extractPicksFromSms, deriveIntent, inferTypesFromQuery } = require('../../src/agent-loop');

// ---- sanitizeForLLM ----
console.log('\nsanitizeForLLM:');

check('strips _ prefixed keys', JSON.stringify(sanitizeForLLM({ foo: 1, _bar: 2 })) === '{"foo":1}');
check('passes through clean objects', JSON.stringify(sanitizeForLLM({ a: 1, b: 2 })) === '{"a":1,"b":2}');
check('handles null', sanitizeForLLM(null) === null);
check('handles undefined', sanitizeForLLM(undefined) === undefined);
check('handles arrays (pass through)', Array.isArray(sanitizeForLLM([1, 2, 3])));

// ---- extractPicksFromSms ----
console.log('\nextractPicksFromSms:');

const testEvents = [
  { id: 'e1', name: 'Jazz Night at Blue Note', venue_name: 'Blue Note' },
  { id: 'e2', name: 'Comedy Hour', venue_name: 'Tiny Cupboard' },
  { id: 'e3', name: 'Art Opening', venue_name: 'Pioneer Works' },
];

const sms1 = 'Check out Jazz Night at Blue Note and Comedy Hour at Tiny Cupboard tonight!';
const picks1 = extractPicksFromSms(sms1, testEvents);
check('finds 2 events in SMS', picks1.length === 2);
check('first pick is e1', picks1[0].event_id === 'e1');
check('second pick is e2', picks1[1].event_id === 'e2');
check('ranks are sequential', picks1[0].rank === 1 && picks1[1].rank === 2);

check('empty SMS returns empty', extractPicksFromSms('', testEvents).length === 0);
check('null SMS returns empty', extractPicksFromSms(null, testEvents).length === 0);
check('no matching events returns empty', extractPicksFromSms('Nothing here', testEvents).length === 0);

const sms2 = 'Blue Note has Jazz Night at Blue Note tonight';
const picks2 = extractPicksFromSms(sms2, testEvents);
check('no duplicate picks', picks2.length === 1);

// ---- deriveIntent ----
console.log('\nderiveIntent:');

check('no tool calls -> conversational', deriveIntent([]) === 'conversational');
check('null -> conversational', deriveIntent(null) === 'conversational');
check('respond -> conversational', deriveIntent([{ name: 'respond', params: { intent: 'greeting' } }]) === 'conversational');
check('search discover -> welcome (no hood/types)', deriveIntent([{ name: 'search', params: { intent: 'discover' } }]) === 'welcome');
check('search discover with hood -> events', deriveIntent([{ name: 'search', params: { intent: 'discover', neighborhood: 'bushwick' } }]) === 'events');
check('search details -> details', deriveIntent([{ name: 'search', params: { intent: 'details' } }]) === 'details');
check('search more -> more', deriveIntent([{ name: 'search', params: { intent: 'more' } }]) === 'more');
check('search bars-only -> places', deriveIntent([{ name: 'search', params: { intent: 'discover', types: ['bars'] } }]) === 'places');
check('search events+bars -> events', deriveIntent([{ name: 'search', params: { intent: 'discover', neighborhood: 'les', types: ['events', 'bars'] } }]) === 'events');
check('multi-call: last search wins', deriveIntent([
  { name: 'search', params: { intent: 'discover', neighborhood: 'bushwick' } },
  { name: 'search', params: { intent: 'discover', neighborhood: 'les' } },
]) === 'events');

// ---- search tool in BRAIN_TOOLS ----
console.log('\nsearch tool:');

const { BRAIN_TOOLS } = require('../../src/brain-llm');
const searchTool = BRAIN_TOOLS.find(t => t.name === 'search');
check('search tool exists in BRAIN_TOOLS', !!searchTool);
check('search tool has intent required', searchTool.parameters.required.includes('intent'));
check('search tool has types param', !!searchTool.parameters.properties.types);
check('search tool has filters param', !!searchTool.parameters.properties.filters);
check('no show_welcome tool', !BRAIN_TOOLS.find(t => t.name === 'show_welcome'));
check('no search_events tool', !BRAIN_TOOLS.find(t => t.name === 'search_events'));
check('no search_places tool', !BRAIN_TOOLS.find(t => t.name === 'search_places'));

// ---- lookup_venue tool in BRAIN_TOOLS ----
console.log('\nlookup_venue tool:');

const lookupTool = BRAIN_TOOLS.find(t => t.name === 'lookup_venue');
check('lookup_venue tool exists in BRAIN_TOOLS', !!lookupTool);
check('lookup_venue has venue_name required', lookupTool.parameters.required.includes('venue_name'));
check('lookup_venue has neighborhood param', !!lookupTool.parameters.properties.neighborhood);
check('BRAIN_TOOLS has exactly 2 tools', BRAIN_TOOLS.length === 2);

// ---- buildBrainSystemPrompt first-session indicator ----
console.log('\nbuildBrainSystemPrompt first-session:');

const { buildBrainSystemPrompt } = require('../../src/brain-llm');

const freshSession = {};
const freshPrompt = buildBrainSystemPrompt(freshSession);
check('fresh session prompt contains first-message indicator', freshPrompt.includes('First message — new user'));

const returningSession = { conversationHistory: [{ role: 'user', content: 'hey' }], lastNeighborhood: 'bushwick' };
const returningPrompt = buildBrainSystemPrompt(returningSession);
check('returning session prompt does NOT contain first-message indicator', !returningPrompt.includes('First message — new session'));

// ---- buildBrainSystemPrompt new prompt structure ----
console.log('\nbuildBrainSystemPrompt prompt structure:');

const anyPrompt = buildBrainSystemPrompt({});
check('prompt has identity section', anyPrompt.includes('<identity>'));
check('prompt has data-contract section', anyPrompt.includes('<data-contract>'));
check('prompt has conversation section', anyPrompt.includes('<conversation>'));
check('prompt has examples section', anyPrompt.includes('<examples>'));
check('prompt has 480 char limit', anyPrompt.includes('480'));
check('prompt mentions short_detail as trusted field', anyPrompt.includes('short_detail'));
check('prompt mentions lookup_venue tool', anyPrompt.includes('lookup_venue'));
check('prompt has mood mapping', anyPrompt.includes('chill') && anyPrompt.includes('jazz'));
check('prompt has anti-fabrication rule', anyPrompt.includes('fabrication'));
check('prompt has no markdown rule', anyPrompt.includes('no markdown'));
check('prompt does NOT have old serendipity framing', !anyPrompt.includes('serendipity:true'));
check('prompt does NOT have old proactive CTA', !anyPrompt.includes('NOTIFY'));
check('prompt does NOT have old places mixing', !anyPrompt.includes('Grab a drink at'));

// ---- buildRecommendationReason ----
console.log('\nbuildRecommendationReason:');

const { buildRecommendationReason } = require('../../src/brain-llm');
check('one-night-only event', buildRecommendationReason({ scarcity: 'one-night-only' }).includes('one-off'));
check('discovery source', buildRecommendationReason({ source_vibe: 'discovery' }).includes('underground'));
check('intimate venue', buildRecommendationReason({ venue_size: 'intimate' }).includes('tiny room'));
check('free event', buildRecommendationReason({ is_free: true }).includes('free'));
check('editorial pick', buildRecommendationReason({ editorial_signal: true }).includes('tastemaker'));
check('interactive format', buildRecommendationReason({ interaction_format: 'interactive' }).includes('not just watching'));
check('multiple signals combined', (() => {
  const r = buildRecommendationReason({ scarcity: 'one-night-only', source_vibe: 'discovery', is_free: true });
  return r.includes('one-off') && r.includes('underground') && r.includes('free');
})());
check('no signals returns undefined', buildRecommendationReason({}) === undefined);

// ---- inferTypesFromQuery ----
console.log('\ninferTypesFromQuery:');

check('null query -> events', inferTypesFromQuery(null).includes('events'));
check('empty query -> events', inferTypesFromQuery('').includes('events'));
check('"best bars" -> bars', inferTypesFromQuery('best bars').includes('bars'));
check('"dinner spot" -> restaurants', inferTypesFromQuery('dinner spot').includes('restaurants'));
check('"comedy show" -> events', inferTypesFromQuery('comedy show').includes('events'));
check('"dinner and a show" -> restaurants + events', (() => {
  const t = inferTypesFromQuery('dinner and a show');
  return t.includes('restaurants') && t.includes('events');
})());
check('"cocktail bar" -> bars', inferTypesFromQuery('cocktail bar').includes('bars'));
check('"what\'s happening tonight" -> events', inferTypesFromQuery("what's happening tonight").includes('events'));

// ---- executeTool details returns event data for model ----
console.log('\nexecuteTool details returns event data:');

const { executeTool } = require('../../src/agent-loop');

const detailsSession = {
  lastPicks: [
    { rank: 1, event_id: 'e1' },
    { rank: 2, event_id: 'e2' },
  ],
  lastEvents: {
    e1: { id: 'e1', name: 'Jazz Night', venue_name: 'Blue Note', category: 'jazz', neighborhood: 'Greenwich Village', start_time_local: '2026-03-08T22:00:00', is_free: false, price_display: '$20', description_short: 'Weekly jazz jam session' },
    e2: { id: 'e2', name: 'Comedy Hour', venue_name: 'Tiny Cupboard', category: 'comedy', neighborhood: 'LES', start_time_local: '2026-03-08T21:00:00', is_free: true, description_short: 'Open mic comedy night' },
  },
};
const dummyTrace = { events: {}, composition: {} };

(async () => {
  // Returns event data via unified search tool
  const detResult = await executeTool('search', { intent: 'details', reference: 'jazz' }, detailsSession, '+1234', dummyTrace);
  check('details returns items array', Array.isArray(detResult.items));
  check('details returns reference', detResult.reference === 'jazz');
  check('details items have description', detResult.items[0].description_short !== undefined);
  check('details items have type tag', detResult.items[0].type === 'event');

  // No picks returns not_found
  const noPickResult = await executeTool('search', { intent: 'details', reference: '1' }, { lastPicks: [] }, '+1234', dummyTrace);
  check('details no picks returns not_found', noPickResult.not_found === true);

  // Stale picks returns stale
  const staleSession2 = { ...detailsSession, lastResponseHadPicks: false, lastNeighborhood: 'Bushwick' };
  const staleResult = await executeTool('search', { intent: 'details', reference: '1' }, staleSession2, '+1234', dummyTrace);
  check('details stale returns stale', staleResult.stale === true);

  // ---- executeTool lookup_venue ----
  console.log('\nexecuteTool lookup_venue:');

  const lookupResult = await executeTool('lookup_venue', { venue_name: 'Some Random Venue', neighborhood: 'SoHo' }, {}, '+10000000000', { events: {}, composition: {} });
  check('lookup_venue returns object', typeof lookupResult === 'object');
  check('lookup_venue without API key returns not_found', lookupResult.not_found === true);
  check('lookup_venue is not unknown tool', !lookupResult.error?.includes('Unknown tool'));
})();

// ---- buildNativeHistory ----
console.log('\nbuildNativeHistory:');

const { buildNativeHistory } = require('../../src/brain-llm');

check('empty input returns []', buildNativeHistory([]).length === 0);
check('null input returns []', buildNativeHistory(null).length === 0);
check('undefined input returns []', buildNativeHistory(undefined).length === 0);

// Basic user + assistant pair
const basicHistory = [
  { role: 'user', content: 'bushwick' },
  { role: 'assistant', content: 'Here are some picks...' },
];
const basicNative = buildNativeHistory(basicHistory);
check('user+assistant → 2 messages', basicNative.length === 2);
check('first is user', basicNative[0].role === 'user');
check('second is assistant', basicNative[1].role === 'assistant');
check('user content preserved', basicNative[0].content === 'bushwick');

// tool_call folds into assistant
const toolHistory = [
  { role: 'user', content: 'bushwick' },
  { role: 'tool_call', content: '', meta: { name: 'search', params: { neighborhood: 'bushwick', intent: 'discover' } } },
  { role: 'assistant', content: 'Here are picks in Bushwick' },
];
const toolNative = buildNativeHistory(toolHistory);
check('tool_call merges into assistant', toolNative.length === 2);
check('assistant contains tool call bracket', toolNative[1].content.includes('[search('));

// search_summary folds into assistant
const summaryHistory = [
  { role: 'user', content: 'bushwick' },
  { role: 'tool_call', content: '', meta: { name: 'search', params: { intent: 'discover' } } },
  { role: 'search_summary', content: '', meta: { match_count: 15, neighborhood: 'Bushwick', result_type: 'events' } },
  { role: 'assistant', content: 'Some picks...' },
];
const summaryNative = buildNativeHistory(summaryHistory);
check('search_summary merges into assistant', summaryNative.length === 2);
check('assistant contains summary bracket', summaryNative[1].content.includes('[15 events in Bushwick]'));

// Consecutive same-role merged
const consecutiveHistory = [
  { role: 'user', content: 'hey' },
  { role: 'user', content: 'bushwick' },
  { role: 'assistant', content: 'Hi!' },
  { role: 'assistant', content: 'Here are picks' },
];
const consNative = buildNativeHistory(consecutiveHistory);
check('consecutive same-role merged', consNative.length === 2);
check('merged user has both contents', consNative[0].content.includes('hey') && consNative[0].content.includes('bushwick'));

// Starts with user, ends with assistant
const badOrder = [
  { role: 'assistant', content: 'orphan' },
  { role: 'user', content: 'hey' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'trailing' },
];
const trimmed = buildNativeHistory(badOrder);
check('starts with user', trimmed.length > 0 && trimmed[0].role === 'user');
check('ends with assistant', trimmed.length > 0 && trimmed[trimmed.length - 1].role === 'assistant');
