const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood, getNycDateString } = require('../geo');

const VENUE_URL = 'https://donyc.com/venues/sofar-sounds-secret-location';
const MAX_PAGES = 3;

/**
 * Extract neighborhood from Sofar event name.
 * "Sofar Sounds - Meatpacking District" → "Meatpacking District"
 * "Sofar Sounds - Lower Manhattan" → "Lower Manhattan"
 */
function extractNeighborhood(name) {
  const m = name.match(/^Sofar Sounds\s*[-–—]\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseCards($, cards) {
  const today = getNycDateString(0);
  const maxDate = getNycDateString(14);
  const parsed = [];

  cards.each((_, el) => {
    const card = $(el);
    const name = card.find('.ds-listing-event-title-text').text().trim();
    if (!name) return;

    const eventPath = card.find('a[itemprop="url"]').attr('href');
    const sourceUrl = eventPath ? `https://donyc.com${eventPath}` : null;

    const startDate = card.find('meta[itemprop="startDate"]').attr('content') || null;
    let dateLocal = null;
    if (startDate) {
      const dm = startDate.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dm) dateLocal = dm[1];
    }
    if (!dateLocal) return;
    if (dateLocal < today || dateLocal > maxDate) return;

    const hoodName = extractNeighborhood(name);
    const neighborhood = hoodName ? resolveNeighborhood(hoodName, null, null) : null;

    const cardText = card.text();
    const isFree = /\bfree\b/i.test(cardText);
    let priceDisplay = isFree ? 'free' : null;
    if (!isFree) {
      const rangeMatch = cardText.match(/\$(\d+(?:\.\d{2})?)\s*[-–]\s*\$?(\d+(?:\.\d{2})?)/);
      if (rangeMatch) {
        priceDisplay = `$${rangeMatch[1]}-$${rangeMatch[2]}`;
      } else {
        const priceMatch = cardText.match(/\$(\d+)/);
        if (priceMatch) priceDisplay = `$${priceMatch[1]}`;
      }
    }

    let ticketUrl = sourceUrl;
    const buyLink = card.find('a[href*="sofarsounds"]').attr('href') ||
                    card.find('a[href*="sofar"]').attr('href');
    if (buyLink) ticketUrl = buyLink;

    const id = makeEventId(name, 'Sofar Sounds', dateLocal, 'sofarsounds', sourceUrl, startDate);

    parsed.push({
      id,
      source_name: 'SofarSounds',
      source_type: 'venue',
      name,
      description_short: 'Intimate secret concert featuring 3 diverse acts at a surprise venue',
      short_detail: 'Intimate secret concert featuring 3 diverse acts at a surprise venue',
      venue_name: 'Sofar Sounds - Secret Location',
      venue_address: null,
      neighborhood,
      start_time_local: startDate || null,
      end_time_local: null,
      date_local: dateLocal,
      time_window: null,
      is_free: isFree,
      price_display: priceDisplay,
      category: 'live_music',
      subcategory: null,
      ticket_url: ticketUrl,
      source_url: sourceUrl,
      map_url: null,
      map_hint: hoodName || null,
    });
  });

  return parsed;
}

async function fetchSofarSoundsEvents() {
  console.log('Fetching Sofar Sounds...');
  try {
    const allEvents = [];
    const seen = new Set();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? VENUE_URL : `${VENUE_URL}?page=${page}`;
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        console.error(`SofarSounds: page ${page} failed (${res.status})`);
        break;
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      const cards = $('.ds-listing.event-card');

      if (cards.length === 0) break;

      for (const evt of parseCards($, cards)) {
        if (seen.has(evt.id)) continue;
        seen.add(evt.id);
        allEvents.push(evt);
      }

      const hasNext = $('a[href*="page="]').filter((_, a) =>
        /next\s*page/i.test($(a).text())
      ).length > 0;
      if (!hasNext) break;
    }

    console.log(`SofarSounds: ${allEvents.length} events`);
    return allEvents;
  } catch (err) {
    console.error('SofarSounds error:', err.message);
    return [];
  }
}

module.exports = { fetchSofarSoundsEvents, extractNeighborhood };
