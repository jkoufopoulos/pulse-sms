const { check } = require('../helpers');

console.log('time-proximity.test.js');

const { computeTimeProximityBoost } = require('../../src/pipeline');

// Mock "now" as 9pm
const now = new Date('2026-04-04T21:00:00-04:00');

// Event happening right now (started at 8pm, ends at 11pm)
const happeningNow = { start_time_local: '2026-04-04T20:00:00', end_time_local: '2026-04-04T23:00:00', date_local: '2026-04-04' };
check('happening now gets high boost', computeTimeProximityBoost(happeningNow, now) >= 0.3);

// Event starting in 1 hour
const startingSoon = { start_time_local: '2026-04-04T22:00:00', date_local: '2026-04-04' };
check('starting in 1hr gets moderate boost', computeTimeProximityBoost(startingSoon, now) >= 0.15);

// Event starting in 4 hours
const laterTonight = { start_time_local: '2026-04-05T01:00:00', date_local: '2026-04-05' };
check('starting in 4hr gets small boost', computeTimeProximityBoost(laterTonight, now) >= 0.0);
check('starting in 4hr gets less than starting soon', computeTimeProximityBoost(laterTonight, now) < computeTimeProximityBoost(startingSoon, now));

// Event that already ended
const alreadyEnded = { start_time_local: '2026-04-04T17:00:00', end_time_local: '2026-04-04T19:00:00', date_local: '2026-04-04' };
check('already ended gets zero', computeTimeProximityBoost(alreadyEnded, now) === 0);

// Event with no time
const noTime = { date_local: '2026-04-04' };
check('no time gets zero boost', computeTimeProximityBoost(noTime, now) === 0);

module.exports = { check };
