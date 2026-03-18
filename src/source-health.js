/**
 * source-health.js — No-op stub. Auto-quarantine removed during hypothesis focus.
 * Provides the same API surface so events.js doesn't need surgery.
 */

const sourceHealth = {};

module.exports = {
  sourceHealth,
  saveHealthData() {},
  updateSourceHealth() {},
  updateScrapeStats() {},
  computeEventMix(events) {
    const mix = {};
    for (const e of events) {
      const cat = e.category || 'other';
      mix[cat] = (mix[cat] || 0) + 1;
    }
    return mix;
  },
  getHealthStatus() { return { sources: {} }; },
  isSourceDisabled() { return false; },
  shouldProbeDisabled() { return false; },
};
