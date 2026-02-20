/**
 * Lightweight extraction input capture — standalone module to avoid circular deps.
 * Sources write here before calling extractEvents().
 * events.js reads and clears here during refreshCache().
 */

let extractionInputs = {};

function captureExtractionInput(sourceName, rawText, sourceUrl) {
  extractionInputs[sourceName] = { rawText, sourceUrl, timestamp: new Date().toISOString() };
}

function getExtractionInputs() {
  return { ...extractionInputs };
}

function clearExtractionInputs() {
  extractionInputs = {};
}

module.exports = { captureExtractionInput, getExtractionInputs, clearExtractionInputs };
