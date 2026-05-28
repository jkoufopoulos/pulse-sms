const twilio = require('twilio');

let client = null;

function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

function maskPhone(phone) {
  if (!phone || phone.length < 4) return '****';
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}

// Test capture mode — per-phone capture so concurrent test requests don't bleed.
// Optional onCapture callback fires inline with sendSMS so the test endpoint
// can stream messages to the client as they happen instead of batching.
const _testCaptures = new Map(); // phone → { messages: [], onCapture: fn|null }

function enableTestCapture(phone, onCapture = null) { _testCaptures.set(phone, { messages: [], onCapture }); }
function disableTestCapture(phone) { const entry = _testCaptures.get(phone); _testCaptures.delete(phone); return entry?.messages || []; }

async function sendSMS(to, body, { maxRetries = 2 } = {}) {
  const capture = _testCaptures.get(to);
  if (capture) {
    const msg = { to, body, timestamp: new Date().toISOString() };
    capture.messages.push(msg);
    if (capture.onCapture) {
      try { capture.onCapture(msg); }
      catch (err) { console.warn(`[TEST] onCapture callback error: ${err.message}`); }
    }
    console.log(`[TEST] Captured SMS to ${maskPhone(to)}: ${body.slice(0, 80)}...`);
    return { sid: 'TEST_' + Date.now() };
  }

  // Safety: block test-phone sends that escaped capture, but allow real inbound users through
  if (process.env.PULSE_TEST_MODE === 'true' && /^\+1(555\d{7}|0{9,})$/.test(to)) {
    console.warn(`[TEST] sendSMS called outside capture for ${maskPhone(to)} — skipping Twilio call`);
    return { sid: 'SKIPPED_TEST_' + Date.now() };
  }

  // Safety: if phone looks like a test phone but capture is disabled, log warning and short-circuit
  if (/^\+1(555\d{7}|0{9,})$/.test(to)) {
    console.warn(`[BUG] sendSMS called for test phone ${maskPhone(to)} without active capture — skipping Twilio call`);
    return { sid: 'SKIPPED_' + Date.now() };
  }

  const masked = maskPhone(to);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const createParams = { body, to };
      if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
        createParams.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
      } else {
        createParams.from = process.env.TWILIO_PHONE_NUMBER;
      }
      const sendPromise = getClient().messages.create(createParams);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('sendSMS timed out after 10s')), 10000)
      );
      const msg = await Promise.race([sendPromise, timeoutPromise]);
      console.log(`SMS sent to ${masked}: ${msg.sid}`);
      return msg;
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
        console.warn(`SMS to ${masked} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`SMS to ${masked} failed after ${maxRetries + 1} attempts: ${err.message}`);
        throw err;
      }
    }
  }
}

module.exports = { sendSMS, maskPhone, enableTestCapture, disableTestCapture };
