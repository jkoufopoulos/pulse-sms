const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString } = require('../geo');

const VENUE_ADDRESSES = {
  'Smalls': '183 W 10th St, New York, NY',
  'Mezzrow': '163 W 10th St, New York, NY',
};

function parseDate(dataDate) {
  // data-date="Feb. 17, 2026" → "2026-02-17"
  if (!dataDate) return null;
  const d = new Date(dataDate.replace('.', ''));
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseFirstTime(timeText, dateLocal) {
  // "6:00 PM & 7:30 PM" → ISO string for 6:00 PM
  // "11:45 PM - 4:00 AM" → ISO string for 11:45 PM
  if (!timeText || !dateLocal) return null;
  const first = timeText.split(/[&\-–]/)[0].trim();
  const match = first.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return `${dateLocal}T${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00-05:00`;
}

async function fetchSmallsLiveEvents() {
  console.log('Fetching SmallsLIVE...');
  try {
    const today = getNycDateString(0);
    const tomorrow = getNycDateString(1);
    const url = `https://www.smallslive.com/search/upcoming-ajax/?page=1&venue=all&starting_date=${today}`;

    const res = await fetch(url, {
      headers: { ...FETCH_HEADERS, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`SmallsLIVE fetch failed: ${res.status}`);
      return [];
    }

    const json = await res.json();
    const html = json.template;
    if (!html) {
      console.error('SmallsLIVE: no template in response');
      return [];
    }

    const $ = cheerio.load(html);
    const events = [];
    const seen = new Set();

    $('.flex-column.day-list').each((i, dayGroup) => {
      const $day = $(dayGroup);
      const dateHeader = $day.find('.title1[data-date]').attr('data-date');
      const dateLocal = parseDate(dateHeader);

      // Only keep today and tomorrow
      if (dateLocal && dateLocal !== today && dateLocal !== tomorrow) return;

      $day.find('.flex-column.day-event').each((j, eventEl) => {
        const $event = $(eventEl);
        const $link = $event.find('a');

        const name = $link.find('.day_event_title').text().trim();
        if (!name) return;

        const venueName = $link.find('div:first-child').text().trim() || 'Smalls';
        const timeText = $link.find('.text-grey').text().trim();
        const href = $link.attr('href');
        const sourceUrl = href ? `https://www.smallslive.com${href}` : null;

        const startTime = parseFirstTime(timeText, dateLocal);
        const venueAddress = VENUE_ADDRESSES[venueName] || VENUE_ADDRESSES['Smalls'];

        const id = makeEventId(name, venueName === 'Mezzrow' ? 'Mezzrow' : 'Smalls Jazz Club', dateLocal, 'smallslive');
        if (seen.has(id)) return;
        seen.add(id);

        events.push({
          id,
          source_name: 'smallslive',
          source_type: 'venue_calendar',
          source_weight: 0.8,
          name,
          description_short: `Live jazz at ${venueName}`,
          short_detail: timeText ? `${timeText} at ${venueName}` : `Live jazz at ${venueName}`,
          venue_name: venueName === 'Mezzrow' ? 'Mezzrow' : 'Smalls Jazz Club',
          venue_address: venueAddress,
          neighborhood: 'West Village',
          start_time_local: startTime,
          end_time_local: null,
          date_local: dateLocal || today,
          time_window: null,
          is_free: false,
          price_display: null,
          category: 'live_music',
          subcategory: 'jazz',
          confidence: 0.9,
          ticket_url: sourceUrl,
          source_url: sourceUrl,
          map_url: null,
          map_hint: venueAddress,
        });
      });
    });

    console.log(`SmallsLIVE: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('SmallsLIVE error:', err.message);
    return [];
  }
}

module.exports = { fetchSmallsLiveEvents };
