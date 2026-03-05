const { sendSMS } = require('./twilio');
const { saveResponseFrame } = require('./pipeline');

async function handleHelp(ctx) {
  const msg1 = "Hey! I'm Pulse — I dig through the best of what's happening in NYC daily that you'll never find on Google or Instagram alone. Comedy, DJ sets, trivia, indie film, art, late-night weirdness, and more across every neighborhood.";
  const msg2 = 'Text me a neighborhood like "Bushwick" or a vibe like "jazz tonight" to start exploring. I\'ll send picks — just tell me what sounds good for details, or ask for more to keep going.';
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
