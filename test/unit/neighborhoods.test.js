const { check } = require('../helpers');
const { extractNeighborhood, detectBorough, detectUnsupported } = require('../../src/neighborhoods');

// ---- extractNeighborhood ----
console.log('\nextractNeighborhood:');

check('east village', extractNeighborhood('east village tonight') === 'East Village');
check('LES', extractNeighborhood('LES shows') === 'Lower East Side');
check('williamsburg', extractNeighborhood('wburg bars') === 'Williamsburg');
check('hells kitchen', extractNeighborhood("hell's kitchen food") === "Hell's Kitchen");
check('no match', extractNeighborhood('hello world') === null);
check('prefers longer match', extractNeighborhood('events in lower east side today') === 'Lower East Side');
// Word boundary: short aliases don't match inside common words
check('ev not in events', extractNeighborhood('any events tonight') === null);
check('ev not in every', extractNeighborhood('every bar nearby') === null);
check('ev not in never', extractNeighborhood('never mind') === null);
check('ev standalone works', extractNeighborhood('ev tonight') === 'East Village');
// Borough shortcuts — boroughs now go through detectBorough, not extractNeighborhood
check('brooklyn returns null', extractNeighborhood('brooklyn tonight') === null);
check('bk returns null', extractNeighborhood('anything in bk') === null);
check('manhattan returns null', extractNeighborhood('manhattan') === null);
check('queens returns null', extractNeighborhood('queens') === null);
check('nyc returns null', extractNeighborhood('nyc tonight') === null);
// detectBorough tests
check('detectBorough bk', detectBorough('anything in bk')?.borough === 'brooklyn');
check('detectBorough queens', detectBorough('queens')?.borough === 'queens');
check('detectBorough brooklyn has hoods', detectBorough('brooklyn tonight')?.neighborhoods?.includes('Williamsburg'));
check('detectBorough non-borough', detectBorough('east village') === null);
// detectUnsupported tests
check('detectUnsupported bay ridge', detectUnsupported('bay ridge')?.name === 'Bay Ridge');
check('detectUnsupported bay ridge has nearby', detectUnsupported('bay ridge')?.nearby?.includes('Sunset Park'));
check('detectUnsupported known hood returns null', detectUnsupported('east village') === null);
check('detectUnsupported gibberish returns null', detectUnsupported('asdfjkl') === null);
// New aliases
check('union sq', extractNeighborhood('union sq tonight') === 'Flatiron');
check('nolita', extractNeighborhood('nolita drinks') === 'SoHo');
check('e.v.', extractNeighborhood('E.V. tonight') === 'East Village');

// ---- extractNeighborhood: landmarks ----
console.log('\nextractNeighborhood (landmarks):');

check('prospect park', extractNeighborhood('near prospect park') === 'Park Slope');
check('central park', extractNeighborhood('central park area') === 'Midtown');
check('washington square', extractNeighborhood('by washington square') === 'Greenwich Village');
check('wash sq', extractNeighborhood('wash sq tonight') === 'Greenwich Village');
check('bryant park', extractNeighborhood('bryant park vibes') === 'Midtown');
check('mccarren park', extractNeighborhood('mccarren park') === 'Williamsburg');
check('tompkins square', extractNeighborhood('near tompkins square') === 'East Village');
check('tompkins', extractNeighborhood('tompkins area') === 'East Village');
check('domino park', extractNeighborhood('domino park') === 'Williamsburg');
check('brooklyn bridge', extractNeighborhood('near brooklyn bridge') === 'DUMBO');
check('highline', extractNeighborhood('the highline') === 'Chelsea');
check('high line', extractNeighborhood('near the high line') === 'Chelsea');
check('hudson yards', extractNeighborhood('hudson yards tonight') === 'Chelsea');
check('barclays center', extractNeighborhood('near barclays center') === 'Downtown Brooklyn');
check('msg', extractNeighborhood('near msg') === 'Midtown');
check('lincoln center', extractNeighborhood('lincoln center area') === 'Upper West Side');
check('carnegie hall', extractNeighborhood('carnegie hall tonight') === 'Midtown');

// ---- extractNeighborhood: subway refs ----
console.log('\nextractNeighborhood (subway):');

check('bedford ave', extractNeighborhood('near bedford ave') === 'Williamsburg');
check('bedford stop', extractNeighborhood('bedford stop') === 'Williamsburg');
check('1st ave', extractNeighborhood('at 1st ave') === 'East Village');
check('first ave', extractNeighborhood('first ave area') === 'East Village');
check('14th street', extractNeighborhood('14th street') === 'Flatiron');
check('14th st', extractNeighborhood('near 14th st') === 'Flatiron');
check('grand central', extractNeighborhood('grand central') === 'Midtown');
check('atlantic ave', extractNeighborhood('at atlantic ave') === 'Downtown Brooklyn');
check('atlantic terminal', extractNeighborhood('atlantic terminal') === 'Downtown Brooklyn');
check('dekalb', extractNeighborhood('near dekalb') === 'Downtown Brooklyn');

// ---- Brooklyn Heights ----
console.log('\nBrooklyn Heights:');

const { resolveNeighborhood } = require('../../src/geo');
check('resolveNeighborhood Brooklyn Heights', resolveNeighborhood('Brooklyn Heights', null, null) === 'Brooklyn Heights');
check('alias bk heights', resolveNeighborhood('bk heights', null, null) === 'Brooklyn Heights');
check('extractNeighborhood brooklyn heights', extractNeighborhood('brooklyn heights tonight') === 'Brooklyn Heights');
check('extractNeighborhood bk heights', extractNeighborhood('bk heights tonight') === 'Brooklyn Heights');
check('borough landmark bam', extractNeighborhood('near bam tonight') === 'Fort Greene');
check('borough landmark brooklyn heights promenade', extractNeighborhood('brooklyn heights promenade walk') === 'Brooklyn Heights');
check('Brooklyn Heights in brooklyn borough', require('../../src/neighborhoods').detectBorough('brooklyn')?.neighborhoods?.includes('Brooklyn Heights'));
