require('dotenv').config();

const express = require('express');
const smsRoutes = require('./routes/sms');
const { clearSmsIntervals } = require('./routes/sms');
const { refreshCache, getCacheStatus } = require('./services/events');

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

// SMS simulator UI (test mode only)
if (process.env.PULSE_TEST_MODE === 'true') {
  app.get('/test', (req, res) => {
    res.sendFile(require('path').join(__dirname, 'test-ui.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`Pulse listening on port ${PORT}`);

  // Fire-and-forget initial cache load (don't block the server)
  refreshCache().catch(err => console.error('Initial cache load failed:', err.message));
});

// Refresh cache every 2 hours
const cacheInterval = setInterval(async () => {
  try {
    await refreshCache();
  } catch (err) {
    console.error('Cache refresh failed:', err.message);
  }
}, 2 * 60 * 60 * 1000);

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  clearInterval(cacheInterval);
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
