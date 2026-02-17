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
  sessions.set(phone, { ...data, timestamp: Date.now() });
}

function clearSession(phone) {
  sessions.delete(phone);
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

module.exports = { getSession, setSession, clearSession, clearSessionInterval };
