// Email alerts for source health failures via Resend API
// No npm dependencies — uses native fetch
// Gracefully no-ops if RESEND_API_KEY is not set
// Persists all alerts to data/alerts.jsonl (append-only)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALERT_EMAIL = process.env.ALERT_EMAIL || 'jkoufopoulos@gmail.com';
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours — avoid spamming on repeated scrapes

const ALERTS_PATH = path.join(__dirname, '../data/alerts.jsonl');
const ALERT_BUFFER_SIZE = 100;
const MAX_ALERT_ENTRIES = 500;

const alertBuffer = [];

let lastAlertSent = 0;

function logAlert(entry) {
  alertBuffer.push(entry);
  if (alertBuffer.length > ALERT_BUFFER_SIZE) {
    alertBuffer.shift();
  }
  try {
    fs.mkdirSync(path.dirname(ALERTS_PATH), { recursive: true });
    fs.appendFileSync(ALERTS_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[ALERT] Failed to write alert log:', err.message);
  }
}

function loadAlerts() {
  try {
    if (!fs.existsSync(ALERTS_PATH)) return;
    const raw = fs.readFileSync(ALERTS_PATH, 'utf8').trim();
    if (!raw) return;
    const lines = raw.split('\n');
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    // Trim file if over cap
    if (entries.length > MAX_ALERT_ENTRIES) {
      const trimmed = entries.slice(-MAX_ALERT_ENTRIES);
      fs.writeFileSync(ALERTS_PATH, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
      console.log(`[ALERT] Trimmed alert log from ${entries.length} to ${trimmed.length} entries`);
      alertBuffer.length = 0;
      alertBuffer.push(...trimmed.slice(-ALERT_BUFFER_SIZE));
    } else {
      alertBuffer.length = 0;
      alertBuffer.push(...entries.slice(-ALERT_BUFFER_SIZE));
    }
    // Restore cooldown timestamps from persisted alerts
    const lastHealth = entries.filter(e => e.type === 'health').pop();
    if (lastHealth) lastAlertSent = new Date(lastHealth.timestamp).getTime();

    const runtimeEntries = entries.filter(e => e.type === 'runtime' && e.alertType);
    for (const e of runtimeEntries.slice(-20)) {
      const ts = new Date(e.timestamp).getTime();
      const existing = _runtimeCooldowns.get(e.alertType) || 0;
      if (ts > existing) _runtimeCooldowns.set(e.alertType, ts);
    }

    console.log(`[ALERT] Loaded ${alertBuffer.length} alerts from disk (health cooldown: ${lastAlertSent ? new Date(lastAlertSent).toISOString() : 'none'}, runtime cooldowns: ${_runtimeCooldowns.size})`);
  } catch (err) {
    console.error('[ALERT] Failed to load alert log:', err.message);
  }
}

function getRecentAlerts(limit = 50) {
  return alertBuffer.slice(-limit).reverse();
}

async function sendHealthAlert(failures, scrapeStats) {
  if (failures.length === 0) return;

  // Cooldown: don't send or log more than once per 6 hours
  if (Date.now() - lastAlertSent < COOLDOWN_MS) {
    console.log(`[ALERT] Cooldown active — skipping (${failures.length} sources failing)`);
    return;
  }

  const subject = `Bestie: ${failures.length} source${failures.length > 1 ? 's' : ''} failing`;

  const lines = failures.map(f =>
    `- ${f.label}: ${f.consecutiveZeros} consecutive zeros` +
    (f.lastError ? ` (${f.lastError})` : '') +
    (f.lastStatus ? ` [${f.lastStatus}]` : '')
  );

  const body = [
    `${failures.length} event source${failures.length > 1 ? 's are' : ' is'} returning 0 events:`,
    '',
    ...lines,
    '',
    `Cache: ${scrapeStats.dedupedEvents} deduped events from ${scrapeStats.sourcesOk} healthy sources`,
    `Failed: ${scrapeStats.sourcesFailed} | Empty: ${scrapeStats.sourcesEmpty}`,
    `Scrape duration: ${scrapeStats.totalDurationMs}ms`,
    `Completed: ${scrapeStats.completedAt}`,
  ].join('\n');

  const alertEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'health',
    subject,
    details: { failures, scrapeStats },
    emailSent: false,
    emailError: null,
  };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    alertEntry.emailError = 'RESEND_API_KEY not set';
    logAlert(alertEntry);
    lastAlertSent = Date.now();
    console.warn('[ALERT] RESEND_API_KEY not set — alert logged without email');
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Bestie Alerts <onboarding@resend.dev>',
        to: ALERT_EMAIL,
        subject,
        text: body,
      }),
    });

    if (res.ok) {
      alertEntry.emailSent = true;
      console.log(`[ALERT] Health alert sent to ${ALERT_EMAIL}`);
    } else {
      const err = await res.text();
      alertEntry.emailError = `${res.status} ${err}`;
      console.error(`[ALERT] Resend API error: ${res.status} ${err}`);
    }
  } catch (err) {
    alertEntry.emailError = err.message;
    console.error(`[ALERT] Email send failed:`, err.message);
  }

  logAlert(alertEntry);
  lastAlertSent = Date.now();
}

// --- Runtime alerts (slow responses, errors) ---
const _runtimeCooldowns = new Map(); // alertType → timestamp
const RUNTIME_COOLDOWN_MS = 30 * 60 * 1000; // 30 min per alert type

async function sendRuntimeAlert(alertType, details) {
  const lastSent = _runtimeCooldowns.get(alertType) || 0;
  if (Date.now() - lastSent < RUNTIME_COOLDOWN_MS) return;

  const subject = `Bestie: ${alertType}`;
  const body = Object.entries(details)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const alertEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'runtime',
    alertType,
    subject,
    details,
    emailSent: false,
    emailError: null,
  };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    alertEntry.emailError = 'RESEND_API_KEY not set';
    logAlert(alertEntry);
    _runtimeCooldowns.set(alertType, Date.now());
    console.warn('[ALERT] RESEND_API_KEY not set — runtime alert logged without email');
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Bestie Alerts <onboarding@resend.dev>',
        to: ALERT_EMAIL,
        subject,
        text: body,
      }),
    });

    if (res.ok) {
      alertEntry.emailSent = true;
      console.log(`[ALERT] Runtime alert "${alertType}" sent to ${ALERT_EMAIL}`);
    } else {
      const err = await res.text();
      alertEntry.emailError = `${res.status} ${err}`;
      console.error(`[ALERT] Resend API error: ${res.status} ${err}`);
    }
  } catch (err) {
    alertEntry.emailError = err.message;
    console.error(`[ALERT] Runtime alert send failed:`, err.message);
  }

  logAlert(alertEntry);
  _runtimeCooldowns.set(alertType, Date.now());
}

module.exports = { sendHealthAlert, sendRuntimeAlert, _runtimeCooldowns, loadAlerts, getRecentAlerts };
