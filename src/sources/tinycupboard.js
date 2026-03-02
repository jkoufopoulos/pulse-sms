const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS, stripHtml } = require('./shared');
const { getNycDateString } = require('../geo');

const VENUE_ADDRESS = '10 Cooper St, Brooklyn, NY 11207';
const VENUE_NAME = 'The Tiny Cupboard';
const NEIGHBORHOOD = 'Bushwick';

function inferCategory(name, description) {
  const nameLower = name.toLowerCase();
  const text = `${name} ${description}`.toLowerCase();
  // Check name first — stronger signal than description
  if (/\bcomedy|stand[- ]?up|improv|roast|sketch|open mic\b/.test(nameLower)) return 'comedy';
  if (/\btrivia\b/.test(nameLower)) return 'trivia';
  if (/\bboard game|game\s*night\b/.test(nameLower)) return 'community';
  // Fall back to full text
  if (/\bcomedy|stand[- ]?up|improv|roast|sketch|open mic\b/.test(text)) return 'comedy';
  if (/\btrivia\b/.test(text)) return 'trivia';
  if (/\bboard game|game\s*night\b/.test(text)) return 'community';
  return 'comedy'; // venue is primarily comedy
}

async function fetchTinyCupboardEvents() {
  console.log('Fetching Tiny Cupboard...');
  try {
    const res = await fetch('https://www.thetinycupboard.com/calendar', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Tiny Cupboard fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const today = getNycDateString(0);
    const maxDate = getNycDateString(7);
    const events = [];
    const seen = new Set();

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        let data = JSON.parse($(el).html());
        // May be a single object or an array of events
        if (!Array.isArray(data)) data = [data];

        for (const item of data) {
          if (!item || item['@type'] !== 'ComedyEvent') continue;

          const name = (item.name || '').trim();
          if (!name) continue;

          const startDate = item.startDate;
          if (!startDate) continue;

          const dateLocal = startDate.slice(0, 10);
          if (dateLocal < today || dateLocal > maxDate) continue;

          const price = parseFloat(item.offers?.price);
          const isFree = price === 0;
          const priceDisplay = isFree ? 'free' : isNaN(price) ? null : `$${Math.round(price)}`;

          const description = item.description
            ? stripHtml(item.description).slice(0, 180)
            : null;

          const category = inferCategory(name, description || '');
          const sourceUrl = item.url || item.offers?.url || null;

          const id = makeEventId(name, VENUE_NAME, dateLocal, 'tinycupboard', sourceUrl, startDate);
          if (seen.has(id)) continue;
          seen.add(id);

          events.push({
            id,
            source_name: 'tinycupboard',
            source_type: 'venue_calendar',
            name,
            description_short: description,
            short_detail: description,
            venue_name: VENUE_NAME,
            venue_address: VENUE_ADDRESS,
            neighborhood: NEIGHBORHOOD,
            start_time_local: startDate,
            end_time_local: null,
            date_local: dateLocal,
            time_window: null,
            is_free: isFree,
            price_display: priceDisplay,
            category,
            subcategory: null,
            ticket_url: sourceUrl,
            source_url: sourceUrl,
            map_url: null,
            map_hint: VENUE_ADDRESS,
          });
        }
      } catch (parseErr) {
        // Skip malformed JSON-LD blocks
      }
    });

    console.log(`Tiny Cupboard: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Tiny Cupboard error:', err.message);
    return [];
  }
}

module.exports = { fetchTinyCupboardEvents };
