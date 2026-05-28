/**
 * Event card builder — concatenates the indexable fields per event.
 * Single source of truth for "what text represents an event in retrieval."
 */

function buildCard(event) {
  const priceField = event.is_free
    ? 'free'
    : (event.price_display || null);

  const detailField = event.short_detail || event.description_short || null;

  const parts = [
    event.name,
    event.venue_name,
    event.neighborhood,
    event.category,
    priceField,
    detailField,
  ].filter(Boolean);

  return parts.join('. ');
}

module.exports = { buildCard };
