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

  const subject = `Pulse: ${failures.length} source${failures.length > 1 ? 's' : ''} failing`;

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
        from: 'Pulse Alerts <onboarding@resend.dev>',
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

  const subject = `Pulse: ${alertType}`;
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
        from: 'Pulse Alerts <onboarding@resend.dev>',
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

// --- Daily digest email ---
const DIGEST_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours — one per day
let lastDigestSent = 0;

async function sendDigestEmail(digest) {
  if (Date.now() - lastDigestSent < DIGEST_COOLDOWN_MS) {
    console.log('[DIGEST] Cooldown active — skipping email');
    return;
  }

  const { formatDigestEmail } = require('./daily-digest');
  const subject = `Pulse daily: ${digest.status} — ${digest.cache.total.toLocaleString()} events${digest.needs_attention.length > 0 ? `, ${digest.needs_attention.length} need attention` : ''}`;
  const body = formatDigestEmail(digest);

  const alertEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'digest',
    subject,
    details: { digest_id: digest.id, status: digest.status },
    emailSent: false,
    emailError: null,
  };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    alertEntry.emailError = 'RESEND_API_KEY not set';
    logAlert(alertEntry);
    lastDigestSent = Date.now();
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
        from: 'Pulse Alerts <onboarding@resend.dev>',
        to: ALERT_EMAIL,
        subject,
        text: body,
      }),
    });

    if (res.ok) {
      alertEntry.emailSent = true;
      console.log(`[DIGEST] Email sent: ${subject}`);
      try {
        const { markDigestEmailed } = require('./db');
        markDigestEmailed(digest.id);
      } catch {}
    } else {
      const err = await res.text();
      alertEntry.emailError = `${res.status} ${err}`;
    }
  } catch (err) {
    alertEntry.emailError = err.message;
  }

  logAlert(alertEntry);
  lastDigestSent = Date.now();
}

// --- Graduated alert (yellow/red severity from digest) ---

async function sendGraduatedAlert(digest) {
  if (digest.status === 'green') return;

  const severity = digest.status; // 'yellow' or 'red'
  const prefix = severity === 'red' ? 'ACTION REQUIRED' : 'Needs attention';
  const subject = `Pulse: ${prefix} — ${digest.needs_attention.length} source issue(s)`;

  const lines = [];
  lines.push(`Severity: ${severity.toUpperCase()}`);
  lines.push(`Date: ${digest.id}`);
  lines.push('');

  if (digest.needs_attention.length > 0) {
    for (const item of digest.needs_attention) {
      const marker = item.severity === 'warn' ? '!' : 'i';
      lines.push(`  [${marker}] ${item.source}: ${item.issue}`);
    }
    lines.push('');
  }

  lines.push(`Cache: ${digest.cache.total} events (${digest.cache.change_pct > 0 ? '+' : ''}${digest.cache.change_pct}% vs yesterday)`);

  if (severity === 'red') {
    lines.push('');
    lines.push('Recommended: check source health dashboard at /health');
  }

  const body = lines.join('\n');

  const alertEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'graduated',
    severity,
    subject,
    details: {
      status: digest.status,
      needs_attention: digest.needs_attention,
      cache_total: digest.cache.total,
      cache_change_pct: digest.cache.change_pct,
    },
    emailSent: false,
    emailError: null,
  };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    alertEntry.emailError = 'RESEND_API_KEY not set';
    logAlert(alertEntry);
    console.warn(`[ALERT] Graduated alert (${severity}) logged without email`);
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
        from: 'Pulse Alerts <onboarding@resend.dev>',
        to: ALERT_EMAIL,
        subject,
        text: body,
      }),
    });

    if (res.ok) {
      alertEntry.emailSent = true;
      console.log(`[ALERT] Graduated alert (${severity}) sent to ${ALERT_EMAIL}`);
    } else {
      const err = await res.text();
      alertEntry.emailError = `${res.status} ${err}`;
      console.error(`[ALERT] Resend API error: ${res.status} ${err}`);
    }
  } catch (err) {
    alertEntry.emailError = err.message;
    console.error(`[ALERT] Graduated alert send failed:`, err.message);
  }

  logAlert(alertEntry);
}

module.exports = { sendHealthAlert, sendRuntimeAlert, sendDigestEmail, sendGraduatedAlert, _runtimeCooldowns, loadAlerts, getRecentAlerts };
