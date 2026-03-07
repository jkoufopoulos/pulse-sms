const { check } = require('../helpers');
const { formatTime, cleanUrl, formatEventDetails, smartTruncate, injectMissingPrices } = require('../../src/formatters');

// ---- formatTime ----
console.log('\nformatTime:');

check('bare date includes month', formatTime('2026-02-18').includes('Feb'));
const ftIso = formatTime('2026-02-18T21:00:00');
check('ISO datetime includes month', ftIso.includes('Feb'));
check('ISO datetime includes time', /\d:\d{2}/.test(ftIso));
check('ISO with Z includes time', /\d:\d{2}/.test(formatTime('2026-02-18T21:00:00Z')));
check('ISO with offset includes time', /\d:\d{2}/.test(formatTime('2026-02-18T21:00:00-05:00')));
check('null returns null', formatTime(null) === null);
check('invalid string passes through', formatTime('not-a-date') === 'not-a-date');

// ---- cleanUrl ----
console.log('\ncleanUrl:');

check('strips UTM params', !cleanUrl('https://example.com/event?utm_source=fb&utm_medium=social').includes('utm_'));
check('strips fbclid', !cleanUrl('https://example.com/event?fbclid=abc123').includes('fbclid'));
check('shortens Eventbrite', cleanUrl('https://www.eventbrite.com/e/some-event-slug-1234567890').includes('/e/1234567890'));
check('shortens Dice', cleanUrl('https://dice.fm/event/abc123-some-event-name').includes('/event/abc123'));
check('shortens Songkick', cleanUrl('https://www.songkick.com/concerts/12345-artist-name').includes('/concerts/12345'));
check('clean URL unchanged', cleanUrl('https://example.com/events') === 'https://example.com/events');
check('null returns null', cleanUrl(null) === null);
check('invalid URL returns as-is', cleanUrl('not-a-url') === 'not-a-url');

// ---- formatEventDetails ----
console.log('\nformatEventDetails:');

check('minimal event has name', formatEventDetails({ name: 'Jazz Night' }).includes('Jazz Night'));
const fullEvt = {
  name: 'Jazz Night',
  venue_name: 'Smalls Jazz Club',
  start_time_local: '2026-02-18T21:00:00',
  is_free: false,
  price_display: '$20',
  venue_address: '183 W 10th St',
  source_url: 'https://example.com/jazz',
};
const fullDetail = formatEventDetails(fullEvt);
check('full event has venue', fullDetail.includes('Smalls Jazz Club'));
check('full event has time', /\d:\d{2}/.test(fullDetail));
check('full event has price', fullDetail.includes('$20'));
check('full event has URL', fullDetail.includes('example.com'));
check('free event shows Free!', formatEventDetails({ name: 'Free Show', is_free: true }).includes('Free!'));
check('venue-in-name dedup', !formatEventDetails({ name: 'Jazz at Smalls Jazz Club', venue_name: 'Smalls Jazz Club' }).includes('Club at Smalls'));
check('result under 480 chars', fullDetail.length <= 480);

// ---- smartTruncate ----
console.log('\nsmartTruncate:');

check('short text unchanged', smartTruncate('hello') === 'hello');
check('exact 480 unchanged', smartTruncate('a'.repeat(480)) === 'a'.repeat(480));
check('481 gets truncated', smartTruncate('a'.repeat(481)).length <= 481);
check('truncated ends with ellipsis', smartTruncate('word '.repeat(100)).endsWith('…'));
check('does not cut mid-word', !smartTruncate('word '.repeat(100)).endsWith('wor…'));
const urlText = 'Event name\nhttps://example.com/' + 'x'.repeat(500);
check('drops partial URL line', !smartTruncate(urlText).includes('https://'));

// ---- injectMissingPrices ----
console.log('\ninjectMissingPrices:');

const eventMap = {
  'e1': { is_free: true, price_display: 'Free' },
  'e2': { is_free: false, price_display: '$20' },
  'e3': { is_free: false, price_display: null },
};
const picks = [{ event_id: 'e1' }, { event_id: 'e2' }];

check('skips when SMS already has price', injectMissingPrices('Great show, $15 cover', picks, eventMap) === 'Great show, $15 cover');
check('skips when SMS says free', injectMissingPrices('Great free show tonight', picks, eventMap) === 'Great free show tonight');
check('injects when price missing', injectMissingPrices('Great show tonight', picks, eventMap).includes('free'));
check('injects multiple prices', injectMissingPrices('Great show tonight', picks, eventMap).includes('$20'));
check('no picks returns unchanged', injectMissingPrices('Great show', [], eventMap) === 'Great show');
check('no eventMap returns unchanged', injectMissingPrices('Great show', picks, null) === 'Great show');
check('no actionable price returns unchanged', injectMissingPrices('Great show', [{ event_id: 'e3' }], eventMap) === 'Great show');
check('respects 480 char limit', injectMissingPrices('x'.repeat(478), picks, eventMap).length <= 480);
