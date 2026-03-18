/**
 * Agent Brain — Mechanical pre-check (help + TCPA).
 * The agent loop in agent-loop.js handles everything else.
 */

const { OPT_OUT_KEYWORDS } = require('./request-guard');
const { executeMore, executeDetails } = require('./brain-execute');

function checkMechanical(message, session, phone) {
  const lower = message.toLowerCase().trim();
  if (/^(help|\?)$/i.test(lower)) return { intent: 'help' };

  if (OPT_OUT_KEYWORDS.test(lower)) return null;
  return null;
}

module.exports = {
  checkMechanical,
  // Re-exports for tests
  executeMore,
  executeDetails,
};
