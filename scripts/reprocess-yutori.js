/**
 * Re-extract all yutori emails with the current model/prompt and upsert to DB.
 * This replaces stale DB entries that were extracted by older prompts without URLs.
 *
 * Usage: node scripts/reprocess-yutori.js
 */
require('dotenv').config();

const { fetchYutoriEvents } = require('../src/sources/yutori/fetch');
const db = require('../src/db');

async function main() {
  console.log('Re-processing all yutori emails with current extraction pipeline...\n');

  const events = await fetchYutoriEvents({ reprocess: true });

  console.log(`\nExtracted ${events.length} events total`);

  const withUrl = events.filter(e => e.ticket_url || e.source_url).length;
  const noUrl = events.filter(e => !e.ticket_url && !e.source_url).length;
  console.log(`With URL: ${withUrl} (${(withUrl / events.length * 100).toFixed(1)}%)`);
  console.log(`Without URL: ${noUrl} (${(noUrl / events.length * 100).toFixed(1)}%)`);

  // Upsert to DB
  console.log(`\nUpserting ${events.length} events to DB...`);
  db.upsertEvents(events);
  console.log('Done. DB updated with fresh extractions.');

  // Verify
  const d = db.getDb();
  const total = d.prepare("SELECT COUNT(*) as cnt FROM events WHERE source_name = 'yutori'").get();
  const dbWithUrl = d.prepare("SELECT COUNT(*) as cnt FROM events WHERE source_name = 'yutori' AND (ticket_url IS NOT NULL OR source_url IS NOT NULL)").get();
  console.log(`\nDB verification — yutori events: ${total.cnt}, with URLs: ${dbWithUrl.cnt} (${(dbWithUrl.cnt / total.cnt * 100).toFixed(1)}%)`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
