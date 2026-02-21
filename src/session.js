// --- Session store for DETAILS/MORE/FREE ---
// Maps phone → { lastPicks, lastEvents, lastNeighborhood, timestamp }
const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours

function getSession(phone) {
  const s = sessions.get(phone);
  if (s && Date.now() - s.timestamp < SESSION_TTL) return s;
  return null;
}

function setSession(phone, data) {
  const existing = sessions.get(phone);
  sessions.set(phone, { ...existing, ...data, timestamp: Date.now() });
}

/**
 * Atomically replace the full response state for a phone.
 * Unlike setSession (which merges), this replaces ALL event-related fields
 * so stale picks/filters/pending state can never survive a response transition.
 *
 * Only conversationHistory is preserved from the previous session.
 */
function setResponseState(phone, frame) {
  const existing = sessions.get(phone);
  sessions.set(phone, {
    conversationHistory: existing?.conversationHistory || [],
    lastPicks: frame.picks ?? [],
    allPicks: frame.allPicks ?? frame.picks ?? [],
    allOfferedIds: frame.offeredIds ?? [],
    lastEvents: frame.eventMap ?? {},
    lastNeighborhood: frame.neighborhood ?? null,
    lastFilters: frame.filters ?? null,
    visitedHoods: frame.visitedHoods ?? [],
    pendingNearby: frame.pendingNearby ?? null,
    pendingNearbyEvents: frame.pendingNearbyEvents ?? null,
    pendingFilters: frame.pendingFilters ?? null,
    pendingMessage: frame.pendingMessage ?? null,
    timestamp: Date.now(),
  });
}

function clearSession(phone) {
  sessions.delete(phone);
}

const MAX_HISTORY_TURNS = 6;

function addToHistory(phone, role, content) {
  const session = sessions.get(phone);
  if (!session) return;
  if (!session.conversationHistory) session.conversationHistory = [];
  session.conversationHistory.push({ role, content: content.slice(0, 300) });
  if (session.conversationHistory.length > MAX_HISTORY_TURNS) {
    session.conversationHistory = session.conversationHistory.slice(-MAX_HISTORY_TURNS);
  }
  session.timestamp = Date.now();
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
}

module.exports = { getSession, setSession, setResponseState, clearSession, addToHistory, clearSessionInterval };
