require('dotenv').config();

const express = require('express');
const smsRoutes = require('./handler');
const { clearSmsIntervals } = require('./handler');
const { refreshCache, getCacheStatus, scheduleDailyScrape, clearSchedule } = require('./events');

// Validate required env vars — exit if critical ones are missing
const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'ANTHROPIC_API_KEY', 'TAVILY_API_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`Fatal: missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse URL-encoded bodies (Twilio sends form data)
app.use(express.urlencoded({ extended: false, limit: '5kb' }));
app.use(express.json());

// Health check with cache + source status
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pulse', ...getCacheStatus() });
});

// SMS webhook
app.use('/api/sms', smsRoutes);

// SMS simulator UI + Eval dashboard (test mode only)
if (process.env.PULSE_TEST_MODE === 'true') {
  app.get('/test', (req, res) => {
    res.sendFile(require('path').join(__dirname, 'test-ui.html'));
  });

  // Eval dashboard UI
  app.get('/eval', (req, res) => {
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

  // Scrape on startup, then schedule daily at 10am ET
  refreshCache().catch(err => console.error('Initial cache load failed:', err.message));
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
