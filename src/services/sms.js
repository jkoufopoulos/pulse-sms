const twilio = require('twilio');

let client = null;

function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

function maskPhone(phone) {
  if (!phone || phone.length < 4) return '****';
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}

async function sendSMS(to, body) {
  const sendPromise = getClient().messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('sendSMS timed out after 10s')), 10000)
  );
  const msg = await Promise.race([sendPromise, timeoutPromise]);
  const masked = maskPhone(to);
  console.log(`SMS sent to ${masked}: ${msg.sid}`);
  return msg;
}

module.exports = { sendSMS, maskPhone };
