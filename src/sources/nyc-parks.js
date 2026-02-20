const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString, resolveNeighborhood, inferCategory } = require('../geo');

async function fetchNYCParksEvents() {
  console.log('Fetching NYC Parks...');
  try {
    const today = getNycDateString(0);
    const tomorrow = getNycDateString(1);
    const events = [];
    const seen = new Set();

    for (const page of [1, 2]) {
      const url = page === 1
        ? 'https://www.nycgovparks.org/events'
        : `https://www.nycgovparks.org/events/p${page}`;
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`NYC Parks page ${page} fetch failed: ${res.status}`);
        continue;
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      $('[itemscope][itemtype="http://schema.org/Event"]').each((i, el) => {
        const $el = $(el);

        const title = $el.find('[itemprop="name"] > a').first().text().trim()
          || $el.find('h3[itemprop="name"]').first().text().trim();
        const startDate = $el.find('meta[itemprop="startDate"]').attr('content') || null;
        const endDate = $el.find('meta[itemprop="endDate"]').attr('content') || null;
        const dateLocal = startDate ? startDate.slice(0, 10) : null;

        if (dateLocal && dateLocal !== today && dateLocal !== tomorrow) return;

        const venueName = $el.find('[itemprop="location"] [itemprop="name"]').first().text().trim() || null;
        const venueAddress = $el.find('meta[itemprop="streetAddress"]').attr('content') || null;
        const borough = $el.find('[itemprop="addressLocality"]').first().text().trim() || null;
        const description = $el.find('[itemprop="description"]').first().text().trim() || null;
        const eventUrl = $el.find('h3 a, [itemprop="name"] a').first().attr('href') || null;

        const categories = [];
        $el.find('a[href^="/events/"]').each((j, link) => {
          const href = $(link).attr('href');
          const cat = href.replace('/events/', '');
          if (cat && !cat.includes('/') && cat !== 'all') categories.push(cat);
        });

        if (!title) return;

        const neighborhood = resolveNeighborhood(borough, null, null);

        const id = makeEventId(title, venueName, dateLocal, 'nyc_parks');
        if (seen.has(id)) return;
        seen.add(id);

        const nameAndDesc = ((title || '') + ' ' + (description || '')).toLowerCase();
        const category = inferCategory(nameAndDesc);

        events.push({
          id,
          source_name: 'nyc_parks',
          source_type: 'government',
          source_weight: 0.75,
          name: title,
          description_short: description ? description.slice(0, 180) : null,
          short_detail: description ? description.slice(0, 180) : null,
          venue_name: venueName || 'NYC Park',
          venue_address: venueAddress || null,
          neighborhood,
          start_time_local: startDate || null,
          end_time_local: endDate || null,
          date_local: dateLocal,
          time_window: null,
          is_free: true,
          price_display: 'free',
          category,
          subcategory: categories[0] || null,
          ticket_url: eventUrl ? `https://www.nycgovparks.org${eventUrl}` : null,
          source_url: eventUrl ? `https://www.nycgovparks.org${eventUrl}` : null,
          map_url: null,
          map_hint: venueAddress || null,
        });
      });
    }

    console.log(`NYC Parks: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('NYC Parks error:', err.message);
    return [];
  }
}

module.exports = { fetchNYCParksEvents };
