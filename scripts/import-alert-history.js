#!/usr/bin/env node
// One-off script: import historical Bestie alert emails from Gmail into data/alerts.jsonl
// Usage: node scripts/import-alert-history.js
// Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN env vars

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchEmails } = require('../src/gmail');

const ALERTS_PATH = path.join(__dirname, '../data/alerts.jsonl');
const DUPE_WINDOW_MS = 60 * 1000; // 1 minute — skip if existing entry matches subject within this window

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function parseType(subject) {
  // Health alerts: "Bestie: 3 sources failing", "Bestie: 1 source failing"
  if (/source.?\s*failing/i.test(subject)) {
    return { type: 'health', alertType: undefined };
  }
  // Runtime alerts: "Bestie: slow_response", "Bestie: error_rate", etc.
  const match = subject.match(/^Bestie:\s*(.+)$/i);
  const alertType = match ? match[1].trim() : 'unknown';
  return { type: 'runtime', alertType };
}

function loadExistingAlerts() {
  try {
    if (!fs.existsSync(ALERTS_PATH)) return [];
    const raw = fs.readFileSync(ALERTS_PATH, 'utf8').trim();
    if (!raw) return [];
    const entries = [];
    for (const line of raw.split('\n')) {
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return entries;
  } catch {
    return [];
  }
}

function isDuplicate(entry, existing) {
  const entryTime = new Date(entry.timestamp).getTime();
  return existing.some(e => {
    if (e.subject !== entry.subject) return false;
    const diff = Math.abs(new Date(e.timestamp).getTime() - entryTime);
    return diff < DUPE_WINDOW_MS;
  });
}

async function main() {
  console.log('Fetching Bestie alert emails from Gmail...');

  const emails = await fetchEmails('from:onboarding@resend.dev subject:Bestie newer_than:90d', 100);

  if (emails.length === 0) {
    console.log('No alert emails found. Check Gmail credentials and search query.');
    return;
  }

  console.log(`Found ${emails.length} emails`);

  const existing = loadExistingAlerts();
  console.log(`Existing alerts in JSONL: ${existing.length}`);

  const entries = emails.map(email => {
    const { type, alertType } = parseType(email.subject);
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date(email.date).toISOString(),
      type,
      subject: email.subject,
      details: { emailBody: stripHtml(email.body) },
      emailSent: true,
      emailError: null,
    };
    if (alertType) entry.alertType = alertType;
    return entry;
  });

  // Sort oldest first so JSONL order is chronological
  entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let imported = 0;
  let skipped = 0;
  let healthCount = 0;
  let runtimeCount = 0;

  const newLines = [];
  for (const entry of entries) {
    if (isDuplicate(entry, existing)) {
      skipped++;
      continue;
    }
    newLines.push(JSON.stringify(entry));
    if (entry.type === 'health') healthCount++;
    else runtimeCount++;
    imported++;
  }

  if (newLines.length === 0) {
    console.log(`No new alerts to import (skipped ${skipped} duplicates)`);
    return;
  }

  fs.mkdirSync(path.dirname(ALERTS_PATH), { recursive: true });

  // Append new entries (prepend if no existing file, so imports come before live alerts)
  if (existing.length === 0) {
    fs.writeFileSync(ALERTS_PATH, newLines.join('\n') + '\n');
  } else {
    // Insert imported entries before existing ones to maintain chronological order
    const allLines = [
      ...newLines,
      ...existing.map(e => JSON.stringify(e)),
    ];
    fs.writeFileSync(ALERTS_PATH, allLines.join('\n') + '\n');
  }

  console.log(`Imported ${imported} alerts (${healthCount} health, ${runtimeCount} runtime), skipped ${skipped} duplicates`);
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
