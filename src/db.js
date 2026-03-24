const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { makeEventId } = require('./sources/shared');

const DB_PATH = path.join(__dirname, '../data/pulse.db');
let db = null;

// --- Connection lifecycle ---

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}

function closeDb() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}

// --- Schema migrations ---

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
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

    CREATE TABLE IF NOT EXISTS recurring_patterns (
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

    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date_local);
    CREATE INDEX IF NOT EXISTS idx_events_neighborhood ON events(neighborhood);
    CREATE INDEX IF NOT EXISTS idx_patterns_day ON recurring_patterns(day_of_week);
    CREATE INDEX IF NOT EXISTS idx_patterns_active ON recurring_patterns(active_until, deactivated);

    CREATE TABLE IF NOT EXISTS daily_digests (
      id TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      report TEXT NOT NULL,
      email_sent INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_masked TEXT NOT NULL,
      label TEXT,
      first_message TEXT,
      started_at TEXT,
      saved_at TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      turns TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_saved ON conversations(saved_at);

    CREATE TABLE IF NOT EXISTS scraped_events (
      event_id TEXT NOT NULL,
      scraped_date TEXT NOT NULL,
      source_name TEXT,
      name TEXT,
      venue_name TEXT,
      neighborhood TEXT,
      date_local TEXT,
      start_time_local TEXT,
      category TEXT,
      subcategory TEXT,
      is_free INTEGER DEFAULT 0,
      price_display TEXT,
      source_weight REAL,
      extraction_confidence REAL,
      completeness REAL,
      description_short TEXT,
      source_url TEXT,
      ticket_url TEXT,
      editorial_note TEXT,
      data_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, scraped_date)
    );

    CREATE INDEX IF NOT EXISTS idx_scraped_venue_date ON scraped_events(venue_name, date_local);
    CREATE INDEX IF NOT EXISTS idx_scraped_cat_hood_date ON scraped_events(category, neighborhood, date_local);
    CREATE INDEX IF NOT EXISTS idx_scraped_scraped_date ON scraped_events(scraped_date);

    CREATE TABLE IF NOT EXISTS event_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_hash TEXT NOT NULL,
      event_id TEXT NOT NULL,
      recommended_at TEXT NOT NULL,
      user_engaged INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_recs_phone ON event_recommendations(phone_hash, recommended_at);
    CREATE INDEX IF NOT EXISTS idx_recs_event ON event_recommendations(event_id);

    CREATE TABLE IF NOT EXISTS nudge_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_hash TEXT NOT NULL,
      phone TEXT NOT NULL,
      pattern_key TEXT NOT NULL,
      detail_count INTEGER DEFAULT 1,
      consent_asked INTEGER DEFAULT 0,
      opted_in INTEGER DEFAULT 0,
      opted_out INTEGER DEFAULT 0,
      last_nudged TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(phone_hash, pattern_key)
    );

    CREATE INDEX IF NOT EXISTS idx_nudge_phone ON nudge_subscriptions(phone_hash);
    CREATE INDEX IF NOT EXISTS idx_nudge_optin ON nudge_subscriptions(opted_in, opted_out);

    CREATE TABLE IF NOT EXISTS places (
      place_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      neighborhood TEXT,
      lat REAL,
      lng REAL,
      place_type TEXT,
      price_level INTEGER,
      rating REAL,
      user_ratings_total INTEGER,
      google_maps_url TEXT,
      editorial_summary TEXT,
      serves_beer INTEGER DEFAULT 0,
      serves_wine INTEGER DEFAULT 0,
      serves_cocktails INTEGER DEFAULT 0,
      outdoor_seating INTEGER DEFAULT 0,
      good_for_groups INTEGER DEFAULT 0,
      live_music INTEGER DEFAULT 0,
      open_hours_json TEXT,
      cached_at TEXT NOT NULL,
      neighborhood_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_places_hood ON places(neighborhood);
    CREATE INDEX IF NOT EXISTS idx_places_cache_key ON places(neighborhood_key, cached_at);

    CREATE TABLE IF NOT EXISTS user_profiles (
      phone_hash TEXT PRIMARY KEY,
      phone TEXT,
      neighborhoods_json TEXT NOT NULL DEFAULT '{}',
      categories_json TEXT NOT NULL DEFAULT '{}',
      subcategories_json TEXT NOT NULL DEFAULT '{}',
      session_count INTEGER NOT NULL DEFAULT 0,
      price_preference TEXT NOT NULL DEFAULT 'any',
      time_preference TEXT NOT NULL DEFAULT 'any',
      free_session_count INTEGER NOT NULL DEFAULT 0,
      total_picks_session_count INTEGER NOT NULL DEFAULT 0,
      late_time_count INTEGER NOT NULL DEFAULT 0,
      early_time_count INTEGER NOT NULL DEFAULT 0,
      timed_session_count INTEGER NOT NULL DEFAULT 0,
      last_active_date TEXT,
      created_at TEXT,
      proactive_opt_in INTEGER NOT NULL DEFAULT 0,
      proactive_opt_in_date TEXT,
      proactive_prompt_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);

  // Migration: add normalized_name column for recurrence detection
  try {
    db.prepare("SELECT normalized_name FROM events LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE events ADD COLUMN normalized_name TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_norm_name ON events(normalized_name, venue_name, date_local)");
    // Backfill existing rows
    const rows = db.prepare("SELECT id, name FROM events WHERE normalized_name IS NULL").all();
    if (rows.length > 0) {
      const update = db.prepare("UPDATE events SET normalized_name = ? WHERE id = ?");
      const tx = db.transaction(() => {
        for (const r of rows) {
          update.run(normalizePatternName(r.name), r.id);
        }
      });
      tx();
      console.log(`Backfilled normalized_name for ${rows.length} events`);
    }
  }
}

// --- Event CRUD ---

const EVENT_COLUMNS = [
  'id', 'source_name', 'source_type', 'source_weight', 'source_tier',
  'name', 'normalized_name', 'description_short', 'short_detail', 'venue_name', 'venue_address',
  'neighborhood', 'start_time_local', 'end_time_local', 'date_local', 'time_window',
  'is_free', 'price_display', 'category', 'subcategory',
  'extraction_confidence', 'completeness', 'needs_review',
  'ticket_url', 'source_url', 'map_url', 'map_hint', 'evidence',
  'scraped_at', 'updated_at',
];

function eventToRow(e) {
  const now = new Date().toISOString();
  return {
    id: e.id,
    source_name: e.source_name || null,
    source_type: e.source_type || null,
    source_weight: e.source_weight ?? null,
    source_tier: e.source_tier || null,
    name: e.name,
    normalized_name: normalizePatternName(e.name),
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

/**
 * Batch upsert events. Higher source_weight wins on conflict.
 */
function upsertEvents(events) {
  const d = getDb();
  const insert = d.prepare(`
    INSERT INTO events (${EVENT_COLUMNS.join(', ')})
    VALUES (${EVENT_COLUMNS.map(c => '@' + c).join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      source_name = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.source_name ELSE events.source_name END,
      source_type = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.source_type ELSE events.source_type END,
      source_weight = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.source_weight ELSE events.source_weight END,
      source_tier = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.source_tier ELSE events.source_tier END,
      name = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.name ELSE events.name END,
      description_short = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.description_short ELSE events.description_short END,
      short_detail = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.short_detail ELSE events.short_detail END,
      venue_name = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.venue_name ELSE events.venue_name END,
      venue_address = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.venue_address ELSE events.venue_address END,
      neighborhood = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.neighborhood ELSE events.neighborhood END,
      start_time_local = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.start_time_local ELSE events.start_time_local END,
      end_time_local = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.end_time_local ELSE events.end_time_local END,
      date_local = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.date_local ELSE events.date_local END,
      time_window = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.time_window ELSE events.time_window END,
      is_free = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.is_free ELSE events.is_free END,
      price_display = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.price_display ELSE events.price_display END,
      category = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.category ELSE events.category END,
      subcategory = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.subcategory ELSE events.subcategory END,
      extraction_confidence = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.extraction_confidence ELSE events.extraction_confidence END,
      completeness = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.completeness ELSE events.completeness END,
      needs_review = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.needs_review ELSE events.needs_review END,
      ticket_url = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.ticket_url ELSE events.ticket_url END,
      source_url = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.source_url ELSE events.source_url END,
      map_url = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.map_url ELSE events.map_url END,
      map_hint = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.map_hint ELSE events.map_hint END,
      evidence = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.evidence ELSE events.evidence END,
      scraped_at = CASE WHEN excluded.source_weight >= events.source_weight OR events.source_weight IS NULL THEN excluded.scraped_at ELSE events.scraped_at END,
      updated_at = excluded.updated_at
  `);

  const tx = d.transaction((rows) => {
    for (const row of rows) {
      insert.run(row);
    }
  });

  tx(events.map(eventToRow));
}

/**
 * Get events within a date range (inclusive). Returns app-format objects.
 */
function getEventsInRange(startDate, endDate) {
  const d = getDb();
  const rows = d.prepare(
    'SELECT * FROM events WHERE date_local >= ? AND date_local <= ?'
  ).all(startDate, endDate);
  return rows.map(rowToEvent);
}

/**
 * Get a single event by ID.
 */
function getEventByIdFromDb(id) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM events WHERE id = ?').get(id);
  return row ? rowToEvent(row) : null;
}

/**
 * Delete events with date_local before cutoffDate.
 */
function pruneOldEvents(cutoffDate) {
  const d = getDb();
  const result = d.prepare('DELETE FROM events WHERE date_local < ? AND date_local IS NOT NULL').run(cutoffDate);
  if (result.changes > 0) {
    console.log(`Pruned ${result.changes} events older than ${cutoffDate}`);
  }
  return result.changes;
}

/**
 * Delete events from specific sources (used by refreshSources before re-upserting).
 */
function deleteEventsBySource(sourceNames) {
  const d = getDb();
  const placeholders = sourceNames.map(() => '?').join(', ');
  // Match both lower-case and original-case source names
  const allNames = [...new Set([
    ...sourceNames,
    ...sourceNames.map(s => s.toLowerCase()),
  ])];
  const ph = allNames.map(() => '?').join(', ');
  return d.prepare(`DELETE FROM events WHERE source_name IN (${ph})`).run(...allNames).changes;
}

/**
 * Delete events from sources NOT in the active registry.
 * Called at boot and after each scrape to enforce registry as single source of truth.
 */
function pruneInactiveSources(activeLabels) {
  const d = getDb();
  const activeSet = new Set(activeLabels);

  // Prune events table
  const allEventSources = d.prepare('SELECT DISTINCT source_name FROM events').all().map(r => r.source_name);
  const inactiveEvents = allEventSources.filter(s => !activeSet.has(s));
  if (inactiveEvents.length > 0) {
    const ph = inactiveEvents.map(() => '?').join(', ');
    const result = d.prepare(`DELETE FROM events WHERE source_name IN (${ph})`).run(...inactiveEvents);
    if (result.changes > 0) {
      console.log(`Pruned ${result.changes} events from inactive sources: ${inactiveEvents.join(', ')}`);
    }
  }

  // Prune recurring_patterns table
  const allPatternSources = d.prepare('SELECT DISTINCT source_name FROM recurring_patterns').all().map(r => r.source_name);
  const inactivePatterns = allPatternSources.filter(s => !activeSet.has(s));
  if (inactivePatterns.length > 0) {
    const ph = inactivePatterns.map(() => '?').join(', ');
    const result = d.prepare(`DELETE FROM recurring_patterns WHERE source_name IN (${ph})`).run(...inactivePatterns);
    if (result.changes > 0) {
      console.log(`Pruned ${result.changes} recurring patterns from inactive sources: ${inactivePatterns.join(', ')}`);
    }
  }
}

// --- Recurring patterns ---

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function normalizePatternName(name) {
  return (name || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function makePatternKey(name, venue, dayOfWeek) {
  return `${normalizePatternName(name)}|${(venue || '').toLowerCase().trim()}|${dayOfWeek}`;
}

/**
 * Add 6 months to an ISO date string. Returns YYYY-MM-DD.
 */
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Upsert a recurring pattern. Sets active_until to last_confirmed + 6 months.
 */
function upsertPattern(pattern) {
  const d = getDb();
  const now = new Date().toISOString();
  const dayNum = typeof pattern.day_of_week === 'string'
    ? DAY_NAMES.indexOf(pattern.day_of_week.toLowerCase())
    : pattern.day_of_week;
  if (dayNum < 0 || dayNum > 6) return;

  const key = makePatternKey(pattern.name, pattern.venue_name, dayNum);
  const lastConfirmed = pattern.last_confirmed || now.slice(0, 10);
  const activeUntil = addMonths(lastConfirmed, 6);

  d.prepare(`
    INSERT INTO recurring_patterns (
      pattern_key, name, venue_name, venue_address, neighborhood,
      day_of_week, time_local, end_time_local, category, subcategory,
      is_free, price_display, description_short, source_name,
      source_url, ticket_url, extraction_confidence,
      first_seen, last_confirmed, active_until, deactivated,
      created_at, updated_at
    ) VALUES (
      @pattern_key, @name, @venue_name, @venue_address, @neighborhood,
      @day_of_week, @time_local, @end_time_local, @category, @subcategory,
      @is_free, @price_display, @description_short, @source_name,
      @source_url, @ticket_url, @extraction_confidence,
      @first_seen, @last_confirmed, @active_until, 0,
      @created_at, @updated_at
    )
    ON CONFLICT(pattern_key) DO UPDATE SET
      last_confirmed = excluded.last_confirmed,
      active_until = excluded.active_until,
      description_short = COALESCE(excluded.description_short, recurring_patterns.description_short),
      source_url = COALESCE(excluded.source_url, recurring_patterns.source_url),
      ticket_url = COALESCE(excluded.ticket_url, recurring_patterns.ticket_url),
      extraction_confidence = COALESCE(excluded.extraction_confidence, recurring_patterns.extraction_confidence),
      neighborhood = COALESCE(excluded.neighborhood, recurring_patterns.neighborhood),
      deactivated = 0,
      updated_at = excluded.updated_at
  `).run({
    pattern_key: key,
    name: pattern.name,
    venue_name: pattern.venue_name,
    venue_address: pattern.venue_address || null,
    neighborhood: pattern.neighborhood || null,
    day_of_week: dayNum,
    time_local: pattern.time_local || null,
    end_time_local: pattern.end_time_local || null,
    category: pattern.category || null,
    subcategory: pattern.subcategory || null,
    is_free: pattern.is_free ? 1 : 0,
    price_display: pattern.price_display || null,
    description_short: pattern.description_short || null,
    source_name: pattern.source_name || 'yutori',
    source_url: pattern.source_url || null,
    ticket_url: pattern.ticket_url || null,
    extraction_confidence: pattern.extraction_confidence ?? null,
    first_seen: lastConfirmed,
    last_confirmed: lastConfirmed,
    active_until: activeUntil,
    created_at: now,
    updated_at: now,
  });
}

/**
 * Get all active (non-expired, non-deactivated) recurring patterns.
 */
function getActivePatterns() {
  const d = getDb();
  const today = new Date().toISOString().slice(0, 10);
  return d.prepare(
    'SELECT * FROM recurring_patterns WHERE active_until >= ? AND deactivated = 0'
  ).all(today);
}

/**
 * Generate event occurrences from active recurring patterns for a date range.
 * Uses makeEventId so IDs match scraped one-offs for natural dedup.
 */
function generateOccurrences(startDate, endDate) {
  const patterns = getActivePatterns();
  if (patterns.length === 0) return [];

  const events = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T23:59:59');

  for (const p of patterns) {
    // Walk each day in range, emit occurrence when day_of_week matches
    const cursor = new Date(start);
    while (cursor <= end) {
      if (cursor.getDay() === p.day_of_week) {
        const dateLocal = cursor.toISOString().slice(0, 10);

        let startTime = null;
        let endTime = null;
        if (p.time_local) {
          startTime = `${dateLocal}T${p.time_local}:00`;
        }
        if (p.end_time_local) {
          endTime = `${dateLocal}T${p.end_time_local}:00`;
        }
        const id = makeEventId(p.name, p.venue_name, dateLocal, null, null, startTime);

        events.push({
          id,
          source_name: p.source_name || 'recurring',
          source_type: 'recurring',
          source_weight: 0.65,
          source_tier: 'secondary',
          name: p.name,
          description_short: p.description_short || null,
          short_detail: p.description_short || null,
          venue_name: p.venue_name,
          venue_address: p.venue_address || null,
          neighborhood: p.neighborhood || null,
          start_time_local: startTime,
          end_time_local: endTime,
          date_local: dateLocal,
          time_window: p.time_local ? (parseInt(p.time_local) >= 21 ? 'late_night' : 'evening') : 'evening',
          is_free: !!p.is_free,
          price_display: p.price_display || null,
          category: p.category || 'other',
          subcategory: p.subcategory || null,
          extraction_confidence: p.extraction_confidence ?? 0.7,
          completeness: 0.85,
          needs_review: false,
          ticket_url: p.ticket_url || null,
          source_url: p.source_url || null,
          map_url: null,
          map_hint: null,
          evidence: null,
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return events;
}

// --- Cross-source recurrence detection ---

/**
 * Detect recurring events from historical data in the events table.
 * Groups by normalized_name + venue_name + day_of_week, finds groups appearing
 * on 2+ distinct dates in the last 30 days, and upserts them as patterns.
 */
function detectRecurringPatterns() {
  const d = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = d.prepare(`
    SELECT
      normalized_name,
      venue_name,
      CAST(strftime('%w', date_local) AS INTEGER) as day_of_week,
      COUNT(DISTINCT date_local) as occurrence_count,
      MAX(date_local) as last_seen,
      MIN(date_local) as first_seen,
      -- Pick representative fields from the most recent occurrence
      MAX(neighborhood) as neighborhood,
      MAX(category) as category,
      MAX(subcategory) as subcategory,
      MAX(is_free) as is_free,
      MAX(price_display) as price_display,
      MAX(description_short) as description_short,
      MAX(source_name) as source_name,
      MAX(source_url) as source_url,
      MAX(ticket_url) as ticket_url,
      MAX(extraction_confidence) as extraction_confidence,
      -- Get start time from the most common time
      MAX(SUBSTR(start_time_local, 12, 5)) as time_local
    FROM events
    WHERE date_local >= ?
      AND normalized_name IS NOT NULL
      AND normalized_name != ''
      AND venue_name IS NOT NULL
      AND venue_name != ''
    GROUP BY normalized_name, venue_name, CAST(strftime('%w', date_local) AS INTEGER)
    HAVING COUNT(DISTINCT date_local) >= 2
  `).all(cutoffStr);

  let count = 0;
  for (const row of rows) {
    upsertPattern({
      name: row.normalized_name,
      venue_name: row.venue_name,
      neighborhood: row.neighborhood,
      day_of_week: row.day_of_week,
      time_local: row.time_local || null,
      category: row.category,
      subcategory: row.subcategory,
      is_free: !!row.is_free,
      price_display: row.price_display,
      description_short: row.description_short,
      source_name: row.source_name,
      source_url: row.source_url,
      ticket_url: row.ticket_url,
      extraction_confidence: row.extraction_confidence,
      last_confirmed: row.last_seen,
    });
    count++;
  }

  if (count > 0) {
    console.log(`Recurrence detection: ${count} patterns found from historical data`);
  }
  return count;
}

/**
 * Process events with _raw recurrence markers and upsert as patterns.
 * Shared by Yutori, NYC Trivia League, and any future scrapers that know
 * their events are recurring.
 */
function processRecurrencePatterns(events, sourceName) {
  const recurring = events.filter(e => {
    const isRec = e.is_recurring || e._raw?.is_recurring;
    const day = e.recurrence_day ?? e._raw?.recurrence_day;
    return isRec && day != null;
  });
  if (recurring.length === 0) return 0;

  let count = 0;
  for (const e of recurring) {
    upsertPattern({
      name: e.name,
      venue_name: e.venue_name || 'TBA',
      venue_address: e.venue_address || null,
      neighborhood: e.neighborhood || null,
      day_of_week: e.recurrence_day ?? e._raw?.recurrence_day,
      time_local: e.recurrence_time ?? (e._raw?.recurrence_time || null),
      end_time_local: null,
      category: e.category || null,
      subcategory: e.subcategory || null,
      is_free: e.is_free || false,
      price_display: e.price_display || null,
      description_short: e.description_short || null,
      source_name: sourceName,
      source_url: e.source_url || null,
      ticket_url: e.ticket_url || null,
      extraction_confidence: e.extraction_confidence ?? null,
      last_confirmed: new Date().toISOString().slice(0, 10),
    });
    count++;
  }
  if (count > 0) {
    console.log(`${sourceName}: ${count} recurring patterns upserted`);
  }
  return count;
}

/**
 * Get a Set of pattern_keys for all active patterns.
 * Used for fast lookup when stamping is_recurring on serving cache events.
 */
function getActivePatternKeys() {
  const patterns = getActivePatterns();
  return new Set(patterns.map(p => p.pattern_key));
}

/**
 * Get count of active recurring patterns + day-of-week labels for health dashboard.
 */
function getPatternCount() {
  const d = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = d.prepare(
    'SELECT COUNT(*) as total FROM recurring_patterns WHERE active_until >= ? AND deactivated = 0'
  ).get(today);
  return row.total;
}

// --- Migration: import from JSON cache ---

/**
 * One-time import of existing events-cache.json into SQLite.
 * Only runs if the events table is empty.
 */
function importFromJsonCache(cachePath) {
  const d = getDb();
  const count = d.prepare('SELECT COUNT(*) as n FROM events').get().n;
  if (count > 0) return 0;

  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const cached = JSON.parse(raw);
    if (!cached.events || cached.events.length === 0) return 0;

    upsertEvents(cached.events);
    console.log(`Imported ${cached.events.length} events from JSON cache into SQLite`);
    return cached.events.length;
  } catch (err) {
    console.warn('Failed to import JSON cache into SQLite:', err.message);
    return 0;
  }
}

// --- Daily digests ---

function saveDigest(id, status, report) {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO daily_digests (id, generated_at, status, report, email_sent)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, new Date().toISOString(), status, JSON.stringify(report));
}

function markDigestEmailed(id) {
  const d = getDb();
  d.prepare('UPDATE daily_digests SET email_sent = 1 WHERE id = ?').run(id);
}

function getDigests(limit = 30) {
  const d = getDb();
  return d.prepare('SELECT * FROM daily_digests ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
    ...row,
    report: JSON.parse(row.report),
    email_sent: !!row.email_sent,
  }));
}

function getYesterdayDigest() {
  const d = getDb();
  const rows = d.prepare('SELECT * FROM daily_digests ORDER BY id DESC LIMIT 2').all();
  if (rows.length < 2) return null;
  return { ...rows[1], report: JSON.parse(rows[1].report) };
}

// --- Conversations ---

function saveConversationToDb({ phone_masked, label, first_message, started_at, turn_count, turns }) {
  const d = getDb();
  const saved_at = new Date().toISOString();
  const result = d.prepare(`
    INSERT INTO conversations (phone_masked, label, first_message, started_at, saved_at, turn_count, turns)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(phone_masked, label || null, first_message || null, started_at || null, saved_at, turn_count, JSON.stringify(turns));
  return { ok: true, id: result.lastInsertRowid, turn_count };
}

function getSavedConversations(id) {
  const d = getDb();
  if (id) {
    const row = d.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, turns: JSON.parse(row.turns) };
  }
  return d.prepare(
    'SELECT id, phone_masked, label, first_message, started_at, saved_at, turn_count FROM conversations ORDER BY saved_at DESC'
  ).all();
}

// --- Scraped events (historical persistence) ---

/**
 * Batch insert events into scraped_events for historical persistence.
 * Uses INSERT OR IGNORE so (event_id, scraped_date) dedup is enforced.
 * This is append-only storage — not used in the serving hot path.
 */
function insertScrapedEvents(events, scrapedDate) {
  if (!events?.length) return 0;
  const d = getDb();
  const date = scrapedDate || new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const insert = d.prepare(`
    INSERT OR IGNORE INTO scraped_events (
      event_id, scraped_date, source_name, name, venue_name, neighborhood,
      date_local, start_time_local, category, subcategory, is_free, price_display,
      source_weight, extraction_confidence, completeness, description_short,
      source_url, ticket_url, editorial_note, data_json, created_at
    ) VALUES (
      @event_id, @scraped_date, @source_name, @name, @venue_name, @neighborhood,
      @date_local, @start_time_local, @category, @subcategory, @is_free, @price_display,
      @source_weight, @extraction_confidence, @completeness, @description_short,
      @source_url, @ticket_url, @editorial_note, @data_json, @created_at
    )
  `);

  const tx = d.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      const result = insert.run(row);
      count += result.changes;
    }
    return count;
  });

  const rows = events.map(e => ({
    event_id: e.id,
    scraped_date: date,
    source_name: e.source_name || null,
    name: e.name || null,
    venue_name: e.venue_name || null,
    neighborhood: e.neighborhood || null,
    date_local: e.date_local || null,
    start_time_local: e.start_time_local || null,
    category: e.category || null,
    subcategory: e.subcategory || null,
    is_free: e.is_free ? 1 : 0,
    price_display: e.price_display || null,
    source_weight: e.source_weight ?? null,
    extraction_confidence: e.extraction_confidence ?? null,
    completeness: e.completeness ?? null,
    description_short: e.description_short || e.short_detail || null,
    source_url: e.source_url || null,
    ticket_url: e.ticket_url || null,
    editorial_note: e.editorial_note || null,
    data_json: JSON.stringify(e),
    created_at: now,
  }));

  const inserted = tx(rows);
  if (inserted > 0) {
    console.log(`Persisted ${inserted} events to scraped_events (date: ${date})`);
  }
  return inserted;
}

// --- Event recommendations ---

/**
 * Record that events were recommended to a user.
 * phone_hash should be SHA-256 prefix (same as session.js hashPhone).
 */
function insertRecommendations(phoneHash, eventIds) {
  if (!phoneHash || !eventIds?.length) return 0;
  const d = getDb();
  const now = new Date().toISOString();

  const insert = d.prepare(`
    INSERT INTO event_recommendations (phone_hash, event_id, recommended_at, user_engaged)
    VALUES (?, ?, ?, 0)
  `);

  const tx = d.transaction((ids) => {
    for (const id of ids) {
      insert.run(phoneHash, id, now);
    }
    return ids.length;
  });

  return tx(eventIds);
}

/**
 * Mark that a user engaged with a recommended event (asked for details, responded positively).
 */
function markRecommendationEngaged(phoneHash, eventId) {
  if (!phoneHash || !eventId) return;
  const d = getDb();
  d.prepare(`
    UPDATE event_recommendations SET user_engaged = 1
    WHERE phone_hash = ? AND event_id = ?
    AND user_engaged = 0
  `).run(phoneHash, eventId);
}

module.exports = {
  getDb,
  closeDb,
  upsertEvents,
  getEventsInRange,
  getEventByIdFromDb,
  pruneOldEvents,
  deleteEventsBySource,
  pruneInactiveSources,
  upsertPattern,
  getActivePatterns,
  generateOccurrences,
  detectRecurringPatterns,
  processRecurrencePatterns,
  getActivePatternKeys,
  getPatternCount,
  importFromJsonCache,
  saveDigest,
  markDigestEmailed,
  getDigests,
  getYesterdayDigest,
  saveConversationToDb,
  getSavedConversations,
  insertScrapedEvents,
  insertRecommendations,
  markRecommendationEngaged,
  // Exposed for testing
  makePatternKey,
  normalizePatternName,
  addMonths,
  DAY_NAMES,
};
