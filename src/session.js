// --- Session store ---
// Maps phone → { lastPicks, lastEvents, lastNeighborhood, ... } (12 fields + timestamp)
// In-memory Map + debounced disk write to data/sessions.json.
// Phone numbers hashed on disk via SHA-256 (same as preference-profile.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicWriteSync(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours
const SESSIONS_PATH = path.join(__dirname, '../data/sessions.json');

let writeTimer = null;

// Per-phone mutex to prevent concurrent request races (#16)
const phoneLocks = new Map();

async function acquireLock(phone) {
  while (phoneLocks.has(phone)) {
    await phoneLocks.get(phone);
  }
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  phoneLocks.set(phone, promise);
  return () => { phoneLocks.delete(phone); resolve(); };
}

// Test phone numbers excluded from disk persistence
const TEST_PHONE_PREFIX = '+1000000';

function isTestPhone(phone) {
  return phone.startsWith(TEST_PHONE_PREFIX);
}

function hashPhone(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
}

function getSession(phone) {
  // Check raw phone key first, then hashed key (from disk load)
  const s = sessions.get(phone) || sessions.get(hashPhone(phone));
  if (s && Date.now() - s.timestamp < SESSION_TTL) return s;
  return null;
}

function setSession(phone, data) {
  const existing = sessions.get(phone) || sessions.get(hashPhone(phone));
  sessions.set(phone, { ...existing, ...data, timestamp: Date.now() });
  scheduleDiskWrite();
}

/**
 * Atomically replace the full response state for a phone.
 * Unlike setSession (which merges), this replaces ALL event-related fields
 * so stale picks/filters/pending state can never survive a response transition.
 *
 * Only conversationHistory is preserved from the previous session.
 */
function setResponseState(phone, frame) {
  const existing = sessions.get(phone) || sessions.get(hashPhone(phone));
  sessions.set(phone, {
    conversationHistory: existing?.conversationHistory || [],
    lastPicks: frame.picks ?? [],
    allPicks: frame.allPicks ?? frame.picks ?? [],
    allOfferedIds: frame.offeredIds ?? [],
    lastEvents: frame.eventMap ?? {},
    lastNeighborhood: frame.neighborhood ?? null,
    lastFilters: frame.filters ?? null,
    lastBorough: frame.borough ?? null,
    visitedHoods: frame.visitedHoods ?? [],
    pendingNearby: frame.pendingNearby ?? null,
    pendingFilters: frame.pendingFilters ?? null,
    pendingMessage: frame.pendingMessage ?? null,
    lastResponseHadPicks: frame.lastResponseHadPicks ?? false,
    timestamp: Date.now(),
  });
  scheduleDiskWrite();
}

function clearSession(phone) {
  sessions.delete(phone);
  scheduleDiskWrite();
}

const MAX_HISTORY_TURNS = 10;

function addToHistory(phone, role, content, meta) {
  const session = sessions.get(phone) || sessions.get(hashPhone(phone));
  if (!session) return;
  if (!session.conversationHistory) session.conversationHistory = [];
  const entry = { role, content: content.slice(0, 300) };
  if (meta) entry.meta = meta;
  session.conversationHistory.push(entry);
  if (session.conversationHistory.length > MAX_HISTORY_TURNS) {
    session.conversationHistory = session.conversationHistory.slice(-MAX_HISTORY_TURNS);
  }
  session.timestamp = Date.now();
  scheduleDiskWrite();
}

// --- Disk persistence (debounced) ---

function scheduleDiskWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const data = {};
      const cutoff = Date.now() - SESSION_TTL;
      for (const [phone, session] of sessions) {
        // Skip expired and test phone sessions
        if (session.timestamp < cutoff) continue;
        if (isTestPhone(phone)) continue;

        const key = hashPhone(phone);
        data[key] = {
          conversationHistory: session.conversationHistory || [],
          lastPicks: session.lastPicks || [],
          allPicks: session.allPicks || [],
          allOfferedIds: session.allOfferedIds || [],
          lastEvents: session.lastEvents || {},
          lastNeighborhood: session.lastNeighborhood || null,
          lastFilters: session.lastFilters || null,
          lastBorough: session.lastBorough || null,
          visitedHoods: session.visitedHoods || [],
          pendingNearby: session.pendingNearby || null,
          pendingFilters: session.pendingFilters || null,
          pendingMessage: session.pendingMessage || null,
          timestamp: session.timestamp,
        };
      }
      atomicWriteSync(SESSIONS_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Session persist error:', err.message);
    }
  }, 2000);
}

/**
 * Load sessions from disk on boot.
 * Phone numbers are hashed on disk — we load with hashed keys.
 * Lookups still work because setSession/getSession use raw phones,
 * so disk-loaded sessions are keyed by hash and new sessions by raw phone.
 * On next write, the raw-phone sessions overwrite the hashed ones.
 */
function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    const cutoff = Date.now() - SESSION_TTL;
    let loaded = 0;
    for (const [hashedPhone, session] of Object.entries(data)) {
      // Skip expired sessions
      if (session.timestamp < cutoff) continue;
      sessions.set(hashedPhone, { ...session });
      loaded++;
    }
    console.log(`Loaded ${loaded} sessions from disk`);
  } catch {
    // File doesn't exist yet — normal on first boot
  }
}

/** Flush sessions to disk synchronously (for graceful shutdown). */
function flushSessions() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    const data = {};
    const cutoff = Date.now() - SESSION_TTL;
    for (const [phone, session] of sessions) {
      if (session.timestamp < cutoff) continue;
      if (isTestPhone(phone)) continue;
      const key = phone.startsWith('+') ? hashPhone(phone) : phone; // already hashed from disk
      data[key] = {
        conversationHistory: session.conversationHistory || [],
        lastPicks: session.lastPicks || [],
        allPicks: session.allPicks || [],
        allOfferedIds: session.allOfferedIds || [],
        lastEvents: session.lastEvents || {},
        lastNeighborhood: session.lastNeighborhood || null,
        lastDateRange: session.lastDateRange || null,
        lastFilters: session.lastFilters || null,
        lastBorough: session.lastBorough || null,
        visitedHoods: session.visitedHoods || [],
        pendingNearby: session.pendingNearby || null,
        pendingNearbyEvents: session.pendingNearbyEvents || null,
        pendingFilters: session.pendingFilters || null,
        pendingMessage: session.pendingMessage || null,
        timestamp: session.timestamp,
      };
    }
    atomicWriteSync(SESSIONS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Session flush error:', err.message);
  }
}

// Clean stale sessions every 10 minutes
const sessionInterval = setInterval(() => {
  try {
    const cutoff = Date.now() - SESSION_TTL;
    for (const [phone, data] of sessions) {
      if (data.timestamp < cutoff) sessions.delete(phone);
    }
  } catch (e) { console.error('Session cleanup error:', e); }
}, 10 * 60 * 1000);

function clearSessionInterval() {
  clearInterval(sessionInterval);
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

module.exports = { getSession, setSession, setResponseState, clearSession, addToHistory, clearSessionInterval, loadSessions, flushSessions, acquireLock, hashPhone };
