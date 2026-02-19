const { check } = require('../helpers');
const { buildComposePrompt } = require('../../src/skills/build-compose-prompt');
const skills = require('../../src/skills/compose-skills');
const { COMPOSE_SYSTEM } = require('../../src/prompts');

console.log('\nskill definitions:');

const skillIds = Object.values(skills).map(s => s.id);
check('all skill IDs are unique', new Set(skillIds).size === skillIds.length);
check('core skill has text', skills.core.text.length > 100);
check('all skills have id', Object.values(skills).every(s => typeof s.id === 'string'));
check('all skills have text field', Object.values(skills).every(s => typeof s.text === 'string'));

console.log('\nbuildComposePrompt:');

// Core-only (no events, no options)
const coreOnly = buildComposePrompt([], {});
check('core-only includes role tag', coreOnly.includes('<role>'));
check('core-only includes output_format', coreOnly.includes('<output_format>'));
check('core-only includes source trust', coreOnly.includes('SOURCE TRUST HIERARCHY'));
check('core-only does NOT include tonight-priority', !coreOnly.includes('TONIGHT PRIORITY'));
check('core-only does NOT include perennial-framing', !coreOnly.includes('PERENNIAL PICKS'));
check('core-only does NOT include last-batch', !coreOnly.includes('LAST batch'));
check('core-only does NOT include free-emphasis', !coreOnly.includes('asked for free'));

// With today events
const todayEvents = [{ date_local: null, day: 'TODAY', source_name: 'dice' }];
const withToday = buildComposePrompt(todayEvents, {});
check('today events includes tonight-priority', withToday.includes('TONIGHT PRIORITY'));

// With perennial events
const perennialEvents = [{ source_name: 'perennial', short_detail: 'Live jazz' }];
const withPerennial = buildComposePrompt(perennialEvents, {});
check('perennial events includes perennial-framing', withPerennial.includes('PERENNIAL PICKS'));

// With tavily venue items
const tavilyEvents = [{ source_name: 'tavily', name: 'Cool Bar' }];
const withTavily = buildComposePrompt(tavilyEvents, {});
check('tavily events includes venue-framing', withTavily.includes('VENUE ITEMS'));

// With isLastBatch
const withLastBatch = buildComposePrompt([], { isLastBatch: true });
check('isLastBatch includes last-batch text', withLastBatch.includes('LAST batch'));

// With exhaustionSuggestion
const withExhaustion = buildComposePrompt([], { isLastBatch: true, exhaustionSuggestion: 'Try Bushwick!' });
check('exhaustionSuggestion appended', withExhaustion.includes('Try Bushwick!'));

// With isFree
const withFree = buildComposePrompt([], { isFree: true });
check('isFree includes free-emphasis', withFree.includes('asked for free'));

// With pendingMessage
const withPending = buildComposePrompt([], { pendingMessage: 'free comedy in BK' });
check('pendingMessage included', withPending.includes('free comedy in BK'));
check('pendingMessage has prioritize framing', withPending.includes('Prioritize events matching'));

// Neighborhood mismatch
const mismatchEvents = [{ neighborhood: 'Bushwick', source_name: 'dice' }];
const withMismatch = buildComposePrompt(mismatchEvents, { requestedNeighborhood: 'East Village' });
check('neighborhood mismatch detected', withMismatch.includes('NEIGHBORHOOD MISMATCH'));

const noMismatch = buildComposePrompt(mismatchEvents, { requestedNeighborhood: 'Bushwick' });
check('no mismatch when neighborhoods match', !noMismatch.includes('NEIGHBORHOOD MISMATCH'));

// Token size comparison
console.log('\nprompt size comparison:');

// Typical case: core + tonight-priority + source-trust (most common compose call)
const typicalPrompt = buildComposePrompt(
  [{ source_name: 'dice', day: 'TODAY', neighborhood: 'East Village' }],
  { requestedNeighborhood: 'East Village' }
);
check('typical prompt shorter than COMPOSE_SYSTEM', typicalPrompt.length < COMPOSE_SYSTEM.length);
check('core-only prompt shorter than COMPOSE_SYSTEM', coreOnly.length < COMPOSE_SYSTEM.length);

const typicalRatio = ((1 - typicalPrompt.length / COMPOSE_SYSTEM.length) * 100).toFixed(0);
const coreRatio = ((1 - coreOnly.length / COMPOSE_SYSTEM.length) * 100).toFixed(0);
console.log(`  (typical is ${typicalRatio}% smaller, core-only is ${coreRatio}% smaller than COMPOSE_SYSTEM)`);
