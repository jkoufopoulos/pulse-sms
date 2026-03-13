const { check } = require('../helpers');
const { shouldPromptOptIn, scoreMatch, findBestMatch, composeProactiveMessage, processProactiveMessages } = require('../../src/proactive');

// ---- shouldPromptOptIn ----
console.log('\nshouldPromptOptIn:');

check('null profile returns false', shouldPromptOptIn(null) === false);

check('already opted in returns false', shouldPromptOptIn({
  proactiveOptIn: true, proactivePromptCount: 0, sessionCount: 1
}) === false);

check('session 1 with 0 prompts returns true', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 0, sessionCount: 1
}) === true);

check('session 2 returns false', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 1, sessionCount: 2
}) === false);

check('session 3 with 1 prompt returns true', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 1, sessionCount: 3
}) === true);

check('session 3 with 2 prompts returns false (max)', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 2, sessionCount: 3
}) === false);

check('session 4 returns false', shouldPromptOptIn({
  proactiveOptIn: false, proactivePromptCount: 1, sessionCount: 4
}) === false);

// ---- scoreMatch ----
console.log('\nscoreMatch:');

const baseEvent = {
  id: 'e1', name: 'Test Event', venue_name: 'Test Venue',
  neighborhood: 'Bushwick', category: 'dj',
  interestingness: 3, scarcity: null, editorial_signal: false,
};

const baseProfile = {
  neighborhoods: { Bushwick: 5, Williamsburg: 3 },
  categories: { dj: 4, live_music: 2 },
  sessionCount: 3,
};

check('neighborhood match scores +3', (() => {
  const score = scoreMatch(baseEvent, baseProfile);
  return score >= 3;
})());

check('no neighborhood match scores lower', (() => {
  const event = { ...baseEvent, neighborhood: 'Harlem' };
  return scoreMatch(event, baseProfile) < scoreMatch(baseEvent, baseProfile);
})());

check('category match adds +2', (() => {
  const noCategory = { ...baseEvent, category: 'theater' };
  return scoreMatch(baseEvent, baseProfile) - scoreMatch(noCategory, baseProfile) === 2;
})());

check('scarcity bonus adds +1', (() => {
  const scarce = { ...baseEvent, scarcity: 'one-night-only' };
  return scoreMatch(scarce, baseProfile) === scoreMatch(baseEvent, baseProfile) + 1;
})());

check('editorial bonus adds +1', (() => {
  const editorial = { ...baseEvent, editorial_signal: true };
  return scoreMatch(editorial, baseProfile) === scoreMatch(baseEvent, baseProfile) + 1;
})());

check('high interestingness scores higher', (() => {
  const boring = { ...baseEvent, interestingness: -2 };
  const exciting = { ...baseEvent, interestingness: 6 };
  return scoreMatch(exciting, baseProfile) > scoreMatch(boring, baseProfile);
})());

// ---- findBestMatch ----
console.log('\nfindBestMatch:');

const events = [
  { id: 'e1', neighborhood: 'Bushwick', category: 'dj', interestingness: 3, scarcity: 'one-night-only', editorial_signal: true },
  { id: 'e2', neighborhood: 'Harlem', category: 'theater', interestingness: 1, scarcity: null, editorial_signal: false },
  { id: 'e3', neighborhood: 'Bushwick', category: 'live_music', interestingness: 4, scarcity: null, editorial_signal: false },
];

const profile = {
  neighborhoods: { Bushwick: 5 },
  categories: { dj: 4 },
  sessionCount: 3,
};

check('returns highest scoring event', (() => {
  const best = findBestMatch(events, profile, []);
  return best?.id === 'e1';
})());

check('excludes already-recommended events', (() => {
  const best = findBestMatch(events, profile, ['e1']);
  return best?.id === 'e3';
})());

check('returns null if nothing clears threshold', (() => {
  const lowProfile = { neighborhoods: {}, categories: {}, sessionCount: 1 };
  const weakEvents = [{ id: 'w1', neighborhood: 'Harlem', category: 'theater', interestingness: -2, scarcity: null, editorial_signal: false }];
  return findBestMatch(weakEvents, lowProfile, []) === null;
})());

check('returns null for empty events', findBestMatch([], profile, []) === null);

// ---- exports ----
console.log('\nexports:');
check('composeProactiveMessage exported', typeof composeProactiveMessage === 'function');
check('processProactiveMessages exported', typeof processProactiveMessages === 'function');
