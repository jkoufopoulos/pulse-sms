const { check } = require('../helpers');
const Database = require('better-sqlite3');

console.log('\n--- db.test.js ---');

// Use in-memory SQLite for isolation — we replicate the schema here
// so tests don't depend on the singleton db connection.

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      source_type TEXT,
      source_weight REAL,
      source_tier TEXT,
      name TEXT NOT NULL,
      description_short TEXT,
      short_detail TEXT,
      venue_name TEXT,
      venue_address TEXT,
      neighborhood TEXT,
      start_time_local TEXT,
      end_time_local TEXT,
      date_local TEXT,
      time_window TEXT,
      is_free INTEGER DEFAULT 0,
      price_display TEXT,
      category TEXT,
      subcategory TEXT,
      extraction_confidence REAL,
      completeness REAL,
      needs_review INTEGER DEFAULT 0,
      ticket_url TEXT,
      source_url TEXT,
      map_url TEXT,
      map_hint TEXT,
      evidence TEXT,
      scraped_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE recurring_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      venue_name TEXT NOT NULL,
      venue_address TEXT,
      neighborhood TEXT,
      day_of_week INTEGER NOT NULL,
      time_local TEXT,
      end_time_local TEXT,
      category TEXT,
      subcategory TEXT,
      is_free INTEGER DEFAULT 0,
      price_display TEXT,
      description_short TEXT,
      source_name TEXT DEFAULT 'yutori',
      source_url TEXT,
      ticket_url TEXT,
      extraction_confidence REAL,
      first_seen TEXT NOT NULL,
      last_confirmed TEXT NOT NULL,
      active_until TEXT NOT NULL,
      deactivated INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_events_date ON events(date_local);
    CREATE INDEX idx_events_neighborhood ON events(neighborhood);
    CREATE INDEX idx_patterns_day ON recurring_patterns(day_of_week);
    CREATE INDEX idx_patterns_active ON recurring_patterns(active_until, deactivated);
  `);
  return db;
}

// --- Test helpers ---

const { makeEventId } = require('../../src/sources/shared');
const { addMonths, makePatternKey, DAY_NAMES } = require('../../src/db');

function makeTestEvent(overrides = {}) {
  const name = overrides.name || 'Test Event';
  const venue = overrides.venue_name || 'Test Venue';
  const date = overrides.date_local || '2026-03-01';
  return {
    id: makeEventId(name, venue, date),
    source_name: 'test',
    source_type: 'structured',
    source_weight: 0.8,
    source_tier: 'primary',
    name,
    description_short: 'A test event',
    short_detail: 'A test event',
    venue_name: venue,
    venue_address: '123 Test St',
    neighborhood: 'Williamsburg',
    start_time_local: `${date}T20:00:00`,
    end_time_local: null,
    date_local: date,
    time_window: 'evening',
    is_free: false,
    price_display: '$10',
    category: 'live_music',
    subcategory: null,
    extraction_confidence: 0.9,
    completeness: 0.85,
    needs_review: false,
    ticket_url: null,
    source_url: 'https://example.com',
    map_url: null,
    map_hint: null,
    evidence: { name_quote: 'Test Event', time_quote: '8pm' },
    ...overrides,
  };
}

// We need a minimal wrapper around the raw DB to test upsert/query logic
// without using the singleton. Replicate the key functions with a passed-in db.

function eventToRow(e) {
  const now = new Date().toISOString();
  return {
    id: e.id,
    source_name: e.source_name || null,
    source_type: e.source_type || null,
    source_weight: e.source_weight ?? null,
    source_tier: e.source_tier || null,
    name: e.name,
    description_short: e.description_short || null,
    short_detail: e.short_detail || null,
    venue_name: e.venue_name || null,
    venue_address: e.venue_address || null,
    neighborhood: e.neighborhood || null,
    start_time_local: e.start_time_local || null,
    end_time_local: e.end_time_local || null,
    date_local: e.date_local || null,
    time_window: e.time_window || null,
    is_free: e.is_free ? 1 : 0,
    price_display: e.price_display || null,
    category: e.category || null,
    subcategory: e.subcategory || null,
    extraction_confidence: e.extraction_confidence ?? null,
    completeness: e.completeness ?? null,
    needs_review: e.needs_review ? 1 : 0,
    ticket_url: e.ticket_url || null,
    source_url: e.source_url || null,
    map_url: e.map_url || null,
    map_hint: e.map_hint || null,
    evidence: e.evidence ? JSON.stringify(e.evidence) : null,
    scraped_at: e.scraped_at || now,
    updated_at: now,
  };
}

function rowToEvent(row) {
  return {
    ...row,
    is_free: !!row.is_free,
    needs_review: !!row.needs_review,
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
  };
}

const EVENT_COLUMNS = [
  'id', 'source_name', 'source_type', 'source_weight', 'source_tier',
  'name', 'description_short', 'short_detail', 'venue_name', 'venue_address',
  'neighborhood', 'start_time_local', 'end_time_local', 'date_local', 'time_window',
  'is_free', 'price_display', 'category', 'subcategory',
  'extraction_confidence', 'completeness', 'needs_review',
  'ticket_url', 'source_url', 'map_url', 'map_hint', 'evidence',
  'scraped_at', 'updated_at',
];

function upsertEvents(db, events) {
  const insert = db.prepare(`
    INSERT INTO events (${EVENT_COLUMNS.join(', ')})
    VALUES (${EVENT_COLUMNS.map(c => '@' + c).join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      name = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.name ELSE events.name END,
      source_name = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.source_name ELSE events.source_name END,
      source_weight = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.source_weight ELSE events.source_weight END,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });
  tx(events.map(eventToRow));
}

// ============================================================
// Tests
// ============================================================

// 1. Schema creation
{
  const db = createTestDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  check('Schema: events table exists', tables.includes('events'));
  check('Schema: recurring_patterns table exists', tables.includes('recurring_patterns'));
  db.close();
}

// 2. Event upsert + query
{
  const db = createTestDb();
  const e1 = makeTestEvent({ date_local: '2026-03-01' });
  const e2 = makeTestEvent({ name: 'Another Show', date_local: '2026-03-02' });
  upsertEvents(db, [e1, e2]);

  const rows = db.prepare('SELECT * FROM events').all();
  check('Upsert: 2 events inserted', rows.length === 2);
  db.close();
}

// 3. Higher weight overwrites lower
{
  const db = createTestDb();
  const e1 = makeTestEvent({ source_name: 'low_source', source_weight: 0.5 });
  upsertEvents(db, [e1]);

  const higher = { ...e1, source_name: 'high_source', source_weight: 0.9 };
  upsertEvents(db, [higher]);

  const row = db.prepare('SELECT source_name, source_weight FROM events WHERE id = ?').get(e1.id);
  check('Weight: higher weight overwrites', row.source_name === 'high_source');
  check('Weight: weight updated', row.source_weight === 0.9);
  db.close();
}

// 4. Lower weight does NOT overwrite higher
{
  const db = createTestDb();
  const e1 = makeTestEvent({ source_name: 'high_source', source_weight: 0.9 });
  upsertEvents(db, [e1]);

  const lower = { ...e1, source_name: 'low_source', source_weight: 0.5 };
  upsertEvents(db, [lower]);

  const row = db.prepare('SELECT source_name, source_weight FROM events WHERE id = ?').get(e1.id);
  check('Weight: lower weight does NOT overwrite', row.source_name === 'high_source');
  db.close();
}

// 5. getEventsInRange date filtering
{
  const db = createTestDb();
  upsertEvents(db, [
    makeTestEvent({ name: 'Early', date_local: '2026-02-28' }),
    makeTestEvent({ name: 'InRange', date_local: '2026-03-02' }),
    makeTestEvent({ name: 'Late', date_local: '2026-03-15' }),
  ]);

  const rows = db.prepare('SELECT * FROM events WHERE date_local >= ? AND date_local <= ?')
    .all('2026-03-01', '2026-03-07');
  check('Range: only in-range event returned', rows.length === 1 && rows[0].name === 'InRange');
  db.close();
}

// 6. pruneOldEvents
{
  const db = createTestDb();
  upsertEvents(db, [
    makeTestEvent({ name: 'Old', date_local: '2026-01-01' }),
    makeTestEvent({ name: 'Recent', date_local: '2026-03-01' }),
  ]);

  const deleted = db.prepare('DELETE FROM events WHERE date_local < ? AND date_local IS NOT NULL')
    .run('2026-02-01').changes;
  check('Prune: old event deleted', deleted === 1);

  const remaining = db.prepare('SELECT * FROM events').all();
  check('Prune: recent event kept', remaining.length === 1 && remaining[0].name === 'Recent');
  db.close();
}

// 7. Boolean round-trip (is_free, needs_review)
{
  const db = createTestDb();
  const e = makeTestEvent({ is_free: true, needs_review: true });
  upsertEvents(db, [e]);

  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(e.id);
  const restored = rowToEvent(row);
  check('Boolean: is_free round-trips as true', restored.is_free === true);
  check('Boolean: needs_review round-trips as true', restored.needs_review === true);
  db.close();
}

// 8. Evidence JSON round-trip
{
  const db = createTestDb();
  const evidence = { name_quote: 'DJ Night', time_quote: '10pm', location_quote: 'Mood Ring' };
  const e = makeTestEvent({ evidence });
  upsertEvents(db, [e]);

  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(e.id);
  const restored = rowToEvent(row);
  check('Evidence: JSON round-trips', JSON.stringify(restored.evidence) === JSON.stringify(evidence));
  db.close();
}

// 9. addMonths utility
{
  check('addMonths: 6 months from 2026-03-01', addMonths('2026-03-01', 6) === '2026-09-01');
  check('addMonths: 6 months from 2026-08-15', addMonths('2026-08-15', 6) === '2027-02-15');
  check('addMonths: 6 months from 2026-09-30', addMonths('2026-09-30', 6) === '2027-03-30');
}

// 10. makePatternKey
{
  const key = makePatternKey('Trivia Night', 'FancyFree Bar', 2);
  check('PatternKey: deterministic', key === 'trivia night|fancyfree bar|2');
  check('PatternKey: consistent', makePatternKey('Trivia Night', 'FancyFree Bar', 2) === key);
}

// 11. Pattern upsert + getActivePatterns
{
  const db = createTestDb();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const activeUntil = addMonths(today, 6);

  db.prepare(`
    INSERT INTO recurring_patterns (
      pattern_key, name, venue_name, day_of_week, time_local,
      category, is_free, source_name, first_seen, last_confirmed, active_until,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('trivia|bar|2', 'Trivia Night', 'FancyFree Bar', 2, '20:00',
    'community', 0, 'yutori', today, today, activeUntil, now, now);

  const active = db.prepare('SELECT * FROM recurring_patterns WHERE active_until >= ? AND deactivated = 0')
    .all(today);
  check('Pattern: active pattern found', active.length === 1);
  check('Pattern: name matches', active[0].name === 'Trivia Night');
  check('Pattern: day_of_week is Tuesday (2)', active[0].day_of_week === 2);
  db.close();
}

// 12. getActivePatterns excludes expired
{
  const db = createTestDb();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  db.prepare(`
    INSERT INTO recurring_patterns (
      pattern_key, name, venue_name, day_of_week, time_local,
      category, is_free, source_name, first_seen, last_confirmed, active_until,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('expired|bar|3', 'Old Trivia', 'Some Bar', 3, '19:00',
    'community', 0, 'yutori', '2025-01-01', '2025-01-01', '2025-07-01', now, now);

  const active = db.prepare('SELECT * FROM recurring_patterns WHERE active_until >= ? AND deactivated = 0')
    .all(today);
  check('Pattern: expired pattern excluded', active.length === 0);
  db.close();
}

// 13. getActivePatterns excludes deactivated
{
  const db = createTestDb();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const activeUntil = addMonths(today, 6);

  db.prepare(`
    INSERT INTO recurring_patterns (
      pattern_key, name, venue_name, day_of_week, time_local,
      category, is_free, source_name, first_seen, last_confirmed, active_until,
      deactivated, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('deact|bar|1', 'Dead Event', 'Bar', 1, '20:00',
    'community', 0, 'yutori', today, today, activeUntil, 1, now, now);

  const active = db.prepare('SELECT * FROM recurring_patterns WHERE active_until >= ? AND deactivated = 0')
    .all(today);
  check('Pattern: deactivated pattern excluded', active.length === 0);
  db.close();
}

// 14. generateOccurrences — correct day-of-week walking
{
  const db = createTestDb();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const activeUntil = addMonths(today, 6);

  // Insert a Tuesday pattern (day_of_week = 2)
  db.prepare(`
    INSERT INTO recurring_patterns (
      pattern_key, name, venue_name, day_of_week, time_local,
      category, is_free, source_name, first_seen, last_confirmed, active_until,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('trivia|venue|2', 'Tuesday Trivia', 'Test Venue', 2, '20:00',
    'community', 0, 'yutori', today, today, activeUntil, now, now);

  // Query a week range: 2026-03-02 (Mon) to 2026-03-08 (Sun)
  const patterns = db.prepare('SELECT * FROM recurring_patterns WHERE active_until >= ? AND deactivated = 0')
    .all(today);

  // Walk dates manually
  const events = [];
  const start = new Date('2026-03-02T00:00:00');
  const end = new Date('2026-03-08T23:59:59');
  for (const p of patterns) {
    const cursor = new Date(start);
    while (cursor <= end) {
      if (cursor.getDay() === p.day_of_week) {
        const dateLocal = cursor.toISOString().slice(0, 10);
        events.push({
          id: makeEventId(p.name, p.venue_name, dateLocal),
          name: p.name,
          date_local: dateLocal,
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  check('Occurrences: exactly 1 Tuesday in week', events.length === 1);
  check('Occurrences: date is 2026-03-03 (Tuesday)', events[0]?.date_local === '2026-03-03');
  db.close();
}

// 15. Occurrence IDs match scraped event IDs (dedup) — with startTime
{
  const scrapedId = makeEventId('Tuesday Trivia', 'Test Venue', '2026-03-03', null, null, '2026-03-03T19:00:00');
  const occurrenceId = makeEventId('Tuesday Trivia', 'Test Venue', '2026-03-03', null, null, '2026-03-03T19:00:00');
  check('Occurrence IDs: match scraped IDs for dedup (with time)', scrapedId === occurrenceId);
  // Without startTime: still backward compatible
  const noTimeId = makeEventId('Tuesday Trivia', 'Test Venue', '2026-03-03');
  check('Occurrence IDs: no startTime still works', noTimeId.length === 12);
}

// 16. DAY_NAMES mapping
{
  check('DAY_NAMES: sunday is 0', DAY_NAMES[0] === 'sunday');
  check('DAY_NAMES: saturday is 6', DAY_NAMES[6] === 'saturday');
  check('DAY_NAMES: tuesday is 2', DAY_NAMES[2] === 'tuesday');
}

// 17. Null evidence round-trip
{
  const db = createTestDb();
  const e = makeTestEvent({ evidence: null });
  upsertEvents(db, [e]);

  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(e.id);
  const restored = rowToEvent(row);
  check('Evidence: null round-trips as null', restored.evidence === null);
  db.close();
}

// 18. pruneInactiveSources
{
  const testDb = createTestDb();

  console.log('\nInactive source pruning:');

  // Insert events from active and inactive sources
  const now2 = new Date().toISOString();
  testDb.prepare(`INSERT INTO events (id, source_name, name, scraped_at, updated_at, date_local) VALUES (?, ?, ?, ?, ?, ?)`).run('evt-active', 'DoNYC', 'Active Event', now2, now2, '2026-03-05');
  testDb.prepare(`INSERT INTO events (id, source_name, name, scraped_at, updated_at, date_local) VALUES (?, ?, ?, ?, ?, ?)`).run('evt-stale', 'ticketmaster', 'Stale Event', now2, now2, '2026-03-05');
  testDb.prepare(`INSERT INTO events (id, source_name, name, scraped_at, updated_at, date_local) VALUES (?, ?, ?, ?, ?, ?)`).run('evt-stale2', 'smallslive', 'Stale Event 2', now2, now2, '2026-03-05');

  // Simulate pruning
  const activeLabels = ['DoNYC', 'RA'];
  const allSources = testDb.prepare('SELECT DISTINCT source_name FROM events').all().map(r => r.source_name);
  const activeSet = new Set([...activeLabels, ...activeLabels.map(l => l.toLowerCase())]);
  const inactive = allSources.filter(s => !activeSet.has(s));
  if (inactive.length > 0) {
    const ph = inactive.map(() => '?').join(', ');
    testDb.prepare(`DELETE FROM events WHERE source_name IN (${ph})`).run(...inactive);
  }

  const remaining = testDb.prepare('SELECT id FROM events').all();
  check('pruneInactiveSources keeps active events', remaining.some(r => r.id === 'evt-active'));
  check('pruneInactiveSources removes ticketmaster', !remaining.some(r => r.id === 'evt-stale'));
  check('pruneInactiveSources removes smallslive', !remaining.some(r => r.id === 'evt-stale2'));
  check('pruneInactiveSources leaves 1 event', remaining.length === 1);
  testDb.close();
}

module.exports = {};
