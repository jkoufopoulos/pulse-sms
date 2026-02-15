const express = require('express');
const { extractNeighborhood } = require('../utils/neighborhoods');
const { fetchEvents, formatEventForPrompt } = require('../services/events');
const { generateResponse } = require('../services/ai');
const { sendSMS } = require('../services/sms');

const router = express.Router();

router.post('/incoming', async (req, res) => {
  const { Body: message, From: phone } = req.body;

  if (!message || !phone) {
    return res.status(400).send('Missing message or phone number');
  }

  console.log(`SMS from ${phone}: ${message}`);

  try {
    // Extract neighborhood from the message, default to Manhattan
    const neighborhood = extractNeighborhood(message) || 'Midtown';

    // Fetch events live from Ticketmaster
    const events = await fetchEvents(neighborhood);
    const eventLines = events.map(formatEventForPrompt);

    console.log(`Found ${events.length} events near ${neighborhood}`);

    // Generate NightOwl response
    const response = await generateResponse(message, eventLines, neighborhood);

    // Send SMS back
    await sendSMS(phone, response);

    console.log(`Response sent to ${phone}: ${response}`);

    // Respond to Twilio webhook (empty TwiML — we already sent via API)
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('Error handling SMS:', err);

    // Try to send an error message to the user
    try {
      await sendSMS(phone, "NightOwl hit a snag — try again in a sec!");
    } catch (smsErr) {
      console.error('Failed to send error SMS:', smsErr);
    }

    res.type('text/xml').send('<Response></Response>');
  }
});

module.exports = router;
