/**
 * BM25 — pure-function implementation, no external dependencies.
 * Reusable in Phase A (will be copied into pulse-rag-hybrid/src/retrieval/).
 *
 * Standard formula: k1=1.2, b=0.75, smoothed-positive IDF.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'in', 'on', 'at', 'for',
  'of', 'to', 'with', 'is', 'it',
]);

function tokenize(s) {
  if (!s) return [];
  const matches = s.toLowerCase().match(/\w+/g) || [];
  return matches.filter(t => !STOPWORDS.has(t) && t.length > 1);
}

function buildBm25(docs, opts = {}) {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;

  const N = docs.length;
  const tokens = docs.map(tokenize);
  const docLens = tokens.map(t => t.length);
  const avgDl = docLens.length === 0
    ? 0
    : docLens.reduce((s, x) => s + x, 0) / N;

  // Document frequency per term (how many docs contain it).
  const df = new Map();
  for (const toks of tokens) {
    for (const t of new Set(toks)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  // IDF per term, smoothed so it stays positive.
  const idf = new Map();
  for (const [term, dfreq] of df) {
    idf.set(term, Math.log((N - dfreq + 0.5) / (dfreq + 0.5) + 1));
  }

  // Term frequency per document (precomputed for speed).
  const tfPerDoc = tokens.map(toks => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  });

  function score(queryTokens, docIdx) {
    let s = 0;
    for (const q of queryTokens) {
      const tf = tfPerDoc[docIdx].get(q) || 0;
      if (tf === 0) continue;
      const i = idf.get(q) || 0;
      const dl = docLens[docIdx];
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + b * (dl / (avgDl || 1)));
      s += i * (num / den);
    }
    return s;
  }

  return { score, tokenize, idf, df, avgDl, docLens };
}

module.exports = { buildBm25, tokenize, STOPWORDS };
