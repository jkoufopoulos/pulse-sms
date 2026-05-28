const test = require('node:test');
const assert = require('node:assert');
const { hybridRetrieve, buildIndex } = require('../../../scripts/phase-0/hybrid-retrieve.js');

const EVENTS = [
  { id: 'a', name: 'Trivia Night', venue_name: 'Bell', neighborhood: 'Williamsburg', category: 'trivia', short_detail: 'pub trivia' },
  { id: 'b', name: 'Comedy Show',  venue_name: 'Club', neighborhood: 'LES',          category: 'comedy', short_detail: 'standup' },
  { id: 'c', name: 'Jazz Night',   venue_name: 'Cellar', neighborhood: 'West Village', category: 'live_music', short_detail: 'jazz quartet' },
];

// 3 fake vectors (dim=4 for testability)
// query vector close to event 'c' (jazz)
const VECTORS = {
  a: [0.1, 0.1, 0.1, 0.9],
  b: [0.1, 0.9, 0.1, 0.1],
  c: [0.9, 0.1, 0.1, 0.1],
};
const QUERY_VEC = [0.85, 0.15, 0.1, 0.1];  // closest to c

test('buildIndex: produces { cards, eventIds, bm25 }', () => {
  const idx = buildIndex(EVENTS);
  assert.strictEqual(idx.cards.length, 3);
  assert.strictEqual(idx.eventIds[0], 'a');
  assert.ok(typeof idx.bm25.score === 'function');
});

test('hybridRetrieve: query "jazz" routes to event c (BM25 dominates lexical match)', () => {
  const idx = buildIndex(EVENTS);
  const results = hybridRetrieve({
    queryText: 'jazz',
    queryVector: [0, 0, 0, 1],  // misleading vector; BM25 should still nail it
    index: idx,
    vectors: VECTORS,
    topK: 3,
    rrfK: 60,
  });
  assert.strictEqual(results[0].id, 'c');
});

test('hybridRetrieve: returns at most topK results', () => {
  const idx = buildIndex(EVENTS);
  const results = hybridRetrieve({
    queryText: 'a vibe',
    queryVector: QUERY_VEC,
    index: idx,
    vectors: VECTORS,
    topK: 2,
    rrfK: 60,
  });
  assert.ok(results.length <= 2);
});

test('hybridRetrieve: each result has { id, rrfScore, bm25Rank, vecRank }', () => {
  const idx = buildIndex(EVENTS);
  const results = hybridRetrieve({
    queryText: 'jazz',
    queryVector: QUERY_VEC,
    index: idx,
    vectors: VECTORS,
    topK: 3,
    rrfK: 60,
  });
  for (const r of results) {
    assert.ok('id' in r);
    assert.ok('rrfScore' in r);
    assert.ok('bm25Rank' in r);
    assert.ok('vecRank' in r);
  }
});
