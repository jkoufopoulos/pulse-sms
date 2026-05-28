/**
 * POST a single message to agent-Pulse's /api/sms/test endpoint and return
 * the captured SMS messages + trace summary.
 *
 * Requires pulse-sms to be running on port 3000 with PULSE_TEST_MODE=true.
 */

const TEST_URL = 'http://localhost:3000/api/sms/test';
const TIMEOUT_MS = 30000;

async function callAgent(message, { phone = '+15550001234', timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(TEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Body: message, From: phone }),
      signal: ctl.signal,
    });
    const json = await res.json().catch(() => ({ error: 'non-JSON response', status: res.status }));
    if (!res.ok) {
      return { error: json.error || `HTTP ${res.status}`, messages: json.messages || [] };
    }
    return json;
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callAgent };
