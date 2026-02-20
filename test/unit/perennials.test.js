const { check } = require('../helpers');
const { getPerennialPicks, toEventObjects, _resetCache } = require('../../src/perennial');

// ---- getPerennialPicks ----
console.log('\ngetPerennialPicks:');

// Basic: known neighborhood returns local picks
const wvPicks = getPerennialPicks('West Village', { dayOfWeek: 'fri' });
check('West Village has local picks', wvPicks.local.length > 0);
check('West Village picks include Smalls', wvPicks.local.some(p => p.venue === 'Smalls Jazz Club'));
check('returns { local, nearby } shape', Array.isArray(wvPicks.local) && Array.isArray(wvPicks.nearby));

// Day filtering: Bed-Stuy has "any" day picks and day-specific picks
const bedStuyMon = getPerennialPicks('Bed-Stuy', { dayOfWeek: 'mon' });
check('Bed-Stuy has "any" day picks on Monday', bedStuyMon.local.length > 0);
const bedStuyFri = getPerennialPicks('Bed-Stuy', { dayOfWeek: 'fri' });
check('Bed-Stuy has more picks on Friday than Monday', bedStuyFri.local.length > bedStuyMon.local.length);

// "any" day always matches
const uwsPicks = getPerennialPicks('Upper West Side', { dayOfWeek: 'tue' });
check('UWS "any" day picks show on Tuesday', uwsPicks.local.length > 0);

// Adjacent neighborhoods show up as nearby
const chelseaPicks = getPerennialPicks('Chelsea', { dayOfWeek: 'fri' });
check('Chelsea has nearby picks from adjacent hoods', chelseaPicks.nearby.length > 0);
check('nearby picks have neighborhood tag', chelseaPicks.nearby.every(p => typeof p.neighborhood === 'string'));

// Unknown neighborhood returns empty
const unknownPicks = getPerennialPicks('Mars', { dayOfWeek: 'fri' });
check('unknown neighborhood returns empty local', unknownPicks.local.length === 0);

// ---- toEventObjects ----
console.log('\ntoEventObjects:');

const wvEventObjs = toEventObjects(wvPicks.local, 'West Village');
check('returns array', Array.isArray(wvEventObjs));
check('non-empty for West Village', wvEventObjs.length > 0);

const firstObj = wvEventObjs[0];
check('id starts with perennial_', firstObj.id.startsWith('perennial_'));
check('id is stable across calls', toEventObjects(wvPicks.local, 'West Village')[0].id === firstObj.id);
check('source_name is perennial', firstObj.source_name === 'perennial');
check('source_weight is 0.78', firstObj.source_weight === 0.78);
check('date_local is null', firstObj.date_local === null);
check('start_time_local is null', firstObj.start_time_local === null);
check('day is null', firstObj.day === null);
check('has name', typeof firstObj.name === 'string' && firstObj.name.length > 0);
check('has venue_name', typeof firstObj.venue_name === 'string');
check('has neighborhood', firstObj.neighborhood === 'West Village');
check('has short_detail', typeof firstObj.short_detail === 'string');
check('has description_short', typeof firstObj.description_short === 'string');
check('completeness is 0.5 for local', firstObj.completeness === 0.5);
check('extraction_confidence is null for perennials', firstObj.extraction_confidence === null);

// Nearby picks have completeness too
const nearbyEventObjs = toEventObjects(chelseaPicks.nearby, 'Chelsea', { isNearby: true });
check('nearby completeness is 0.5', nearbyEventObjs.length > 0 && nearbyEventObjs[0].completeness === 0.5);

// Free picks have is_free: true
const bedStuyAllPicks = getPerennialPicks('Bed-Stuy', { dayOfWeek: 'fri' });
const bedStuyEventObjs = toEventObjects(bedStuyAllPicks.local, 'Bed-Stuy');
const freeObj = bedStuyEventObjs.find(e => e.is_free === true);
const paidObj = bedStuyEventObjs.find(e => e.is_free === false);
check('free picks have is_free: true', freeObj !== undefined);
check('paid picks have is_free: false', paidObj !== undefined);

// Empty input returns empty array
check('empty array returns empty', toEventObjects([], 'Test').length === 0);
check('null returns empty', toEventObjects(null, 'Test').length === 0);

// URL fields populated from pick url
const smallsObj = wvEventObjs.find(e => e.name === 'Smalls Jazz Club');
check('ticket_url from pick url', smallsObj && smallsObj.ticket_url === 'https://www.smallslive.com');
check('source_url from pick url', smallsObj && smallsObj.source_url === 'https://www.smallslive.com');

// Picks without url have null
const johnnysObj = wvEventObjs.find(e => e.name === "Johnny's Bar");
check('no url pick has null ticket_url', johnnysObj && johnnysObj.ticket_url === null);
