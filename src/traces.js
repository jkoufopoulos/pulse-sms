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
const RING_BUFFER_SIZE = 200;
const MAX_TRACE_FILES = 4;

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

module.exports = { startTrace, saveTrace, loadTraces, annotateTrace, getRecentTraces, getTraceById };
