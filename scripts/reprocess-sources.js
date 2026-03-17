/**
 * Re-extract events from all email + web sources with the current model/prompt
 * and upsert to DB. Replaces stale DB entries from older extraction runs.
 *
 * Sources: yutori, nonsensenyc, screenslate, skint, bkmag
 *
 * Usage: node scripts/reprocess-sources.js [--source yutori,skint,...]
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { _setCache: setExtractionCache, saveExtractionCache } = require('../src/extraction-cache');

const ALL_SOURCES = {
  yutori: {
    fetch: () => require('../src/sources/yutori/fetch').fetchYutoriEvents({ reprocess: true }),
    cacheFile: path.join(__dirname, '../data/yutori/cached-events.json'),
    dbName: 'yutori',
  },
  nonsensenyc: {
    fetch: () => require('../src/sources/nonsense').fetchNonsenseNYCEvents(),
    cacheFile: path.join(__dirname, '../data/nonsense/cached-events.json'),
    dbName: 'nonsensenyc',
  },
  screenslate: {
    fetch: () => require('../src/sources/screenslate').fetchScreenSlateEvents(),
    cacheFile: path.join(__dirname, '../data/screenslate/cached-events.json'),
    dbName: 'ScreenSlate',
  },
  skint: {
    fetch: () => require('../src/sources/skint').fetchSkintEvents(),
    cacheFile: null, // no separate cache file
    dbName: 'theskint',
  },
  bkmag: {
    fetch: () => require('../src/sources/bkmag').fetchBKMagEvents(),
    cacheFile: path.join(__dirname, '../data/bkmag/cached-events.json'),
    dbName: 'bkmag',
  },
};

function clearSourceCache(name, source) {
  // Clear the source's own cached-events.json so it re-fetches/re-extracts
  if (source.cacheFile && fs.existsSync(source.cacheFile)) {
    fs.unlinkSync(source.cacheFile);
    console.log(`  Cleared ${name} cached-events.json`);
  }
}

function reportUrlCoverage(label, events) {
  const total = events.length;
  if (total === 0) {
    console.log(`  ${label}: 0 events`);
    return;
  }
  const withUrl = events.filter(e => e.ticket_url || e.source_url).length;
  const noUrl = total - withUrl;
  console.log(`  ${label}: ${total} events, ${withUrl} with URLs (${(withUrl / total * 100).toFixed(1)}%), ${noUrl} without`);
}

async function main() {
  // Parse --source flag
  const sourceArg = process.argv.includes('--source')
    ? process.argv[process.argv.indexOf('--source') + 1]
    : null;
  const sourceNames = sourceArg
    ? sourceArg.split(',').map(s => s.trim().toLowerCase())
    : Object.keys(ALL_SOURCES);

  // Validate source names
  for (const name of sourceNames) {
    if (!ALL_SOURCES[name]) {
      console.error(`Unknown source: ${name}. Available: ${Object.keys(ALL_SOURCES).join(', ')}`);
      process.exit(1);
    }
  }

  // Clear the global extraction-hashes cache so all sources re-extract
  console.log('Clearing global extraction hash cache...');
  setExtractionCache({});
  saveExtractionCache();

  const allEvents = [];

  for (const name of sourceNames) {
    const source = ALL_SOURCES[name];
    console.log(`\n=== ${name.toUpperCase()} ===`);

    // Clear source-specific cache
    clearSourceCache(name, source);

    try {
      console.log(`  Fetching and extracting...`);
      const events = await source.fetch();
      reportUrlCoverage(name, events);
      allEvents.push(...events);

      // Upsert to DB
      if (events.length > 0) {
        console.log(`  Upserting ${events.length} events to DB...`);
        db.upsertEvents(events);
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  // Final DB verification
  console.log('\n=== DB VERIFICATION ===');
  const d = db.getDb();
  for (const name of sourceNames) {
    const source = ALL_SOURCES[name];
    const total = d.prepare("SELECT COUNT(*) as cnt FROM events WHERE source_name = ?").get(source.dbName);
    const withUrl = d.prepare("SELECT COUNT(*) as cnt FROM events WHERE source_name = ? AND (ticket_url IS NOT NULL OR source_url IS NOT NULL)").get(source.dbName);
    const pct = total.cnt > 0 ? (withUrl.cnt / total.cnt * 100).toFixed(1) : '0.0';
    console.log(`  ${name}: ${total.cnt} total, ${withUrl.cnt} with URLs (${pct}%)`);
  }

  console.log(`\nDone. ${allEvents.length} total events re-extracted and upserted.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
