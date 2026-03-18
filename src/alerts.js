/**
 * alerts.js — No-op stub. Alert system removed during hypothesis focus.
 */

module.exports = {
  sendRuntimeAlert() {},
  sendGraduatedAlert() { return Promise.resolve(); },
  loadAlerts() {},
  getRecentAlerts() { return []; },
};
