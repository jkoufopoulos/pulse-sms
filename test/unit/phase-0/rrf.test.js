const test = require('node:test');
const assert = require('node:assert');
const { rrfFuse } = require('../../../scripts/phase-0/rrf.js');

test('rrfFuse: doc at rank 1 in both rankings beats doc in only one', () => {
  // ranking is an array of doc IDs in descending score order
  const bm = ['a', 'b', 'c'];
  const vec = ['a', 'd', 'e'];
  const fused = rrfFuse([bm, vec], { k: 60 });
  // 'a' appears at rank 0 in both → highest RRF
  assert.strictEqual(fused[0].id, 'a');
});

test('rrfFuse: doc in only one ranking still ranks if other docs have weak presence', () => {
  const bm = ['a', 'b', 'c'];
  const vec = ['d', 'e', 'f'];
  const fused = rrfFuse([bm, vec], { k: 60 });
  // first 6 docs each contribute 1/(60+rank); fused has 6 unique entries
  assert.strictEqual(fused.length, 6);
  // 'a' and 'd' both appear at rank 0 → tied at top
  assert.ok(['a', 'd'].includes(fused[0].id));
});

test('rrfFuse: known RRF math — score = sum of 1/(k+rank) across methods', () => {
  const bm = ['x'];
  const vec = ['x'];
  const fused = rrfFuse([bm, vec], { k: 60 });
  // x appears at rank 0 in both methods: score = 1/60 + 1/60
  const expected = (1 / 60) + (1 / 60);
  assert.ok(Math.abs(fused[0].score - expected) < 1e-9);
});

test('rrfFuse: empty rankings return empty', () => {
  const fused = rrfFuse([[], []], { k: 60 });
  assert.strictEqual(fused.length, 0);
});

test('rrfFuse: respects top-k limit if provided', () => {
  const bm = ['a', 'b', 'c', 'd', 'e'];
  const vec = ['a', 'b', 'c', 'd', 'e'];
  const fused = rrfFuse([bm, vec], { k: 60, topK: 3 });
  assert.strictEqual(fused.length, 3);
});
