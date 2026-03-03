const fs = require('fs');
const path = require('path');
const { backfillEvidence } = require('../shared');

const YUTORI_DIR = path.join(__dirname, '../../../data/yutori');
const PROCESSED_DIR = path.join(YUTORI_DIR, 'processed');
const PROCESSED_IDS_FILE = path.join(YUTORI_DIR, 'processed-ids.json');
const CACHE_FILE = path.join(YUTORI_DIR, 'cached-events.json');

/**
 * Load cached events from previously processed briefings.
 */
function loadCachedEvents() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data?.events) backfillEvidence(data.events);
      return data;
    }
  } catch (err) {
    console.warn('Yutori: failed to load cached-events.json:', err.message);
  }
  return null;
}

/**
 * Save extracted events, accumulating with previously cached events.
 * Dedupes by event ID and prunes events >30 days in the past.
 */
function saveCachedEvents(newEvents) {
  try {
    fs.mkdirSync(YUTORI_DIR, { recursive: true });

    // Load existing cached events and merge
    const existing = loadCachedEvents();
    const existingEvents = existing?.events || [];
    const seen = new Set(newEvents.map(e => e.id));
    const kept = existingEvents.filter(e => !seen.has(e.id));
    const merged = [...newEvents, ...kept];

    // Prune events with dates >30 days in the past
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const pruned = merged.filter(e => {
      const d = e.date_local;
      if (!d) return true; // keep undated events
      return d >= cutoffStr;
    });

    fs.writeFileSync(CACHE_FILE, JSON.stringify({ events: pruned, timestamp: Date.now() }, null, 2));
  } catch (err) {
    console.warn('Yutori: failed to save cached-events.json:', err.message);
  }
}

/**
 * Load the set of already-processed Gmail message IDs.
 */
function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_IDS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf8')));
    }
  } catch (err) {
    console.warn('Yutori: failed to load processed-ids.json:', err.message);
  }
  return new Set();
}

/**
 * Save the set of processed Gmail message IDs.
 */
function saveProcessedIds(ids) {
  try {
    fs.mkdirSync(YUTORI_DIR, { recursive: true });
    fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify([...ids], null, 2));
  } catch (err) {
    console.warn('Yutori: failed to save processed-ids.json:', err.message);
  }
}

/**
 * Scan extracted events for recurrence markers and upsert into recurring_patterns table.
 * Delegates to the shared processRecurrencePatterns in db.js.
 */
function processRecurrencePatterns(events) {
  try {
    const db = require('../../db');
    db.processRecurrencePatterns(events, 'yutori');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.warn('Yutori: failed to upsert recurring patterns:', err.message);
    }
  }
}

/**
 * Create a filename slug from a subject and date string.
 */
function makeFilename(subject, dateStr) {
  const date = dateStr ? new Date(dateStr) : new Date();
  const ymd = isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
  const slug = (subject || 'briefing')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${ymd}-${slug}.html`;
}

module.exports = {
  YUTORI_DIR,
  PROCESSED_DIR,
  CACHE_FILE,
  loadCachedEvents,
  saveCachedEvents,
  loadProcessedIds,
  saveProcessedIds,
  processRecurrencePatterns,
  makeFilename,
};
