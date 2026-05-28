const test = require('node:test');
const assert = require('node:assert');
const { buildBm25 } = require('../../../scripts/phase-0/bm25.js');

const DOCS = [
  'trivia night at northern bell williamsburg free pub',  // doc 0
  'brooklyn music kitchen open mic clinton hill live',     // doc 1
  'blind brunch date ladies in brooklyn greenpoint',       // doc 2
  'jazz late night vinyl west village live music',         // doc 3
];

test('BM25: tokenize lowercases and strips stopwords', () => {
  const bm = buildBm25(DOCS);
  const tokens = bm.tokenize('Brooklyn Date Night');
  assert.deepStrictEqual(tokens, ['brooklyn', 'date', 'night']);
});

test('BM25: tokenize drops stopwords from list', () => {
  const bm = buildBm25(DOCS);
  const tokens = bm.tokenize('the brooklyn and a date');
  assert.deepStrictEqual(tokens, ['brooklyn', 'date']);
});

test('BM25: IDF higher for rare terms', () => {
  const bm = buildBm25(DOCS);
  // "brooklyn" appears in 2 of 4 docs; "vinyl" appears in 1 of 4
  // therefore IDF(vinyl) > IDF(brooklyn)
  const idfBrooklyn = bm.idf.get('brooklyn');
  const idfVinyl = bm.idf.get('vinyl');
  assert.ok(idfVinyl > idfBrooklyn, `expected idf(vinyl)=${idfVinyl} > idf(brooklyn)=${idfBrooklyn}`);
});

test('BM25: scoring ranks doc with rare-term match higher', () => {
  const bm = buildBm25(DOCS);
  const qTokens = bm.tokenize('brooklyn date');
  const scores = DOCS.map((_, i) => bm.score(qTokens, i));
  // doc 2 has BOTH "brooklyn" AND "date"; doc 1 has only "brooklyn"
  assert.ok(scores[2] > scores[1], `doc 2 score ${scores[2]} should beat doc 1 score ${scores[1]}`);
});

test('BM25: doc with no query tokens scores 0', () => {
  const bm = buildBm25(DOCS);
  const qTokens = bm.tokenize('jazz vinyl');
  const score = bm.score(qTokens, 0);  // doc 0 has neither
  assert.strictEqual(score, 0);
});

test('BM25: top-K ordering matches scores', () => {
  const bm = buildBm25(DOCS);
  const qTokens = bm.tokenize('brooklyn');
  const ranked = DOCS
    .map((_, i) => ({ i, score: bm.score(qTokens, i) }))
    .sort((a, b) => b.score - a.score);
  // docs with "brooklyn" should come first (indices 1 and 2)
  assert.ok([1, 2].includes(ranked[0].i));
  assert.ok([1, 2].includes(ranked[1].i));
});
