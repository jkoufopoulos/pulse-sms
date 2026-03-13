require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const smsRoutes = require('./handler');
const { clearSmsIntervals, getInflightCount } = require('./handler');
const { refreshCache, getCacheStatus, getHealthStatus, getEventById, isCacheFresh, scheduleDailyScrape, clearSchedule, scheduleEmailPolls, clearEmailSchedule } = require('./events');
const { loadProfiles } = require('./preference-profile');
const { loadReferrals, clearReferralInterval } = require('./referral');
const { loadSessions, flushSessions, clearSessionInterval } = require('./session');
const { loadAlerts, getRecentAlerts } = require('./alerts');

// Validate required env vars — exit if critical ones are missing
const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'ANTHROPIC_API_KEY', 'TAVILY_API_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`Fatal: missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware (L11 fix)
app.set('trust proxy', 1); // Railway runs behind a reverse proxy
app.use(helmet());

// Parse URL-encoded bodies (Twilio sends form data)
app.use(express.urlencoded({ extended: false, limit: '5kb' }));
app.use(express.json({ limit: '5mb' }));

// Public health check — no internal details (L10 fix)
const BUILD_SHA = 'af6d8c8';
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pulse', build: BUILD_SHA });
});

// Health dashboard — gated behind test mode or auth token
app.get('/health', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;

  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  if (acceptsHtml && !req.query.json) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    return res.sendFile(require('path').join(__dirname, 'health-ui.html'));
  }
  res.json(getHealthStatus());
});

// Alert history API — same auth gating as /health
app.get('/api/alerts', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;

  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(getRecentAlerts(limit));
});

// Cost summary API — same auth gating as /health
app.get('/api/health/costs', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;

  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { getCostSummary } = require('./handler');
  const traces = getRecentTraces(200);

  const nycToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const todayTraces = traces.filter(t => {
    if (!t.timestamp) return false;
    const traceDate = new Date(t.timestamp).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return traceDate === nycToday;
  });

  function aggregateTraces(traceList) {
    let totalUsd = 0;
    const byProvider = {};
    for (const t of traceList) {
      const cost = t.total_ai_cost_usd || 0;
      totalUsd += cost;
      if (t.ai_costs) {
        for (const ac of t.ai_costs) {
          const provider = ac.provider || 'anthropic';
          byProvider[provider] = (byProvider[provider] || 0) + (ac.cost_usd || 0);
        }
      }
    }
    return { total_usd: Math.round(totalUsd * 100000) / 100000, message_count: traceList.length, by_provider: byProvider };
  }

  const todayAgg = aggregateTraces(todayTraces);
  todayAgg.avg_per_message_usd = todayAgg.message_count > 0
    ? Math.round((todayAgg.total_usd / todayAgg.message_count) * 100000) / 100000 : 0;

  const recentAgg = aggregateTraces(traces);
  recentAgg.avg_per_message_usd = recentAgg.message_count > 0
    ? Math.round((recentAgg.total_usd / recentAgg.message_count) * 100000) / 100000 : 0;

  res.json({
    today: todayAgg,
    recent: recentAgg,
    budget: getCostSummary(),
  });
});

// Latency stats API -- same auth gating as /health
app.get('/api/health/latency', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;

  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { computeLatencyStats } = require('./traces');
  const traces = getRecentTraces(200);

  const nycToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayTraces = traces.filter(t => {
    if (!t.timestamp) return false;
    const traceDate = new Date(t.timestamp).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return traceDate === nycToday;
  });

  res.json({
    today: computeLatencyStats(todayTraces),
    recent: computeLatencyStats(traces),
  });
});

// SMS webhook
app.use('/api/sms', smsRoutes);

// Proactive outreach kill switches
app.post('/api/proactive/pause', (req, res) => {
  const { pauseProactive } = require('./proactive');
  pauseProactive();
  console.log('[PROACTIVE] Manually paused via API');
  res.json({ status: 'paused' });
});

app.post('/api/proactive/resume', (req, res) => {
  const { resumeProactive } = require('./proactive');
  resumeProactive();
  console.log('[PROACTIVE] Resumed via API');
  res.json({ status: 'resumed' });
});

// Architecture explorer (read-only doc, always available)
app.get('/architecture', (req, res) => {
  res.redirect(301, 'https://jkoufopoulos.github.io/pulse-sms/architecture.html');
});

// Eval report viewer (read-only, always available)
app.get('/eval-report', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'eval-report.html'));
});

app.get('/eval-quality', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'eval-quality.html'));
});

// Eval report API — list available reports and serve report data
const REPORT_PREFIXES = {
  'scenario-eval-': 'scenario',
  'regression-eval-': 'regression',
  'extraction-audit-': 'extraction',
  'scrape-audit-': 'scrape',
  'quality-eval-': 'quality',
};
function getReportType(filename) {
  for (const [prefix, type] of Object.entries(REPORT_PREFIXES)) {
    if (filename.startsWith(prefix)) return type;
  }
  return null;
}
function isValidReportFilename(filename) {
  return filename.endsWith('.json') && getReportType(filename) !== null;
}

app.get('/api/eval-reports', (req, res) => {
  const reportsDir = require('path').join(__dirname, '..', 'data', 'reports');
  const fs = require('fs');
  if (!fs.existsSync(reportsDir)) return res.json([]);
  const typeFilter = req.query.type || null;
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.json') && getReportType(f) !== null)
    .filter(f => !typeFilter || getReportType(f) === typeFilter)
    .sort()
    .reverse();
  const summaries = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(require('path').join(reportsDir, f), 'utf8'));
      const type = getReportType(f);
      const base = { filename: f, type, timestamp: data.timestamp };
      if (type === 'scenario') {
        return { ...base, total: data.total, passed: data.passed, failed: data.failed, errors: data.errors, judge_model: data.judge_model, judge_cost: data.judge_cost, elapsed_seconds: data.elapsed_seconds, concurrency: data.concurrency, base_url: data.base_url, code_evals: data.code_evals };
      }
      if (type === 'regression') {
        const scenarios = data.scenarios || [];
        const passed = scenarios.filter(s => s.pass).length;
        return { ...base, total: scenarios.length, passed, failed: scenarios.length - passed, principles: data.principles || [], elapsed_seconds: data.elapsed_seconds, base_url: data.base_url };
      }
      if (type === 'extraction') {
        return { ...base, total: data.summary?.total, passed: data.summary?.passed, pass_rate: data.summary?.passRate, tier: data.tier };
      }
      if (type === 'scrape') {
        return { ...base, total: data.summary?.total, passed: data.summary?.passed, pass_rate: data.summary?.passRate, sources_below: data.summary?.sourcesBelow };
      }
      if (type === 'quality') {
        return { ...base, ...data.summary, judge_model: data.judge_model, judge_cost: data.judge_cost, elapsed_seconds: data.elapsed_seconds, base_url: data.base_url };
      }
      return base;
    } catch { return null; }
  }).filter(Boolean);
  res.json(summaries);
});

app.get('/api/eval-reports/:filename', (req, res) => {
  const fs = require('fs');
  const filePath = require('path').join(__dirname, '..', 'data', 'reports', req.params.filename);
  if (!isValidReportFilename(req.params.filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// Eval report upload — accepts JSON report body, writes to data/reports/
app.put('/api/eval-reports/:filename', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;
  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const fs = require('fs');
  const path = require('path');
  const filename = req.params.filename;
  if (!isValidReportFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, filename), JSON.stringify(req.body, null, 2));
  res.json({ ok: true, filename });
});

app.delete('/api/eval-reports/:filename', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;
  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const fs = require('fs');
  const path = require('path');
  const filename = req.params.filename;
  if (!isValidReportFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(__dirname, '..', 'data', 'reports', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true, deleted: filename });
});

// Eval overrides API — human judge overrides for scenario verdicts
app.get('/api/eval-overrides', (req, res) => {
  const fs = require('fs');
  const filePath = require('path').join(__dirname, '..', 'data', 'reports', 'scenario-overrides.json');
  if (!fs.existsSync(filePath)) return res.json({});
  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch { res.json({}); }
});

app.put('/api/eval-overrides/:scenarioName', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;
  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const fs = require('fs');
  const path = require('path');
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  const filePath = path.join(reportsDir, 'scenario-overrides.json');
  const { verdict, category, notes, against_report, against_llm_verdict } = req.body;

  if (!verdict || !['pass', 'fail'].includes(verdict)) {
    return res.status(400).json({ error: 'verdict must be "pass" or "fail"' });
  }
  if (!category || !['false_failure', 'false_pass', 'data_dependent', 'product_gap', 'known_bug'].includes(category)) {
    return res.status(400).json({ error: 'category must be one of: false_failure, false_pass, data_dependent, product_gap' });
  }

  fs.mkdirSync(reportsDir, { recursive: true });
  let overrides = {};
  if (fs.existsSync(filePath)) {
    try { overrides = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
  }

  overrides[req.params.scenarioName] = {
    verdict,
    category,
    notes: notes || '',
    overridden_at: new Date().toISOString(),
    against_report: against_report || null,
    against_llm_verdict: against_llm_verdict != null ? against_llm_verdict : null,
  };

  fs.writeFileSync(filePath, JSON.stringify(overrides, null, 2));
  res.json({ ok: true });
});

app.delete('/api/eval-overrides/:scenarioName', (req, res) => {
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  const isTestMode = process.env.PULSE_TEST_MODE === 'true';
  const hasValidToken = authToken && req.query.token === authToken;
  if (!isTestMode && !hasValidToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const fs = require('fs');
  const filePath = require('path').join(__dirname, '..', 'data', 'reports', 'scenario-overrides.json');
  if (!fs.existsSync(filePath)) return res.json({ ok: true });

  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
  delete overrides[req.params.scenarioName];
  fs.writeFileSync(filePath, JSON.stringify(overrides, null, 2));
  res.json({ ok: true });
});

// Evals landing page (read-only, always available)
app.get('/evals', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'evals-landing.html'));
});

// Events browser (read-only, always available)
app.get('/events', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' https://*.basemaps.cartocdn.com");
  res.sendFile(require('path').join(__dirname, 'events-ui.html'));
});
app.get('/api/events', (req, res) => {
  const { getRawCache } = require('./events');
  res.json(getRawCache());
});

// Agent Eye — simulate what the model sees for a neighborhood/filter combo
app.get('/api/agent-eye', async (req, res) => {
  try {
    const { buildSearchPool } = require('./brain-execute');
    const { serializePoolForContinuation } = require('./brain-llm');
    const { scoreInterestingness } = require('./events');

    const params = {
      neighborhood: req.query.neighborhood || null,
      intent: 'new_search',
    };
    if (req.query.categories) {
      params.categories = req.query.categories.split(',').filter(Boolean);
    }
    if (req.query.free_only === 'true') params.free_only = true;
    if (req.query.time_after) params.time_after = req.query.time_after;

    // Mock session/trace — agent eye has no prior context
    const mockTrace = {
      events: {}, composition: {},
    };

    const poolResult = await buildSearchPool(params, null, '+10000000000', mockTrace);

    if (poolResult.zeroMatch) {
      return res.json({
        zero_match: true,
        message: poolResult.zeroMatch.sms,
        filters: poolResult.zeroMatch.activeFilters,
      });
    }

    const serialized = serializePoolForContinuation(poolResult);

    // Attach raw event data for detail views (keyed by id)
    const rawEvents = {};
    for (const e of (poolResult.pool || [])) {
      rawEvents[e.id] = {
        ...e,
        interestingness: scoreInterestingness(e),
      };
    }

    res.json({
      serialized,
      raw_events: rawEvents,
      meta: {
        candidates: mockTrace.events.candidates_count,
        sent_to_llm: poolResult.pool?.length || 0,
        match_count: poolResult.matchCount,
        hard_count: poolResult.hardCount,
        soft_count: poolResult.softCount,
        is_sparse: poolResult.isSparse,
        exclusions: mockTrace.events.exclusions,
      },
    });
  } catch (err) {
    console.error('Agent eye error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// AI Insights — LLM-generated actionable summary of event cache health
let insightsCache = { text: null, cacheKey: null, version: 0 };
app.get('/api/events/insights', async (req, res) => {
  try {
    const { getRawCache } = require('./events');
    const { generate } = require('./llm');
    const { MODELS } = require('./model-config');

    const data = getRawCache();
    const events = data.events || [];
    if (events.length === 0) return res.json({ insights: 'No events in cache.' });

    // Cache key: event count + cache timestamp + prompt version (bust on prompt changes)
    const INSIGHTS_VERSION = 2;
    const cacheKey = `v${INSIGHTS_VERSION}-${events.length}-${data.cached_at || ''}`;
    if (insightsCache.cacheKey === cacheKey && insightsCache.text) {
      return res.json({ insights: insightsCache.text, cached: true });
    }

    // Aggregate stats
    const sources = {};
    const categories = {};
    const neighborhoods = {};
    const boroughs = { Manhattan: 0, Brooklyn: 0, Queens: 0, unknown: 0 };
    let noTime = 0, noVenue = 0, noHood = 0, noPrice = 0, noDesc = 0, otherCat = 0, freeCount = 0;
    const dateCounts = {};

    for (const e of events) {
      // Source stats
      const src = e.source_name || 'unknown';
      if (!sources[src]) sources[src] = { count: 0, noTime: 0, noVenue: 0, noHood: 0, noPrice: 0, otherCat: 0, completenessSum: 0 };
      const s = sources[src];
      s.count++;
      s.completenessSum += (e.completeness ?? 0);
      if (!e.start_time_local) { s.noTime++; noTime++; }
      if (!e.venue_name || e.venue_name === 'TBA') { s.noVenue++; noVenue++; }
      if (!e.neighborhood) { s.noHood++; noHood++; }
      if (!e.price_display && !e.is_free) { s.noPrice++; noPrice++; }
      if (e.category === 'other' || !e.category) { s.otherCat++; otherCat++; }
      if (!e.description_short && !e.description) noDesc++;
      if (e.is_free) freeCount++;

      // Category
      const cat = e.category || 'unknown';
      categories[cat] = (categories[cat] || 0) + 1;

      // Neighborhood
      const hood = e.neighborhood || 'unknown';
      neighborhoods[hood] = (neighborhoods[hood] || 0) + 1;

      // Date
      if (e.date_local) dateCounts[e.date_local] = (dateCounts[e.date_local] || 0) + 1;
    }

    // Format source summary (sorted by count desc)
    const srcSummary = Object.entries(sources)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, s]) => {
        const gaps = [];
        if (s.noTime > 0) gaps.push(`${s.noTime} no time`);
        if (s.noHood > 0) gaps.push(`${s.noHood} no neighborhood`);
        if (s.noPrice > 0) gaps.push(`${s.noPrice} no price`);
        if (s.otherCat > 0) gaps.push(`${s.otherCat} "other" category`);
        const avgComp = (s.completenessSum / s.count * 100).toFixed(0);
        return `${name}: ${s.count} events, ${avgComp}% avg completeness${gaps.length ? ' — ' + gaps.join(', ') : ''}`;
      }).join('\n');

    // Category summary
    const catSummary = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}: ${count} (${(count / events.length * 100).toFixed(1)}%)`)
      .join(', ');

    // Neighborhood summary (top 15 + thin count)
    const hoodEntries = Object.entries(neighborhoods).sort((a, b) => b[1] - a[1]);
    const thinHoods = hoodEntries.filter(([, c]) => c <= 2);
    const hoodSummary = hoodEntries.slice(0, 15)
      .map(([h, c]) => `${h}: ${c}`)
      .join(', ') + (thinHoods.length > 0 ? `\n${thinHoods.length} neighborhoods with ≤2 events` : '');

    // Date spread (next 7 days)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dates = Object.keys(dateCounts).sort();
    const todayIdx = dates.indexOf(today);
    const nextDates = dates.slice(Math.max(todayIdx, 0), Math.max(todayIdx, 0) + 7);
    const dateSummary = nextDates.map(d => `${d}: ${dateCounts[d] || 0} events`).join(', ');

    const statsBlock = `PULSE EVENT CACHE — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}

Total: ${events.length} events from ${Object.keys(sources).length} sources across ${Object.keys(neighborhoods).length} neighborhoods
Free: ${freeCount} (${(freeCount / events.length * 100).toFixed(0)}%), No price data: ${noPrice} (${(noPrice / events.length * 100).toFixed(0)}%)
Missing fields overall: ${noTime} no time, ${noVenue} no venue, ${noHood} no neighborhood, ${noDesc} no description, ${otherCat} "other" category

SOURCE BREAKDOWN:
${srcSummary}

CATEGORIES: ${catSummary}

NEIGHBORHOODS (top 15): ${hoodSummary}

DATE SPREAD (next 7 days): ${dateSummary}`;

    const systemPrompt = `You are a terse ops advisor for Pulse, an SMS-based NYC events product. The operator can see all the charts and numbers already — do NOT restate stats they can read.

Your job: tell them the 3-5 specific ACTIONS to take this week, ranked by user-facing impact. Each action should be a concrete task, not an observation.

Good: "Add price extraction to the donyc scraper — it's your biggest source but 91% lack prices, so free-filter queries miss 500+ events"
Bad: "Missing price data affects 1262 events across all sources"

Good: "Find a food/drink-focused source (Eater, Infatuation, Resy) — you have 70 food events vs 400+ comedy, and food is the #1 thing people text about after nightlife"
Bad: "Food and drink category is underrepresented at 2.7%"

Format: numbered list, one action per line, max 2 sentences each. Lead with the verb. No headers, no markdown.`;

    const result = await generate(MODELS.extract, systemPrompt, statsBlock, { maxTokens: 512, temperature: 0.3, timeout: 15000 });

    insightsCache = { text: result.text, cacheKey };
    res.json({ insights: result.text, cached: false });
  } catch (err) {
    console.error('Insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/geo/neighborhoods', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require('path').join(__dirname, 'public', 'nyc-neighborhoods.geojson'));
});

// Digest history
app.get('/digests', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'digest-ui.html'));
});
app.get('/api/digests', (req, res) => {
  try {
    const { getDigests } = require('./db');
    res.json(getDigests(30));
  } catch (err) {
    res.json([]);
  }
});

// Event short-link — redirects to source URL
app.get('/e/:eventId', (req, res) => {
  const event = getEventById(req.params.eventId);
  if (event) {
    const directUrl = event.ticket_url || event.source_url;
    if (directUrl) return res.redirect(302, directUrl);
  }
  res.status(404).send('Event not found');
});

// --- Read-only dashboards & APIs (always available) ---

// Eval dashboard UI
app.get('/eval', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'eval-ui.html'));
});

// API: cache metadata for eval reproducibility
app.get('/api/eval/cache-meta', (req, res) => {
  const status = getCacheStatus();
  const { getRawCache } = require('./events');
  const { events } = getRawCache();
  const sourceCounts = {};
  for (const e of events) {
    sourceCounts[e.source_name] = (sourceCounts[e.source_name] || 0) + 1;
  }
  res.json({
    cache_size: status.cache_size,
    cache_age_minutes: status.cache_age_minutes,
    source_counts: sourceCounts,
  });
});

// API: get all cached events
app.get('/api/eval/events', (req, res) => {
  const { getRawCache } = require('./events');
  res.json(getRawCache());
});

// API: trace endpoints
const { getRecentTraces, getTraceById, annotateTrace, loadTraces, saveConversation } = require('./traces');
loadTraces(); // Load existing traces from disk at startup

app.get('/api/eval/traces', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(getRecentTraces(limit));
});

app.get('/api/eval/traces/:id', (req, res) => {
  const trace = getTraceById(req.params.id);
  if (!trace) return res.status(404).json({ error: 'Trace not found' });
  res.json(trace);
});

app.post('/api/eval/traces/:id/annotate', (req, res) => {
  const { verdict, failure_modes, notes } = req.body;
  if (!verdict || !['pass', 'fail'].includes(verdict)) {
    return res.status(400).json({ error: 'verdict must be "pass" or "fail"' });
  }
  const ok = annotateTrace(req.params.id, { verdict, failure_modes, notes });
  if (!ok) return res.status(404).json({ error: 'Trace not found' });
  res.json({ ok: true });
});

// API: save conversation on demand (admin action from simulator)
app.post('/api/conversations/save', (req, res) => {
  const { phone, label } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });
  const result = saveConversation(phone, { label });
  res.json(result);
});

// API: list and read saved conversations
app.get('/api/conversations/saved', (req, res) => {
  const { getSavedConversations } = require('./db');
  if (req.query.id) {
    const conv = getSavedConversations(Number(req.query.id));
    if (!conv) return res.status(404).json({ error: 'Not found' });
    return res.json(conv);
  }
  res.json(getSavedConversations());
});

// API: extraction audit (GET = read latest report)
app.get('/api/eval/audit', (req, res) => {
  const fs = require('fs');
  const reportsDir = require('path').join(__dirname, '../data/reports');
  try {
    const files = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith('extraction-audit-'))
      .sort()
      .reverse();
    if (files.length === 0) return res.json({ error: 'No audit reports yet' });
    const report = JSON.parse(fs.readFileSync(require('path').join(reportsDir, files[0]), 'utf8'));
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: scrape audit (GET = read latest report)
app.get('/api/eval/scrape-audit', (req, res) => {
  const fs = require('fs');
  const reportsDir = require('path').join(__dirname, '../data/reports');
  try {
    const files = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith('scrape-audit-'))
      .sort()
      .reverse();
    if (files.length === 0) return res.json({ error: 'No scrape audit reports yet' });
    const report = JSON.parse(fs.readFileSync(require('path').join(reportsDir, files[0]), 'utf8'));
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Test mode: SMS simulator + mutating APIs ---
if (process.env.PULSE_TEST_MODE === 'true') {
  app.get('/test', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    res.sendFile(require('path').join(__dirname, 'test-ui.html'));
  });

  // API: run AI scoring on cached events
  app.post('/api/eval/score', async (req, res) => {
    try {
      const { getRawCache } = require('./events');
      const { scoreEvents } = require('./eval');
      const { events } = getRawCache();
      const scored = await scoreEvents(events);
      res.json(scored);
    } catch (err) {
      console.error('Eval scoring error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // API: return current cache (no scrape — use POST /api/scrape to force)
  app.post('/api/eval/refresh', async (req, res) => {
    try {
      const { getRawCache } = require('./events');
      res.json(getRawCache());
    } catch (err) {
      console.error('Eval refresh error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // API: force scrape — all sources or selective (?sources=skint,yutori&reprocess=1)
  app.post('/api/scrape', async (req, res) => {
    try {
      const { refreshCache, refreshSources, getRawCache } = require('./events');
      const sourceFilter = req.query.sources?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const reprocess = req.query.reprocess === '1';
      if (sourceFilter?.length > 0) {
        await refreshSources(sourceFilter, { reprocess });
      } else {
        await refreshCache();
      }
      res.json(getRawCache());
    } catch (err) {
      console.error('Scrape error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // API: run full extraction audit (POST = costs AI tokens)
  app.post('/api/eval/audit', async (req, res) => {
    try {
      const { getRawCache, getExtractionInputs } = require('./events');
      const { runFullAudit } = require('./evals/extraction-audit');
      const { events } = getRawCache();
      const inputs = getExtractionInputs();
      const sampleSize = parseInt(req.query.sample) || 10;
      const report = await runFullAudit(events, inputs, sampleSize);
      const fs = require('fs');
      const reportsDir = require('path').join(__dirname, '../data/reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      const reportFile = require('path').join(reportsDir, `extraction-audit-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      res.json(report);
    } catch (err) {
      console.error('Audit error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // API: session injection for eval runner
  const { setSession, clearSession } = require('./handler');
  app.post('/api/eval/session', (req, res) => {
    const { phone, session } = req.body;
    if (!phone) return res.status(400).json({ error: 'Missing phone' });
    if (session) {
      setSession(phone, session);
    } else {
      clearSession(phone);
    }
    res.json({ ok: true });
  });

}

const server = app.listen(PORT, () => {
  console.log(`Pulse listening on port ${PORT}`);
  loadProfiles();
  loadReferrals();
  loadSessions();
  loadAlerts();

  // Scrape on startup only if no fresh persisted cache — saves time and tokens on restarts
  if (isCacheFresh()) {
    console.log('Persisted cache is fresh, skipping startup scrape');
  } else {
    refreshCache().catch(err => console.error('Initial cache load failed:', err.message));
  }
  scheduleDailyScrape();
  scheduleEmailPolls();
});

// Graceful shutdown — wait for in-flight requests before exiting
const GRACEFUL_TIMEOUT_MS = 30000;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return; // prevent double-shutdown
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);

  // Phase 1: Stop accepting new connections + clear scheduled work
  clearSchedule();
  clearEmailSchedule();
  clearSmsIntervals();
  clearReferralInterval();
  clearSessionInterval();
  server.close(() => console.log('Server stopped accepting connections'));

  // Phase 2: Wait for in-flight requests to complete (up to 30s)
  const drainStart = Date.now();
  while (getInflightCount() > 0 && Date.now() - drainStart < GRACEFUL_TIMEOUT_MS) {
    console.log(`Waiting for ${getInflightCount()} in-flight request(s)...`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (getInflightCount() > 0) {
    console.warn(`Shutdown timeout: ${getInflightCount()} request(s) still in-flight after ${GRACEFUL_TIMEOUT_MS}ms`);
  }

  // Phase 3: Cleanup
  try { flushSessions(); } catch (e) { console.error('Session flush on shutdown:', e.message); }
  try { require('./db').closeDb(); } catch {}

  console.log('Graceful shutdown complete');
  process.exit(getInflightCount() > 0 ? 1 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  shutdown('uncaughtException');
});
