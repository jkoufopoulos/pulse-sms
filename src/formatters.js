const { parseAsNycTime } = require('./geo');
const { isSearchUrl } = require('./ai');

function formatTime(isoStr) {
  // Bare date (no time component) — parse as local to avoid UTC midnight shift
  if (!/T|:/.test(isoStr)) {
    try {
      const [y, m, d] = isoStr.split('-').map(Number);
      if (y && m && d) {
        return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      }
    } catch {}
    return isoStr;
  }
  try {
    // Use parseAsNycTime to correctly handle offset-less ISO strings
    // (e.g. Eventbrite's "2026-02-15T19:00:00" which is NYC local, not UTC)
    const ms = parseAsNycTime(isoStr);
    if (isNaN(ms)) return isoStr;
    return new Date(ms).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return isoStr; }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Strip UTM and tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref' || key === 'fbclid' || key === 'aff') {
        u.searchParams.delete(key);
      }
    }
    let clean = u.toString().replace(/\?$/, '');

    // Shorten Eventbrite: extract trailing numeric ID → eventbrite.com/e/<id>
    const ebMatch = clean.match(/eventbrite\.com\/e\/.*?(\d{10,})$/);
    if (ebMatch) return `https://www.eventbrite.com/e/${ebMatch[1]}`;

    // Shorten Dice: extract hash prefix → dice.fm/event/<hash>
    const diceMatch = clean.match(/dice\.fm\/event\/([a-z0-9]+)-/);
    if (diceMatch) return `https://dice.fm/event/${diceMatch[1]}`;

    // Shorten Songkick: strip slug after concert ID
    const skMatch = clean.match(/(songkick\.com\/concerts\/\d+)/);
    if (skMatch) return `https://www.${skMatch[1]}`;

    return clean;
  } catch { return url; }
}

function formatEventDetails(event) {
  const venue = event.venue_name && event.venue_name !== 'TBA' ? event.venue_name : null;

  // Dedupe: skip "at Venue" if event name already contains venue
  let detail = event.name || '';
  if (venue && !detail.toLowerCase().includes(venue.toLowerCase())) {
    detail += ` at ${venue}`;
  }

  // Time — show end time compactly if same day
  if (event.start_time_local) {
    detail += `\n${formatTime(event.start_time_local)}`;
    if (event.end_time_local) {
      try {
        const startMs = parseAsNycTime(event.start_time_local);
        const endMs = parseAsNycTime(event.end_time_local);
        const start = new Date(startMs);
        const end = new Date(endMs);
        const startDate = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const endDate = end.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        if (startDate === endDate) {
          detail += ` – ${end.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}`;
        } else {
          detail += ` – ${formatTime(event.end_time_local)}`;
        }
      } catch {
        detail += ` – ${formatTime(event.end_time_local)}`;
      }
    }
  }

  if (event.is_free) detail += `\nFree!`;
  else if (event.price_display) detail += `\n${event.price_display}`;

  if (event.venue_address) detail += `\n${event.venue_address}`;
  // URL: prefer ticket_url > source_url, but never search pages. Fallback to Google Maps.
  const directUrl = [event.ticket_url, event.source_url].find(u => u && !isSearchUrl(u));
  if (directUrl) {
    detail += `\n${cleanUrl(directUrl)}`;
  } else {
    // Google Maps fallback
    const venueName = event.venue_name || event.name || '';
    const hood = event.neighborhood || '';
    if (venueName) {
      detail += `\nhttps://www.google.com/maps/search/${encodeURIComponent(`${venueName} ${hood} NYC`.trim())}`;
    }
  }

  // Only show map_hint if it adds info beyond the address
  if (event.map_hint && (!event.venue_address || !event.venue_address.includes(event.map_hint))) {
    const hint = event.map_hint.replace(/^near\s+/i, '');
    detail += `\nNear ${hint}`;
  }

  return detail.slice(0, 480);
}

module.exports = { formatTime, cleanUrl, formatEventDetails };
