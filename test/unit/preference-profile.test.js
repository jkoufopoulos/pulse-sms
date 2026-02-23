const { check } = require('../helpers');
const {
  getProfile,
  updateProfile,
  deriveFiltersFromProfile,
  getTopNeighborhood,
  getTopCategories,
  exportProfiles,
  hashPhone,
  _resetForTest,
} = require('../../src/preference-profile');

// Reset state before tests
_resetForTest();

console.log('\npreference-profile:');

// ---- getProfile ----
console.log('\ngetProfile:');

const blank = getProfile('+12125550001');
check('unknown user returns blank profile', blank.sessionCount === 0);
check('blank has empty neighborhoods', Object.keys(blank.neighborhoods).length === 0);
check('blank has empty categories', Object.keys(blank.categories).length === 0);
check('blank pricePreference is any', blank.pricePreference === 'any');
check('blank timePreference is any', blank.timePreference === 'any');
check('blank createdAt is null', blank.createdAt === null);

// ---- updateProfile with event_picks ----
console.log('\nupdateProfile (event_picks):');

async function runAsyncTests() {
  _resetForTest();

  const phone = '+12125550010';
  await updateProfile(phone, {
    neighborhood: 'williamsburg',
    filters: { category: 'live_music', subcategory: 'jazz' },
    responseType: 'event_picks',
  });

  const p1 = getProfile(phone);
  check('sessionCount incremented', p1.sessionCount === 1);
  check('neighborhood tracked', p1.neighborhoods.williamsburg === 1);
  check('category tracked', p1.categories.live_music === 1);
  check('subcategory tracked', p1.subcategories.jazz === 1);
  check('totalPicksSessionCount incremented', p1.totalPicksSessionCount === 1);
  check('createdAt set', p1.createdAt !== null);
  check('lastActiveDate set', p1.lastActiveDate !== null);

  // ---- updateProfile with conversational ----
  console.log('\nupdateProfile (conversational):');

  const convPhone = '+12125550011';
  await updateProfile(convPhone, {
    neighborhood: 'bushwick',
    filters: { category: 'comedy' },
    responseType: 'conversational',
  });

  const p2 = getProfile(convPhone);
  check('conversational: sessionCount incremented', p2.sessionCount === 1);
  check('conversational: neighborhood NOT tracked', (p2.neighborhoods.bushwick || 0) === 0);
  check('conversational: category NOT tracked', (p2.categories.comedy || 0) === 0);
  check('conversational: totalPicksSessionCount stays 0', p2.totalPicksSessionCount === 0);

  // ---- updateProfile with ask_neighborhood ----
  console.log('\nupdateProfile (ask_neighborhood):');

  const askPhone = '+12125550012';
  await updateProfile(askPhone, {
    neighborhood: null,
    filters: {},
    responseType: 'ask_neighborhood',
  });

  const p3 = getProfile(askPhone);
  check('ask_neighborhood: sessionCount incremented', p3.sessionCount === 1);
  check('ask_neighborhood: totalPicksSessionCount stays 0', p3.totalPicksSessionCount === 0);

  // ---- Multiple updates compound correctly ----
  console.log('\ncompounding updates:');

  const multiPhone = '+12125550013';
  await updateProfile(multiPhone, { neighborhood: 'east_village', filters: { subcategory: 'jazz' }, responseType: 'event_picks' });
  await updateProfile(multiPhone, { neighborhood: 'east_village', filters: { subcategory: 'jazz' }, responseType: 'event_picks' });
  await updateProfile(multiPhone, { neighborhood: 'west_village', filters: { subcategory: 'jazz' }, responseType: 'event_picks' });

  const p4 = getProfile(multiPhone);
  check('3 sessions → sessionCount 3', p4.sessionCount === 3);
  check('east_village count 2', p4.neighborhoods.east_village === 2);
  check('west_village count 1', p4.neighborhoods.west_village === 1);
  check('jazz subcategory count 3', p4.subcategories.jazz === 3);
  check('totalPicksSessionCount 3', p4.totalPicksSessionCount === 3);

  // ---- pricePreference derives to 'free' ----
  console.log('\npricePreference derivation:');

  const freePhone = '+12125550014';
  await updateProfile(freePhone, { neighborhood: 'les', filters: { free_only: true }, responseType: 'event_picks' });
  await updateProfile(freePhone, { neighborhood: 'les', filters: { free_only: true }, responseType: 'event_picks' });
  await updateProfile(freePhone, { neighborhood: 'les', filters: {}, responseType: 'event_picks' });

  const p5 = getProfile(freePhone);
  check('free 2/3 sessions → free preference', p5.pricePreference === 'free');

  const paidPhone = '+12125550015';
  await updateProfile(paidPhone, { neighborhood: 'les', filters: { free_only: true }, responseType: 'event_picks' });
  await updateProfile(paidPhone, { neighborhood: 'les', filters: {}, responseType: 'event_picks' });
  await updateProfile(paidPhone, { neighborhood: 'les', filters: {}, responseType: 'event_picks' });

  const p6 = getProfile(paidPhone);
  check('free 1/3 sessions → any preference', p6.pricePreference === 'any');

  // ---- timePreference derivation ----
  console.log('\ntimePreference derivation:');

  const latePhone = '+12125550016';
  await updateProfile(latePhone, { neighborhood: 'bushwick', filters: { time_after: '22:00' }, responseType: 'event_picks' });
  await updateProfile(latePhone, { neighborhood: 'bushwick', filters: { time_after: '23:00' }, responseType: 'event_picks' });
  await updateProfile(latePhone, { neighborhood: 'bushwick', filters: { time_after: '18:00' }, responseType: 'event_picks' });

  const p7 = getProfile(latePhone);
  check('late 2/3 timed sessions → late preference', p7.timePreference === 'late');

  const earlyPhone = '+12125550017';
  await updateProfile(earlyPhone, { neighborhood: 'bushwick', filters: { time_after: '18:00' }, responseType: 'event_picks' });
  await updateProfile(earlyPhone, { neighborhood: 'bushwick', filters: { time_after: '19:00' }, responseType: 'event_picks' });
  await updateProfile(earlyPhone, { neighborhood: 'bushwick', filters: { time_after: '23:00' }, responseType: 'event_picks' });

  const p8 = getProfile(earlyPhone);
  check('early 2/3 timed sessions → early preference', p8.timePreference === 'early');

  const noTimePhone = '+12125550018';
  await updateProfile(noTimePhone, { neighborhood: 'bushwick', filters: {}, responseType: 'event_picks' });

  const p9 = getProfile(noTimePhone);
  check('no time filters → any preference', p9.timePreference === 'any');

  // Invalid time_after format should not count
  const badTimePhone = '+12125550019';
  await updateProfile(badTimePhone, { neighborhood: 'bushwick', filters: { time_after: 'late' }, responseType: 'event_picks' });
  const p9b = getProfile(badTimePhone);
  check('invalid time_after format → timedSessionCount stays 0', p9b.timedSessionCount === 0);

  // ---- deriveFiltersFromProfile ----
  console.log('\nderiveFiltersFromProfile:');

  const emptyDerived = deriveFiltersFromProfile(blankProfile());
  check('blank profile → empty filters', Object.keys(emptyDerived).length === 0);

  const nullDerived = deriveFiltersFromProfile(null);
  check('null profile → empty filters', Object.keys(nullDerived).length === 0);

  // Build a profile with known signals
  const derivedPhone = '+12125550020';
  await updateProfile(derivedPhone, { neighborhood: 'bushwick', filters: { category: 'comedy' }, responseType: 'event_picks' });
  await updateProfile(derivedPhone, { neighborhood: 'bushwick', filters: { category: 'comedy' }, responseType: 'event_picks' });
  await updateProfile(derivedPhone, { neighborhood: 'bushwick', filters: { category: 'live_music' }, responseType: 'event_picks' });

  const derivedProfile = getProfile(derivedPhone);
  const derived = deriveFiltersFromProfile(derivedProfile);
  check('derives top category as filter', derived.category === 'comedy');

  // Free preference derivation
  const derivedFreePhone = '+12125550021';
  await updateProfile(derivedFreePhone, { neighborhood: 'les', filters: { free_only: true }, responseType: 'event_picks' });
  await updateProfile(derivedFreePhone, { neighborhood: 'les', filters: { free_only: true }, responseType: 'event_picks' });
  const derivedFree = deriveFiltersFromProfile(getProfile(derivedFreePhone));
  check('free preference → free_only in derived', derivedFree.free_only === true);

  // Late time derivation
  const derivedLatePhone = '+12125550022';
  await updateProfile(derivedLatePhone, { neighborhood: 'bushwick', filters: { time_after: '22:00' }, responseType: 'event_picks' });
  await updateProfile(derivedLatePhone, { neighborhood: 'bushwick', filters: { time_after: '23:00' }, responseType: 'event_picks' });
  const derivedLate = deriveFiltersFromProfile(getProfile(derivedLatePhone));
  check('late preference → time_after in derived', derivedLate.time_after === '21:00');

  // No signal → null dimensions
  const minimalPhone = '+12125550023';
  await updateProfile(minimalPhone, { neighborhood: 'bushwick', filters: {}, responseType: 'event_picks' });
  const minimalDerived = deriveFiltersFromProfile(getProfile(minimalPhone));
  check('no category signal → no category filter', minimalDerived.category === undefined);
  check('no free signal → no free_only', minimalDerived.free_only === undefined);
  check('no time signal → no time_after', minimalDerived.time_after === undefined);

  // ---- getTopNeighborhood ----
  console.log('\ngetTopNeighborhood:');

  check('null profile → null', getTopNeighborhood(null) === null);
  check('blank profile → null', getTopNeighborhood(blankProfile()) === null);
  check('multi profile → highest count', getTopNeighborhood(getProfile(multiPhone)) === 'east_village');

  // ---- getTopCategories ----
  console.log('\ngetTopCategories:');

  check('null profile → empty', getTopCategories(null).length === 0);

  const catPhone = '+12125550024';
  await updateProfile(catPhone, { neighborhood: 'les', filters: { category: 'comedy' }, responseType: 'event_picks' });
  await updateProfile(catPhone, { neighborhood: 'les', filters: { category: 'comedy' }, responseType: 'event_picks' });
  await updateProfile(catPhone, { neighborhood: 'les', filters: { category: 'live_music', subcategory: 'jazz' }, responseType: 'event_picks' });
  await updateProfile(catPhone, { neighborhood: 'les', filters: { category: 'live_music', subcategory: 'jazz' }, responseType: 'event_picks' });
  await updateProfile(catPhone, { neighborhood: 'les', filters: { category: 'nightlife' }, responseType: 'event_picks' });

  const topCats = getTopCategories(getProfile(catPhone), 3);
  check('top categories returns array', Array.isArray(topCats));
  check('top categories length capped at n', topCats.length <= 3);
  check('top categories includes comedy', topCats.includes('comedy'));
  check('top categories includes jazz (from subcategories)', topCats.includes('jazz'));

  // ---- updateProfile with 'more' responseType ----
  console.log('\nupdateProfile (more):');

  const morePhone = '+12125550025';
  await updateProfile(morePhone, { neighborhood: 'williamsburg', filters: { category: 'comedy' }, responseType: 'more' });

  const pm = getProfile(morePhone);
  check('more: sessionCount incremented', pm.sessionCount === 1);
  check('more: neighborhood tracked', pm.neighborhoods.williamsburg === 1);
  check('more: category tracked', pm.categories.comedy === 1);
  check('more: totalPicksSessionCount incremented', pm.totalPicksSessionCount === 1);

  // ---- Phone validation ----
  console.log('\nphone validation:');

  let threw = false;
  try {
    await updateProfile(null, { responseType: 'event_picks' });
  } catch {
    threw = true;
  }
  check('null phone does not throw', !threw);

  await updateProfile('', { neighborhood: 'bushwick', filters: {}, responseType: 'event_picks' });
  check('empty string phone rejected (no profile created)', getProfile('').sessionCount === 0);

  await updateProfile('not-a-phone', { neighborhood: 'bushwick', filters: {}, responseType: 'event_picks' });
  check('invalid format rejected', getProfile('not-a-phone').sessionCount === 0);

  await updateProfile('12125550099', { neighborhood: 'bushwick', filters: {}, responseType: 'event_picks' });
  check('missing + prefix rejected', getProfile('12125550099').sessionCount === 0);

  // Valid E.164 should work
  const validPhone = '+12125550099';
  await updateProfile(validPhone, { neighborhood: 'bushwick', filters: {}, responseType: 'event_picks' });
  check('valid E.164 accepted', getProfile(validPhone).sessionCount === 1);

  // ---- Test phone exclusion ----
  console.log('\ntest phone exclusion:');

  const testPhone = '+10000000000';
  await updateProfile(testPhone, { neighborhood: 'bushwick', filters: { category: 'comedy' }, responseType: 'event_picks' });
  check('default test phone rejected', getProfile(testPhone).sessionCount === 0);

  const testPhone2 = '+10000001234';
  await updateProfile(testPhone2, { neighborhood: 'les', filters: {}, responseType: 'event_picks' });
  check('test prefix phone rejected', getProfile(testPhone2).sessionCount === 0);

  // ---- Phone hashing ----
  console.log('\nphone hashing:');

  check('hashPhone returns string', typeof hashPhone('+12125550001') === 'string');
  check('hashPhone is 16 chars', hashPhone('+12125550001').length === 16);
  check('hashPhone is deterministic', hashPhone('+12125550001') === hashPhone('+12125550001'));
  check('different phones → different hashes', hashPhone('+12125550001') !== hashPhone('+12125550002'));

  // ---- Persistence round-trip ----
  console.log('\npersistence:');

  const exported = exportProfiles();
  check('export returns object', typeof exported === 'object');
  check('export contains test profiles', Object.keys(exported).length > 0);
  check('exported profile has correct sessionCount', exported[phone]?.sessionCount === 1);

  // Verify test phones are not in exported data
  const hasTestPhone = Object.keys(exported).some(k => k.startsWith('+1000000'));
  check('no test phones in exported data', !hasTestPhone);

  // Clean up
  _resetForTest();
}

function blankProfile() {
  return {
    neighborhoods: {},
    categories: {},
    subcategories: {},
    sessionCount: 0,
    pricePreference: 'any',
    timePreference: 'any',
    freeSessionCount: 0,
    totalPicksSessionCount: 0,
    lateTimeCount: 0,
    earlyTimeCount: 0,
    timedSessionCount: 0,
    lastActiveDate: null,
    createdAt: null,
    proactiveOptIn: false,
    proactiveOptInDate: null,
    proactiveOptInPromptedAt: null,
  };
}

module.exports = { runAsync: runAsyncTests };
