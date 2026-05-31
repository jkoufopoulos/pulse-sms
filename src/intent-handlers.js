const { sendSMS } = require('./twilio');
const { WELCOME_INTRO, WELCOME_INSTRUCTIONS } = require('./messages');

// Help is a sidebar — it does not change the search frame. conversationHistory was
// already appended in handler.js before dispatch; we only need to send + finalize.
// Calling saveResponseFrame here used to silently wipe lastBorough/visitedHoods.
async function handleHelp(ctx) {
  const msg1 = WELCOME_INTRO;
  const msg2 = WELCOME_INSTRUCTIONS + ' The more you text, the better it gets.';
  await sendSMS(ctx.phone, msg1);
  await sendSMS(ctx.phone, msg2);
  console.log(`Help sent to ${ctx.masked}`);
  ctx.finalizeTrace(msg1 + '\n' + msg2, 'help');
}

module.exports = { handleHelp };
