/**
 * scrape-guard.js — No-op stub. Auto-quarantine removed during hypothesis focus.
 * source-health.js is also stubbed, so there's no history to compare against.
 */

const MIN_HISTORY = 3;

function getBaselineStats() { return null; }
function checkBaseline() { return { quarantined: false, reason: null }; }

module.exports = { checkBaseline, getBaselineStats, MIN_HISTORY };
