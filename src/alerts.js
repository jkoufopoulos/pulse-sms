// Email alerts for source health failures via Resend API
// No npm dependencies — uses native fetch
// Gracefully no-ops if RESEND_API_KEY is not set

const ALERT_EMAIL = process.env.ALERT_EMAIL || 'jkoufopoulos@gmail.com';
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours — avoid spamming on repeated scrapes

let lastAlertSent = 0;

async function sendHealthAlert(failures, scrapeStats) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[ALERT] RESEND_API_KEY not set — skipping email alert');
    return;
  }

  if (failures.length === 0) return;

  // Cooldown: don't send more than once per 6 hours
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
      lastAlertSent = Date.now();
      console.log(`[ALERT] Health alert sent to ${ALERT_EMAIL}`);
    } else {
      const err = await res.text();
      console.error(`[ALERT] Resend API error: ${res.status} ${err}`);
    }
  } catch (err) {
    console.error(`[ALERT] Email send failed:`, err.message);
  }
}

// --- Runtime alerts (slow responses, errors) ---
const _runtimeCooldowns = new Map(); // alertType → timestamp
const RUNTIME_COOLDOWN_MS = 30 * 60 * 1000; // 30 min per alert type

async function sendRuntimeAlert(alertType, details) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[ALERT] RESEND_API_KEY not set — skipping email alert');
    return;
  }

  const lastSent = _runtimeCooldowns.get(alertType) || 0;
  if (Date.now() - lastSent < RUNTIME_COOLDOWN_MS) return;

  const subject = `Pulse: ${alertType}`;
  const body = Object.entries(details)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

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
      _runtimeCooldowns.set(alertType, Date.now());
      console.log(`[ALERT] Runtime alert "${alertType}" sent to ${ALERT_EMAIL}`);
    } else {
      const err = await res.text();
      console.error(`[ALERT] Resend API error: ${res.status} ${err}`);
    }
  } catch (err) {
    console.error(`[ALERT] Runtime alert send failed:`, err.message);
  }
}

module.exports = { sendHealthAlert, sendRuntimeAlert, _runtimeCooldowns };
