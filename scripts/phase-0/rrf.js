/**
 * Reciprocal Rank Fusion — merges multiple ranked lists into one.
 *
 * Each input ranking is an array of doc IDs in descending score order.
 * Each doc gets fused_score = sum over rankings of 1 / (k + rank_in_ranking).
 * Standard k = 60 from the original Cormack/Clarke/Buettcher paper.
 */

function rrfFuse(rankings, { k = 60, topK = null } = {}) {
  const scores = new Map();

  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const id = ranking[rank];
      const inc = 1 / (k + rank);
      scores.set(id, (scores.get(id) || 0) + inc);
    }
  }

  const fused = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);

  return topK == null ? fused : fused.slice(0, topK);
}

module.exports = { rrfFuse };
