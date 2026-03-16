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
const RING_BUFFER_SIZE = 500;

// Per-token pricing by provider (shared source of truth)
const PRICING = {
  anthropic: { input: 1.00 / 1_000_000, output: 5.00 / 1_000_000 },  // Haiku 4.5
  gemini:    { input: 0.10 / 1_000_000, output: 0.40 / 1_000_000 },  // Gemini 2.5 Flash
};
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
    routing: { pre_routed: false, result: null, latency_ms: 0, raw_response: null, model_routing: null },
    events: { cache_size: 0, candidates_count: 0, sent_to_claude: 0, candidate_ids: [], sent_ids: [], getEvents_ms: null, exclusions: null },
    composition: { raw_response: null, latency_ms: 0, picks: null, not_picked_reason: null, neighborhood_used: null, reasoning: null },
    output_sms: null,
    output_sms_length: 0,
    output_intent: null,
    total_latency_ms: 0,
    ai_costs: [],
    total_ai_cost_usd: 0,
    // Agent brain fields
    brain_tool: null,       // "search" or "respond"
    brain_params: null,     // the tool call parameters
    brain_latency_ms: null, // brain LLM call time
    brain_iterations: [],   // per-iteration timing [{tool, ms}]
    brain_provider: null,   // "gemini", "anthropic", or "mechanical"
    brain_error: null,      // error message if brain failed
    annotation: null,
  };
}

/**
 * Record an AI call's cost on a trace.
 * Pushes to trace.ai_costs, increments total_ai_cost_usd, returns cost_usd.
 */
function recordAICost(trace, callType, usage, provider = 'anthropic') {
  if (!trace || !usage) return 0;
  const pricing = PRICING[provider] || PRICING.anthropic;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cost = inputTokens * pricing.input + outputTokens * pricing.output;
  trace.ai_costs.push({
    call_type: callType,
    provider: provider || 'anthropic',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: cost,
  });
  trace.total_ai_cost_usd += cost;
  return cost;
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
      trace: {
        id: trace.id,
        intent: trace.output_intent,
        neighborhood: trace.routing?.resolved_neighborhood || trace.routing?.result?.neighborhood,
        pre_routed: trace.routing?.pre_routed,
        latency_ms: trace.total_latency_ms,
        ai_cost_usd: trace.total_ai_cost_usd,
        model: trace.routing?.model_routing?.model,
        active_filters: trace.composition?.active_filters,
        pool_meta: trace.events?.pool_meta,
        candidates_count: trace.events?.candidates_count,
        picks: trace.composition?.picks,
        active_skills: trace.composition?.active_skills,
        filter_state: trace.composition?.filter_state,
      }
    });
  }

  conv.lastActivity = Date.now();
}

/**
 * Save a specific phone's conversation to SQLite on demand (admin action from simulator).
 * Returns { ok, id, turn_count } or { ok: false, error }.
 */
function saveConversation(rawPhone, { label } = {}) {
  const { maskPhone } = require('./twilio');
  const { saveConversationToDb } = require('./db');
  const masked = maskPhone(rawPhone);
  const conv = conversations.get(masked);
  if (!conv || conv.turns.length === 0) {
    return { ok: false, error: 'No active conversation for this phone' };
  }

  const firstUserMsg = conv.turns.find(t => t.sender === 'user')?.message || '';
  return saveConversationToDb({
    phone_masked: masked,
    label: label || null,
    first_message: firstUserMsg,
    started_at: conv.startedAt,
    turn_count: conv.turns.length,
    turns: conv.turns,
  });
}

/**
 * Compute latency percentile stats from an array of traces.
 */
function computeLatencyStats(traces) {
  const zero = { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, brain_p50: 0, brain_p95: 0, outliers: [] };
  if (!traces?.length) return zero;

  const totals = traces.map(t => t.total_latency_ms || 0).sort((a, b) => a - b);
  const brains = traces.filter(t => t.brain_latency_ms != null).map(t => t.brain_latency_ms).sort((a, b) => a - b);

  function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p / 100 * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  const p95 = percentile(totals, 95);
  const outlierThreshold = Math.max(p95 * 1.5, 8000);
  const outliers = traces
    .filter(t => (t.total_latency_ms || 0) > outlierThreshold)
    .map(t => ({
      id: t.id,
      total_ms: t.total_latency_ms,
      brain_ms: t.brain_latency_ms,
      intent: t.output_intent,
      message: (t.input_message || '').slice(0, 40),
      timestamp: t.timestamp,
    }))
    .slice(0, 10);

  return {
    count: totals.length,
    avg: Math.round(totals.reduce((a, b) => a + b, 0) / totals.length),
    p50: percentile(totals, 50),
    p95,
    p99: percentile(totals, 99),
    max: totals[totals.length - 1],
    brain_p50: percentile(brains, 50),
    brain_p95: percentile(brains, 95),
    outliers,
  };
}

module.exports = {
  startTrace, saveTrace, loadTraces, annotateTrace, getRecentTraces, getTraceById, getLatestTraceForPhone,
  recordConversationTurn, saveConversation,
  PRICING, recordAICost, computeLatencyStats
};
