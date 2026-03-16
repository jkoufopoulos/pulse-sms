/**
 * User preference profile — silent background signal capture.
 * Tracks cross-session patterns (neighborhoods, categories, price/time preferences)
 * without any user-facing changes. Fire-and-forget writes after saveResponseFrame.
 *
 * Storage: SQLite (user_profiles table in data/pulse.db).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./db');

const PROFILES_PATH = path.join(__dirname, '../data/profiles.json');

// E.164 format: + followed by 7-15 digits
const E164_RE = /^\+\d{7,15}$/;

// Test phone numbers excluded from persistence
const TEST_PHONE_PREFIX = '+1000000';

function isTestPhone(phone) {
  return phone.startsWith(TEST_PHONE_PREFIX);
}

function hashPhone(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
}

function blankProfile() {
  return {
    neighborhoods: {},
    categories: {},
    subcategories: {},
    sessionCount: 0,
    pricePreference: 'any',
    timePreference: 'any',
    freeSessionCount: 0,
    totalPicksSessionCount: 0,
    lateTimeCount: 0,
    earlyTimeCount: 0,
    timedSessionCount: 0,
    lastActiveDate: null,
    createdAt: null,
    proactiveOptIn: false,
    proactiveOptInDate: null,
    proactivePromptCount: 0,
  };
}

/** Convert a DB row to an in-memory profile object. */
function rowToProfile(row) {
  return {
    neighborhoods: JSON.parse(row.neighborhoods_json || '{}'),
    categories: JSON.parse(row.categories_json || '{}'),
    subcategories: JSON.parse(row.subcategories_json || '{}'),
    sessionCount: row.session_count,
    pricePreference: row.price_preference,
    timePreference: row.time_preference,
    freeSessionCount: row.free_session_count,
    totalPicksSessionCount: row.total_picks_session_count,
    lateTimeCount: row.late_time_count,
    earlyTimeCount: row.early_time_count,
    timedSessionCount: row.timed_session_count,
    lastActiveDate: row.last_active_date,
    createdAt: row.created_at,
    proactiveOptIn: !!row.proactive_opt_in,
    proactiveOptInDate: row.proactive_opt_in_date,
    proactivePromptCount: row.proactive_prompt_count,
  };
}

/** Convert an in-memory profile to DB row params. */
function profileToRow(phoneHash, phone, profile) {
  const now = new Date().toISOString();
  return {
    phone_hash: phoneHash,
    phone: phone || null,
    neighborhoods_json: JSON.stringify(profile.neighborhoods || {}),
    categories_json: JSON.stringify(profile.categories || {}),
    subcategories_json: JSON.stringify(profile.subcategories || {}),
    session_count: profile.sessionCount || 0,
    price_preference: profile.pricePreference || 'any',
    time_preference: profile.timePreference || 'any',
    free_session_count: profile.freeSessionCount || 0,
    total_picks_session_count: profile.totalPicksSessionCount || 0,
    late_time_count: profile.lateTimeCount || 0,
    early_time_count: profile.earlyTimeCount || 0,
    timed_session_count: profile.timedSessionCount || 0,
    last_active_date: profile.lastActiveDate || null,
    created_at: profile.createdAt || null,
    proactive_opt_in: profile.proactiveOptIn ? 1 : 0,
    proactive_opt_in_date: profile.proactiveOptInDate || null,
    proactive_prompt_count: profile.proactivePromptCount || 0,
    updated_at: now,
  };
}

function getProfile(phone) {
  try {
    const db = getDb();
    const hash = hashPhone(phone);
    const row = db.prepare('SELECT * FROM user_profiles WHERE phone_hash = ?').get(hash);
    return row ? rowToProfile(row) : blankProfile();
  } catch {
    return blankProfile();
  }
}

async function updateProfile(phone, { neighborhood, filters, responseType }) {
  try {
    if (!phone || !E164_RE.test(phone)) return;
    if (isTestPhone(phone)) return;

    const db = getDb();
    const hash = hashPhone(phone);
    const row = db.prepare('SELECT * FROM user_profiles WHERE phone_hash = ?').get(hash);
    const profile = row ? rowToProfile(row) : blankProfile();

    const now = new Date().toISOString().slice(0, 10);

    // Always: increment sessionCount, update dates
    profile.sessionCount++;
    profile.lastActiveDate = now;
    if (!profile.createdAt) profile.createdAt = now;

    // Only increment neighborhood/category on actual picks
    if (responseType === 'event_picks' || responseType === 'more') {
      if (neighborhood) {
        profile.neighborhoods[neighborhood] = (profile.neighborhoods[neighborhood] || 0) + 1;
      }
      if (filters?.category) {
        profile.categories[filters.category] = (profile.categories[filters.category] || 0) + 1;
      }
      if (filters?.subcategory) {
        profile.subcategories[filters.subcategory] = (profile.subcategories[filters.subcategory] || 0) + 1;
      }
      profile.totalPicksSessionCount++;
      if (filters?.free_only) {
        profile.freeSessionCount++;
      }
      if (filters?.time_after && /^\d{2}:\d{2}$/.test(filters.time_after)) {
        profile.timedSessionCount++;
        const hour = parseInt(filters.time_after.split(':')[0], 10);
        if (hour >= 21 || hour <= 5) {
          profile.lateTimeCount++;
        } else if (hour <= 20) {
          profile.earlyTimeCount++;
        }
      }

      // Recalculate derived fields
      if (profile.totalPicksSessionCount > 0) {
        profile.pricePreference = (profile.freeSessionCount / profile.totalPicksSessionCount) > 0.5 ? 'free' : 'any';
      }
      if (profile.timedSessionCount > 0) {
        if ((profile.lateTimeCount / profile.timedSessionCount) > 0.5) {
          profile.timePreference = 'late';
        } else if ((profile.earlyTimeCount / profile.timedSessionCount) > 0.5) {
          profile.timePreference = 'early';
        } else {
          profile.timePreference = 'any';
        }
      }
    }

    const params = profileToRow(hash, phone, profile);
    db.prepare(`
      INSERT OR REPLACE INTO user_profiles (
        phone_hash, phone, neighborhoods_json, categories_json, subcategories_json,
        session_count, price_preference, time_preference,
        free_session_count, total_picks_session_count,
        late_time_count, early_time_count, timed_session_count,
        last_active_date, created_at,
        proactive_opt_in, proactive_opt_in_date, proactive_prompt_count,
        updated_at
      ) VALUES (
        @phone_hash, @phone, @neighborhoods_json, @categories_json, @subcategories_json,
        @session_count, @price_preference, @time_preference,
        @free_session_count, @total_picks_session_count,
        @late_time_count, @early_time_count, @timed_session_count,
        @last_active_date, @created_at,
        @proactive_opt_in, @proactive_opt_in_date, @proactive_prompt_count,
        @updated_at
      )
    `).run(params);
  } catch (err) {
    console.error('Profile update error:', err.message);
  }
}

function deriveFiltersFromProfile(profile) {
  if (!profile || profile.sessionCount === 0) return {};

  const result = {};

  // Top category (merged categories + subcategories, ranked)
  const merged = {};
  for (const [cat, count] of Object.entries(profile.categories || {})) {
    merged[cat] = (merged[cat] || 0) + count;
  }
  for (const [sub, count] of Object.entries(profile.subcategories || {})) {
    merged[sub] = (merged[sub] || 0) + count;
  }
  const topCat = Object.entries(merged).sort((a, b) => b[1] - a[1])[0];
  if (topCat) result.category = topCat[0];

  if (profile.pricePreference === 'free') result.free_only = true;
  if (profile.timePreference === 'late') result.time_after = '21:00';
  if (profile.timePreference === 'early') result.time_after = '18:00';

  return result;
}

function getTopNeighborhood(profile) {
  if (!profile?.neighborhoods) return null;
  const entries = Object.entries(profile.neighborhoods);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function getTopCategories(profile, n = 3) {
  if (!profile) return [];
  const merged = {};
  for (const [cat, count] of Object.entries(profile.categories || {})) {
    merged[cat] = (merged[cat] || 0) + count;
  }
  for (const [sub, count] of Object.entries(profile.subcategories || {})) {
    merged[sub] = (merged[sub] || 0) + count;
  }
  return Object.entries(merged)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);
}

function getOptInEligibleUsers() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT phone FROM user_profiles WHERE proactive_opt_in = 1 AND phone IS NOT NULL').all();
    return rows.map(r => r.phone);
  } catch {
    return [];
  }
}

function setProactiveOptIn(phone, optIn) {
  if (!phone) return;
  try {
    const db = getDb();
    const hash = hashPhone(phone);
    const row = db.prepare('SELECT * FROM user_profiles WHERE phone_hash = ?').get(hash);
    const profile = row ? rowToProfile(row) : blankProfile();

    profile.proactiveOptIn = !!optIn;
    if (optIn) profile.proactiveOptInDate = new Date().toISOString();

    const params = profileToRow(hash, phone, profile);
    db.prepare(`
      INSERT OR REPLACE INTO user_profiles (
        phone_hash, phone, neighborhoods_json, categories_json, subcategories_json,
        session_count, price_preference, time_preference,
        free_session_count, total_picks_session_count,
        late_time_count, early_time_count, timed_session_count,
        last_active_date, created_at,
        proactive_opt_in, proactive_opt_in_date, proactive_prompt_count,
        updated_at
      ) VALUES (
        @phone_hash, @phone, @neighborhoods_json, @categories_json, @subcategories_json,
        @session_count, @price_preference, @time_preference,
        @free_session_count, @total_picks_session_count,
        @late_time_count, @early_time_count, @timed_session_count,
        @last_active_date, @created_at,
        @proactive_opt_in, @proactive_opt_in_date, @proactive_prompt_count,
        @updated_at
      )
    `).run(params);
  } catch (err) {
    console.error('setProactiveOptIn error:', err.message);
  }
}

function incrementProactivePromptCount(phone) {
  if (!phone) return;
  try {
    const db = getDb();
    const hash = hashPhone(phone);
    const row = db.prepare('SELECT * FROM user_profiles WHERE phone_hash = ?').get(hash);
    const profile = row ? rowToProfile(row) : blankProfile();

    profile.proactivePromptCount = (profile.proactivePromptCount || 0) + 1;

    const params = profileToRow(hash, phone, profile);
    db.prepare(`
      INSERT OR REPLACE INTO user_profiles (
        phone_hash, phone, neighborhoods_json, categories_json, subcategories_json,
        session_count, price_preference, time_preference,
        free_session_count, total_picks_session_count,
        late_time_count, early_time_count, timed_session_count,
        last_active_date, created_at,
        proactive_opt_in, proactive_opt_in_date, proactive_prompt_count,
        updated_at
      ) VALUES (
        @phone_hash, @phone, @neighborhoods_json, @categories_json, @subcategories_json,
        @session_count, @price_preference, @time_preference,
        @free_session_count, @total_picks_session_count,
        @late_time_count, @early_time_count, @timed_session_count,
        @last_active_date, @created_at,
        @proactive_opt_in, @proactive_opt_in_date, @proactive_prompt_count,
        @updated_at
      )
    `).run(params);
  } catch (err) {
    console.error('incrementProactivePromptCount error:', err.message);
  }
}

/**
 * Migration: load profiles from JSON into SQLite if table is empty.
 * Called at server boot. No-op if already migrated or no JSON file.
 */
function loadProfiles() {
  try {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as n FROM user_profiles').get().n;
    if (count > 0) {
      console.log(`Loaded ${count} user profiles from SQLite`);
      return;
    }

    // Migrate from profiles.json if it exists
    if (!fs.existsSync(PROFILES_PATH)) return;

    const data = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    const entries = Object.entries(data);
    if (entries.length === 0) return;

    const tx = db.transaction(() => {
      for (const [key, profile] of entries) {
        const hash = key.length === 16 ? key : hashPhone(key);
        // key might be a raw phone or a hash; store phone only if it looks like E.164
        const phone = E164_RE.test(key) ? key : null;
        const params = profileToRow(hash, phone, profile);
        db.prepare(`
          INSERT OR IGNORE INTO user_profiles (
            phone_hash, phone, neighborhoods_json, categories_json, subcategories_json,
            session_count, price_preference, time_preference,
            free_session_count, total_picks_session_count,
            late_time_count, early_time_count, timed_session_count,
            last_active_date, created_at,
            proactive_opt_in, proactive_opt_in_date, proactive_prompt_count,
            updated_at
          ) VALUES (
            @phone_hash, @phone, @neighborhoods_json, @categories_json, @subcategories_json,
            @session_count, @price_preference, @time_preference,
            @free_session_count, @total_picks_session_count,
            @late_time_count, @early_time_count, @timed_session_count,
            @last_active_date, @created_at,
            @proactive_opt_in, @proactive_opt_in_date, @proactive_prompt_count,
            @updated_at
          )
        `).run(params);
      }
    });
    tx();

    console.log(`Migrated ${entries.length} profiles from JSON to SQLite`);

    // Rename old file
    const migratedPath = PROFILES_PATH + '.migrated';
    try { fs.renameSync(PROFILES_PATH, migratedPath); } catch {}
  } catch (err) {
    console.error('loadProfiles error:', err.message);
  }
}

function exportProfiles() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM user_profiles').all();
    const data = {};
    for (const row of rows) {
      const key = row.phone || row.phone_hash;
      data[key] = rowToProfile(row);
    }
    return data;
  } catch {
    return {};
  }
}

// For testing: clear all profiles from SQLite
function _resetForTest() {
  try {
    const db = getDb();
    db.prepare('DELETE FROM user_profiles').run();
  } catch {
    // DB not initialized yet — safe to ignore
  }
}

module.exports = {
  getProfile,
  updateProfile,
  deriveFiltersFromProfile,
  getTopNeighborhood,
  getTopCategories,
  getOptInEligibleUsers,
  setProactiveOptIn,
  incrementProactivePromptCount,
  loadProfiles,
  exportProfiles,
  hashPhone,
  _resetForTest,
};
