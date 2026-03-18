/**
 * source-health.js — No-op stub. Auto-quarantine removed during hypothesis focus.
 * Provides the same API surface so events.js doesn't need surgery.
 */

// Proxy that auto-creates entries so sourceHealth[label].anything = x never crashes
const sourceHealth = new Proxy({}, {
  get(target, prop) {
    if (!(prop in target)) target[prop] = {};
    return target[prop];
  }
});

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
