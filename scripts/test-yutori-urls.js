/**
 * Test yutori extraction pipeline on film/art emails and report URL coverage.
 *
 * Usage: node scripts/test-yutori-urls.js [--limit 5]
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { extractYutoriEvents } = require('../src/ai');
const { normalizeExtractedEvent } = require('../src/sources/shared');
const { preprocessYutoriHtml } = require('../src/sources/yutori/html-preprocess');
const { isGarbageName } = require('../src/curation');
const { resolveDayOfWeekDate } = require('../src/sources/yutori/general-parser');

const DATASET_DIR = path.join(__dirname, '..', 'data', 'yutori-dataset');

// Categories that produce art/film/other events
const TARGET_CATS = [
  'NYC curated film screenings',
  'NYC underground music and film nights',
  'Manhattan Indie Events',
  'Brooklyn indie events',
  'Central Brooklyn Indie Events',
];

async function main() {
  const limitArg = process.argv.includes('--limit')
    ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
    : Infinity;

  const idx = JSON.parse(fs.readFileSync(path.join(DATASET_DIR, 'index.json'), 'utf8'));
  const targetEmails = idx.emails
    .filter(e => TARGET_CATS.includes(e.category) && !e.is_trivia)
    .slice(0, limitArg);

  console.log(`Processing ${targetEmails.length} film/art emails through extraction pipeline...\n`);

  let totalEvents = 0;
  let withTicketUrl = 0;
  let withSourceUrl = 0;
  let withAnyUrl = 0;
  let noUrl = 0;
  const noUrlExamples = [];

  for (let i = 0; i < targetEmails.length; i++) {
    const email = targetEmails[i];
    const filepath = path.join(DATASET_DIR, email.filename);
    if (!fs.existsSync(filepath)) {
      console.log(`  SKIP (missing): ${email.filename}`);
      continue;
    }

    const raw = fs.readFileSync(filepath, 'utf8');
    console.log(`[${i + 1}/${targetEmails.length}] ${email.filename} (${email.category})`);

    try {
      const result = await extractYutoriEvents(raw, email.filename);
      const rawEvents = result.events || [];
      const normalized = rawEvents.map(e => normalizeExtractedEvent(e, 'yutori', 'aggregator', 0.8));
      const passed = normalized.filter(e => e.name && e.completeness >= 0.25);

      // Apply same content filter as production
      const filtered = passed.filter(e => {
        const hasTime = !!e.start_time_local;
        const hasUrl = !!e.ticket_url || !!e.source_url;
        let hasVenue = !!e.venue_name && e.venue_name !== 'TBA';
        if (hasVenue) {
          const vLow = e.venue_name.toLowerCase();
          const nLow = (e.name || '').toLowerCase();
          if (nLow.startsWith(vLow) || vLow.startsWith(nLow.split(':')[0])) hasVenue = false;
        }
        if (!hasTime && !hasVenue && !hasUrl) return false;
        if (isGarbageName(e.name)) return false;
        return true;
      });

      for (const e of filtered) {
        totalEvents++;
        if (e.ticket_url) withTicketUrl++;
        if (e.source_url) withSourceUrl++;
        if (e.ticket_url || e.source_url) {
          withAnyUrl++;
        } else {
          noUrl++;
          noUrlExamples.push({ name: e.name, venue: e.venue_name, category: e.category, email: email.filename });
        }
      }

      console.log(`  → ${filtered.length} events (${filtered.filter(e => e.ticket_url || e.source_url).length} with URLs)\n`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
    }
  }

  console.log('\n=== URL COVERAGE REPORT ===');
  console.log(`Total events extracted: ${totalEvents}`);
  console.log(`With ticket_url:        ${withTicketUrl} (${(withTicketUrl/totalEvents*100).toFixed(1)}%)`);
  console.log(`With source_url:        ${withSourceUrl} (${(withSourceUrl/totalEvents*100).toFixed(1)}%)`);
  console.log(`With ANY url:           ${withAnyUrl} (${(withAnyUrl/totalEvents*100).toFixed(1)}%)`);
  console.log(`Without any url:        ${noUrl} (${(noUrl/totalEvents*100).toFixed(1)}%)`);

  if (noUrlExamples.length > 0) {
    console.log(`\n=== EVENTS WITHOUT URLs (${noUrlExamples.length}) ===`);
    for (const ex of noUrlExamples.slice(0, 20)) {
      console.log(`  "${ex.name}" @ ${ex.venue} [${ex.category}] (from ${ex.email})`);
    }
    if (noUrlExamples.length > 20) {
      console.log(`  ... and ${noUrlExamples.length - 20} more`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
