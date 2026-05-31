// test/unit/eval-matcher.test.js
const { check } = require('../helpers');
const { match } = require('../../src/eval/carryover/matcher');

console.log('\n--- eval-matcher.test.js ---');

// --- exact primitive match ---
check('string equal passes', match('a', 'a').passed === true);
check('string mismatch fails', match('a', 'b').passed === false);
check('mismatch reports path and values', match('a', 'b').mismatches[0].path === '' && match('a', 'b').mismatches[0].expected === 'a');
check('number equal passes', match(7, 7).passed === true);

// --- $present ---
check('$present passes on truthy', match({ $present: true }, 'williamsburg').passed === true);
check('$present passes on 0 (defined-not-null)', match({ $present: true }, 0).passed === true);
check('$present fails on undefined', match({ $present: true }, undefined).passed === false);
check('$present fails on null', match({ $present: true }, null).passed === false);

// --- $absent ---
check('$absent passes on undefined', match({ $absent: true }, undefined).passed === true);
check('$absent passes on null', match({ $absent: true }, null).passed === true);
check('$absent fails on value', match({ $absent: true }, 'williamsburg').passed === false);

// --- $regex ---
check('$regex passes', match({ $regex: '^2[0-3]:' }, '22:30').passed === true);
check('$regex fails', match({ $regex: '^2[0-3]:' }, '08:00').passed === false);

// --- $in ---
check('$in passes', match({ $in: ['comedy', 'music'] }, 'comedy').passed === true);
check('$in fails', match({ $in: ['comedy', 'music'] }, 'art').passed === false);

// --- $contains ---
check('$contains passes', match({ $contains: 'comedy' }, ['comedy', 'music']).passed === true);
check('$contains fails when not in array', match({ $contains: 'art' }, ['comedy', 'music']).passed === false);
check('$contains fails when not array', match({ $contains: 'comedy' }, 'comedy').passed === false);

// --- $absent_or_empty ---
check('$absent_or_empty passes on undefined', match({ $absent_or_empty: true }, undefined).passed === true);
check('$absent_or_empty passes on []', match({ $absent_or_empty: true }, []).passed === true);
check('$absent_or_empty fails on non-empty array', match({ $absent_or_empty: true }, ['comedy']).passed === false);

// --- partial object match ---
const actual = { neighborhood: 'williamsburg', filters: { categories: ['comedy'], free_only: true }, intent: 'discover' };
check('partial object match passes when subset matches',
  match({ neighborhood: 'williamsburg', intent: 'discover' }, actual).passed === true);
check('keys not in expected are ignored',
  match({ neighborhood: 'williamsburg' }, actual).passed === true);
check('nested mismatch reports nested path',
  match({ filters: { free_only: false } }, actual).mismatches[0].path === 'filters.free_only');

// --- nested $contains in filters ---
check('nested $contains passes',
  match({ filters: { categories: { $contains: 'comedy' } } }, actual).passed === true);
check('nested $contains fails',
  match({ filters: { categories: { $contains: 'jazz' } } }, actual).passed === false);

// --- nested $absent on missing nested key ---
check('nested $absent passes when key missing',
  match({ filters: { time_after: { $absent: true } } }, actual).passed === true);
