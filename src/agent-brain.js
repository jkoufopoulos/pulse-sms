/**
 * Agent Brain — Mechanical pre-check (help + TCPA).
 * The agent loop in agent-loop.js handles everything else.
 */

const { OPT_OUT_KEYWORDS } = require('./request-guard');
const { executeMore, executeDetails } = require('./brain-execute');
const { captureConsent } = require('./nudges');

function checkMechanical(message, session, phone) {
  const lower = message.toLowerCase().trim();
  if (/^(help|\?)$/i.test(lower)) return { intent: 'help' };
  if (/^(stop|unsubscribe)\s+notify$/i.test(lower)) return { intent: 'proactive_opt_out' };
  if (/^notify$/i.test(lower)) return { intent: 'proactive_opt_in' };

  // Nudge consent: REMIND ME / NUDGE OFF
  if (phone) {
    const nudge = captureConsent(phone, message);
    if (nudge.handled) return { intent: nudge.intent, reply: nudge.reply };
  }

  if (OPT_OUT_KEYWORDS.test(lower)) return null;
  return null;
}

module.exports = {
  checkMechanical,
  // Re-exports for tests
  executeMore,
  executeDetails,
};
