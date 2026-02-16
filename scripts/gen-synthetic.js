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

const cases = [];

// --- EVENTS intent: direct neighborhood names ---
for (const hood of NEIGHBORHOODS) {
  const slangs = SLANG[hood];
  // Direct name
  cases.push(makeCase(
    `${hood} tonight`,
    { intent: 'events', neighborhood: hood, has_events: true },
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
  { intent: 'free', neighborhood: 'East Village' },
  ['free', 'with_hood'],
));

// --- MORE intent ---
const moreSession = {
  lastNeighborhood: 'East Village',
  lastPicks: [{ event_id: 'e1' }],
  lastEvents: { e1: { id: 'e1', name: 'Jazz Night' } },
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
// Emoji only
cases.push(makeCase(
  '🎶🎉',
  { intent: 'conversational' },
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
  { lastNeighborhood: 'Bushwick', lastPicks: [{ event_id: 'e1' }], lastEvents: { e1: { id: 'e1', name: 'Test' } } },
));

// --- SESSION CONTEXT: different hood ---
cases.push(makeCase(
  'williamsburg',
  { intent: 'events', neighborhood: 'Williamsburg' },
  ['session', 'diff_hood'],
  { lastNeighborhood: 'East Village', lastPicks: [{ event_id: 'e1' }], lastEvents: { e1: { id: 'e1', name: 'Test' } } },
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

// Write output
const outputDir = path.join(__dirname, '..', 'data', 'fixtures');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, 'synthetic-cases.json');
fs.writeFileSync(outputPath, JSON.stringify(cases, null, 2));
console.log(`Generated ${cases.length} synthetic test cases → ${outputPath}`);
