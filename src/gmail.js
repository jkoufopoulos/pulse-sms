const { google } = require('googleapis');

const GMAIL_TIMEOUT_MS = 15_000; // 15s per API call

/**
 * Create an authenticated Gmail API client from env vars.
 * Returns null if credentials are not configured.
 */
function getGmailService() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('[GMAIL] Missing credentials — GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN not set');
    return null;
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2, timeout: GMAIL_TIMEOUT_MS });
}

/**
 * Run a Gmail API call with an AbortController timeout.
 * Google's `timeout` option doesn't always work reliably, so we belt-and-suspenders it.
 */
async function withTimeout(fn, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GMAIL_TIMEOUT_MS);
  const start = Date.now();
  try {
    const result = await fn({ signal: controller.signal });
    console.log(`[GMAIL] ${label} completed in ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`${label} timed out after ${elapsed}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch Yutori agent briefing emails from Gmail.
 * Returns [] if credentials are not configured or on any error.
 *
 * @param {number} sinceHours - Lookback window in hours (default 48)
 * @returns {Promise<Array<{id: string, subject: string, body: string, date: string}>>}
 */
async function fetchYutoriEmails(sinceHours = 48) {
  const gmail = getGmailService();
  if (!gmail) {
    console.error('[GMAIL] Cannot fetch Yutori emails — Gmail service unavailable (check credentials)');
    return [];
  }

  const totalStart = Date.now();
  try {
    const days = Math.ceil(sinceHours / 24);
    const query = `from:notifications@yutori.com newer_than:${days}d`;
    console.log(`[GMAIL] fetchYutoriEmails starting — query: "${query}"`);

    const listRes = await withTimeout(
      ({ signal }) => gmail.users.messages.list({ userId: 'me', q: query, maxResults: 30, signal }),
      `messages.list(yutori)`
    );

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      console.log(`[GMAIL] fetchYutoriEmails: no messages matched (${Date.now() - totalStart}ms total)`);
      return [];
    }
    console.log(`[GMAIL] fetchYutoriEmails: ${messages.length} messages found`);

    const results = [];
    for (const msg of messages) {
      const full = await withTimeout(
        ({ signal }) => gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full', signal }),
        `messages.get(yutori:${msg.id})`
      );

      const headers = full.data.payload.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const body = extractBody(full.data.payload);

      if (body) {
        results.push({ id: msg.id, subject, body, date });
      }
    }

    console.log(`[GMAIL] fetchYutoriEmails done — ${results.length} emails in ${Date.now() - totalStart}ms`);
    return results;
  } catch (err) {
    const elapsed = Date.now() - totalStart;
    const isAuthError = /invalid_grant|token.*expired|token.*revoked|unauthorized/i.test(err.message);
    const isTimeout = /timed out/i.test(err.message);
    if (isAuthError) {
      console.error('[GMAIL] AUTH FAILURE — refresh token is expired or revoked. Re-run: node scripts/gmail-auth.js');
      console.error('[GMAIL] No Yutori emails will be ingested until credentials are refreshed.');
      try {
        const { sendRuntimeAlert } = require('./alerts');
        sendRuntimeAlert('gmail-auth-failure', {
          error: err.message,
          impact: 'Yutori email ingestion is completely stalled — no new events will be cached until credentials are refreshed',
          fix: 'Run: node scripts/gmail-auth.js',
        }).catch(() => {});
      } catch {}
    } else if (isTimeout) {
      console.error(`[GMAIL] Yutori TIMEOUT after ${elapsed}ms. This is likely a network issue on Railway.`);
    } else {
      console.error(`[GMAIL] Yutori fetch error after ${elapsed}ms:`, err.message);
    }
    return [];
  }
}

/**
 * Extract the email body from a Gmail message payload.
 * Prefers text/html, falls back to text/plain.
 */
function extractBody(payload) {
  // Direct body on the payload
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }

  // Multipart — look for html first, then plain text
  if (payload.parts) {
    const htmlPart = findPart(payload.parts, 'text/html');
    if (htmlPart) return decodeBase64(htmlPart.body.data);

    const textPart = findPart(payload.parts, 'text/plain');
    if (textPart) return decodeBase64(textPart.body.data);

    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return null;
}

/**
 * Find a MIME part by type in a parts array.
 */
function findPart(parts, mimeType) {
  return parts.find(p => p.mimeType === mimeType && p.body && p.body.data);
}

/**
 * Decode Gmail's URL-safe base64 encoding.
 */
function decodeBase64(data) {
  return Buffer.from(data, 'base64').toString('utf8');
}

/**
 * Generic email fetcher — search Gmail by query string.
 * Returns [] if credentials are not configured or on any error.
 *
 * @param {string} query - Gmail search query (e.g. "from:foo@bar.com newer_than:7d")
 * @param {number} maxResults - Max emails to return (default 10)
 * @returns {Promise<Array<{id: string, subject: string, body: string, date: string}>>}
 */
async function fetchEmails(query, maxResults = 10) {
  const gmail = getGmailService();
  if (!gmail) {
    console.error('[GMAIL] Cannot fetch emails — Gmail service unavailable (check credentials)');
    return [];
  }

  const totalStart = Date.now();
  try {
    console.log(`[GMAIL] fetchEmails starting — query: "${query}", maxResults: ${maxResults}`);

    const listRes = await withTimeout(
      ({ signal }) => gmail.users.messages.list({ userId: 'me', q: query, maxResults, signal }),
      `messages.list(${query})`
    );

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      console.log(`[GMAIL] fetchEmails: no messages matched (${Date.now() - totalStart}ms total)`);
      return [];
    }
    console.log(`[GMAIL] fetchEmails: ${messages.length} messages found`);

    const results = [];
    for (const msg of messages) {
      const full = await withTimeout(
        ({ signal }) => gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full', signal }),
        `messages.get(${msg.id})`
      );

      const headers = full.data.payload.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const body = extractBody(full.data.payload);

      if (body) {
        results.push({ id: msg.id, subject, body, date });
      }
    }

    console.log(`[GMAIL] fetchEmails done — ${results.length} emails fetched in ${Date.now() - totalStart}ms`);
    return results;
  } catch (err) {
    const elapsed = Date.now() - totalStart;
    const isAuthError = /invalid_grant|token.*expired|token.*revoked|unauthorized/i.test(err.message);
    const isTimeout = /timed out/i.test(err.message);
    if (isAuthError) {
      console.error('[GMAIL] AUTH FAILURE — refresh token is expired or revoked. Re-run: node scripts/gmail-auth.js');
      try {
        const { sendRuntimeAlert } = require('./alerts');
        sendRuntimeAlert('gmail-auth-failure', {
          error: err.message,
          impact: 'Email ingestion is stalled until credentials are refreshed',
          fix: 'Run: node scripts/gmail-auth.js',
        }).catch(() => {});
      } catch {}
    } else if (isTimeout) {
      console.error(`[GMAIL] TIMEOUT after ${elapsed}ms — query: "${query}". This is likely a network issue on Railway.`);
    } else {
      console.error(`[GMAIL] Fetch error after ${elapsed}ms:`, err.message);
    }
    return [];
  }
}

module.exports = { getGmailService, fetchYutoriEmails, fetchEmails };
