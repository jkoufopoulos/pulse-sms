/**
 * Complexity-based model routing.
 *
 * Scores each request 0-100 based on deterministic signals available before
 * the AI call. High-complexity requests route to Claude Haiku 4.5 (~$0.001);
 * everything else stays on Gemini 2.5 Flash (~$0.0001).
 *
 * Pure functions, no side effects. Imported by handler.js.
 */

const THRESHOLD = parseInt(process.env.PULSE_COMPLEXITY_THRESHOLD, 10) || 40;
const MODEL_OVERRIDE = process.env.PULSE_MODEL_OVERRIDE || null;
const BUDGET_DOWNGRADE_PCT = 0.70; // downgrade Haiku-eligible when >70% budget used

const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  flash: 'gemini-2.5-flash',
};

/**
 * Score request complexity from 0-100 based on deterministic signals.
 *
 * @param {Object} ctx
 * @param {string}  ctx.message - user's raw SMS text
 * @param {Object}  ctx.session - current session state
 * @param {number}  ctx.matchCount - total filter matches (hard + soft)
 * @param {number}  ctx.hardCount - hard filter matches
 * @param {number}  ctx.softCount - soft filter matches
 * @param {boolean} ctx.isSparse - fewer than 3 matches
 * @param {string}  ctx.hood - resolved neighborhood (null if none)
 * @param {Object}  ctx.activeFilters - merged active filters
 * @param {Array}   ctx.events - event pool sent to LLM
 * @param {Array}   ctx.conversationHistory - prior turns
 * @param {boolean} ctx.isCitywide - citywide request
 * @param {boolean} ctx.hasPreDetectedFilters - pre-router detected a filter follow-up
 * @param {number}  ctx.budgetUsedPct - fraction of daily budget consumed (0-1)
 * @returns {number} complexity score 0-100
 */
function scoreComplexity(ctx) {
  let score = 0;
  const {
    message = '',
    session,
    matchCount = 0,
    hardCount = 0,
    softCount = 0,
    isSparse = false,
    hood,
    activeFilters = {},
    events = [],
    conversationHistory = [],
    isCitywide = false,
    hasPreDetectedFilters = false,
  } = ctx;

  const hasActiveFilter = activeFilters && Object.values(activeFilters).some(Boolean);

  // --- Match quality signals ---
  if (hasActiveFilter && hardCount === 0 && softCount === 0) {
    score += 30; // must improvise with nothing
  } else if (hasActiveFilter && hardCount === 0 && softCount > 0) {
    score += 15; // soft matches need careful verification
  }

  if (isSparse) {
    score += 10; // must frame limited options well
  }

  if (events.length > 0 && events.length < 5) {
    score += 10; // very constrained composition
  }

  if (events.length === 0) {
    score += 25; // must deflect gracefully
  }

  // --- Filter interaction ambiguity ---
  // When the user has active filters but the pre-router didn't detect a specific
  // filter follow-up, the message likely involves filter intent (clear, modify, or
  // implicit preference). These need semantic understanding — route to Haiku.
  if (hasActiveFilter && !hasPreDetectedFilters) {
    score += 35; // ambiguous filter interaction needs semantic parsing
  }

  // --- Filter complexity ---
  const filterDimensions = Object.values(activeFilters).filter(Boolean).length;
  if (filterDimensions >= 3) {
    score += 15; // multi-constraint reasoning
  } else if (filterDimensions === 2) {
    score += 5; // moderate constraint
  }

  // --- Conversation depth ---
  const historyLen = conversationHistory.length;
  if (historyLen >= 8) {
    score += 10; // deep context to track
  } else if (historyLen >= 4) {
    score += 5; // moderate context
  }

  // --- Neighborhood resolution ---
  if (!hood && !isCitywide) {
    score += 10; // semantic understanding needed
  }

  // --- Message complexity ---
  const msgLen = message.length;
  if (msgLen > 80) {
    score += 10; // complex/compound request
  } else if (msgLen > 40) {
    score += 5; // moderate complexity
  }

  // --- Session signals ---
  if (!session?.lastNeighborhood) {
    score += 5; // first message, sets tone
  }

  if (isCitywide) {
    score += 5; // harder selection across all NYC
  }

  return Math.min(score, 100);
}

/**
 * Route to the appropriate model based on complexity score.
 *
 * @param {Object} ctx - same as scoreComplexity, plus budgetUsedPct
 * @returns {{ model: string, provider: string, tier: string, score: number, reason: string }}
 */
function routeModel(ctx) {
  const score = scoreComplexity(ctx);
  const budgetUsedPct = ctx.budgetUsedPct || 0;

  // Override forces all traffic to one model
  if (MODEL_OVERRIDE) {
    const provider = MODEL_OVERRIDE.startsWith('gemini-') ? 'gemini' : 'anthropic';
    return {
      model: MODEL_OVERRIDE,
      provider,
      tier: 'override',
      score,
      reason: `PULSE_MODEL_OVERRIDE=${MODEL_OVERRIDE}`,
    };
  }

  // Score above threshold → Haiku (unless budget-constrained)
  if (score >= THRESHOLD) {
    if (budgetUsedPct > BUDGET_DOWNGRADE_PCT) {
      return {
        model: MODELS.flash,
        provider: 'gemini',
        tier: 'flash',
        score,
        reason: `score ${score} >= ${THRESHOLD} but budget ${Math.round(budgetUsedPct * 100)}% > ${Math.round(BUDGET_DOWNGRADE_PCT * 100)}% — downgraded to Flash`,
      };
    }
    return {
      model: MODELS.haiku,
      provider: 'anthropic',
      tier: 'haiku',
      score,
      reason: `score ${score} >= ${THRESHOLD}`,
    };
  }

  return {
    model: MODELS.flash,
    provider: 'gemini',
    tier: 'flash',
    score,
    reason: `score ${score} < ${THRESHOLD}`,
  };
}

module.exports = { scoreComplexity, routeModel, MODELS };
