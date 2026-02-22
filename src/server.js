require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const smsRoutes = require('./handler');
const { clearSmsIntervals } = require('./handler');
const { refreshCache, getCacheStatus, getHealthStatus, isCacheFresh, scheduleDailyScrape, clearSchedule } = require('./events');

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
app.use(express.json());

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

// SMS webhook
app.use('/api/sms', smsRoutes);

// Architecture explorer (read-only doc, always available)
app.get('/architecture', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'architecture.html'));
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

// SMS simulator UI + Eval dashboard (test mode only)
if (process.env.PULSE_TEST_MODE === 'true') {
  app.get('/test', (req, res) => {
    // Allow inline scripts for the simulator UI (gated behind PULSE_TEST_MODE)
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    res.sendFile(require('path').join(__dirname, 'test-ui.html'));
  });

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

  // API: force cache refresh
  app.post('/api/eval/refresh', async (req, res) => {
    try {
      const { refreshCache, getRawCache } = require('./events');
      await refreshCache();
      res.json(getRawCache());
    } catch (err) {
      console.error('Eval refresh error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // API: trace endpoints
  const { getRecentTraces, getTraceById, annotateTrace, loadTraces } = require('./traces');
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

  // API: extraction audit
  app.get('/api/eval/audit', (req, res) => {
    // Return latest audit report from disk
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

  app.post('/api/eval/audit', async (req, res) => {
    try {
      const { getRawCache, getExtractionInputs } = require('./events');
      const { runFullAudit } = require('./evals/extraction-audit');
      const { events } = getRawCache();
      const inputs = getExtractionInputs();
      const sampleSize = parseInt(req.query.sample) || 10;
      const report = await runFullAudit(events, inputs, sampleSize);
      // Save report
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

      // Step 1: getEvents returns top 20 (filtered upcoming + ranked by proximity)
      const candidates = await getEvents(neighborhood);

      // Step 2: top 8 sent to Claude (mirrors handler.js line 337)
      const sent_to_claude = candidates.slice(0, 8);

      // Step 3: compose response
      const compose_result = await composeResponse(
        "what's happening in " + neighborhood,
        sent_to_claude,
        neighborhood,
        {}
      );

      // Step 4: split sent_to_claude into picked vs not_picked
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
