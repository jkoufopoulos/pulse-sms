/**
 * Pull all Yutori Scout emails from Gmail and save event-related ones as a dataset.
 *
 * Usage: node scripts/pull-yutori-dataset.js [--days 30]
 *
 * Output:
 *   data/yutori-dataset/           — all event-related HTML files
 *   data/yutori-dataset/index.json — metadata index
 *   data/yutori-dataset/skipped.json — non-event emails that were filtered out
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { fetchEmails } = require('../src/gmail');
const { isEventEmail } = require('../src/sources/yutori/email-filter');

const DATASET_DIR = path.join(__dirname, '..', 'data', 'yutori-dataset');

function makeFilename(subject, date) {
  const dateStr = date ? new Date(date).toISOString().slice(0, 10) : 'unknown';
  const slug = (subject || 'untitled')
    .toLowerCase()
    .replace(/^(re:|fwd:)\s*/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${dateStr}-${slug}.html`;
}

async function main() {
  const daysArg = process.argv.includes('--days')
    ? parseInt(process.argv[process.argv.indexOf('--days') + 1], 10)
    : 30;

  console.log(`Fetching Yutori emails from last ${daysArg} days...`);

  // Gmail API maxResults caps at 500 per call, paginate if needed
  const query = `from:notifications@yutori.com newer_than:${daysArg}d`;
  const emails = await fetchEmails(query, 500);

  if (emails.length === 0) {
    console.log('No emails found. Check Gmail credentials.');
    return;
  }

  console.log(`Found ${emails.length} emails total.`);

  // Create dataset directory
  fs.mkdirSync(DATASET_DIR, { recursive: true });

  const index = [];
  const skipped = [];
  const seen = new Set();

  for (const email of emails) {
    const filename = makeFilename(email.subject, email.date);

    // Deduplicate by filename
    if (seen.has(filename)) continue;
    seen.add(filename);

    const isEvent = isEventEmail(filename, email.body);

    if (isEvent) {
      const filepath = path.join(DATASET_DIR, filename);
      fs.writeFileSync(filepath, email.body, 'utf8');
      index.push({
        filename,
        subject: email.subject,
        date: email.date,
        gmail_id: email.id,
        size: email.body.length,
      });
    } else {
      skipped.push({
        filename,
        subject: email.subject,
        date: email.date,
        gmail_id: email.id,
        reason: 'filtered by isEventEmail',
      });
    }
  }

  // Save index
  fs.writeFileSync(
    path.join(DATASET_DIR, 'index.json'),
    JSON.stringify({ total_fetched: emails.length, event_emails: index.length, skipped: skipped.length, emails: index }, null, 2)
  );
  fs.writeFileSync(
    path.join(DATASET_DIR, 'skipped.json'),
    JSON.stringify({ count: skipped.length, emails: skipped }, null, 2)
  );

  console.log(`\nResults:`);
  console.log(`  Event emails saved: ${index.length}`);
  console.log(`  Non-event skipped:  ${skipped.length}`);
  console.log(`  Dataset:            ${DATASET_DIR}/`);
  console.log(`  Index:              ${DATASET_DIR}/index.json`);
  console.log(`  Skipped:            ${DATASET_DIR}/skipped.json`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
