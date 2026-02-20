#!/usr/bin/env node

/**
 * One-time setup script for obtaining a Gmail OAuth refresh token.
 *
 * Usage:
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-auth.js
 *
 * Opens your browser to the Google consent screen, starts a temporary
 * localhost server to receive the OAuth callback, exchanges the auth code
 * for tokens, and prints the refresh token to paste into your .env file.
 */

const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Error: Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables.');
    console.error('');
    console.error('Example:');
    console.error('  GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx node scripts/gmail-auth.js');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh token generation
  });

  console.log('Opening browser for Google authorization...');
  console.log('');
  console.log('If the browser does not open, visit this URL manually:');
  console.log(authUrl);
  console.log('');

  // Open browser
  const { exec } = require('child_process');
  exec(`open "${authUrl}"`);

  // Wait for OAuth callback
  const code = await waitForCallback();

  console.log('Authorization code received. Exchanging for tokens...');
  const { tokens } = await oauth2.getToken(code);

  console.log('');
  console.log('Add this to your .env file:');
  console.log('');
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('');

  if (!tokens.refresh_token) {
    console.warn('Warning: No refresh token returned. This can happen if you previously');
    console.warn('authorized this app. Revoke access at https://myaccount.google.com/permissions');
    console.warn('and run this script again.');
  }

  process.exit(0);
}

function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization denied</h1><p>You can close this tab.</p>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(code);
        return;
      }

      // Ignore favicon and other requests
      res.writeHead(200);
      res.end();
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Waiting for OAuth callback on port ${REDIRECT_PORT}...`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for OAuth callback'));
    }, 120_000);
  });
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
