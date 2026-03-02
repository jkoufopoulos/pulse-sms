const { check } = require('../helpers');
const { buildUnifiedPrompt } = require('../../src/skills/build-compose-prompt');
const skills = require('../../src/skills/compose-skills');
const { UNIFIED_SYSTEM } = require('../../src/prompts');

console.log('\nskill definitions:');

const skillIds = Object.values(skills).map(s => s.id);
check('all skill IDs are unique', new Set(skillIds).size === skillIds.length);
check('core skill removed (#17)', !skills.core);
check('all skills have id', Object.values(skills).every(s => typeof s.id === 'string'));
check('all skills have text field', Object.values(skills).every(s => typeof s.text === 'string'));

console.log('\nbuildUnifiedPrompt:');

// Core-only (no events, no options)
const coreOnly = buildUnifiedPrompt([], {});
check('core-only includes role tag', coreOnly.includes('<role>'));
check('core-only includes output_format', coreOnly.includes('<output_format>'));
check('core-only does NOT include tonight-priority', !coreOnly.includes('tonight-priority'));
check('core-only does NOT include last-batch', !coreOnly.includes('last-batch'));
check('core-only does NOT include free-emphasis', !coreOnly.includes('free-emphasis'));

// With today events
const todayEvents = [{ date_local: null, day: 'TODAY', source_name: 'dice' }];
const withToday = buildUnifiedPrompt(todayEvents, {});
check('today events includes tonight-priority', withToday.includes('tonight-priority'));
check('today events includes source tiers', withToday.includes('source-tiers'));

// With isLastBatch
const withLastBatch = buildUnifiedPrompt([], { isLastBatch: true });
check('isLastBatch includes last-batch text', withLastBatch.includes('last-batch'));

// With exhaustionSuggestion
const withExhaustion = buildUnifiedPrompt([], { isLastBatch: true, exhaustionSuggestion: 'Try Bushwick!' });
check('exhaustionSuggestion appended', withExhaustion.includes('Try Bushwick!'));

// With isFree
const withFree = buildUnifiedPrompt([], { isFree: true });
check('isFree includes free-emphasis', withFree.includes('asked for free'));

// With pendingMessage
const withPending = buildUnifiedPrompt([], { pendingMessage: 'free comedy in BK' });
check('pendingMessage included', withPending.includes('free comedy in BK'));
check('pendingMessage has prioritize framing', withPending.includes('Prioritize events matching'));

// Neighborhood mismatch
const mismatchEvents = [{ neighborhood: 'Bushwick', source_name: 'dice' }];
const withMismatch = buildUnifiedPrompt(mismatchEvents, { requestedNeighborhood: 'East Village' });
check('neighborhood mismatch detected', withMismatch.includes('neighborhood-mismatch'));

const noMismatch = buildUnifiedPrompt(mismatchEvents, { requestedNeighborhood: 'Bushwick' });
check('no mismatch when neighborhoods match', !noMismatch.includes('neighborhood-mismatch'));

// Prompt always includes UNIFIED_SYSTEM base
check('unified prompt includes UNIFIED_SYSTEM content', coreOnly.includes('You are Bestie'));

// Typical case: core + tonight-priority + source-trust (most common compose call)
console.log('\nprompt size:');
const typicalPrompt = buildUnifiedPrompt(
  [{ source_name: 'dice', day: 'TODAY', neighborhood: 'East Village' }],
  { requestedNeighborhood: 'East Village' }
);
console.log(`  UNIFIED_SYSTEM base: ${UNIFIED_SYSTEM.length} chars`);
console.log(`  typical prompt: ${typicalPrompt.length} chars`);
console.log(`  core-only prompt: ${coreOnly.length} chars`);
