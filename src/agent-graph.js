/**
 * agent-graph.js — Explicit state-machine refactor of agent-loop.js.
 *
 * Behavior matches handleAgentRequest. The only new trace field is
 * `stateHistory` — a per-state latency log enabling trajectory analysis.
 *
 * Why this exists:
 *   - per-state observability (latency histograms, success rates per node)
 *   - HITL approval gates added as new nodes, no orchestrator surgery
 *   - swap the runner for LangGraph / Step Functions / Bedrock Agents
 *     without touching the nodes
 *
 * Scope note: the model's internal multi-turn reasoning stays inside
 * runAgentLoop (a provider-protocol concern, not product orchestration).
 * This file makes explicit everything *around* that loop — bridging,
 * shortcuts, composition, sanitization, save, send, follow-up actions,
 * fallback. That is where product policy lives and where the bug
 * surface is.
 *
 * Demo: import { handleAgentRequestGraph } and swap it for
 * handleAgentRequest in handler.js. Same signature.
 */

const { runAgentLoop } = require('./llm');
const { MODELS } = require('./model-config');
const { BRAIN_TOOLS, buildBrainSystemPrompt, buildNativeHistory, projectBrainContext } = require('./brain-llm');

// PULSE_BRAIN_PROJECT=true switches the brain to projected prompts: a terser
// <state> block (single source of truth for canonical facts) + a 1-2 turn
// linguistic tail (no tool_call/search_summary noise). Off by default until
// eval signs off. tailTurns is tighter for Haiku because that's where dual-
// channel reconciliation load matters most.
function buildBrainPrompt(session) {
  if (process.env.PULSE_BRAIN_PROJECT === 'true') {
    const tailTurns = MODELS.brain.startsWith('claude-haiku') ? 1 : 2;
    return projectBrainContext(session, { tailTurns });
  }
  return {
    systemPrompt: buildBrainSystemPrompt(session),
    messages: buildNativeHistory(session?.conversationHistory),
  };
}
const { sendSMS, maskPhone } = require('./twilio');
const { recordAICost } = require('./traces');
const { getSession, setSession, addToHistory } = require('./session');
const { trackAICost } = require('./request-guard');
const { smartTruncate } = require('./formatters');
const { sendRuntimeAlert } = require('./alerts');
const {
  executeTool,
  sanitizeForLLM,
  buildPreemptCopy,
  resolveDetailUrl,
  saveSessionFromToolCalls,
  extractPlacePicksFromSms,
  deriveIntent,
  rewriteIfTooLong,
  stripMarkdown,
  SMS_CHAR_LIMIT,
} = require('./agent-loop');

const STATES = {
  ENTRY: 'entry',
  BRIDGE: 'bridge',
  SHORTCUT: 'shortcut',
  URL_RESEND: 'url_resend',
  AGENT: 'agent',
  COMPOSE: 'compose',
  ENFORCE_LENGTH: 'enforce_length',
  SANITIZE: 'sanitize',
  SAVE: 'save',
  SEND: 'send',
  DETAIL_URL: 'detail_url',
  FALLBACK_MODEL: 'fallback_model',
  ERROR_SMS: 'error_sms',
  FINALIZE: 'finalize',
  DONE: 'done',
};

// ---------------------------------------------------------------------------
// Pure helpers lifted from handleAgentRequest's inline body
// ---------------------------------------------------------------------------

function bridgeClarification(session, message) {
  const pending = session.pendingClarification;
  if (!pending) return session;
  const { extractNeighborhood } = require('./neighborhoods');
  const hasNeighborhood = !!extractNeighborhood(message);
  const hasCategory = /\b(comedy|jazz|live music|dj|trivia|film|theater|art|dance|nightlife|bars?|restaurant|dinner|brunch)\b/i.test(message);
  const isNewQuery = hasNeighborhood && hasCategory;

  const next = { ...session, pendingClarification: null };
  if (!isNewQuery && pending.implicit_filters) {
    if (pending.implicit_filters.neighborhood && !session.lastNeighborhood) {
      next.lastNeighborhood = pending.implicit_filters.neighborhood;
    }
    const merged = { ...(session.lastFilters || {}) };
    if (pending.implicit_filters.category) merged.categories = [pending.implicit_filters.category];
    if (pending.implicit_filters.time) merged.date_range = pending.implicit_filters.time;
    if (Object.keys(merged).length > 0) next.lastFilters = merged;
  }
  return next;
}

function matchesUrlResend(message, session) {
  return !!(session?.lastSentUrl && /\b(url|link|send.*(link|url))\b/i.test(message));
}

function pickComposeText(loopResult) {
  const clarifyCall = loopResult.toolCalls.find(tc => tc.name === 'clarify');
  if (clarifyCall) return clarifyCall.params?.question || loopResult.text;
  return loopResult.text;
}

function templateFallback(toolCalls) {
  const lastSearch = [...toolCalls].reverse().find(tc => tc.name === 'search');
  const pool = lastSearch?.result?._poolResult?.pool;
  if (!pool?.length) return null;
  const top3 = pool.slice(0, 3);
  const hood = lastSearch.result?._poolResult?.hood || 'NYC';
  const lines = top3.map(e => {
    const time = e.start_time_local
      ? new Date(e.start_time_local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
      : 'tonight';
    return `${e.name} — ${e.venue_name}, ${time}`;
  });
  return `Tonight in ${hood}:\n\n${lines.join('\n')}\n\nReply a number for details or "more" for more picks`;
}

function recordHistory(phone, toolCalls) {
  for (const tc of toolCalls) {
    addToHistory(phone, 'tool_call', '', { name: tc.name, params: tc.params });
    if (tc.name === 'search' && tc.result && !tc.result.not_found && !tc.result.stale) {
      const r = tc.result;
      const hood = r._poolResult?.hood || r._placePoolResult?.neighborhood || (r._welcomeResult ? 'citywide' : null);
      const count = (r.items || []).length || r._moreResult?.events?.length || 0;
      const resultType = r._placePoolResult && !r._poolResult ? 'places' : r._poolResult ? 'events' : null;
      if (hood || count) {
        addToHistory(phone, 'search_summary', '', { neighborhood: hood, match_count: count, result_type: resultType });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Nodes — each is (ctx) => { next, ctx }
// ---------------------------------------------------------------------------

const nodes = {
  [STATES.ENTRY]: async (ctx) => {
    if (!getSession(ctx.phone)) setSession(ctx.phone, {});
    if (!ctx.session) ctx.session = getSession(ctx.phone);
    addToHistory(ctx.phone, 'user', ctx.message);
    return { next: STATES.BRIDGE, ctx };
  },

  [STATES.BRIDGE]: async (ctx) => {
    if (ctx.session?.pendingClarification) {
      ctx.session = bridgeClarification(ctx.session, ctx.message);
      setSession(ctx.phone, ctx.session);
    }
    return { next: STATES.SHORTCUT, ctx };
  },

  [STATES.SHORTCUT]: async (ctx) => {
    if (matchesUrlResend(ctx.message, ctx.session)) return { next: STATES.URL_RESEND, ctx };
    return { next: STATES.AGENT, ctx };
  },

  [STATES.URL_RESEND]: async (ctx) => {
    await sendSMS(ctx.phone, ctx.session.lastSentUrl);
    addToHistory(ctx.phone, 'assistant', ctx.session.lastSentUrl);
    ctx.smsText = ctx.session.lastSentUrl;
    ctx.intent = 'url_resend';
    ctx.trace.output_sms = ctx.smsText;
    return { next: STATES.FINALIZE, ctx };
  },

  [STATES.AGENT]: async (ctx) => {
    const { systemPrompt, messages: priorMessages } = buildBrainPrompt(ctx.session);
    const tools = ctx.session?.pendingClarification
      ? BRAIN_TOOLS.filter(t => t.name !== 'clarify')
      : BRAIN_TOOLS;

    const rawResults = [];
    let clarifySeenInBatch = false;
    let preemptSent = false;
    const preemptEnabled = process.env.PULSE_PREEMPT_ENABLED === 'true';

    const executeAndTrack = async (toolName, params) => {
      if (toolName === 'clarify') {
        clarifySeenInBatch = true;
        const result = await executeTool(toolName, params, ctx.session, ctx.phone, ctx.trace);
        rawResults.push({ name: toolName, params, result });
        return sanitizeForLLM(result);
      }
      if (clarifySeenInBatch) return { skipped: true, reason: 'clarify_in_batch' };
      if (preemptEnabled && !preemptSent) {
        const copy = buildPreemptCopy(toolName, params);
        if (copy) {
          preemptSent = true;
          ctx.trace.preempt = { fired: true, copy, tool: toolName };
          sendSMS(ctx.phone, copy)
            .then(msg => { ctx.trace.preempt.delivered = true; if (msg?.sid) ctx.trace.preempt.sid = msg.sid; })
            .catch(err => { ctx.trace.preempt.delivered = false; ctx.trace.preempt.error = err.message; });
        }
      }
      const result = await executeTool(toolName, params, ctx.session, ctx.phone, ctx.trace);
      rawResults.push({ name: toolName, params, result });
      return sanitizeForLLM(result);
    };

    const loopResult = await runAgentLoop(
      MODELS.brain, systemPrompt, ctx.message, tools, executeAndTrack,
      { maxIterations: 3, timeout: 12000, priorMessages, stopTools: ['clarify'] }
    );

    recordAICost(ctx.trace, 'brain', loopResult.totalUsage, loopResult.provider);
    trackAICost(ctx.phone, loopResult.totalUsage, loopResult.provider);

    ctx.trace.brain_provider = loopResult.provider;
    ctx.trace.brain_latency_ms = loopResult.elapsed_ms || null;
    ctx.trace.brain_iterations = loopResult.iterations || [];
    ctx.trace.brain_tool_calls = loopResult.toolCalls.map(tc => ({ name: tc.name, params: tc.params }));
    ctx.trace.routing.pre_routed = false;
    ctx.trace.routing.provider = loopResult.provider;

    ctx.toolCalls = rawResults;
    ctx.loopResult = loopResult;
    return { next: STATES.COMPOSE, ctx };
  },

  [STATES.COMPOSE]: async (ctx) => {
    let smsText = pickComposeText(ctx.loopResult);
    if (!smsText) smsText = templateFallback(ctx.toolCalls);
    if (!smsText) smsText = "Tell me what you're in the mood for -- drop a neighborhood or a vibe.";
    ctx.smsText = smsText;
    return { next: STATES.ENFORCE_LENGTH, ctx };
  },

  [STATES.ENFORCE_LENGTH]: async (ctx) => {
    if (ctx.smsText.length > SMS_CHAR_LIMIT) {
      ctx.smsText = await rewriteIfTooLong(ctx.smsText, ctx.trace);
    }
    return { next: STATES.SANITIZE, ctx };
  },

  [STATES.SANITIZE]: async (ctx) => {
    ctx.smsText = smartTruncate(stripMarkdown(ctx.smsText));
    return { next: STATES.SAVE, ctx };
  },

  [STATES.SAVE]: async (ctx) => {
    recordHistory(ctx.phone, ctx.toolCalls);
    saveSessionFromToolCalls(ctx.phone, ctx.session, ctx.toolCalls, ctx.smsText);
    return { next: STATES.SEND, ctx };
  },

  [STATES.SEND]: async (ctx) => {
    ctx.intent = deriveIntent(ctx.toolCalls);
    await sendSMS(ctx.phone, ctx.smsText);
    ctx.smsSent = true;
    if (ctx.intent === 'details') return { next: STATES.DETAIL_URL, ctx };
    return { next: STATES.FINALIZE, ctx };
  },

  [STATES.DETAIL_URL]: async (ctx) => {
    let urlSent = false;

    const detailsCall = ctx.toolCalls.find(tc => tc.name === 'search' && tc.params?.intent === 'details');
    const eventUrl = detailsCall ? resolveDetailUrl(detailsCall.params?.reference, ctx.session) : null;
    if (eventUrl) {
      await sendSMS(ctx.phone, eventUrl);
      setSession(ctx.phone, { lastSentUrl: eventUrl });
      urlSent = true;
    }

    if (!urlSent && ctx.session?.lastResultType === 'places') {
      const placePool = Object.values(ctx.session?.lastPlaceMap || {});
      const placePicks = extractPlacePicksFromSms(ctx.smsText, placePool);
      if (placePicks.length > 0) {
        const place = ctx.session.lastPlaceMap[placePicks[0].place_id];
        if (place?.google_maps_url) {
          await sendSMS(ctx.phone, place.google_maps_url);
          setSession(ctx.phone, { lastSentUrl: place.google_maps_url });
          urlSent = true;
        }
      }
    }

    if (!urlSent) {
      const lookupCall = ctx.toolCalls.find(tc => tc.name === 'lookup_venue' && tc.result?.google_maps_url);
      if (lookupCall) {
        await sendSMS(ctx.phone, lookupCall.result.google_maps_url);
        setSession(ctx.phone, { lastSentUrl: lookupCall.result.google_maps_url });
      }
    }

    return { next: STATES.FINALIZE, ctx };
  },

  [STATES.FALLBACK_MODEL]: async (ctx) => {
    const { systemPrompt, messages: priorMessages } = buildBrainPrompt(ctx.session);
    console.warn(`[agent-graph] ${MODELS.brain} failed, trying ${MODELS.fallback}: ${ctx.error?.message}`);
    try {
      const fallbackResult = await runAgentLoop(
        MODELS.fallback, systemPrompt, ctx.message, BRAIN_TOOLS,
        async (toolName, params) => sanitizeForLLM(await executeTool(toolName, params, ctx.session, ctx.phone, ctx.trace)),
        { maxIterations: 2, timeout: 12000, priorMessages }
      );
      recordAICost(ctx.trace, 'brain_fallback', fallbackResult.totalUsage, fallbackResult.provider);
      trackAICost(ctx.phone, fallbackResult.totalUsage, fallbackResult.provider);
      ctx.trace.brain_latency_ms = (ctx.trace.brain_latency_ms || 0) + (fallbackResult.elapsed_ms || 0);
      ctx.trace.brain_iterations = [...(ctx.trace.brain_iterations || []), ...(fallbackResult.iterations || [])];

      ctx.toolCalls = fallbackResult.toolCalls;
      ctx.smsText = smartTruncate(fallbackResult.text || "Tell me what you're in the mood for!");
      ctx.intent = deriveIntent(fallbackResult.toolCalls);
      await sendSMS(ctx.phone, ctx.smsText);
      ctx.smsSent = true;
      return { next: STATES.FINALIZE, ctx };
    } catch (err) {
      ctx.trace.brain_error = (ctx.trace.brain_error || '') + ` fallback: ${err.message}`;
      console.error('[agent-graph] fallback also failed:', err.message);
      return { next: STATES.ERROR_SMS, ctx };
    }
  },

  [STATES.ERROR_SMS]: async (ctx) => {
    const sms = "Pulse hit a snag -- try again in a sec!";
    await sendSMS(ctx.phone, sms);
    ctx.smsText = sms;
    ctx.intent = 'error';
    sendRuntimeAlert('agent_loop_error', {
      error: ctx.error?.message || 'unknown',
      phone_masked: maskPhone(ctx.phone),
      message: ctx.message.slice(0, 80),
    });
    return { next: STATES.FINALIZE, ctx };
  },

  [STATES.FINALIZE]: async (ctx) => {
    ctx.finalizeTrace(ctx.smsText || null, ctx.intent || 'unknown');
    return { next: STATES.DONE, ctx };
  },
};

// ---------------------------------------------------------------------------
// Runner — stepper + per-state observability + error routing
// ---------------------------------------------------------------------------

async function run(initialCtx) {
  let state = STATES.ENTRY;
  let ctx = {
    toolCalls: [],
    smsText: null,
    intent: null,
    smsSent: false,
    error: null,
    loopResult: null,
    ...initialCtx,
  };
  ctx.trace.stateHistory = [];

  while (state !== STATES.DONE) {
    const t0 = Date.now();
    try {
      const out = await nodes[state](ctx);
      ctx.trace.stateHistory.push({ state, ms: Date.now() - t0 });
      state = out.next;
      ctx = out.ctx;
    } catch (err) {
      ctx.trace.stateHistory.push({ state, ms: Date.now() - t0, error: err.message });
      console.error(`[agent-graph] ${state} threw: ${err.message}`);
      ctx.error = err;
      if (ctx.smsSent) {
        // post-send failure — SMS already delivered, just record and finalize
        ctx.trace.brain_error = `post_send: ${err.message}`;
        if (!ctx.trace.output_sms) ctx.finalizeTrace(null, ctx.intent || deriveIntent(ctx.toolCalls));
        return ctx;
      }
      ctx.trace.brain_error = err.message;
      // Only the AGENT node gets a fallback model retry; other failures go straight to error SMS
      if (state === STATES.AGENT && !err.message?.includes('fallback')) {
        state = STATES.FALLBACK_MODEL;
        continue;
      }
      state = STATES.ERROR_SMS;
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Public entrypoint — drop-in replacement for handleAgentRequest
// ---------------------------------------------------------------------------

async function handleAgentRequestGraph(phone, message, session, trace, finalizeTrace) {
  await run({ phone, message, session, trace, finalizeTrace });
  return trace.id;
}

module.exports = {
  handleAgentRequestGraph,
  run,
  nodes,
  STATES,
};
