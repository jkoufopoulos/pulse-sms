/**
 * Trace capture + filesystem persistence for Pulse eval system.
 *
 * Every SMS request through handleMessageAI() generates a trace.
 * Storage: JSONL files in data/traces/, one file per day, 4-file rotation.
 * In-memory ring buffer of 200 for fast UI access.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACES_DIR = path.join(__dirname, '..', 'data', 'traces');
const CONVERSATIONS_DIR = path.join(__dirname, '..', 'data', 'conversations');
const RING_BUFFER_SIZE = 200;
const MAX_TRACE_FILES = 4;
const CONVERSATION_IDLE_MS = 10 * 60 * 1000; // 10 minutes
const CONVERSATION_CHECK_MS = 5 * 60 * 1000; // check every 5 minutes

// In-memory ring buffer for fast access
const traceBuffer = [];

// Ensure traces directory exists
function ensureDir() {
  if (!fs.existsSync(TRACES_DIR)) {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
  }
}

/**
 * Get today's trace filename: traces-YYYY-MM-DD.jsonl
 */
function getTodayFilename() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return `traces-${d}.jsonl`;
}

/**
 * Start a new trace — returns a mutable trace object to fill in as the request flows.
 */
function startTrace(phone_masked, input_message) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    phone_masked,
    input_message,
    session_before: { lastNeighborhood: null, lastPicks: null },
    routing: { pre_routed: false, result: null, latency_ms: 0, raw_response: null },
    events: { cache_size: 0, candidates_count: 0, sent_to_claude: 0, candidate_ids: [], sent_ids: [], getEvents_ms: null },
    composition: { raw_response: null, latency_ms: 0, picks: null, not_picked_reason: null, neighborhood_used: null },
    output_sms: null,
    output_sms_length: 0,
    output_intent: null,
    total_latency_ms: 0,
    annotation: null,
  };
}

/**
 * Save a completed trace to disk (JSONL) and ring buffer.
 */
function saveTrace(trace) {
  // Add to ring buffer
  traceBuffer.push(trace);
  if (traceBuffer.length > RING_BUFFER_SIZE) {
    traceBuffer.shift();
  }

  // Write to JSONL file
  try {
    ensureDir();
    const filepath = path.join(TRACES_DIR, getTodayFilename());
    fs.appendFileSync(filepath, JSON.stringify(trace) + '\n');
    rotateTraceFiles();
  } catch (err) {
    console.error('Failed to save trace:', err.message);
  }

  // Thread into conversation (test mode only)
  recordConversationTurn(trace);
}

/**
 * Rotate trace files — keep only MAX_TRACE_FILES most recent.
 */
function rotateTraceFiles() {
  try {
    const files = fs.readdirSync(TRACES_DIR)
      .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    for (const file of files.slice(MAX_TRACE_FILES)) {
      fs.unlinkSync(path.join(TRACES_DIR, file));
    }
  } catch (err) {
    console.error('Trace rotation error:', err.message);
  }
}

/**
 * Load traces from disk into ring buffer (called at startup).
 */
function loadTraces() {
  try {
    ensureDir();
    const files = fs.readdirSync(TRACES_DIR)
      .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
      .sort(); // oldest first

    traceBuffer.length = 0;
    for (const file of files) {
      const lines = fs.readFileSync(path.join(TRACES_DIR, file), 'utf8')
        .split('\n')
        .filter(Boolean);
      for (const line of lines) {
        try {
          traceBuffer.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
    }

    // Trim to ring buffer size (keep most recent)
    while (traceBuffer.length > RING_BUFFER_SIZE) {
      traceBuffer.shift();
    }

    console.log(`Loaded ${traceBuffer.length} traces from disk`);
  } catch (err) {
    console.error('Failed to load traces:', err.message);
  }
}

/**
 * Annotate a trace by ID. Sets annotation field.
 * Returns true if found, false otherwise.
 */
function annotateTrace(traceId, annotation) {
  // Update in ring buffer
  const trace = traceBuffer.find(t => t.id === traceId);
  if (!trace) return false;

  trace.annotation = {
    verdict: annotation.verdict, // 'pass' | 'fail'
    failure_modes: annotation.failure_modes || [],
    notes: annotation.notes || '',
    annotated_at: new Date().toISOString(),
  };

  // Update on disk — rewrite the file containing this trace
  try {
    ensureDir();
    const files = fs.readdirSync(TRACES_DIR)
      .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'));

    for (const file of files) {
      const filepath = path.join(TRACES_DIR, file);
      const lines = fs.readFileSync(filepath, 'utf8').split('\n').filter(Boolean);
      let modified = false;

      const updated = lines.map(line => {
        try {
          const t = JSON.parse(line);
          if (t.id === traceId) {
            t.annotation = trace.annotation;
            modified = true;
            return JSON.stringify(t);
          }
          return line;
        } catch { return line; }
      });

      if (modified) {
        fs.writeFileSync(filepath, updated.join('\n') + '\n');
        break;
      }
    }
  } catch (err) {
    console.error('Failed to persist annotation:', err.message);
  }

  return true;
}

/**
 * Get recent traces from the ring buffer.
 * @param {number} limit - max traces to return (default 100)
 * @returns {Array} traces, newest first
 */
function getRecentTraces(limit = 100) {
  return traceBuffer.slice(-limit).reverse();
}

/**
 * Get a single trace by ID.
 */
function getTraceById(traceId) {
  return traceBuffer.find(t => t.id === traceId) || null;
}

/**
 * Get the most recent trace for a given masked phone number.
 */
function getLatestTraceForPhone(phone_masked) {
  for (let i = traceBuffer.length - 1; i >= 0; i--) {
    if (traceBuffer[i].phone_masked === phone_masked) return traceBuffer[i];
  }
  return null;
}

// --- Conversation capture (test mode only) ---

const conversations = new Map(); // phone_masked → { turns, lastActivity, startedAt }
let conversationFlushInterval = null;

/**
 * Record a conversation turn from a completed trace.
 * Only active in PULSE_TEST_MODE.
 */
function recordConversationTurn(trace) {
  if (process.env.PULSE_TEST_MODE !== 'true') return;

  const key = trace.phone_masked;
  if (!key) return;

  let conv = conversations.get(key);
  if (!conv) {
    conv = { turns: [], lastActivity: 0, startedAt: trace.timestamp };
    conversations.set(key, conv);
  }

  conv.turns.push({
    sender: 'user',
    message: trace.input_message,
    timestamp: trace.timestamp
  });

  if (trace.output_sms) {
    conv.turns.push({
      sender: 'pulse',
      message: trace.output_sms,
      timestamp: trace.timestamp,
      _meta: {
        intent: trace.output_intent,
        neighborhood: trace.routing?.resolved_neighborhood || trace.routing?.result?.neighborhood,
        pre_routed: trace.routing?.pre_routed,
        latency_ms: trace.total_latency_ms
      }
    });
  }

  conv.lastActivity = Date.now();
}

/**
 * Flush a single conversation to disk.
 */
function flushConversation(key, conv) {
  try {
    if (!fs.existsSync(CONVERSATIONS_DIR)) {
      fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    }
    const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const filepath = path.join(CONVERSATIONS_DIR, `conversations-${d}.jsonl`);
    const record = {
      phone_masked: key,
      started_at: conv.startedAt,
      ended_at: conv.turns[conv.turns.length - 1]?.timestamp || conv.startedAt,
      turn_count: conv.turns.length,
      turns: conv.turns
    };
    fs.appendFileSync(filepath, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('Failed to flush conversation:', err.message);
  }
}

/**
 * Flush idle conversations (no activity for CONVERSATION_IDLE_MS).
 */
function flushIdleConversations() {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    if (now - conv.lastActivity >= CONVERSATION_IDLE_MS) {
      flushConversation(key, conv);
      conversations.delete(key);
    }
  }
}

/**
 * Flush all active conversations to disk (called on shutdown).
 */
function flushAllConversations() {
  for (const [key, conv] of conversations) {
    flushConversation(key, conv);
  }
  conversations.clear();
}

/**
 * Start the idle-flush interval timer. Call once at startup (test mode only).
 */
function startConversationCapture() {
  if (process.env.PULSE_TEST_MODE !== 'true') return;
  if (conversationFlushInterval) return;
  conversationFlushInterval = setInterval(flushIdleConversations, CONVERSATION_CHECK_MS);
  conversationFlushInterval.unref(); // don't prevent process exit
  console.log('Conversation capture active (test mode)');
}

/**
 * Stop the idle-flush interval and flush remaining conversations.
 */
function stopConversationCapture() {
  if (conversationFlushInterval) {
    clearInterval(conversationFlushInterval);
    conversationFlushInterval = null;
  }
  flushAllConversations();
}

module.exports = {
  startTrace, saveTrace, loadTraces, annotateTrace, getRecentTraces, getTraceById, getLatestTraceForPhone,
  recordConversationTurn, startConversationCapture, stopConversationCapture
};
