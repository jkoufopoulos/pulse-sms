require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const smsRoutes = require('./handler');
const { clearSmsIntervals } = require('./handler');
const { refreshCache, getCacheStatus, getHealthStatus, getEventById, isCacheFresh, scheduleDailyScrape, clearSchedule } = require('./events');
const { loadProfiles } = require('./preference-profile');
const { loadReferrals, clearReferralInterval } = require('./referral');
const { loadAlerts, getRecentAlerts } = require('./alerts');
const { renderEventCard, renderStaleCard } = require('./card');

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
app.use(express.json({ limit: '2mb' }));

// Public health check — no internal details (L10 fix)
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pulse' });
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

// SMS webhook
app.use('/api/sms', smsRoutes);

// Architecture explorer (read-only doc, always available)
app.get('/architecture', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'architecture.html'));
});

// Eval report viewer (read-only, always available)
app.get('/eval-report', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'eval-report.html'));
});

// Eval report API — list available reports and serve report data
const REPORT_PREFIXES = {
  'scenario-eval-': 'scenario',
  'regression-eval-': 'regression',
  'extraction-audit-': 'extraction',
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
        return { ...base, total: data.total, passed: data.passed, failed: data.failed, errors: data.errors, judge_model: data.judge_model, judge_cost: data.judge_cost, elapsed_seconds: data.elapsed_seconds, concurrency: data.concurrency, base_url: data.base_url };
      }
      if (type === 'regression') {
        const scenarios = data.scenarios || [];
        const passed = scenarios.filter(s => s.pass).length;
        return { ...base, total: scenarios.length, passed, failed: scenarios.length - passed, principles: data.principles || [], elapsed_seconds: data.elapsed_seconds, base_url: data.base_url };
      }
      if (type === 'extraction') {
        return { ...base, total: data.summary?.total, passed: data.summary?.passed, pass_rate: data.summary?.passRate, tier: data.tier };
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
  const fs = require('fs');
  const path = require('path');
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  const filePath = path.join(reportsDir, 'scenario-overrides.json');
  const { verdict, category, notes, against_report, against_llm_verdict } = req.body;

  if (!verdict || !['pass', 'fail'].includes(verdict)) {
    return res.status(400).json({ error: 'verdict must be "pass" or "fail"' });
  }
  if (!category || !['false_failure', 'false_pass', 'data_dependent', 'known_bug'].includes(category)) {
    return res.status(400).json({ error: 'category must be one of: false_failure, false_pass, data_dependent, known_bug' });
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'events-ui.html'));
});
app.get('/api/events', (req, res) => {
  const { getRawCache } = require('./events');
  res.json(getRawCache());
});

// Event card page — shareable Pulse URLs with OG meta tags
app.get('/e/:eventId', (req, res) => {
  const pulsePhone = process.env.TWILIO_PHONE_NUMBER || '+18337857300';
  const domain = process.env.PULSE_CARD_DOMAIN || `${req.protocol}://${req.get('host')}`;
  const formattedPhone = pulsePhone.replace(/\D/g, '').replace(/^1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
  const event = getEventById(req.params.eventId);
  if (event) {
    const refCode = req.query.ref || null;
    res.send(renderEventCard(event, formattedPhone, pulsePhone, domain, refCode));
  } else {
    res.send(renderStaleCard(formattedPhone, pulsePhone));
  }
});

// --- Read-only dashboards & APIs (always available) ---

// Eval dashboard UI
app.get('/eval', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'eval-ui.html'));
});

// API: get all cached events
app.get('/api/eval/events', (req, res) => {
  const { getRawCache } = require('./events');
  res.json(getRawCache());
});

// API: trace endpoints
const { getRecentTraces, getTraceById, annotateTrace, loadTraces, startConversationCapture } = require('./traces');
loadTraces(); // Load existing traces from disk at startup
startConversationCapture(); // Thread traces into conversations for golden dataset

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

  // API: force scrape — all sources or selective (?sources=skint,yutori)
  app.post('/api/scrape', async (req, res) => {
    try {
      const { refreshCache, refreshSources, getRawCache } = require('./events');
      const sourceFilter = req.query.sources?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (sourceFilter?.length > 0) {
        await refreshSources(sourceFilter);
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

  // API: simulate a neighborhood request — shows the full event funnel
  app.post('/api/eval/simulate', async (req, res) => {
    try {
      const { neighborhood } = req.body;
      if (!neighborhood) {
        return res.status(400).json({ error: 'Missing neighborhood' });
      }

      const { getEvents } = require('./events');
      const { composeResponse } = require('./ai');

      const candidates = await getEvents(neighborhood);
      const sent_to_claude = candidates.slice(0, 8);
      const compose_result = await composeResponse(
        "what's happening in " + neighborhood,
        sent_to_claude,
        neighborhood,
        {}
      );

      const pickedIds = new Set((compose_result.picks || []).map(p => p.event_id));
      const picked = sent_to_claude.filter(e => pickedIds.has(e.id));
      const not_picked = sent_to_claude.filter(e => !pickedIds.has(e.id));

      res.json({
        neighborhood,
        candidates,
        sent_to_claude,
        compose_result,
        picked,
        not_picked,
      });
    } catch (err) {
      console.error('Eval simulate error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

const server = app.listen(PORT, () => {
  console.log(`Pulse listening on port ${PORT}`);
  loadProfiles();
  loadReferrals();
  loadAlerts();

  // Scrape on startup only if no fresh persisted cache — saves time and tokens on restarts
  if (isCacheFresh()) {
    console.log('Persisted cache is fresh, skipping startup scrape');
  } else {
    refreshCache().catch(err => console.error('Initial cache load failed:', err.message));
  }
  scheduleDailyScrape();
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  clearSchedule();
  clearSmsIntervals();
  clearReferralInterval();
  // Flush captured conversations before exit
  try { require('./traces').stopConversationCapture(); } catch {}
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled rejection:', reason);
});
