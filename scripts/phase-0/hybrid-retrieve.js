/**
 * Hybrid retrieval — fuses BM25 (lexical) and cosine (dense) rankings via RRF.
 * Given a query (text + vector) and an index, returns top-K events with
 * provenance (which method ranked them where).
 */

const { buildBm25 } = require('./bm25');
const { buildCard } = require('./event-cards');
const { cosine } = require('./cosine');
const { rrfFuse } = require('./rrf');

function buildIndex(events) {
  const cards = events.map(buildCard);
  const eventIds = events.map(e => e.id);
  const bm25 = buildBm25(cards);
  return { cards, eventIds, bm25, events };
}

function hybridRetrieve({
  queryText, queryVector, index, vectors,
  topK = 10, rrfK = 60, candidatePool = 50,
}) {
  const { bm25, eventIds } = index;

  // BM25 ranking
  const qTokens = bm25.tokenize(queryText);
  const bm25Scored = eventIds.map((id, i) => ({
    id, score: bm25.score(qTokens, i),
  }));
  const bm25Ranked = bm25Scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, candidatePool);
  const bm25Ranking = bm25Ranked.map(r => r.id);
  const bm25Rank = new Map(bm25Ranking.map((id, i) => [id, i]));

  // Dense ranking
  const vecScored = eventIds
    .filter(id => vectors[id])
    .map(id => ({ id, score: cosine(queryVector, vectors[id]) }));
  const vecRanked = vecScored
    .sort((a, b) => b.score - a.score)
    .slice(0, candidatePool);
  const vecRanking = vecRanked.map(r => r.id);
  const vecRank = new Map(vecRanking.map((id, i) => [id, i]));

  // RRF fuse
  const fused = rrfFuse([bm25Ranking, vecRanking], { k: rrfK, topK });

  return fused.map(({ id, score }) => ({
    id,
    rrfScore: score,
    bm25Rank: bm25Rank.has(id) ? bm25Rank.get(id) + 1 : null,
    vecRank: vecRank.has(id) ? vecRank.get(id) + 1 : null,
  }));
}

module.exports = { hybridRetrieve, buildIndex };
