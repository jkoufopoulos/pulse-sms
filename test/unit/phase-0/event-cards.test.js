const test = require('node:test');
const assert = require('node:assert');
const { buildCard } = require('../../../scripts/phase-0/event-cards.js');

test('buildCard: all six fields present and joined by ". "', () => {
  const event = {
    name: 'Trivia Night',
    venue_name: 'Northern Bell',
    neighborhood: 'Williamsburg',
    category: 'trivia',
    is_free: true,
    short_detail: 'Weekly pub trivia with prizes.',
  };
  const card = buildCard(event);
  assert.strictEqual(
    card,
    'Trivia Night. Northern Bell. Williamsburg. trivia. free. Weekly pub trivia with prizes.'
  );
});

test('buildCard: is_free=false uses price_display', () => {
  const event = {
    name: 'Show', venue_name: 'BAM', neighborhood: 'Fort Greene',
    category: 'film', is_free: false, price_display: '$15',
    short_detail: 'Film screening.',
  };
  const card = buildCard(event);
  assert.ok(card.includes('. $15. '), `expected price segment in card: ${card}`);
});

test('buildCard: missing fields are dropped (no double periods)', () => {
  const event = {
    name: 'Event', venue_name: 'Place',
    // no neighborhood, no category, no price, no detail
    is_free: false,
  };
  const card = buildCard(event);
  assert.strictEqual(card, 'Event. Place');
});

test('buildCard: prefers short_detail over description_short', () => {
  const event = {
    name: 'A', venue_name: 'B',
    short_detail: 'short_one', description_short: 'desc_one',
  };
  const card = buildCard(event);
  assert.ok(card.endsWith('short_one'));
});

test('buildCard: falls back to description_short if short_detail missing', () => {
  const event = {
    name: 'A', venue_name: 'B',
    description_short: 'desc_one',
  };
  const card = buildCard(event);
  assert.ok(card.endsWith('desc_one'));
});
