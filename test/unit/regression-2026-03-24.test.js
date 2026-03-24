/**
 * Regression tests from 2026-03-24 live SMS testing.
 * Each test maps to a real bug encountered during first phone number provisioning.
 */

const { check } = require('../helpers');
const { stripMarkdown, deriveIntent, extractPicksFromSms } = require('../../src/agent-loop');
const { buildBrainSystemPrompt } = require('../../src/brain-llm');

// ---- 1. Markdown stripping (SMS must be plain text) ----
console.log('\nRegression: markdown stripping');

check('strips **bold**', stripMarkdown('Check out **Jazz Night**') === 'Check out Jazz Night');
check('strips *italic*', stripMarkdown('A *great* show') === 'A great show');
check('strips __bold__', stripMarkdown('Try __Blue Note__') === 'Try Blue Note');
check('strips _italic_', stripMarkdown('A _great_ show') === 'A great show');
check('strips [text](url)', stripMarkdown('See [details](https://example.com)') === 'See details');
check('strips nested bold+italic', stripMarkdown('**Tonight (7:30 PM):** Trivia at **Lydia\'s**') === 'Tonight (7:30 PM): Trivia at Lydia\'s');
check('handles null', stripMarkdown(null) === null);
check('handles empty', stripMarkdown('') === '');
check('plain text unchanged', stripMarkdown('No formatting here') === 'No formatting here');
check('multiple bold in one line', stripMarkdown('**A** and **B** and **C**') === 'A and B and C');

// ---- 2. No false familiarity with thin data ----
console.log('\nRegression: no false familiarity from thin pick history');

const thinSession = {
  allPicks: [
    { event_id: 'e1' },
    { event_id: 'e2' },
  ],
  lastEvents: {
    e1: { category: 'comedy' },
    e2: { category: 'jazz' },
  },
};
const thinPrompt = buildBrainSystemPrompt(thinSession);
check('< 5 picks: no prior pick categories in prompt', !thinPrompt.includes("User's prior pick categories"));

const richSession = {
  allPicks: [
    { event_id: 'e1' }, { event_id: 'e2' }, { event_id: 'e3' },
    { event_id: 'e4' }, { event_id: 'e5' },
  ],
  lastEvents: {
    e1: { category: 'comedy' },
    e2: { category: 'jazz' },
    e3: { category: 'film' },
    e4: { category: 'comedy' },
    e5: { category: 'nightlife' },
  },
};
const richPrompt = buildBrainSystemPrompt(richSession);
check('>= 5 picks: prior pick categories included', richPrompt.includes("User's prior pick categories"));

// ---- 3. deriveIntent: details wins even with follow-up search ----
console.log('\nRegression: deriveIntent details not masked by follow-up search');

check('details + discover → details (not events)', deriveIntent([
  { name: 'search', params: { intent: 'details', reference: 'ABBA' } },
  { name: 'search', params: { intent: 'discover', neighborhood: 'Lower East Side' } },
]) === 'details');

check('discover + details → details (order doesnt matter)', deriveIntent([
  { name: 'search', params: { intent: 'discover', neighborhood: 'bushwick' } },
  { name: 'search', params: { intent: 'details', reference: '2' } },
]) === 'details');

check('details alone still works', deriveIntent([
  { name: 'search', params: { intent: 'details', reference: '1' } },
]) === 'details');

check('discover alone still returns events', deriveIntent([
  { name: 'search', params: { intent: 'discover', neighborhood: 'bushwick' } },
]) === 'events');

// ---- 4. Test mode allows real phone sends ----
console.log('\nRegression: test mode guard allows real phones');

// The regex that gates test-mode blocking: only test phones should be blocked
const testGuardRegex = /^\+1(555\d{7}|0{9,})$/;
check('test phone +15551234567 is blocked', testGuardRegex.test('+15551234567'));
check('test phone +10000000000 is blocked', testGuardRegex.test('+10000000000'));
check('real phone +12034149957 is NOT blocked', !testGuardRegex.test('+12034149957'));
check('real phone +19175551234 is NOT blocked (starts 555 but not at position 2)', !testGuardRegex.test('+19175551234'));
// Actually +19175551234 won't match since 555 isn't right after +1
check('real phone +16467226926 is NOT blocked', !testGuardRegex.test('+16467226926'));

// ---- 5. Anti-familiarity prompt rule ----
console.log('\nRegression: prompt includes anti-familiarity rule');

const anyPrompt = buildBrainSystemPrompt({});
check('prompt says no fake familiarity', anyPrompt.includes('fake familiarity'));
check('prompt mentions "your kind of stuff"', anyPrompt.includes('your kind of stuff'));

// ---- 6. Prompt enforces plain text ----
console.log('\nRegression: prompt enforces plain text SMS');

check('prompt says no markdown', anyPrompt.includes('no markdown'));
check('prompt says no bold', anyPrompt.includes('no bold'));
check('prompt says plain text only', anyPrompt.includes('Plain text only'));
