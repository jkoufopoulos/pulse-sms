/**
 * Reciprocal Rank Fusion (RRF) — fuses multiple ranked lists into one.
 *
 * Standard formula: score(d) = sum_r 1 / (k + rank_r(d))
 * where rank is 1-indexed and k is a smoothing constant (default 60).
 */

/**
 * @param {string[][]} rankings  - Array of ranked ID lists (best first)
 * @param {{ k?: number, topK?: number }} opts
 * @returns {{ id: string, score: number }[]}  sorted best-first, length <= topK
 */
function rrfFuse(rankings, opts = {}) {
  const k = opts.k ?? 60;
  const topK = opts.topK ?? Infinity;

  const scores = new Map();

  for (const ranked of rankings) {
    ranked.forEach((id, i) => {
      const rank = i + 1; // 1-indexed
      const contrib = 1 / (k + rank);
      scores.set(id, (scores.get(id) || 0) + contrib);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { rrfFuse };
