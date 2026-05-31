// src/eval/carryover/replay.js
//
// replayScenario(scenario, { runId, db }) → { scenarioId, description, turns: [...] }
//
// Drives one scenario through handleAgentRequestGraph against the fixture pool.
// For each turn, captures the brain's system prompt + messages, tool call,
// agent SMS, session frame before/after, and (if scenario has expect) matcher
// result — then writes a row to eval_turn_captures.

const path = require('path');

const FIXTURE_PATH = path.join(__dirname, 'fixtures/events.json');
const FIXTURE_EVENTS = require(FIXTURE_PATH);

// Fields from session to snapshot before/after each turn (per spec).
const SNAPSHOT_FIELDS = [
  'lastNeighborhood',
  'lastBorough',
  'lastFilters',
  'lastResultType',
  'pendingNearby',
  'visitedHoods',
];

function snapshotSession(session) {
  if (!session) return null;
  const out = {};
  for (const f of SNAPSHOT_FIELDS) out[f] = session[f] === undefined ? null : session[f];
  // lastPicks shrunk to ids only (full event blobs are noise)
  if (session.lastPicks) out.lastPicks = session.lastPicks.map(p => p.event_id || p);
  else out.lastPicks = null;
  return out;
}

function makeTestPhone(scenarioId) {
  const slug = scenarioId.replace(/[^0-9]/g, '').padStart(7, '0').slice(-7);
  return `+1555${slug}`;
}

// Install a capture hook on llm.runAgentLoop. The hook is module-level on llm.js,
// so destructured imports (like agent-graph.js's `const { runAgentLoop } = require('./llm')`)
// still hit it via the closure inside runAgentLoop. Returns { restore } to clear it.
function installCaptureHook(captureRef) {
  const { setAgentLoopCaptureHook } = require('../../llm');
  setAgentLoopCaptureHook(({ systemPrompt, priorMessages }) => {
    captureRef.brain_prompt = systemPrompt || null;
    captureRef.brain_messages = JSON.stringify(priorMessages || []);
  });
  return { restore: () => setAgentLoopCaptureHook(null) };
}

async function replayScenario(scenario, { runId, db }) {
  // Lazy-require so tests can stub before this loads
  const { setEventCache } = require('../../events');
  const { setSession, getSession, clearSession, addToHistory } = require('../../session');
  const { enableTestCapture, disableTestCapture } = require('../../twilio');
  const { startTrace } = require('../../traces');
  const { handleAgentRequestGraph } = require('../../agent-graph');
  const { match } = require('./matcher');

  setEventCache(FIXTURE_EVENTS);

  const phone = makeTestPhone(scenario.id);
  clearSession(phone);
  setSession(phone, {});

  enableTestCapture(phone);

  const insert = db.prepare(`INSERT INTO eval_turn_captures (
    run_id, scenario_id, turn_index, trace_id, user_msg,
    brain_prompt, brain_messages, tool_call, agent_sms,
    session_before, session_after, matcher_result, captured_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const turnsOut = [];
  try {
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const sessionBefore = snapshotSession(getSession(phone));

      addToHistory(phone, 'user', turn.user);

      const capture = { brain_prompt: null, brain_messages: null };
      const patch = installCaptureHook(capture);

      const trace = startTrace('eval', turn.user);
      let agentSms = null;
      const finalizeTrace = (smsText, intent) => {
        trace.output_sms = smsText || null;
        trace.output_intent = intent || trace.output_intent || null;
        agentSms = smsText || null;
      };

      try {
        await handleAgentRequestGraph(phone, turn.user, getSession(phone), trace, finalizeTrace);
      } finally {
        patch.restore();
      }

      const sessionAfter = snapshotSession(getSession(phone));

      const toolCall = trace.brain_tool
        ? { name: trace.brain_tool, params: trace.brain_params || {} }
        : null;

      let matcherResult = null;
      if (turn.expect) {
        if (!toolCall) {
          matcherResult = {
            passed: false,
            mismatches: [{ path: 'tool', expected: turn.expect.tool, actual: null, reason: 'no tool call' }],
          };
        } else {
          const mismatches = [];
          if (toolCall.name !== turn.expect.tool) {
            mismatches.push({ path: 'tool', expected: turn.expect.tool, actual: toolCall.name, reason: 'wrong tool' });
          }
          const argMatch = match(turn.expect.args, toolCall.params || {});
          for (const m of argMatch.mismatches) {
            mismatches.push({ ...m, path: m.path ? `args.${m.path}` : 'args' });
          }
          matcherResult = { passed: mismatches.length === 0, mismatches };
        }
      }

      const capturedAt = new Date().toISOString();
      insert.run(
        runId, scenario.id, i, trace.id, turn.user,
        capture.brain_prompt, capture.brain_messages,
        toolCall ? JSON.stringify(toolCall) : null,
        agentSms,
        JSON.stringify(sessionBefore),
        JSON.stringify(sessionAfter),
        matcherResult ? JSON.stringify(matcherResult) : null,
        capturedAt
      );

      turnsOut.push({
        turn_index: i,
        user_msg: turn.user,
        trace_id: trace.id,
        brain_prompt: capture.brain_prompt,
        brain_messages: capture.brain_messages,
        tool_call: toolCall,
        agent_sms: agentSms,
        session_before: sessionBefore,
        session_after: sessionAfter,
        matcher_result: matcherResult,
      });
    }
  } finally {
    disableTestCapture(phone);
    clearSession(phone);
  }

  return {
    scenarioId: scenario.id,
    description: scenario.description || '',
    turns: turnsOut,
  };
}

module.exports = { replayScenario, snapshotSession, makeTestPhone };
