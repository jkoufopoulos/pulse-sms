/**
 * Run the structured parser against the Yutori dataset and report extraction quality.
 * Usage: node scripts/validate-yutori-parser.js
 */
const fs = require('fs');
const path = require('path');
const { parseStructuredYutoriHtml } = require('../src/sources/yutori/structured-parser');
const { isEventEmail, isTriviaEmail } = require('../src/sources/yutori/email-filter');

const DATASET_DIR = path.join(__dirname, '..', 'data', 'yutori-dataset');

function main() {
  const indexPath = path.join(DATASET_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('Run scripts/build-yutori-dataset.js first');
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let totalEvents = 0;
  let withName = 0, withVenue = 0, withDate = 0, withTime = 0;
  let withPrice = 0, withUrl = 0, withDesc = 0;
  let fullyComplete = 0;
  let emptyFiles = 0;
  let filteredOut = 0;
  let triviaSkipped = 0;

  const perFile = [];

  for (const entry of index.emails) {
    const filepath = path.join(DATASET_DIR, entry.filename);
    if (!fs.existsSync(filepath)) continue;

    const html = fs.readFileSync(filepath, 'utf8');

    // Check if updated filter would skip this
    if (!isEventEmail(entry.filename, html)) {
      filteredOut++;
      continue;
    }

    // Trivia emails use separate parseTriviaEvents in production
    if (isTriviaEmail(entry.filename, html)) {
      triviaSkipped++;
      continue;
    }

    const dateMatch = entry.filename.match(/^(\d{4}-\d{2}-\d{2})/);
    const fallbackDate = dateMatch ? dateMatch[1] : null;

    const events = parseStructuredYutoriHtml(html, fallbackDate);
    totalEvents += events.length;

    if (events.length === 0) {
      emptyFiles++;
      perFile.push({ file: entry.filename, events: 0, sample: 'N/A' });
      continue;
    }

    for (const e of events) {
      if (e.name) withName++;
      if (e.venue_name) withVenue++;
      if (e.date_local) withDate++;
      if (e.start_time_local) withTime++;
      if (e.price_display) withPrice++;
      if (e.source_url) withUrl++;
      if (e.description_short) withDesc++;
      if (e.name && e.venue_name && e.date_local && e.start_time_local && e.source_url) fullyComplete++;
    }

    perFile.push({ file: entry.filename, events: events.length, sample: events[0]?.name });
  }

  console.log('=== YUTORI STRUCTURED PARSER VALIDATION ===\n');
  const active = index.emails.length - filteredOut - triviaSkipped;
  console.log(`Dataset: ${index.emails.length} emails (${filteredOut} filtered out, ${triviaSkipped} trivia, ${active} active)`);
  console.log(`Total events extracted: ${totalEvents}`);
  console.log(`Empty files (0 events): ${emptyFiles}`);
  console.log(`\nField coverage:`);
  const pct = (n) => totalEvents > 0 ? (n/totalEvents*100).toFixed(0) : '0';
  console.log(`  Name:        ${withName}/${totalEvents} (${pct(withName)}%)`);
  console.log(`  Venue:       ${withVenue}/${totalEvents} (${pct(withVenue)}%)`);
  console.log(`  Date:        ${withDate}/${totalEvents} (${pct(withDate)}%)`);
  console.log(`  Time:        ${withTime}/${totalEvents} (${pct(withTime)}%)`);
  console.log(`  Price:       ${withPrice}/${totalEvents} (${pct(withPrice)}%)`);
  console.log(`  Source URL:  ${withUrl}/${totalEvents} (${pct(withUrl)}%)`);
  console.log(`  Description: ${withDesc}/${totalEvents} (${pct(withDesc)}%)`);
  console.log(`  COMPLETE:    ${fullyComplete}/${totalEvents} (${pct(fullyComplete)}%)`);

  console.log(`\nComparison vs current LLM extraction:`);
  console.log(`  URL:      ${pct(withUrl)}% vs 18% (was 82% missing)`);
  console.log(`  Time:     ${pct(withTime)}% vs 58% (was 42% missing)`);
  console.log(`  Complete: ${pct(fullyComplete)}% vs 9%`);

  // Show files with 0 events
  if (emptyFiles > 0) {
    console.log(`\nFiles with 0 events extracted:`);
    perFile.filter(f => f.events === 0).forEach(f => console.log(`  ${f.file}`));
  }

  // Show per-file counts
  console.log(`\nPer-file breakdown:`);
  perFile.sort((a, b) => b.events - a.events);
  for (const f of perFile.slice(0, 10)) {
    console.log(`  ${f.events} events | ${f.file} | e.g. "${f.sample}"`);
  }
  if (perFile.length > 10) console.log(`  ... and ${perFile.length - 10} more files`);
}

main();
