const { makeEventId, FETCH_HEADERS } = require('./shared');
const { getNycDateString, resolveNeighborhood } = require('../geo');
const { lookupVenue } = require('../venues');

const RA_NYC_AREA_ID = 8;

const RA_QUERY = `query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $filterOptions: FilterOptionsInputDtoInput, $page: Int, $pageSize: Int) {
  eventListings(filters: $filters, filterOptions: $filterOptions, pageSize: $pageSize, page: $page) {
    data {
      id
      listingDate
      event {
        id title date startTime endTime contentUrl isTicketed
        venue { id name contentUrl }
        artists { id name }
        pick { blurb }
      }
    }
    totalResults
  }
}`;

async function fetchRAEvents() {
  console.log('Fetching Resident Advisor...');
  try {
    const today = getNycDateString(0);
    const endDate = getNycDateString(7);

    const payload = {
      operationName: 'GET_EVENT_LISTINGS',
      variables: {
        filters: {
          areas: { eq: RA_NYC_AREA_ID },
          listingDate: {
            gte: `${today}T00:00:00.000Z`,
            lte: `${endDate}T23:59:59.000Z`,
          },
        },
        filterOptions: { genre: true },
        pageSize: 30,
        page: 1,
      },
      query: RA_QUERY,
    };

    const events = [];
    const PAGE_SIZE = 30;
    const MAX_PAGES = 10;
    let page = 1;
    let totalResults = 0;

    while (page <= MAX_PAGES) {
      payload.variables.page = page;

      const res = await fetch('https://ra.co/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://ra.co/events/us/newyorkcity',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        console.error(`RA fetch failed: ${res.status} (page ${page})`);
        break;
      }

      const data = await res.json();

      if (data.errors) {
        console.error('RA GraphQL errors:', data.errors[0]?.message);
        break;
      }

      const listings = data?.data?.eventListings?.data;
      if (!Array.isArray(listings) || listings.length === 0) break;

      totalResults = data?.data?.eventListings?.totalResults || 0;

      for (const listing of listings) {
        const e = listing.event;
        if (!e || !e.title) continue;

        const dateLocal = e.date ? e.date.slice(0, 10) : (listing.listingDate ? listing.listingDate.slice(0, 10) : null);

        const venueName = e.venue?.name;
        const venueCoords = lookupVenue(venueName);
        const neighborhood = venueCoords
          ? resolveNeighborhood(null, venueCoords.lat, venueCoords.lng)
          : null;

        const artists = (e.artists || []).map(a => a.name).filter(Boolean);
        const desc = e.pick?.blurb
          || (artists.length > 0 ? artists.slice(0, 3).join(', ') + (artists.length > 3 ? ` + ${artists.length - 3} more` : '') : null);

        const startTime = e.startTime
          ? (e.startTime.includes('T') ? e.startTime : `${dateLocal}T${e.startTime}:00`)
          : null;
        const endTime = e.endTime
          ? (e.endTime.includes('T') ? e.endTime : `${dateLocal}T${e.endTime}:00`)
          : null;

        events.push({
          id: makeEventId(e.title, venueName, dateLocal, 'ra'),
          source_name: 'ra',
          source_type: 'aggregator',
          name: e.title,
          description_short: desc ? desc.slice(0, 180) : null,
          short_detail: desc ? desc.slice(0, 180) : null,
          venue_name: venueName || 'TBA',
          venue_address: null,
          neighborhood,
          start_time_local: startTime,
          end_time_local: endTime,
          date_local: dateLocal,
          time_window: null,
          is_free: e.isTicketed === false,
          price_display: e.isTicketed === false ? 'free' : (e.isTicketed === true ? 'Ticketed' : null),
          category: 'nightlife',
          subcategory: null,
          ticket_url: e.contentUrl ? `https://ra.co${e.contentUrl}` : null,
          map_url: null,
          map_hint: null,
        });
      }

      // Stop if we've fetched all results
      if (events.length >= totalResults || listings.length < PAGE_SIZE) break;
      page++;
    }

    console.log(`RA: ${events.length} events (${page} pages)`);
    return events;
  } catch (err) {
    console.error('RA error:', err.message);
    return [];
  }
}

module.exports = { fetchRAEvents };
