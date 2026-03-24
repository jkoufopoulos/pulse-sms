/**
 * alerts.js — Email alerts via Resend.
 * Sends operational alerts (scrape success/failure, critical errors).
 * No-ops gracefully when RESEND_API_KEY or ALERT_EMAIL are not set.
 */

async function sendRuntimeAlert(type, data) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!apiKey || !to) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(apiKey);
    const subject = `[Pulse] ${type}`;
    const body = Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n');

    await resend.emails.send({
      from: 'Pulse <alerts@updates.jkoufopoulos.com>',
      to,
      subject,
      text: body,
    });
    console.log(`[ALERT] Sent ${type} to ${to}`);
  } catch (err) {
    console.error(`[ALERT] Failed to send ${type}:`, err.message);
  }
}

module.exports = {
  sendRuntimeAlert,
  sendGraduatedAlert() { return Promise.resolve(); },
  loadAlerts() {},
  getRecentAlerts() { return []; },
};
