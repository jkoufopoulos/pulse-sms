/**
 * Content-hash extraction cache — skip LLM extraction when raw content hasn't changed.
 *
 * Computes sha256(nycDateString + rawContent) so the cache auto-invalidates
 * when either the content changes or the NYC date rolls forward.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../data/extraction-hashes.json');

let cache = {};

// Load cache from disk on module init
function loadExtractionCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[EXTRACTION-CACHE] failed to load cache:', err.message);
    cache = {};
  }
  return cache;
}

function saveExtractionCache() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn('[EXTRACTION-CACHE] failed to save cache:', err.message);
  }
}

function computeHash(rawContent) {
  const nycDateString = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  return crypto.createHash('sha256').update(nycDateString + rawContent).digest('hex');
}

/**
 * Check cache for a content match. Returns cached events array on hit, null on miss.
 */
function getCachedExtraction(sourceName, rawContent) {
  const hash = computeHash(rawContent);
  const entry = cache[sourceName];
  if (entry && entry.hash === hash) {
    // Don't reuse empty results — likely a previous extraction failure (LLM truncation)
    if (entry.events.length === 0) {
      console.log(`[EXTRACTION-CACHE] ${sourceName}: skipping cached 0-event result, re-extracting`);
      return null;
    }
    console.log(`[EXTRACTION-CACHE] ${sourceName}: content unchanged, reusing ${entry.events.length} cached events`);
    return entry.events;
  }
  console.log(`[EXTRACTION-CACHE] ${sourceName}: content changed, extracting fresh`);
  return null;
}

/**
 * Store extraction result keyed by source name.
 */
function setCachedExtraction(sourceName, rawContent, events) {
  const hash = computeHash(rawContent);
  cache[sourceName] = {
    hash,
    events,
    timestamp: new Date().toISOString(),
  };
  saveExtractionCache();
}

// Load on require
loadExtractionCache();

module.exports = {
  getCachedExtraction,
  setCachedExtraction,
  loadExtractionCache,
  saveExtractionCache,
  // Exposed for testing
  _computeHash: computeHash,
  _getCache: () => cache,
  _setCache: (c) => { cache = c; },
};
