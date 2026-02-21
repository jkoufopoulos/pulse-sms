const { google } = require('googleapis');

/**
 * Create an authenticated Gmail API client from env vars.
 * Returns null if credentials are not configured.
 */
function getGmailService() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2 });
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
    return [];
  }

  try {
    const days = Math.ceil(sinceHours / 24);
    const query = `from:notifications@yutori.com newer_than:${days}d`;

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      return [];
    }

    const results = [];
    for (const msg of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = full.data.payload.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const body = extractBody(full.data.payload);

      if (body) {
        results.push({ id: msg.id, subject, body, date });
      }
    }

    return results;
  } catch (err) {
    console.error('Gmail fetch error:', err.message);
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
    return [];
  }

  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      return [];
    }

    const results = [];
    for (const msg of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = full.data.payload.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const body = extractBody(full.data.payload);

      if (body) {
        results.push({ id: msg.id, subject, body, date });
      }
    }

    return results;
  } catch (err) {
    console.error('Gmail fetch error:', err.message);
    return [];
  }
}

module.exports = { getGmailService, fetchYutoriEmails, fetchEmails };
