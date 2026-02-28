/**
 * Lightweight extraction input capture — standalone module to avoid circular deps.
 * Sources write here before calling extractEvents().
 * events.js reads and clears here during refreshCache().
 */

let extractionInputs = {};

function captureExtractionInput(sourceName, rawText, sourceUrl) {
  const existing = extractionInputs[sourceName];
  if (existing) {
    // Append — sources like Nonsense NYC and Yutori process multiple chunks
    existing.rawText += '\n---\n' + rawText;
    existing.timestamp = new Date().toISOString();
  } else {
    extractionInputs[sourceName] = { rawText, sourceUrl, timestamp: new Date().toISOString() };
  }
}

function getExtractionInputs() {
  return { ...extractionInputs };
}

function clearExtractionInputs() {
  extractionInputs = {};
}

module.exports = { captureExtractionInput, getExtractionInputs, clearExtractionInputs };
