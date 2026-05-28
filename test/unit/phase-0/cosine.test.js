const test = require('node:test');
const assert = require('node:assert');
const { cosine } = require('../../../scripts/phase-0/cosine.js');

test('cosine: identical vectors return 1.0', () => {
  const a = [1, 2, 3];
  assert.strictEqual(cosine(a, a), 1);
});

test('cosine: opposite vectors return -1', () => {
  const a = [1, 2, 3];
  const b = [-1, -2, -3];
  assert.ok(Math.abs(cosine(a, b) - -1) < 1e-9);
});

test('cosine: orthogonal vectors return 0', () => {
  const a = [1, 0];
  const b = [0, 1];
  assert.strictEqual(cosine(a, b), 0);
});

test('cosine: handles unit-length input correctly', () => {
  const a = [0.6, 0.8];   // unit vector
  const b = [0.8, 0.6];   // unit vector
  // dot product = 0.48 + 0.48 = 0.96
  assert.ok(Math.abs(cosine(a, b) - 0.96) < 1e-9);
});

test('cosine: works on 3072-dim arrays (Gemini embeddings)', () => {
  const a = new Array(3072).fill(0.01);
  const b = new Array(3072).fill(0.01);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9);
});
