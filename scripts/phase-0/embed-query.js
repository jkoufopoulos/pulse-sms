/**
 * Embed a single query string via Gemini gemini-embedding-001.
 * Uses RETRIEVAL_QUERY task type (vs RETRIEVAL_DOCUMENT for the cards).
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

async function embedQuery(text, { apiKey } = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not provided');

  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
    }),
  });
  if (!res.ok) {
    throw new Error(`embed-query failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.embedding.values;
}

module.exports = { embedQuery };
