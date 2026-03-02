const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString } = require('../geo');

const VENUE_NAME = 'Brooklyn Comedy Collective';
const VENUE_ADDRESS = '167 Graham Ave, Brooklyn, NY 11206';
const NEIGHBORHOOD = 'East Williamsburg';

function parseDate(dateText) {
  // "Sunday, March 1, 2026" → "2026-03-01"
  if (!dateText) return null;
  const d = new Date(dateText);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function inferCategory(name) {
  const lower = name.toLowerCase();
  if (/\bimprov\b|jam\b/.test(lower)) return 'comedy';
  if (/\bsketch\b/.test(lower)) return 'comedy';
  if (/\bstand[- ]?up\b|comedy\b|roast\b|open mic\b/.test(lower)) return 'comedy';
  if (/\bclown\b|variety\b|character\b/.test(lower)) return 'comedy';
  if (/\bdrag\b/.test(lower)) return 'theater';
  return 'comedy'; // venue is a comedy theater
}

async function fetchBrooklynCCEvents() {
  console.log('Fetching Brooklyn Comedy Collective...');
  try {
    const res = await fetch('https://www.brooklyncc.com/show-schedule', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`BCC fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const today = getNycDateString(0);
    const maxDate = getNycDateString(7);
    const events = [];
    const seen = new Set();

    $('.eventlist-event').each((_, el) => {
      const $e = $(el);

      const name = $e.find('.eventlist-title-link').text().trim();
      if (!name) return;

      // Date from first meta item: "Sunday, March 1, 2026"
      const dateText = $e.find('.eventlist-meta-item').first().text().trim();
      const dateLocal = parseDate(dateText);
      if (!dateLocal || dateLocal < today || dateLocal > maxDate) return;

      // Time — prefer 24hr format for reliable parsing
      const time24 = $e.find('.event-time-24hr').first().text().trim();
      let startTime = null;
      if (time24 && /^\d{1,2}:\d{2}$/.test(time24)) {
        const hh = time24.split(':')[0].padStart(2, '0');
        const mm = time24.split(':')[1];
        startTime = `${dateLocal}T${hh}:${mm}:00`;
      }

      // Price — from ticket link text or free keyword
      const fullText = $e.text();
      let priceDisplay = null;
      let isFree = false;
      const priceMatch = fullText.match(/Tickets?:\s*\$(\d+)/i);
      if (priceMatch) {
        priceDisplay = `$${priceMatch[1]}`;
      } else if (/\bfree\b/i.test(fullText)) {
        priceDisplay = 'free';
        isFree = true;
      }

      // Ticket URL — Eventbrite link
      let ticketUrl = null;
      $e.find('a[href*="eventbrite"]').each((_, a) => {
        if (!ticketUrl) ticketUrl = $(a).attr('href');
      });

      // Source URL — event detail page
      const titleHref = $e.find('.eventlist-title-link').attr('href');
      const sourceUrl = titleHref ? `https://www.brooklyncc.com${titleHref}` : null;

      // Stage/room as subcategory
      const stage = $e.find('.eventlist-cats a').text().trim() || null;

      const category = inferCategory(name);
      const id = makeEventId(name, VENUE_NAME, dateLocal, 'brooklyncc', sourceUrl, startTime);
      if (seen.has(id)) return;
      seen.add(id);

      events.push({
        id,
        source_name: 'brooklyncc',
        source_type: 'venue_calendar',
        name,
        description_short: stage ? `${name} at ${stage}` : name,
        short_detail: stage ? `${stage} — ${priceDisplay || ''}`.trim() : null,
        venue_name: VENUE_NAME,
        venue_address: VENUE_ADDRESS,
        neighborhood: NEIGHBORHOOD,
        start_time_local: startTime,
        end_time_local: null,
        date_local: dateLocal,
        time_window: null,
        is_free: isFree,
        price_display: priceDisplay,
        category,
        subcategory: stage,
        ticket_url: ticketUrl,
        source_url: sourceUrl,
        map_url: null,
        map_hint: VENUE_ADDRESS,
      });
    });

    console.log(`Brooklyn Comedy Collective: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Brooklyn Comedy Collective error:', err.message);
    return [];
  }
}

module.exports = { fetchBrooklynCCEvents };
