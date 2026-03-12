/**
 * Build a Yutori event dataset from locally processed emails.
 * Filters to event-related emails only using isEventEmail.
 *
 * Usage: node scripts/build-yutori-dataset.js
 *
 * Output:
 *   data/yutori-dataset/           — event-related HTML files (copied)
 *   data/yutori-dataset/index.json — metadata index
 *   data/yutori-dataset/skipped.json — non-event emails that were filtered out
 */
const fs = require('fs');
const path = require('path');
const { isEventEmail, isTriviaEmail } = require('../src/sources/yutori/email-filter');

const PROCESSED_DIR = path.join(__dirname, '..', 'data', 'yutori', 'processed');
const DATASET_DIR = path.join(__dirname, '..', 'data', 'yutori-dataset');

function main() {
  if (!fs.existsSync(PROCESSED_DIR)) {
    console.error('No processed directory found at', PROCESSED_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(PROCESSED_DIR)
    .filter(f => /\.(html?)$/i.test(f))
    .sort();

  console.log(`Found ${files.length} processed Yutori emails.`);

  fs.mkdirSync(DATASET_DIR, { recursive: true });

  const eventEmails = [];
  const skipped = [];

  for (const file of files) {
    const filepath = path.join(PROCESSED_DIR, file);
    const html = fs.readFileSync(filepath, 'utf8');

    const isEvent = isEventEmail(file, html);
    const isTrivia = isEvent && isTriviaEmail(file, html);

    if (isEvent) {
      // Copy to dataset
      fs.copyFileSync(filepath, path.join(DATASET_DIR, file));

      // Extract the scout category from HTML
      const categoryMatch = html.match(
        /text-transform:\s*uppercase[^>]*>\s*<a[^>]*style="[^"]*text-decoration-line:\s*none"[^>]*>([^<]+)<\/a>/i
      );
      const category = categoryMatch ? categoryMatch[1].trim() : 'unknown';

      // Count <li> items (structured event fields)
      const liCount = (html.match(/<li[^>]*>/gi) || []).length;

      // Count event paragraphs (bold name pattern)
      const boldCount = (html.match(/<b[^>]*style="font-weight:700">[^<]{10,}<\/b>/gi) || []).length;

      // Count source badges
      const badgeCount = (html.match(/scouts\.yutori\.com\/api\/view\?url=/gi) || []).length;

      eventEmails.push({
        filename: file,
        category,
        is_trivia: isTrivia,
        size: html.length,
        li_count: liCount,
        bold_events: boldCount,
        source_badges: badgeCount,
        date: file.match(/^(\d{4}-\d{2}-\d{2})/) ? file.match(/^(\d{4}-\d{2}-\d{2})/)[1] : 'unknown',
      });
    } else {
      // Extract reason
      const categoryMatch = html.match(
        /text-transform:\s*uppercase[^>]*>\s*<a[^>]*style="[^"]*text-decoration-line:\s*none"[^>]*>([^<]+)<\/a>/i
      );
      const category = categoryMatch ? categoryMatch[1].trim() : 'unknown';

      skipped.push({
        filename: file,
        category,
        reason: 'filtered by isEventEmail',
      });
    }
  }

  // Save index
  fs.writeFileSync(
    path.join(DATASET_DIR, 'index.json'),
    JSON.stringify({
      total_processed: files.length,
      event_emails: eventEmails.length,
      trivia_emails: eventEmails.filter(e => e.is_trivia).length,
      non_trivia_events: eventEmails.filter(e => !e.is_trivia).length,
      skipped: skipped.length,
      emails: eventEmails,
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(DATASET_DIR, 'skipped.json'),
    JSON.stringify({ count: skipped.length, emails: skipped }, null, 2)
  );

  // Summary
  console.log(`\nResults:`);
  console.log(`  Total emails:       ${files.length}`);
  console.log(`  Event emails:       ${eventEmails.length}`);
  console.log(`    Trivia:           ${eventEmails.filter(e => e.is_trivia).length}`);
  console.log(`    Non-trivia:       ${eventEmails.filter(e => !e.is_trivia).length}`);
  console.log(`  Skipped (non-event): ${skipped.length}`);
  console.log(`  Dataset:             ${DATASET_DIR}/`);

  // Category breakdown
  const catCounts = {};
  for (const e of eventEmails) {
    catCounts[e.category] = (catCounts[e.category] || 0) + 1;
  }
  console.log(`\nEvent email categories:`);
  for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  const skipCatCounts = {};
  for (const e of skipped) {
    skipCatCounts[e.category] = (skipCatCounts[e.category] || 0) + 1;
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped email categories:`);
    for (const [cat, count] of Object.entries(skipCatCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count}`);
    }
  }

  // Format stats
  console.log(`\nStructure stats (event emails):`);
  const withLi = eventEmails.filter(e => e.li_count > 0).length;
  const withBold = eventEmails.filter(e => e.bold_events > 0).length;
  const withBadges = eventEmails.filter(e => e.source_badges > 0).length;
  console.log(`  With <li> items (structured fields): ${withLi} (${(withLi/eventEmails.length*100).toFixed(0)}%)`);
  console.log(`  With bold event names:               ${withBold} (${(withBold/eventEmails.length*100).toFixed(0)}%)`);
  console.log(`  With source badges:                  ${withBadges} (${(withBadges/eventEmails.length*100).toFixed(0)}%)`);
}

main();
