#!/usr/bin/env node
/**
 * Generate synthetic test cases from dimension tuples + phrasing templates.
 * Deterministic — no LLM generation, pure string templates.
 *
 * Usage: node scripts/gen-synthetic.js
 * Output: data/fixtures/synthetic-cases.json
 */

const fs = require('fs');
const path = require('path');

const NEIGHBORHOODS = [
  'East Village', 'Williamsburg', 'Bushwick', 'Lower East Side',
  'Chelsea', 'SoHo', 'Crown Heights', 'Harlem',
];

const SLANG = {
  'East Village': ['ev', 'e.v.', 'east village'],
  'Williamsburg': ['wburg', 'williamsburg', 'billyburg'],
  'Bushwick': ['bushwick', 'east wburg'],
  'Lower East Side': ['les', 'lower east side', 'LES'],
  'Chelsea': ['chelsea', 'meatpacking'],
  'SoHo': ['soho', 'nolita'],
  'Crown Heights': ['crown heights'],
  'Harlem': ['harlem'],
};

const LANDMARKS = {
  'East Village': 'tompkins square',
  'Williamsburg': 'bedford ave',
  'Lower East Side': null,
  'Chelsea': 'highline',
  'SoHo': null,
  'Crown Heights': null,
  'Harlem': null,
  'Bushwick': null,
};

const SUBWAY = {
  'East Village': '1st ave',
  'Williamsburg': 'bedford stop',
  'Lower East Side': null,
  'Chelsea': null,
  'SoHo': null,
  'Crown Heights': null,
  'Harlem': null,
  'Bushwick': null,
};

let caseId = 0;

function makeCase(message, expected, tags, session) {
  caseId++;
  const c = {
    id: `syn-${String(caseId).padStart(3, '0')}`,
    message,
    expected,
    tags,
  };
  if (session) c.session = session;
  return c;
}

function makeMultiTurnCase(turns, tags) {
  caseId++;
  return {
    id: `syn-${String(caseId).padStart(3, '0')}`,
    turns,  // [{message, expected}, ...]
    tags,
  };
}

const cases = [];

// --- EVENTS intent: direct neighborhood names ---
for (const hood of NEIGHBORHOODS) {
  const slangs = SLANG[hood];
  // Direct name
  cases.push(makeCase(
    `${hood} tonight`,
    { intent: 'events', neighborhood: hood },  // don't assert has_events — cache may be empty for some neighborhoods
    ['events', 'direct', hood.toLowerCase().replace(/\s+/g, '_')],
  ));

  // Slang variant
  if (slangs.length > 1) {
    cases.push(makeCase(
      `what's happening in ${slangs[1]}`,
      { intent: 'events', neighborhood: hood },
      ['events', 'slang', hood.toLowerCase().replace(/\s+/g, '_')],
    ));
  }

  // Question phrasing
  cases.push(makeCase(
    `anything going on near ${slangs[0]}?`,
    { intent: 'events', neighborhood: hood },
    ['events', 'question', hood.toLowerCase().replace(/\s+/g, '_')],
  ));
}

// --- EVENTS: landmark phrasing ---
for (const [hood, landmark] of Object.entries(LANDMARKS)) {
  if (!landmark) continue;
  cases.push(makeCase(
    `near ${landmark}`,
    { intent: 'events', neighborhood: hood },
    ['events', 'landmark', hood.toLowerCase().replace(/\s+/g, '_')],
  ));
}

// --- EVENTS: subway phrasing ---
for (const [hood, subway] of Object.entries(SUBWAY)) {
  if (!subway) continue;
  cases.push(makeCase(
    `what's good around ${subway}`,
    { intent: 'events', neighborhood: hood },
    ['events', 'subway', hood.toLowerCase().replace(/\s+/g, '_')],
  ));
}

// --- FREE intent ---
cases.push(makeCase(
  'free',
  { intent: 'free' },
  ['free', 'bare'],
));
cases.push(makeCase(
  'free stuff',
  { intent: 'free' },
  ['free', 'bare'],
));
cases.push(makeCase(
  'anything free tonight',
  { intent: 'free' },
  ['free', 'phrased'],
));
cases.push(makeCase(
  'free events in east village',
  { neighborhood: 'East Village' },  // intent can be 'free' or 'events' with free_only filter — both valid
  ['free', 'with_hood'],
));

// --- MORE intent ---
// Session needs enough events that "more" finds remaining ones without hitting Tavily
const moreSession = {
  lastNeighborhood: 'East Village',
  lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
  lastEvents: {
    e1: { id: 'e1', name: 'Jazz Night at Nublu', neighborhood: 'East Village', start_time_local: '2026-02-16T19:00:00', source_name: 'Dice', source_weight: 0.8, confidence: 0.9 },
    e2: { id: 'e2', name: 'Punk at Bowery Ballroom', neighborhood: 'East Village', start_time_local: '2026-02-16T21:00:00', source_name: 'Songkick', source_weight: 0.75, confidence: 0.85 },
    e3: { id: 'e3', name: 'Comedy at Eastville', neighborhood: 'East Village', start_time_local: '2026-02-16T20:00:00', is_free: true, source_name: 'The Skint', source_weight: 0.9, confidence: 0.95 },
    e4: { id: 'e4', name: 'DJ Set at Webster Hall', neighborhood: 'East Village', start_time_local: '2026-02-16T22:00:00', source_name: 'RA', source_weight: 0.85, confidence: 0.88 },
    e5: { id: 'e5', name: 'Gallery Opening on 3rd St', neighborhood: 'East Village', start_time_local: '2026-02-16T18:00:00', is_free: true, source_name: 'The Skint', source_weight: 0.9, confidence: 0.9 },
    e6: { id: 'e6', name: 'Indie Rock at Mercury Lounge', neighborhood: 'East Village', start_time_local: '2026-02-16T20:30:00', source_name: 'Dice', source_weight: 0.8, confidence: 0.87 },
  },
};
cases.push(makeCase(
  'more',
  { intent: 'more' },
  ['more', 'bare'],
  moreSession,
));
cases.push(makeCase(
  'what else',
  { intent: 'more' },
  ['more', 'phrased'],
  moreSession,
));
cases.push(makeCase(
  'show me more',
  { intent: 'more' },
  ['more', 'phrased'],
  moreSession,
));
cases.push(makeCase(
  "what else you got",
  { intent: 'more' },
  ['more', 'phrased'],
  moreSession,
));

// --- DETAILS intent ---
const detailsSession = {
  lastNeighborhood: 'Williamsburg',
  lastPicks: [
    { event_id: 'e1' },
    { event_id: 'e2' },
  ],
  lastEvents: {
    e1: { id: 'e1', name: 'DJ Night at Output' },
    e2: { id: 'e2', name: 'Art Opening at 56 Bogart' },
  },
};
cases.push(makeCase(
  '1',
  { intent: 'details' },
  ['details', 'number'],
  detailsSession,
));
cases.push(makeCase(
  '2',
  { intent: 'details' },
  ['details', 'number'],
  detailsSession,
));
cases.push(makeCase(
  'tell me more about the DJ night',
  { intent: 'details' },
  ['details', 'name_ref'],
  detailsSession,
));

// --- HELP intent ---
cases.push(makeCase(
  'help',
  { intent: 'help' },
  ['help'],
));
cases.push(makeCase(
  '?',
  { intent: 'help' },
  ['help'],
));

// --- CONVERSATIONAL intent ---
cases.push(makeCase(
  'hey',
  { intent: 'conversational', must_not: [] },
  ['conversational', 'greeting'],
));
cases.push(makeCase(
  'thanks',
  { intent: 'conversational' },
  ['conversational', 'thanks'],
));
cases.push(makeCase(
  'bye',
  { intent: 'conversational' },
  ['conversational', 'bye'],
));

// --- OFF-TOPIC (should be conversational + redirect) ---
cases.push(makeCase(
  'who won the knicks game?',
  { intent: 'conversational', must_not: ['knicks won', 'score', 'points'] },
  ['conversational', 'off_topic'],
));
cases.push(makeCase(
  "what's the weather like?",
  { intent: 'conversational', must_not: ['degrees', 'sunny', 'rain', 'forecast'] },
  ['conversational', 'off_topic'],
));
cases.push(makeCase(
  'tell me a joke',
  { intent: 'conversational', must_not: [] },
  ['conversational', 'off_topic'],
));

// --- EDGE CASES ---
// Emoji only — Claude may interpret music emojis as wanting events, which is reasonable
cases.push(makeCase(
  '🎶🎉',
  {},  // no strict intent expectation — both conversational and events are valid
  ['edge', 'emoji'],
));

// Number only (no session)
cases.push(makeCase(
  '5',
  { intent: 'conversational' },
  ['edge', 'number_no_session'],
));

// Very long message
cases.push(makeCase(
  'hey I was wondering if you could help me find something really cool to do tonight in the east village area because my friends are visiting from out of town and I want to show them a good time and we like live music and comedy and maybe some good food too',
  { intent: 'events', neighborhood: 'East Village' },
  ['edge', 'long_message'],
));

// Gibberish
cases.push(makeCase(
  'asdfghjkl',
  { intent: 'conversational' },
  ['edge', 'gibberish'],
));

// --- SESSION CONTEXT: same hood ---
cases.push(makeCase(
  "what's going on tonight",
  { intent: 'more' },
  ['session', 'same_hood'],
  {
    lastNeighborhood: 'Bushwick',
    lastPicks: [{ event_id: 'e1' }, { event_id: 'e2' }],
    lastEvents: {
      e1: { id: 'e1', name: 'Techno at Elsewhere', neighborhood: 'Bushwick', start_time_local: '2026-02-16T23:00:00', source_name: 'RA', source_weight: 0.85, confidence: 0.88 },
      e2: { id: 'e2', name: 'Drag Bingo at 3 Dollar Bill', neighborhood: 'Bushwick', start_time_local: '2026-02-16T19:00:00', source_name: 'Eventbrite', source_weight: 0.7, confidence: 0.8 },
      e3: { id: 'e3', name: 'House of Yes Late Night', neighborhood: 'Bushwick', start_time_local: '2026-02-16T22:00:00', source_name: 'RA', source_weight: 0.85, confidence: 0.9 },
      e4: { id: 'e4', name: 'Open Studios Bushwick', neighborhood: 'Bushwick', start_time_local: '2026-02-16T12:00:00', is_free: true, source_name: 'The Skint', source_weight: 0.9, confidence: 0.92 },
    },
  },
));

// --- SESSION CONTEXT: different hood ---
cases.push(makeCase(
  'williamsburg',
  { intent: 'events', neighborhood: 'Williamsburg' },
  ['session', 'diff_hood'],
  {
    lastNeighborhood: 'East Village',
    lastPicks: [{ event_id: 'e1' }],
    lastEvents: {
      e1: { id: 'e1', name: 'Jazz Night', neighborhood: 'East Village', start_time_local: '2026-02-16T19:00:00', source_name: 'Dice', source_weight: 0.8, confidence: 0.9 },
    },
  },
));

// --- FILTER: category ---
cases.push(makeCase(
  'comedy in east village',
  { intent: 'events', neighborhood: 'East Village' },
  ['filter', 'category'],
));
cases.push(makeCase(
  'live music williamsburg',
  { intent: 'events', neighborhood: 'Williamsburg' },
  ['filter', 'category'],
));

// --- FILTER: vibe ---
cases.push(makeCase(
  'something chill in chelsea',
  { intent: 'events', neighborhood: 'Chelsea' },
  ['filter', 'vibe'],
));

// =============================================
// NEW SINGLE-TURN CASES
// =============================================

// --- Off-topic variations ---
cases.push(makeCase(
  'what time is it',
  { intent: 'conversational', must_not: [] },
  ['conversational', 'off_topic'],
));
cases.push(makeCase(
  'recommend a restaurant',
  { intent: 'conversational', must_not: [] },
  ['conversational', 'off_topic'],
));
cases.push(makeCase(
  "what's your name",
  { intent: 'conversational', must_not: [] },
  ['conversational', 'off_topic'],
));
cases.push(makeCase(
  'can you order me food',
  { intent: 'conversational', must_not: [] },
  ['conversational', 'off_topic'],
));

// --- Greeting variations ---
cases.push(makeCase(
  'yo',
  { intent: 'conversational' },
  ['conversational', 'greeting'],
));
cases.push(makeCase(
  'sup',
  { intent: 'conversational' },
  ['conversational', 'greeting'],
));
cases.push(makeCase(
  'hola',
  { intent: 'conversational' },
  ['conversational', 'greeting'],
));

// --- More neighborhood slang ---
cases.push(makeCase(
  'the village',
  { intent: 'events' },  // could resolve to East Village or West Village
  ['events', 'slang'],
));
cases.push(makeCase(
  'west village',
  { intent: 'events' },
  ['events', 'slang'],
));
cases.push(makeCase(
  'flatiron',
  { intent: 'events' },
  ['events', 'slang'],
));
cases.push(makeCase(
  'midtown',
  { intent: 'events' },
  ['events', 'slang'],
));
cases.push(makeCase(
  'greenpoint',
  { intent: 'events' },
  ['events', 'slang'],
));

// --- Vibe filters ---
cases.push(makeCase(
  'something wild in bushwick',
  { intent: 'events', neighborhood: 'Bushwick' },
  ['filter', 'vibe'],
));
cases.push(makeCase(
  'romantic spot chelsea',
  { intent: 'events', neighborhood: 'Chelsea' },
  ['filter', 'vibe'],
));
cases.push(makeCase(
  'weird stuff in east village',
  { intent: 'events', neighborhood: 'East Village' },
  ['filter', 'vibe'],
));

// --- Category filters ---
cases.push(makeCase(
  'art in chelsea',
  { intent: 'events', neighborhood: 'Chelsea' },
  ['filter', 'category'],
));
cases.push(makeCase(
  'theater tonight',
  { intent: 'events' },
  ['filter', 'category'],
));
cases.push(makeCase(
  'jazz in harlem',
  { intent: 'events', neighborhood: 'Harlem' },
  ['filter', 'category'],
));

// --- Free with hood ---
cases.push(makeCase(
  'free in williamsburg',
  { neighborhood: 'Williamsburg' },  // intent can be 'free' or 'events' with free_only
  ['free', 'with_hood'],
));
cases.push(makeCase(
  'free bushwick events',
  { neighborhood: 'Bushwick' },
  ['free', 'with_hood'],
));

// --- Edge cases ---
cases.push(makeCase(
  'a',
  { intent: 'conversational' },
  ['edge', 'single_char'],
));
cases.push(makeCase(
  '...',
  { intent: 'conversational' },
  ['edge', 'punctuation'],
));
cases.push(makeCase(
  'NYC tonight',
  { intent: 'events' },  // no specific neighborhood — should still attempt events
  ['edge', 'city_wide'],
));
cases.push(makeCase(
  'ev',
  { intent: 'events', neighborhood: 'East Village' },
  ['events', 'slang', 'east_village'],
));
cases.push(makeCase(
  'anything fun tonight',
  { intent: 'events' },
  ['events', 'no_hood'],
));

// =============================================
// MULTI-TURN CASES
// =============================================

// 1. events → details by number
cases.push(makeMultiTurnCase([
  { message: 'East Village', expected: { intent: 'events', neighborhood: 'East Village' } },
  { message: '1', expected: { intent: 'details' } },
], ['multi_turn', 'events_then_details']));

// 2. events → details pick 2
cases.push(makeMultiTurnCase([
  { message: 'East Village', expected: { intent: 'events', neighborhood: 'East Village' } },
  { message: '2', expected: { intent: 'details' } },
], ['multi_turn', 'events_then_details']));

// 3. events → more
cases.push(makeMultiTurnCase([
  { message: 'Williamsburg', expected: { intent: 'events', neighborhood: 'Williamsburg' } },
  { message: 'more', expected: { intent: 'more' } },
], ['multi_turn', 'events_then_more']));

// 4. events → more → more (cache exhaustion)
cases.push(makeMultiTurnCase([
  { message: 'Bushwick', expected: { intent: 'events', neighborhood: 'Bushwick' } },
  { message: 'more', expected: { intent: 'more' } },
  { message: 'more', expected: { intent: 'more' } },
], ['multi_turn', 'events_more_more']));

// 5. events (slang) → more (phrased)
cases.push(makeMultiTurnCase([
  { message: 'les', expected: { intent: 'events', neighborhood: 'Lower East Side' } },
  { message: 'what else', expected: { intent: 'more' } },
], ['multi_turn', 'events_then_more']));

// 6. events → more (vague phrasing)
cases.push(makeMultiTurnCase([
  { message: 'Bushwick', expected: { intent: 'events', neighborhood: 'Bushwick' } },
  { message: 'anything else tonight', expected: { intent: 'more' } },
], ['multi_turn', 'events_then_more']));

// 7. events → free same hood
cases.push(makeMultiTurnCase([
  { message: 'East Village', expected: { intent: 'events', neighborhood: 'East Village' } },
  { message: 'free', expected: { intent: 'free' } },
], ['multi_turn', 'events_then_free']));

// 8. greeting → events
cases.push(makeMultiTurnCase([
  { message: 'hey', expected: { intent: 'conversational' } },
  { message: 'east village', expected: { intent: 'events', neighborhood: 'East Village' } },
], ['multi_turn', 'greeting_then_events']));

// 9. help → events
cases.push(makeMultiTurnCase([
  { message: 'help', expected: { intent: 'help' } },
  { message: 'bushwick', expected: { intent: 'events', neighborhood: 'Bushwick' } },
], ['multi_turn', 'help_then_events']));

// 10. events → farewell
cases.push(makeMultiTurnCase([
  { message: 'East Village', expected: { intent: 'events', neighborhood: 'East Village' } },
  { message: 'thanks', expected: { intent: 'conversational' } },
], ['multi_turn', 'events_then_farewell']));

// 11. events → details → more (3-turn)
cases.push(makeMultiTurnCase([
  { message: 'les', expected: { intent: 'events', neighborhood: 'Lower East Side' } },
  { message: '1', expected: { intent: 'details' } },
  { message: 'more', expected: { intent: 'more' } },
], ['multi_turn', 'events_details_more']));

// 12. neighborhood switch
cases.push(makeMultiTurnCase([
  { message: 'Chelsea', expected: { intent: 'events', neighborhood: 'Chelsea' } },
  { message: 'williamsburg', expected: { intent: 'events', neighborhood: 'Williamsburg' } },
], ['multi_turn', 'hood_switch']));

// 13. events → more → details (3-turn)
cases.push(makeMultiTurnCase([
  { message: 'soho', expected: { intent: 'events', neighborhood: 'SoHo' } },
  { message: 'more', expected: { intent: 'more' } },
  { message: '1', expected: { intent: 'details' } },
], ['multi_turn', 'events_more_details']));

// 14. events → off-topic (should redirect)
cases.push(makeMultiTurnCase([
  { message: 'East Village', expected: { intent: 'events', neighborhood: 'East Village' } },
  { message: 'who won the knicks game?', expected: { intent: 'conversational', must_not: ['knicks won', 'score', 'points'] } },
], ['multi_turn', 'events_then_offtopic']));

// 15. events → details → farewell (3-turn)
cases.push(makeMultiTurnCase([
  { message: 'Harlem', expected: { intent: 'events', neighborhood: 'Harlem' } },
  { message: '2', expected: { intent: 'details' } },
  { message: 'thanks', expected: { intent: 'conversational' } },
], ['multi_turn', 'events_details_farewell']));

// 16. events → more → switch hood (3-turn)
cases.push(makeMultiTurnCase([
  { message: 'ev', expected: { intent: 'events', neighborhood: 'East Village' } },
  { message: 'more', expected: { intent: 'more' } },
  { message: 'williamsburg', expected: { intent: 'events', neighborhood: 'Williamsburg' } },
], ['multi_turn', 'events_more_switch']));

// 17. events → more (phrased)
cases.push(makeMultiTurnCase([
  { message: 'Crown Heights', expected: { intent: 'events', neighborhood: 'Crown Heights' } },
  { message: 'show me more', expected: { intent: 'more' } },
], ['multi_turn', 'events_then_more']));

// 18. events → free
cases.push(makeMultiTurnCase([
  { message: 'Williamsburg', expected: { intent: 'events', neighborhood: 'Williamsburg' } },
  { message: 'free stuff', expected: { intent: 'free' } },
], ['multi_turn', 'events_then_free']));

// 19. events → farewell (bye)
cases.push(makeMultiTurnCase([
  { message: 'Bushwick', expected: { intent: 'events', neighborhood: 'Bushwick' } },
  { message: 'bye', expected: { intent: 'conversational' } },
], ['multi_turn', 'events_then_farewell']));

// 20. events → more → details (3-turn, phrased)
cases.push(makeMultiTurnCase([
  { message: 'East Village', expected: { intent: 'events', neighborhood: 'East Village' } },
  { message: 'what else you got', expected: { intent: 'more' } },
  { message: '1', expected: { intent: 'details' } },
], ['multi_turn', 'events_more_details']));

// 21. free → free again (push for more free, should hit Tavily path)
cases.push(makeMultiTurnCase([
  { message: 'free in east village', expected: { neighborhood: 'East Village' } },
  { message: 'free', expected: { intent: 'free' } },
], ['multi_turn', 'free_then_free']));

// 22. free → free → free (3-turn free exhaustion, Tavily path)
cases.push(makeMultiTurnCase([
  { message: 'free stuff', expected: { intent: 'free' } },
  { message: 'more free stuff', expected: {} },  // could be more or free — both valid
  { message: 'anything else free', expected: {} },
], ['multi_turn', 'free_exhaustion']));

// 23. events → free → more free (cross-intent into free then push)
cases.push(makeMultiTurnCase([
  { message: 'Williamsburg', expected: { intent: 'events', neighborhood: 'Williamsburg' } },
  { message: 'actually anything free?', expected: { intent: 'free' } },
  { message: 'more free stuff', expected: {} },
], ['multi_turn', 'events_free_morefree']));

// 24. free with hood → free again → details
cases.push(makeMultiTurnCase([
  { message: 'free in bushwick', expected: { neighborhood: 'Bushwick' } },
  { message: 'free', expected: { intent: 'free' } },
  { message: '1', expected: { intent: 'details' } },
], ['multi_turn', 'free_free_details']));

// 25. free → more → free (alternating)
cases.push(makeMultiTurnCase([
  { message: 'free east village', expected: { neighborhood: 'East Village' } },
  { message: 'more', expected: { intent: 'more' } },
  { message: 'just the free ones', expected: { intent: 'free' } },
], ['multi_turn', 'free_more_free']));

// Write output
const outputDir = path.join(__dirname, '..', 'data', 'fixtures');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, 'synthetic-cases.json');
fs.writeFileSync(outputPath, JSON.stringify(cases, null, 2));
console.log(`Generated ${cases.length} synthetic test cases → ${outputPath}`);
