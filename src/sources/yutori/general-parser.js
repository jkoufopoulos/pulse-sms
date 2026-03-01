const { TRIVIA_HOODS, parseTo24h, resolveMonthDay } = require('./trivia-parser');

// === Deterministic general event parser (P6: deterministic extraction first) ===

/**
 * Tag-to-category mapping for Yutori event tags (uppercase bracket tags like [35MM], [Q&A]).
 */
const TAG_TO_CATEGORY = [
  { pattern: /REPERTORY|RESTORED PRINT|35MM|MIDNIGHT|PREMIERE|SERIES|CULT|DOCUMENTARY|ANIME|MARATHON|INTERNATIONAL|ANNIVERSARY/i, category: 'art', subcategory: 'film' },
  { pattern: /COMEDY|STAND-UP|IMPROV/i, category: 'comedy', subcategory: null },
  { pattern: /DJ|DANCE|RAVE/i, category: 'nightlife', subcategory: null },
];

/**
 * Infer category from the full event line text when tags aren't present.
 */
function inferCategory(text) {
  const lower = text.toLowerCase();
  if (/\b(?:screening|cinema|repertory|35mm|restored?\s*print|midnight\s*show|film\s*forum|metrograph|nitehawk|ifc center|spectacle)\b/.test(lower)) return { category: 'art', subcategory: 'film' };
  if (/\b(?:stand-?up|improv|comedy)\b/.test(lower)) return { category: 'comedy', subcategory: null };
  if (/\b(?:listening\s*session)\b/.test(lower)) return { category: 'music', subcategory: 'listening' };
  if (/\b(?:dj\b|techno|house\s*music|rave|dance\s*party|dancehall|edm|underground\s*(?:edm|techno))\b/.test(lower)) return { category: 'nightlife', subcategory: null };
  if (/\b(?:jazz|concert|live\s*music|album\s*release|indie\s*rock|songwriter|kora)\b/.test(lower)) return { category: 'music', subcategory: null };
  if (/\b(?:art\s*opening|gallery|exhibition|installation)\b/.test(lower)) return { category: 'art', subcategory: null };
  if (/\b(?:book\s*launch|reading|literary|poetry)\b/.test(lower)) return { category: 'art', subcategory: 'literary' };
  if (/\b(?:listening\s*session)\b/.test(lower)) return { category: 'music', subcategory: 'listening' };
  return { category: 'other', subcategory: null };
}

/**
 * Extract venue name and address from a text fragment.
 * Splits on the first street-number boundary: "Mercury Lounge 217 E 10th St" → venue + addr.
 */
function splitVenueAddress(venueStr) {
  // Clean trailing borough/neighborhood references
  const cleaned = venueStr.replace(/,\s*(?:Brooklyn|Manhattan|Queens|Bronx|Staten Island|New York|NY)(?:\s*,?\s*(?:NY)?\s*\d{5})?.*$/i, '').trim();

  // Try splitting on comma + street number: "Paragon, 990 Broadway"
  const commaSplit = cleaned.match(/^(.+?),\s*(\d+\s+.+)$/);
  if (commaSplit) return { venue: commaSplit[1].trim(), address: commaSplit[2].trim() };

  // Try splitting on space + street number: "Metrograph 7 Ludlow St"
  const spaceSplit = cleaned.match(/^(.+?)\s+(\d+\s+\w+.*)$/);
  if (spaceSplit && spaceSplit[1].length >= 2) return { venue: spaceSplit[1].trim(), address: spaceSplit[2].trim() };

  // Try splitting on number run-on: "LunÀtico486 Halsey Street"
  const runOn = cleaned.match(/^([^\d]+?)(\d+\s+.+)$/);
  if (runOn && runOn[1].length >= 2) return { venue: runOn[1].trim(), address: runOn[2].trim() };

  return { venue: cleaned, address: null };
}

/**
 * Parse a single [Event] line into structured event fields.
 * Uses ordered heuristics — works across numbered, venue-colon, em-dash, and field-labeled formats.
 *
 * @param {string} line - The full [Event] line including prefix
 * @param {string} fallbackDate - YYYY-MM-DD to use when no date found in line
 * @returns {object|null} Parsed event or null if line is not a parseable event
 */
function parseGeneralEventLine(line, fallbackDate) {
  let text = line.replace(/^\[Event\]\s*/, '').trim();
  text = text.replace(/^\d+[.)]\s*/, '');        // Strip number prefix
  text = text.replace(/\.\s*\.?\s*$/, '').trim(); // Strip trailing dots

  // --- Skip conditions ---
  if (text.length < 20) return null;
  if (/^(?:Full details|Don't Miss|Full Screening Log|Coming Up:)/i.test(text)) return null;
  if (/^(?:Date & time|Venue|Event type|Entry|Tickets):\s/i.test(text)) return null;
  if (/^(?:Entry fee|Registration|Format:|Prizes|Most events|Themed nights|Weekly recurring)/i.test(text)) return null;
  // Skip aggregate/prose lines (venue hosts "multiple..." or long sentences without structured data)
  if (/\bhosts?\s+multiple\b/i.test(text)) return null;
  // Skip lines that are clearly analysis/commentary (fintech leak-through)
  if (/\b(?:raises the bar|signaling|reframing|positioning|signals?)\b/i.test(text) && !/\b(?:PM|AM|\$\d)/i.test(text)) return null;

  const refYear = fallbackDate ? parseInt(fallbackDate.slice(0, 4), 10) : new Date().getFullYear();

  // === Extract fields in order, removing matched text to avoid re-matching ===

  // 1. Extract tags: [UPPERCASE CONTENT]
  const tags = [];
  text = text.replace(/\[([A-Z][A-Z0-9\s&/'–-]+)\]/g, (_, tag) => {
    tags.push(tag.trim());
    return ' ';
  });

  // 2. Extract price
  let price = null;
  let isFree = false;
  const priceMatch = text.match(/\$\d+(?:\.\d{1,2})?(?:\s*[-–]\s*\$?\d+(?:\.\d{1,2})?)?/);
  if (priceMatch) {
    price = priceMatch[0];
    text = text.slice(0, priceMatch.index) + ' ' + text.slice(priceMatch.index + priceMatch[0].length);
  }
  if (!price) {
    const freeMatch = text.match(/\b(Free(?:\s+(?:RSVP|admission|entry))?)\b/i);
    if (freeMatch) {
      price = freeMatch[1];
      isFree = true;
      text = text.slice(0, freeMatch.index) + ' ' + text.slice(freeMatch.index + freeMatch[0].length);
    }
  }
  if (price && /free/i.test(price)) isFree = true;

  // 3. Extract ticket URL (labeled or bare)
  let ticketUrl = null;
  const labeledUrlMatch = text.match(/(?:Tickets|Details|Info|Series|Purchase page|Tournament listings)(?:\s*(?:and info)?(?:\s*via\s+[^(]+)?)?\s*[:.]?\s*(https?:\/\/\S+)/i);
  if (labeledUrlMatch) {
    ticketUrl = labeledUrlMatch[1].replace(/[.,;)]+$/, '');
    text = text.slice(0, labeledUrlMatch.index) + ' ' + text.slice(labeledUrlMatch.index + labeledUrlMatch[0].length);
  } else {
    const bareUrlMatch = text.match(/(https?:\/\/\S+)/);
    if (bareUrlMatch) {
      ticketUrl = bareUrlMatch[1].replace(/[.,;)]+$/, '');
      text = text.slice(0, bareUrlMatch.index) + ' ' + text.slice(bareUrlMatch.index + bareUrlMatch[0].length);
    }
  }

  // 4. Extract time: H:MM AM/PM with optional end time
  // First neutralize "doors close/ends at" times so they don't get picked as start time
  let startTime = null;
  let endTime = null;
  const timeText = text.replace(/(?:close[sd]?|ends?|closing|doors?\s+close)\s+\d{1,2}:\d{2}\s*[AP]M/gi, '');
  const timeMatch = timeText.match(/(\d{1,2}:\d{2})\s*([AP]M)\s*(?:[-–]\s*(\d{1,2}:\d{2})\s*([AP]M))?/i);
  if (timeMatch) {
    startTime = parseTo24h(timeMatch[1] + ' ' + timeMatch[2]);
    if (timeMatch[3] && timeMatch[4]) endTime = parseTo24h(timeMatch[3] + ' ' + timeMatch[4]);
    // Remove the matched time from original text (find same pattern in original)
    const origTimeMatch = text.match(/(\d{1,2}:\d{2})\s*([AP]M)\s*(?:[-–]\s*(\d{1,2}:\d{2})\s*([AP]M))?/i);
    if (origTimeMatch && parseTo24h(origTimeMatch[1] + ' ' + origTimeMatch[2]) !== startTime) {
      // First match in original was the "close" time — find and remove the real start time
      const afterClose = text.slice(origTimeMatch.index + origTimeMatch[0].length);
      const realMatch = afterClose.match(/(\d{1,2}:\d{2})\s*([AP]M)\s*(?:[-–]\s*(\d{1,2}:\d{2})\s*([AP]M))?/i);
      if (realMatch) {
        const realIdx = origTimeMatch.index + origTimeMatch[0].length + realMatch.index;
        text = text.slice(0, realIdx) + ' ' + text.slice(realIdx + realMatch[0].length);
      }
    } else if (origTimeMatch) {
      text = text.slice(0, origTimeMatch.index) + ' ' + text.slice(origTimeMatch.index + origTimeMatch[0].length);
    }
  }

  // 5. Extract date: "Day Mon DD[, YYYY]" or "Month DD[, YYYY]"
  let dateLocal = null;
  const datePatterns = [
    /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
    /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
  ];
  for (const pat of datePatterns) {
    const dateMatch = text.match(pat);
    if (dateMatch) {
      dateLocal = resolveMonthDay(dateMatch[1], dateMatch[2], dateMatch[3] ? parseInt(dateMatch[3], 10) : refYear);
      if (dateLocal) {
        text = text.slice(0, dateMatch.index) + ' ' + text.slice(dateMatch.index + dateMatch[0].length);
        break;
      }
    }
  }
  if (!dateLocal) dateLocal = fallbackDate;

  // 6. Extract quoted title
  let name = null;
  const quotedMatch = line.match(/"([^"]+)"/);
  if (quotedMatch) {
    name = quotedMatch[1].trim();
  }

  // 7. Extract venue + address
  let venueName = null;
  let venueAddress = null;

  // Pattern A: For quoted titles, find 'at Venue' after the closing quote in original line
  if (name) {
    const quoteEnd = line.indexOf('"', line.indexOf('"' + name) + name.length + 1);
    if (quoteEnd !== -1) {
      const afterQuote = line.slice(quoteEnd + 1);
      const atAfter = afterQuote.match(/^\s*at\s+(.+?)(?:\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*[\s,]|\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s|\s*—|\s*$)/i);
      if (atAfter) {
        const raw = atAfter[1].trim().replace(/\.\s*$/, '');
        const { venue, address } = splitVenueAddress(raw);
        if (venue.length >= 2) { venueName = venue; venueAddress = address; }
      }
    }
  }

  // Pattern B: "at VenueInfo" in remaining text (em-dash and other formats)
  if (!venueName) {
    const atMatch = text.match(/\bat\s+([A-Z][^—;]+?)(?:\s*[—;.]|\s*$)/i);
    if (atMatch) {
      const raw = atMatch[1].trim().replace(/\.\s*$/, '');
      const { venue, address } = splitVenueAddress(raw);
      if (venue.length >= 2) { venueName = venue; venueAddress = address; }
    }
  }

  // Pattern C: "Venue: Name, Address" (field-labeled format)
  if (!venueName) {
    const venueKV = text.match(/Venue:\s*([^,;]+)(?:,\s*(.+?))?(?:[.;]|$)/i);
    if (venueKV) {
      venueName = venueKV[1].trim();
      if (venueKV[2]) {
        venueAddress = venueKV[2].trim().replace(/,\s*(?:NY|New York|Brooklyn|Manhattan|Queens|Bronx)(?:\s*,?\s*(?:NY)?\s*\d{5})?.*$/i, '').trim();
      }
    }
  }

  // Pattern D: "VenueName:" prefix (venue-colon format like "Metrograph: ...")
  if (!venueName) {
    const colonMatch = text.match(/^([A-Z][^:—"]{2,40}):\s/);
    if (colonMatch) {
      venueName = colonMatch[1].trim();
    }
  }

  // Pattern E: Standalone "VenueName, NNN Street" after date/time removal
  if (!venueName) {
    const standaloneMatch = text.match(/(?:^|[.;]\s*)([A-Z][A-Za-z\s']+?),\s*(\d+(?:-\d+)?\s+(?:\w+\s*)+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Way|Pl|Place|Broadway|Parkway)\b[^.;]*)/i);
    if (standaloneMatch) {
      venueName = standaloneMatch[1].trim();
      venueAddress = standaloneMatch[2].trim().replace(/,\s*(?:Brooklyn|Manhattan|Queens|Bronx|New York|NY).*$/i, '').trim();
    }
  }

  // Pattern F: Parenthetical venue "(Venue Name, Date Range)"
  if (!venueName && !name) {
    const parenVenue = line.match(/\(([^)]+?),\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
    if (parenVenue) {
      venueName = parenVenue[1].trim();
    }
  }

  // 8. Extract neighborhood from known list
  let neighborhood = null;
  const searchText = (text + ' ' + (venueAddress || '')).toLowerCase();
  for (const hood of TRIVIA_HOODS) {
    const idx = searchText.indexOf(hood);
    if (idx !== -1) {
      const before = idx > 0 ? searchText[idx - 1] : ' ';
      const after = idx + hood.length < searchText.length ? searchText[idx + hood.length] : ' ';
      if (/[\s,.(]/.test(before) && /[\s,.):;]/.test(after)) {
        neighborhood = hood.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
        break;
      }
    }
  }

  // 9. Unquoted name (if no quoted title found)
  if (!name) {
    const stripped = line.replace(/^\[Event\]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
    // Try first segment before em-dash
    const dashParts = stripped.split(/\s*—\s*/);
    if (dashParts.length >= 2 && dashParts[0].length >= 5) {
      name = dashParts[0].replace(/\.\s*$/, '').trim();
    } else {
      // Use first clause before semicolon or period
      name = stripped.split(/[;.]/)[0].trim().slice(0, 120);
    }
  }

  if (!name || name.length < 5) return null;

  // Truncate long names at a natural break (100 chars max)
  if (name.length > 100) {
    const breakMatch = name.slice(0, 100).match(/^(.{40,}?)(?:\s*[-–—;,]\s)/);
    name = breakMatch ? breakMatch[1].trim() : name.slice(0, 100).trim();
  }

  // 10. Infer category
  let category = null;
  let subcategory = null;
  const tagStr = tags.join(' ');
  for (const { pattern, category: cat, subcategory: sub } of TAG_TO_CATEGORY) {
    if (pattern.test(tagStr)) {
      category = cat;
      subcategory = sub;
      break;
    }
  }
  if (!category) {
    const inferred = inferCategory(line);
    category = inferred.category;
    subcategory = inferred.subcategory;
  }

  // Confidence based on extracted fields
  const fieldCount = [name, venueName, dateLocal, startTime].filter(Boolean).length;
  const confidence = fieldCount >= 4 ? 0.9 : fieldCount >= 3 ? 0.8 : 0.7;

  // Build description from remaining text
  const remaining = text.replace(/\s+/g, ' ').trim();
  const description = remaining.length > 20 ? remaining.slice(0, 200).trim() : null;

  return {
    name,
    venue_name: venueName,
    venue_address: venueAddress,
    neighborhood,
    date_local: dateLocal,
    start_time_local: startTime,
    end_time_local: endTime,
    is_free: isFree,
    price_display: price,
    category,
    subcategory,
    extraction_confidence: confidence,
    source_url: ticketUrl,
    description_short: description,
    evidence: {
      name_quote: name ? name.toLowerCase() : null,
      time_quote: startTime || null,
      location_quote: venueName ? venueName.toLowerCase() : null,
      price_quote: price ? price.toLowerCase() : null,
    },
  };
}

/**
 * Parse non-trivia events from preprocessed Yutori text.
 * Extracts [Event] lines and runs the general parser on each.
 *
 * @param {string} text - Preprocessed Yutori email text
 * @param {string} filename - Email filename (e.g., "2026-02-25-scout-...")
 * @returns {object[]} Array of parsed events
 */
function parseNonTriviaEvents(text, filename) {
  const baseDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  const fallbackDate = baseDateMatch ? baseDateMatch[1] : null;
  if (!fallbackDate) return [];

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const events = [];

  for (const line of lines) {
    if (!line.startsWith('[Event]')) continue;
    const event = parseGeneralEventLine(line, fallbackDate);
    if (event) events.push(event);
  }

  return events;
}

module.exports = { parseGeneralEventLine, parseNonTriviaEvents, inferCategory };
