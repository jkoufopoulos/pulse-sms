const twilio = require('twilio');

let client = null;

function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

async function sendSMS(to, body) {
  const msg = await getClient().messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
  const masked = to.length > 4 ? to.slice(0, -4).replace(/\d/g, '*') + to.slice(-4) : '****';
  console.log(`SMS sent to ${masked}: ${msg.sid}`);
  return msg;
}

module.exports = { sendSMS };
