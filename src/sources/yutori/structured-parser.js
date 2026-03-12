const { inferCategory } = require('./general-parser');
const { parseTo24h, resolveMonthDay } = require('./trivia-parser');

/**
 * Decode Yutori tracking URLs to their destination.
 * scouts.yutori.com/api/view?url=ENCODED&... → decoded URL
 */
function decodeTrackingUrl(url) {
  const match = url.match(/scouts\.yutori\.com\/api\/view\?url=([^&"'\s]+)/i);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { return url; }
  }
  return url;
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Strip all HTML tags from a string.
 */
function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Extract the first source URL from an HTML block.
 * Looks for tracking badge links (scouts.yutori.com/api/view) or "Details: URL" text.
 */
function extractSourceUrl(html) {
  // Tracking badge: <a href="scouts.yutori.com/api/view?url=...&destination=source">
  const badgeMatch = html.match(
    /href=["'](https?:\/\/scouts\.yutori\.com\/api\/view\?url=[^"']+?destination=source[^"']*)["']/i
  );
  if (badgeMatch) return decodeTrackingUrl(decodeEntities(badgeMatch[1]));

  // Any tracking URL
  const anyTracker = html.match(
    /href=["'](https?:\/\/scouts\.yutori\.com\/api\/view\?url=[^"']+)["']/i
  );
  if (anyTracker) return decodeTrackingUrl(decodeEntities(anyTracker[1]));

  // Details: URL in text
  const text = stripTags(html);
  const detailsMatch = text.match(/Details:\s*(https?:\/\/\S+)/i);
  if (detailsMatch) return detailsMatch[1].replace(/[.,;)]+$/, '');

  // Bare URL in text
  const bareMatch = text.match(/(https?:\/\/(?!scouts\.yutori\.com)\S+)/i);
  if (bareMatch) return bareMatch[1].replace(/[.,;)]+$/, '');

  return null;
}

/**
 * Parse date/time from text like "Thu, Feb 19, 9:30 PM–3:00 AM" or "Tue Mar 3, 8:00 PM".
 * Returns { date_local, start_time_local, end_time_local }.
 */
function parseDateTimeLine(text, fallbackDate) {
  const refYear = fallbackDate ? parseInt(fallbackDate.slice(0, 4), 10) : new Date().getFullYear();
  let dateLocal = null;
  let startTime = null;
  let endTime = null;

  // Extract date: "Mon DD" or "Day, Mon DD"
  const datePatterns = [
    /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
    /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
  ];
  for (const pat of datePatterns) {
    const m = text.match(pat);
    if (m) {
      dateLocal = resolveMonthDay(m[1], m[2], m[3] ? parseInt(m[3], 10) : refYear);
      if (dateLocal) break;
    }
  }
  if (!dateLocal) dateLocal = fallbackDate;

  // Special time words
  const SPECIAL_TIMES = { sunrise: '06:00', sundown: '18:00', sunset: '18:00', noon: '12:00', midnight: '00:00' };
  const specialMatch = text.match(/\b(sunrise|sundown|sunset|noon|midnight)\b/i);
  if (specialMatch && dateLocal) {
    startTime = dateLocal + 'T' + SPECIAL_TIMES[specialMatch[1].toLowerCase()];
  }

  // Doors/show format: "H:MM PM doors / H:MM PM show" — use show time
  if (!startTime) {
    const doorsShowMatch = text.match(/(\d{1,2}(?::\d{2})?)\s*([AP]M)\s*doors\s*\/\s*(\d{1,2}(?::\d{2})?)\s*([AP]M)\s*show/i);
    if (doorsShowMatch && dateLocal) {
      const showTime = doorsShowMatch[3].includes(':') ? doorsShowMatch[3] : doorsShowMatch[3] + ':00';
      startTime = dateLocal + 'T' + parseTo24h(showTime + ' ' + doorsShowMatch[4]);
    }
  }

  // Extract time: "H:MM AM/PM" or "H AM/PM" with optional end time
  if (!startTime) {
    const timeMatch = text.match(/(\d{1,2}(?::\d{2})?)\s*([AP]M)\s*(?:[-–]\s*(\d{1,2}(?::\d{2})?)\s*([AP]M))?/i);
    if (timeMatch && dateLocal) {
      const startRaw = timeMatch[1].includes(':') ? timeMatch[1] : timeMatch[1] + ':00';
      startTime = dateLocal + 'T' + parseTo24h(startRaw + ' ' + timeMatch[2]);
      if (timeMatch[3] && timeMatch[4]) {
        const endRaw = timeMatch[3].includes(':') ? timeMatch[3] : timeMatch[3] + ':00';
        endTime = dateLocal + 'T' + parseTo24h(endRaw + ' ' + timeMatch[4]);
      }
    }
  }

  return { date_local: dateLocal, start_time_local: startTime, end_time_local: endTime };
}

/**
 * Parse price from text.
 */
function parsePrice(text) {
  const priceMatch = text.match(/\$\d+(?:\.\d{1,2})?(?:\s*[-–]\s*\$?\d+(?:\.\d{1,2})?)?/);
  if (priceMatch) return { price_display: priceMatch[0], is_free: /free/i.test(priceMatch[0]) };

  if (/\bfree\b/i.test(text) && !/price not/i.test(text)) {
    return { price_display: 'Free', is_free: true };
  }
  return { price_display: null, is_free: false };
}

/**
 * Split "Venue, Address" or "Venue — Address" into parts.
 * Strips trailing borough/zip.
 */
function splitVenueAddr(raw) {
  if (!raw) return { venue: null, address: null };
  const cleaned = raw.replace(/\.\s*$/, '').trim();
  // "Paragon, 990 Broadway, Brooklyn"
  const commaSplit = cleaned.match(/^(.+?),\s*(\d+\s+.+)$/);
  if (commaSplit) {
    return {
      venue: commaSplit[1].trim(),
      address: commaSplit[2].replace(/,\s*(?:Brooklyn|Manhattan|Queens|Bronx|New York|NY)(?:\s*,?\s*(?:NY)?\s*\d{5})?.*$/i, '').trim(),
    };
  }
  return { venue: cleaned, address: null };
}

/**
 * Parse a single event from an inline <li> (Template A).
 * Format: "Name at Venue, Address — Day, Date, Time. Description. [badge]"
 */
function parseInlineLi(liHtml, fallbackDate) {
  const sourceUrl = extractSourceUrl(liHtml);

  // Strip badge spans and tags to get clean text
  let text = liHtml
    .replace(/<span[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  text = decodeEntities(text);

  // Strip "Full details:" prefix
  text = text.replace(/^Full details:\s*/i, '');

  if (text.length < 20) return null;

  // Skip non-event commentary lines and email preamble
  if (/^(?:All prices|Many screenings|Several films|Most events|Don't Miss|Note:)/i.test(text)) return null;
  if (/\[object Object\]|Here.?s a summary|I'm prioritizing|I'm flagging/i.test(text)) return null;

  // Extract quoted name
  let name = null;
  const quotedMatch = text.match(/"([^"]+)"/);
  if (quotedMatch) {
    name = quotedMatch[1].trim();
  }

  // Extract venue — multiple patterns
  let venueName = null;
  let venueAddress = null;

  // Pattern 1: "Venue: 'Title'" prefix (e.g., "Metrograph: "The Girl with the Hatbox"")
  if (name) {
    const venuePrefix = text.match(/^([A-Z][A-Za-z\s.']+?):\s*"/);
    if (venuePrefix && venuePrefix[1].trim() !== name) {
      venueName = venuePrefix[1].trim();
    }
  }

  // Pattern 2: "Title" at Venue — (standard pattern)
  if (!venueName) {
    const atVenue = text.match(/\bat\s+([A-Z][^—–;.]+?)(?:,\s*(\d+[^—–;.]+?))?(?:\s*[—–;.]|\s*$)/i);
    if (atVenue) {
      venueName = atVenue[1].trim().replace(/,\s*$/, '');
      if (atVenue[2]) {
        venueAddress = atVenue[2].trim()
          .replace(/,\s*(?:Brooklyn|Manhattan|Queens|Bronx|New York|NY)(?:\s*,?\s*(?:NY)?\s*\d{5})?.*$/i, '')
          .trim();
      }
      // If venue still has address embedded (e.g., "Paragon, 990 Broadway")
      if (!venueAddress) {
        const split = splitVenueAddr(venueName);
        if (split.address) {
          venueName = split.venue;
          venueAddress = split.address;
        }
      }
    }
  }

  // Pattern 3: "Name — Venue" after em-dash (e.g., "Film Society — The Crypt under...")
  if (!venueName && name) {
    const afterName = text.slice(text.indexOf(name) + name.length);
    const dashVenue = afterName.match(/\s*[—–]\s*(?:The\s+)?([A-Z][A-Za-z\s']+?)(?:\s*[—–,;]|\s*$)/);
    if (dashVenue && !/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(dashVenue[1])) {
      venueName = dashVenue[1].trim();
    }
  }

  // Pattern 4: Semicolon-delimited "Venue: Place, Address" (e.g., "Name — Date; Venue: Rash, 941 Willoughby Ave; Type: EDM")
  if (!venueName) {
    const venueFieldMatch = text.match(/Venue:\s*([^;]+)/i);
    if (venueFieldMatch) {
      const split = splitVenueAddr(venueFieldMatch[1].trim());
      venueName = split.venue;
      if (split.address) venueAddress = split.address;
    }
  }

  // Pattern 5: Comma-separated venue after time (e.g., "Name — Mar 6, 7:00 PM, Medicine for Nightmares, The Mission")
  if (!venueName) {
    const afterTime = text.match(/\d{1,2}:\d{2}\s*(?:AM|PM)(?:\s*[-–]\s*\d{1,2}:\d{2}\s*(?:AM|PM))?,\s*([A-Z][^,]+?)(?:,\s*(.+?))?(?:\.\s|$)/i);
    if (afterTime) {
      const candidate = afterTime[1].trim();
      // Make sure it's not a city/borough name
      if (!/^(?:New York|Brooklyn|Manhattan|Queens|Bronx|NY|The Mission)$/i.test(candidate)) {
        venueName = candidate;
        if (afterTime[2]) {
          venueAddress = afterTime[2].replace(/,\s*(?:New York|Brooklyn|Manhattan|Queens|Bronx|NY)(?:\s*,?\s*(?:NY)?\s*\d{5})?.*$/i, '').trim();
        }
      }
    }
  }

  // Pattern 6: Parenthetical venue (e.g., "Varda Retrospective (Film Forum, Mar 13")
  if (!venueName && name) {
    const parenVenue = text.match(/\(([A-Z][A-Za-z\s.']+?)(?:,\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i);
    if (parenVenue) {
      venueName = parenVenue[1].trim();
    }
  }

  // If no quoted name, derive from text before "at Venue" or "Venue:"
  if (!name) {
    const beforeAt = text.match(/^(.+?)\s+at\s+[A-Z]/i);
    if (beforeAt) {
      name = beforeAt[1].replace(/^\d+[.)]\s*/, '').replace(/\.\s*$/, '').trim();
    } else {
      // Try splitting on em-dash
      const dashParts = text.split(/\s*[—–]\s*/);
      let rawName = dashParts[0].replace(/^\d+[.)]\s*/, '').trim();
      // Extract parenthetical venue before truncating: "Name (Venue, Mar 13" → name = "Name", venue = "Venue"
      const parenVenueInName = rawName.match(/^(.+?)\s*\(([A-Z][A-Za-z\s.']+?)(?:,\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i);
      if (parenVenueInName) {
        rawName = parenVenueInName[1].trim();
        if (!venueName) venueName = parenVenueInName[2].trim();
      }
      name = rawName.slice(0, 120);
    }
  }

  if (!name || name.length < 5) return null;

  const dt = parseDateTimeLine(text, fallbackDate);
  const price = parsePrice(text);

  // Description: find prose text after structured fields (date, price, tags)
  let description = null;
  // Look for text after last [TAG] or after last semicolon-separated field
  const afterTags = text.match(/\]\.\s*(.{15,}?)(?:\.\s*$|\s*$)/);
  if (afterTags) {
    description = afterTags[1].replace(/\.\s*$/, '').trim();
  }
  if (!description) {
    // Try text after semicolon-separated fields, skipping prices and tags
    const semiParts = text.split(/;\s*/);
    for (let i = semiParts.length - 1; i >= 1; i--) {
      const part = semiParts[i].replace(/\.\s*$/, '').trim();
      if (part.length > 15 && !/^(?:\$|Free|Price|\[|Details|https?:|Series:)/i.test(part)) {
        description = part;
        break;
      }
    }
  }

  const catInfo = inferCategory(text);

  return {
    name: name.slice(0, 120),
    venue_name: venueName,
    venue_address: venueAddress,
    date_local: dt.date_local,
    start_time_local: dt.start_time_local,
    end_time_local: dt.end_time_local,
    is_free: price.is_free,
    price_display: price.price_display,
    source_url: sourceUrl,
    description_short: description,
    category: catInfo.category,
    subcategory: catInfo.subcategory,
    extraction_confidence: 0.9,
  };
}

/**
 * Parse a single event from a <br/>-separated <li> or <p> (Template B/C).
 * Format: "Name" at Venue<br/>Address<br/>Date, Time<br/>Price<br/>Description<br/>Details: URL
 */
function parseBrSeparatedBlock(blockHtml, fallbackDate) {
  const sourceUrl = extractSourceUrl(blockHtml);

  // Split on <br/> or <br> to get field lines
  const lines = blockHtml
    .replace(/<span[^>]*>[\s\S]*?<\/span>/gi, '')
    .split(/<br\s*\/?>/i)
    .map(l => decodeEntities(stripTags(l).trim()))
    .filter(l => l.length > 0);

  if (lines.length < 3) return null;

  // Line 0: event name (and possibly venue)
  const firstLine = lines[0].replace(/^\d+[.)]\s*/, '').trim();

  let name = null;
  let venueName = null;

  const quotedMatch = firstLine.match(/"([^"]+)"/);
  if (quotedMatch) {
    name = quotedMatch[1].trim();
    const afterQuote = firstLine.slice(firstLine.lastIndexOf('"') + 1);
    const atMatch = afterQuote.match(/\s*at\s+(.+)/i);
    if (atMatch) venueName = atMatch[1].trim();
  } else {
    const atMatch = firstLine.match(/^(.+?)\s+at\s+(.+)/i);
    if (atMatch) {
      name = atMatch[1].trim();
      venueName = atMatch[2].trim();
    } else {
      name = firstLine;
    }
  }

  if (!name || name.length < 3) return null;

  // Parse remaining lines
  let venueAddress = null;
  let dateText = '';
  let priceText = '';
  let description = null;
  let detailsUrl = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Address line: starts with a number/letter+number (street address) but not a time
    if (/^\d+[A-Za-z]?\s/.test(line) && !venueAddress && !/^\d{1,2}:\d{2}/.test(line)) {
      venueAddress = line.replace(/,\s*(?:Brooklyn|Manhattan|Queens|Bronx|New York|NY)(?:\s*,?\s*(?:NY)?\s*\d{5})?.*$/i, '').trim();
      continue;
    }

    // Date/time line: contains month name or day-of-week
    if (/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(line) && !dateText) {
      dateText = line;
      continue;
    }

    // Price line
    if (/^(?:\$|Free|Price\s+not|Pay)/i.test(line)) {
      priceText = line;
      continue;
    }

    // Details URL line
    if (/^Details:\s*https?:\/\//i.test(line)) {
      const urlMatch = line.match(/(https?:\/\/\S+)/);
      if (urlMatch) detailsUrl = urlMatch[1].replace(/[.,;)]+$/, '');
      continue;
    }

    // Everything else is description (take first substantial line)
    if (line.length > 15 && !description) {
      description = line;
    }
  }

  const dt = parseDateTimeLine(dateText, fallbackDate);
  const price = parsePrice(priceText || dateText);
  const catInfo = inferCategory(name + ' ' + (description || ''));

  return {
    name: name.slice(0, 120),
    venue_name: venueName,
    venue_address: venueAddress,
    date_local: dt.date_local,
    start_time_local: dt.start_time_local,
    end_time_local: dt.end_time_local,
    is_free: price.is_free,
    price_display: price.price_display,
    source_url: sourceUrl || detailsUrl,
    description_short: description,
    category: catInfo.category,
    subcategory: catInfo.subcategory,
    extraction_confidence: 0.9,
  };
}

/**
 * Detect whether a <li> is a field label (Date & time, Venue, etc.)
 */
function isFieldLabelLi(liText) {
  return /^(?:Date\s*&\s*time|Venue|Event type|Entry|Tickets|Location|Price|Format|Registration):/i.test(liText);
}

/**
 * Parse an event from a <p> (name+description) followed by field <li> items.
 * Template D: <p><b>Name</b> — Description [badge]</p><ul><li>Date & time: ...</li><li>Venue: ...</li>...</ul>
 */
function parseParagraphPlusFields(pHtml, fieldLis, fallbackDate) {
  const sourceUrl = extractSourceUrl(pHtml);

  // Extract name from bold tag
  let name = null;
  const boldMatch = pHtml.match(/<b[^>]*style="font-weight:700">([\s\S]*?)<\/b>/i);
  if (boldMatch) {
    name = decodeEntities(stripTags(boldMatch[1]).trim());
  }
  if (!name) {
    const strongMatch = pHtml.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    if (strongMatch) name = decodeEntities(stripTags(strongMatch[1]).trim());
  }
  if (!name || name.length < 3) return null;

  // Extract description from the paragraph (text after bold name, before badge)
  let description = null;
  const pText = decodeEntities(stripTags(
    pHtml.replace(/<span[^>]*>[\s\S]*?<\/span>/gi, '')
         .replace(/<b[^>]*>[\s\S]*?<\/b>/gi, '')
         .replace(/<strong[^>]*>[\s\S]*?<\/strong>/gi, '')
  ).trim());
  // Clean up leading em-dash
  const descClean = pText.replace(/^[\s—–]+/, '').trim();
  if (descClean.length > 15) description = descClean.slice(0, 300);

  // Parse field <li> items
  let venueName = null;
  let venueAddress = null;
  let dateText = '';
  let priceText = '';

  for (const li of fieldLis) {
    const text = decodeEntities(stripTags(li).trim());

    const venueMatch = text.match(/^Venue:\s*(.+)/i);
    if (venueMatch) {
      const raw = venueMatch[1].trim();
      const parts = raw.split(',').map(s => s.trim());
      venueName = parts[0];
      if (parts.length >= 2) {
        // Join address parts, strip borough/zip
        venueAddress = parts.slice(1).join(', ')
          .replace(/,\s*(?:NY|New York)(?:\s*\d{5})?.*$/i, '').trim();
      }
      continue;
    }

    const dateMatch = text.match(/^Date\s*&\s*time:\s*(.+)/i);
    if (dateMatch) {
      dateText = dateMatch[1].replace(/\|/g, ',').trim();
      continue;
    }

    const priceMatch = text.match(/^(?:Tickets|Entry|Price):\s*(.+)/i);
    if (priceMatch) {
      priceText = priceMatch[1].trim();
      continue;
    }
  }

  const dt = parseDateTimeLine(dateText, fallbackDate);
  const price = parsePrice(priceText);
  const catInfo = inferCategory(name + ' ' + (description || ''));

  return {
    name: name.slice(0, 120),
    venue_name: venueName,
    venue_address: venueAddress,
    date_local: dt.date_local,
    start_time_local: dt.start_time_local,
    end_time_local: dt.end_time_local,
    is_free: price.is_free,
    price_display: price.price_display,
    source_url: sourceUrl,
    description_short: description,
    category: catInfo.category,
    subcategory: catInfo.subcategory,
    extraction_confidence: 0.9,
  };
}

/**
 * Detect whether a <li> uses <br/>-separated fields or inline format.
 */
function isBrSeparated(liHtml) {
  return (liHtml.match(/<br\s*\/?>/gi) || []).length >= 2;
}

/**
 * Parse all events from a raw Yutori Scout email HTML.
 * Handles all 3 templates: inline <li>, numbered <ol> with <br/> fields, paragraph <p> with <br/> fields.
 *
 * @param {string} html - Raw email HTML
 * @param {string} fallbackDate - YYYY-MM-DD from filename
 * @returns {object[]} Array of parsed events
 */
function parseStructuredYutoriHtml(html, fallbackDate) {
  // Strip header (before first <h3>) and footer (after "Report generated by")
  let body = html;
  const h3Index = body.indexOf('<h3');
  if (h3Index > 0) body = body.slice(h3Index);
  const reportIdx = body.indexOf('Report generated by');
  if (reportIdx > 0) body = body.slice(0, reportIdx);

  const events = [];

  // Strategy 0: Detect <p>(name+desc+badge)</p><ul><li>field labels</li>...</ul> pattern
  // This must run first to avoid Strategy 1 treating field labels as separate events
  const hasFieldLis = /Date\s*&amp;\s*time:|Date\s*&\s*time:|Venue:|Event type:/i.test(body);
  if (hasFieldLis) {
    // Find all <p>...<b>Name</b>...badge...</p> followed by <ul>...<li>field</li>...</ul>
    const pUlPattern = /<p[^>]*>([\s\S]*?<b[^>]*style="font-weight:700">[\s\S]*?<\/b>[\s\S]*?)<\/p>\s*<ul[^>]*>([\s\S]*?)<\/ul>/gi;
    let pUlMatch;
    while ((pUlMatch = pUlPattern.exec(body)) !== null) {
      const pHtml = pUlMatch[1];
      const ulHtml = pUlMatch[2];

      // Extract <li> contents
      const fieldLis = [];
      const liInner = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let fm;
      while ((fm = liInner.exec(ulHtml)) !== null) {
        fieldLis.push(fm[1]);
      }

      // Check if these are field labels
      const hasFields = fieldLis.some(li => isFieldLabelLi(decodeEntities(stripTags(li).trim())));
      if (hasFields) {
        const event = parseParagraphPlusFields(pUlMatch[0], fieldLis, fallbackDate);
        if (event && event.name) events.push(event);
      }
    }

    // If we found events with this strategy, skip Strategy 1 (which would double-count field <li>s)
    if (events.length > 0) {
      // But also check for any inline <li> events that aren't field labels (mixed format emails)
      const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liPattern.exec(body)) !== null) {
        const liText = decodeEntities(stripTags(liMatch[1]).trim());
        if (liText.length < 30) continue;
        if (isFieldLabelLi(liText)) continue; // Skip field labels already consumed
        const event = parseInlineLi(liMatch[0], fallbackDate);
        if (event && event.name) events.push(event);
      }
      return events;
    }
  }

  // Strategy 1: Extract events from <li> items
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liPattern.exec(body)) !== null) {
    const liContent = liMatch[1];
    const liFull = liMatch[0];

    // Skip very short items or TL;DR lines
    const plainText = stripTags(liContent).trim();
    if (plainText.length < 30) continue;

    // Skip field label lines that leaked through
    if (isFieldLabelLi(plainText)) continue;

    let event;
    if (isBrSeparated(liContent)) {
      event = parseBrSeparatedBlock(liContent, fallbackDate);
    } else {
      event = parseInlineLi(liFull, fallbackDate);
    }

    if (event && event.name) events.push(event);
  }

  // Strategy 2: If no <li> events found, try <p> blocks (Template C)
  if (events.length === 0) {
    const pPattern = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pPattern.exec(body)) !== null) {
      const pHtml = pMatch[1];
      const pText = decodeEntities(stripTags(pHtml).trim());

      // Parse paragraphs that look like numbered events, have <br/> structure, or contain a date+venue
      const hasEventSignals = /\d{1,2}:\d{2}\s*(?:AM|PM)/i.test(pText) && /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(pText);
      if (!/^\d+[.)]\s/.test(pText) && !/<br\s*\/?>/i.test(pHtml) && !hasEventSignals) continue;
      if (pText.length < 40) continue;
      // Skip TL;DR, category headers, summary lines
      if (/^(?:TL;DR|Here.?s a summary|Free\/low-cost)/i.test(pText)) continue;
      // Skip short bold category headers
      if (/<b[^>]*style="font-weight:700">[^<]{3,40}<\/b>/i.test(pHtml) && pText.length < 80) continue;

      let event;
      if (/<br\s*\/?>/i.test(pHtml)) {
        event = parseBrSeparatedBlock(pHtml, fallbackDate);
      } else {
        event = parseInlineLi(pMatch[0], fallbackDate);
      }
      if (event && event.name) events.push(event);
    }
  }

  // Strategy 3: If still no events, try <pre> blocks (plain text formatted)
  if (events.length === 0) {
    const prePattern = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
    let preMatch;
    while ((preMatch = prePattern.exec(body)) !== null) {
      const preText = decodeEntities(stripTags(preMatch[1]));
      // Split on numbered event boundaries: "1) ", "2) ", etc.
      const chunks = preText.split(/(?=^\d+\)\s)/m).filter(c => c.trim().length > 30);
      for (const chunk of chunks) {
        // Convert plain text lines to <br/>-separated for parseBrSeparatedBlock
        const fakeHtml = chunk.trim().split('\n').map(l => l.trim()).filter(Boolean).join('<br/>');
        const event = parseBrSeparatedBlock(fakeHtml, fallbackDate);
        if (event && event.name) events.push(event);
      }
    }
  }

  return events;
}

module.exports = { parseStructuredYutoriHtml, decodeTrackingUrl, extractSourceUrl };
