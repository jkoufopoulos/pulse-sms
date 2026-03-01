const { PRICING } = require('./traces');

// --- Twilio retry deduplication ---
// Twilio sends the same MessageSid on retries. Track recent ones to avoid duplicate processing.
const processedMessages = new Map(); // MessageSid -> timestamp
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes

// --- TCPA opt-out keywords — must not respond to these ---
const OPT_OUT_KEYWORDS = /^\s*(stop|unsubscribe|cancel|quit)\s*$/i;

// --- Cost-based daily AI budget per user ---
const aiBudgets = new Map(); // phone -> { cost_usd, date }
const DAILY_BUDGET_USD = 0.10;

function getNycDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isOverBudget(phone) {
  const today = getNycDate();
  const entry = aiBudgets.get(phone);
  if (!entry || entry.date !== today) return false;
  return entry.cost_usd >= DAILY_BUDGET_USD;
}

function trackAICost(phone, usage, provider = 'anthropic') {
  if (!usage) return;
  const pricing = PRICING[provider] || PRICING.anthropic;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cost = inputTokens * pricing.input + outputTokens * pricing.output;

  const today = getNycDate();
  const entry = aiBudgets.get(phone);
  if (!entry || entry.date !== today) {
    aiBudgets.set(phone, { cost_usd: cost, date: today });
  } else {
    entry.cost_usd += cost;
  }
}

function getCostSummary() {
  const today = getNycDate();
  let activeUsers = 0, totalSpend = 0;
  for (const [, entry] of aiBudgets) {
    if (entry.date === today) {
      activeUsers++;
      totalSpend += entry.cost_usd;
    }
  }
  return { active_users: activeUsers, total_spend_usd: totalSpend, daily_limit_usd: DAILY_BUDGET_USD };
}

function getBudgetUsedPct(phone) {
  const today = getNycDate();
  const entry = aiBudgets.get(phone);
  if (!entry || entry.date !== today) return 0;
  return entry.cost_usd / DAILY_BUDGET_USD;
}

// --- IP-based rate limit for test endpoint (30 messages per IP per hour) ---
const ipRateLimits = new Map(); // ip -> { count, resetTime }
const IP_RATE_LIMIT = 30;
const IP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour

// Clean stale dedup entries every 5 minutes
const dedupInterval = setInterval(() => {
  try {
    const cutoff = Date.now() - DEDUP_TTL;
    for (const [sid, ts] of processedMessages) {
      if (ts < cutoff) processedMessages.delete(sid);
    }
  } catch (e) { console.error('Dedup cleanup error:', e); }
}, 5 * 60 * 1000);

// Clean stale budget + IP rate limit entries every 10 minutes
const rateLimitInterval = setInterval(() => {
  try {
    const today = getNycDate();
    for (const [phone, entry] of aiBudgets) {
      if (entry.date !== today) aiBudgets.delete(phone);
    }
    const now = Date.now();
    for (const [ip, entry] of ipRateLimits) {
      if (now >= entry.resetTime) ipRateLimits.delete(ip);
    }
  } catch (e) { console.error('Budget cleanup error:', e); }
}, 10 * 60 * 1000);

function clearGuardIntervals() {
  clearInterval(dedupInterval);
  clearInterval(rateLimitInterval);
}

module.exports = {
  processedMessages,
  DEDUP_TTL,
  OPT_OUT_KEYWORDS,
  isOverBudget,
  trackAICost,
  getCostSummary,
  getBudgetUsedPct,
  getNycDate,
  DAILY_BUDGET_USD,
  ipRateLimits,
  IP_RATE_LIMIT,
  IP_RATE_WINDOW,
  clearGuardIntervals,
};
