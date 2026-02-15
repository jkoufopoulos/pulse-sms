require('dotenv').config();

const express = require('express');
const smsRoutes = require('./routes/sms');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse URL-encoded bodies (Twilio sends form data)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nightowl' });
});

// SMS webhook
app.use('/api/sms', smsRoutes);

app.listen(PORT, () => {
  console.log(`NightOwl listening on port ${PORT}`);

  // Validate required env vars
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'ANTHROPIC_API_KEY', 'TICKETMASTER_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`Warning: missing env vars: ${missing.join(', ')}`);
  }
});
