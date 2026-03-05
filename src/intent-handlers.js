const { sendSMS } = require('./twilio');
const { saveResponseFrame } = require('./pipeline');
const { WELCOME_INTRO, WELCOME_INSTRUCTIONS } = require('./messages');

async function handleHelp(ctx) {
  const msg1 = WELCOME_INTRO;
  const msg2 = WELCOME_INSTRUCTIONS + ' The more you text, the better it gets.';
  saveResponseFrame(ctx.phone, {
    picks: ctx.session?.lastPicks || [],
    eventMap: ctx.session?.lastEvents || {},
    neighborhood: ctx.session?.lastNeighborhood || null,
    filters: ctx.session?.lastFilters || null,
    offeredIds: ctx.session?.allOfferedIds || [],
    prevSession: ctx.session,
    lastResponseHadPicks: false,
  });
  await sendSMS(ctx.phone, msg1);
  await sendSMS(ctx.phone, msg2);
  console.log(`Help sent to ${ctx.masked}`);
  ctx.finalizeTrace(msg1 + '\n' + msg2, 'help');
}

module.exports = { handleHelp };
