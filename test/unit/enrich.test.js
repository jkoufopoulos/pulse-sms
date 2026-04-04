const { check } = require('../helpers');

console.log('enrich.test.js');

// Test: identifyGaps flags events missing URLs
const { identifyGaps } = require('../../src/enrich');

const complete = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: 'https://example.com', start_time_local: '2026-04-04T20:00:00', description_short: 'Live jazz' };
const missingUrl = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: null, ticket_url: null, start_time_local: '2026-04-04T20:00:00', description_short: 'Live jazz' };
const missingTime = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: 'https://example.com', start_time_local: null, description_short: 'Live jazz' };
const missingDesc = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: 'https://example.com', start_time_local: '2026-04-04T20:00:00', description_short: null, description: null };
const missingAll = { name: 'Jazz Night', venue_name: 'Blue Note', source_url: null, ticket_url: null, start_time_local: null, description_short: null, description: null };

const gaps = identifyGaps([complete, missingUrl, missingTime, missingDesc, missingAll]);
check('identifyGaps: complete event has no gaps', gaps.get(complete) === undefined);
check('identifyGaps: missing URL flagged', gaps.get(missingUrl).includes('url'));
check('identifyGaps: missing time flagged', gaps.get(missingTime).includes('time'));
check('identifyGaps: missing desc flagged', gaps.get(missingDesc).includes('description'));
check('identifyGaps: missing all has 3 gaps', gaps.get(missingAll).length === 3);

// Test: buildSearchQuery creates sensible query
const { buildSearchQuery } = require('../../src/enrich');
check('buildSearchQuery: includes name and venue', buildSearchQuery(missingUrl) === '"Jazz Night" "Blue Note" NYC');
check('buildSearchQuery: no venue uses name only', buildSearchQuery({ name: 'Jazz Night', venue_name: null }) === '"Jazz Night" NYC');

module.exports = { check };
