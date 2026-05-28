/**
 * Cosine similarity for dense vectors.
 * Returns value in [-1, 1]; 1 = same direction, 0 = orthogonal, -1 = opposite.
 */

function cosine(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

module.exports = { cosine };
