const { check } = require('../helpers');
const { checkMechanical } = require('../../src/agent-brain');

const sessionWithPicks = {
  lastPicks: [{ id: 'e1', name: 'Test Event' }],
  lastNeighborhood: 'williamsburg',
  lastResponseHadPicks: true
};

const emptySession = {};

// ---- checkMechanical ----
console.log('\ncheckMechanical:');

// Help returns intent
check('help → { intent: "help" }', JSON.stringify(checkMechanical('help', emptySession)) === '{"intent":"help"}');
check('? → { intent: "help" }', JSON.stringify(checkMechanical('?', emptySession)) === '{"intent":"help"}');
check('HELP (uppercase) → { intent: "help" }', JSON.stringify(checkMechanical('HELP', emptySession)) === '{"intent":"help"}');

// TCPA returns null (silent drop)
check('STOP → null', checkMechanical('STOP', emptySession) === null);
check('unsubscribe → null', checkMechanical('unsubscribe', emptySession) === null);

// Bare numbers → null (fall through to agent brain)
check('bare "1" with picks → null', checkMechanical('1', sessionWithPicks) === null);
check('bare "3" with picks → null', checkMechanical('3', sessionWithPicks) === null);
check('bare "5" without session → null', checkMechanical('5', emptySession) === null);

// "more" / "what else" → null (fall through to agent brain)
check('"more" with session → null', checkMechanical('more', sessionWithPicks) === null);
check('"what else" with session → null', checkMechanical('what else', sessionWithPicks) === null);
check('"more" without session → null', checkMechanical('more', emptySession) === null);

// Greetings → null (fall through to agent brain)
check('"hey" → null', checkMechanical('hey', emptySession) === null);
check('"hello" with session → null', checkMechanical('hello', sessionWithPicks) === null);
check('"yo" → null', checkMechanical('yo', emptySession) === null);

// Thanks → null (fall through to agent brain)
check('"thanks" → null', checkMechanical('thanks', emptySession) === null);
check('"thank you" → null', checkMechanical('thank you', emptySession) === null);

// Bye → null (fall through to agent brain)
check('"bye" → null', checkMechanical('bye', emptySession) === null);
check('"later" → null', checkMechanical('later', emptySession) === null);

// Satisfied-exit → null (fall through to agent brain)
check('"cool" → null', checkMechanical('cool', emptySession) === null);
check('"sounds good" → null', checkMechanical('sounds good', emptySession) === null);
check('"perfect thanks" → null', checkMechanical('perfect thanks', emptySession) === null);

// Decline → null (fall through to agent brain)
check('"nah" → null', checkMechanical('nah', emptySession) === null);
check('"no thanks" → null', checkMechanical('no thanks', emptySession) === null);

// Acknowledgments → null (fall through to agent brain)
check('"ok" with session → null', checkMechanical('ok', sessionWithPicks) === null);
check('"bet" → null', checkMechanical('bet', emptySession) === null);

// Impatient follow-ups → null (fall through to agent brain)
check('"hello??" with session → null', checkMechanical('hello??', sessionWithPicks) === null);
check('"??" → null', checkMechanical('??', emptySession) === null);

// Regular messages → null (fall through to agent brain)
check('"williamsburg" → null', checkMechanical('williamsburg', emptySession) === null);
check('"comedy in bushwick" → null', checkMechanical('comedy in bushwick', emptySession) === null);
