const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { resolveNeighborhood } = require('../geo');
const { extractNeighborhood } = require('../neighborhoods');

/**
 * Get NYC day-of-week index (0=Sun...6=Sat) and a helper to resolve
 * a day name to its actual date relative to today.
 * Returns { todayDow, resolveDate(dayName) → "YYYY-MM-DD" or null }
 */
function getNycDayContext() {
  const now = new Date();
  const nycStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, d, y] = nycStr.split('/').map(Number);
  const todayDow = new Date(y, m - 1, d).getDay();

  function resolveDate(dayName) {
    const dayIndex = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
      .indexOf(dayName.toLowerCase());
    if (dayIndex === -1) return null;
    // How many days from today? Negative = past, 0 = today, positive = future
    let delta = dayIndex - todayDow;
    if (delta < -3) delta += 7; // more than 3 days ago wraps to next week
    const target = new Date(y, m - 1, d + delta);
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const dd = String(target.getDate()).padStart(2, '0');
    return `${target.getFullYear()}-${mm}-${dd}`;
  }

  function formatDate(isoDate) {
    const [yr, mo, dy] = isoDate.split('-').map(Number);
    return new Date(yr, mo - 1, dy)
      .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      .toUpperCase();
  }

  const todayIso = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return { todayDow, todayIso, resolveDate, formatDate };
}

/**
 * Parse a post date range from a Skint heading like "THURS-MON, 3/13-16" or "TUES-THURS, 3/10-12".
 * Returns { startDate: "YYYY-MM-DD", startDow: 0-6 } or null.
 */
function parsePostDateRange(headerText, refYear) {
  // Match "M/D-D" or "M/D-M/D" patterns (e.g., "3/13-16", "12/28-1/2")
  const match = headerText.match(/(\d{1,2})\/(\d{1,2})\s*[-–]\s*(?:(\d{1,2})\/)?(\d{1,2})/);
  if (!match) return null;

  const startMonth = parseInt(match[1], 10);
  const startDay = parseInt(match[2], 10);
  if (startMonth < 1 || startMonth > 12 || startDay < 1 || startDay > 31) return null;

  const startDate = new Date(refYear, startMonth - 1, startDay);
  const startDow = startDate.getDay();
  const iso = `${refYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;

  return { startDate: iso, startDow };
}

/**
 * Create a resolveDate function anchored to a post's start date.
 * Day names resolve forward from the anchor (e.g., if anchor is Friday 3/13,
 * "friday" → 3/13, "saturday" → 3/14, "sunday" → 3/15, "monday" → 3/16).
 */
function createAnchoredResolveDate(postStartDate, postStartDow) {
  const [y, m, d] = postStartDate.split('-').map(Number);

  return function resolveDate(dayName) {
    const dayIndex = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
      .indexOf(dayName.toLowerCase());
    if (dayIndex === -1) return null;

    let delta = dayIndex - postStartDow;
    if (delta < 0) delta += 7; // always forward from anchor
    const target = new Date(y, m - 1, d + delta);
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const dd = String(target.getDate()).padStart(2, '0');
    return `${target.getFullYear()}-${mm}-${dd}`;
  };
}

/**
 * Refine a raw venue string that's too long (likely includes description text).
 * Tries comma and "at" boundaries to isolate the venue name.
 * Returns { venue, extraDescription }.
 */
function refineVenue(rawVenue) {
  if (rawVenue.length <= 60) return { venue: rawVenue, extraDescription: null };

  // Strategy 1: last comma — "long description, venue name"
  const lastComma = rawVenue.lastIndexOf(',');
  if (lastComma > 0) {
    const afterComma = rawVenue.slice(lastComma + 1).trim();
    if (afterComma.length >= 3 && afterComma.length <= 60) {
      return { venue: afterComma, extraDescription: rawVenue.slice(0, lastComma).trim() };
    }
  }

  // Strategy 2: " at " preposition — "long description at venue name"
  const atIdx = rawVenue.lastIndexOf(' at ');
  if (atIdx > 0) {
    const afterAt = rawVenue.slice(atIdx + 4).trim();
    if (afterAt.length >= 3 && afterAt.length <= 60) {
      return { venue: afterAt, extraDescription: rawVenue.slice(0, atIdx).trim() };
    }
  }

  return { venue: rawVenue, extraDescription: null };
}

/**
 * Detect whether a price string indicates a free event.
 * Catches: "free", "free admission", "free admission (rsvp required)",
 * "free rsvp (required)", "pay-what-you-can", "pay what you wish", "pwyc", etc.
 */
function isFreePrice(priceStr) {
  if (!priceStr) return false;
  const p = priceStr.toLowerCase();
  return /^free\b/.test(p)
    || /\bfree admission\b/.test(p)
    || /\bfree entry\b/.test(p)
    || /\bfree rsvp\b/.test(p)
    || /\bpay[- ]?what[- ]?you[- ]?(can|wish|want)\b/.test(p)
    || /\bpwyc\b/.test(p)
    || /\bdonation[- ]?based\b/.test(p)
    || /\bsuggested donation\b/.test(p);
}

// === Deterministic Skint parser (P6: deterministic extraction first) ===

const CATEGORY_PATTERNS = [
  { pattern: /\b(comedy|stand[- ]?up|improv|sketch|roast)\b/i, category: 'comedy' },
  { pattern: /\b(storytelling|stories|story\s+show|tale\b|open mic)\b/i, category: 'comedy' },
  { pattern: /\b(jazz|dj\b|hip[- ]?hop|concert|live music|band\b|singer|songwriter|punk|rock\b|electronic|techno|house music|soul\b|funk|r&b|rap\b|classical|orchestra|symphony|opera)\b/i, category: 'live_music' },
  { pattern: /\b(art\s+(opening|show|exhibition)|gallery|exhibition|sculpture|installation|mural)\b/i, category: 'art' },
  // Trivia before film — "pop quiz at cinema" should be trivia, not film
  { pattern: /\b(trivia|quiz\b|game night|bingo)\b/i, category: 'trivia' },
  { pattern: /\b(film|movie|screening|documentary)\b/i, category: 'film' },
  { pattern: /\b(theater|theatre|play\b|musical|broadway|drama)\b/i, category: 'theater' },
  { pattern: /\b(dance\b|ballet|salsa|swing dance|tango)\b/i, category: 'dance' },
  { pattern: /\b(tour|walking tour|trolley tour)\b/i, category: 'tours' },
  // "tasting" requires food/drink context to avoid false positives on "wine tasting of ideas"
  { pattern: /\b(food|chili|cook-?off|supper club)\b/i, category: 'food' },
  { pattern: /\b((?:wine|beer|whiskey|cocktail|cheese|chocolate|food|coffee)\s+tasting)\b/i, category: 'food' },
  { pattern: /\b(book\b|reading|author|literary|poetry|spoken word)\b/i, category: 'literature' },
  { pattern: /\b(market|flea|bazaar|craft fair|vintage)\b/i, category: 'market' },
];

function inferCategory(text) {
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return 'other';
}

function convertTo24h(time, ampm) {
  let h, m;
  if (time.includes(':')) {
    [h, m] = time.split(':').map(Number);
  } else {
    h = Number(time);
    m = 0;
  }
  ampm = ampm.toLowerCase();
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseSkintTime(timeStr) {
  // Range: "12-6pm", "7-9:30pm", "7pm-2am"
  const rangeMatch = timeStr.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*[-–]\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)/i);
  if (rangeMatch) {
    const [, t1, ampm1, t2, ampm2] = rangeMatch;
    return {
      start: convertTo24h(t1, ampm1 || ampm2),
      end: convertTo24h(t2, ampm2),
    };
  }
  // Single: "7pm", "7:30pm"
  const singleMatch = timeStr.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)/i);
  if (singleMatch) {
    return {
      start: convertTo24h(singleMatch[1], singleMatch[2]),
      end: null,
    };
  }
  return { start: null, end: null };
}

/**
 * Parse a single Skint event paragraph into structured fields.
 * Returns null if the paragraph can't be parsed deterministically.
 *
 * Format: "day time[ (modifier)]: event name: description. venue (neighborhood), price. >>"
 */
function parseSkintParagraph(text, dateLocal) {
  let remaining = text;
  const isBullet = /^\s*[►•]/.test(remaining);

  // 1. Strip bullet prefix (► sub-events) and trailing >> link text
  remaining = remaining.replace(/^\s*[►•]\s*/, '');
  remaining = remaining.replace(/\s*>{1,2}\s*$/, '').replace(/\s*»\s*$/, '').trim();

  // 2. Extract day prefix + optional thru range + optional time + optional modifier
  // Handles: "fri 7pm:", "sat 1pm:", "mon 7pm (monthly):", "thru sun:", "today 7pm:", "daily 10am:"
  // Multi-day: "tues thru sun:", "tues thru 3/14:", "wed thru fri 7pm:"
  // Time can be single "7pm" or range "12-6pm" / "7pm-2am" (first am/pm optional in ranges)
  const dayTimeMatch = remaining.match(
    /^((?:mon|tue|wed|thu|fri|sat|sun)\w*\s+thru\s+(?:(?:mon|tue|wed|thu|fri|sat|sun)\w*|\d{1,2}\/\d{1,2})|mon|tue|wed|thu|fri|sat|sun|thru\s+(?:(?:mon|tue|wed|thu|fri|sat|sun)\w*|\d{1,2}\/\d{1,2}|\w+)|today|tonight|daily)\w*(?:\s*\+\s*\w+)?(?:\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*[-–]\s*\d{1,2}(?::\d{2})?)?\s*(?:am|pm)))?(?:\s*(\([^)]*\)))?\s*:\s*/i
  );

  let dayGroup = '';
  let timeStr = null;
  let modifierStr = null;
  let startTime = null;
  let endTime = null;
  let seriesEnd = null;
  let isRecurring = false;
  let modifierText = null;

  if (dayTimeMatch) {
    dayGroup = dayTimeMatch[1] || '';
    timeStr = dayTimeMatch[2] || null;
    modifierStr = dayTimeMatch[3] || null; // e.g., "(monthly)", "(biweekly)"
    remaining = remaining.slice(dayTimeMatch[0].length);

    // 2a. If no bare time but paren contains a time, extract it
    // Handles: "fri + sat (7pm):", "sat + sun (11am-6pm sat, ...)"
    if (!timeStr && modifierStr) {
      const parenContent = modifierStr.replace(/[()]/g, '').trim();
      const parenTimeMatch = parenContent.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*[-–]\s*\d{1,2}(?::\d{2})?)?\s*(?:am|pm))/i);
      if (parenTimeMatch) {
        timeStr = parenTimeMatch[1];
        // Keep modifier only if it has non-time content (e.g., "weekends 10am-5pm")
        const withoutTime = parenContent.replace(parenTimeMatch[0], '').replace(/,.*$/, '').trim();
        if (/monthly|biweekly|weekly|bimonthly|weekends?/.test(withoutTime)) {
          modifierStr = `(${withoutTime})`;
        } else {
          modifierStr = null;
        }
      }
    }

    const parsed = timeStr ? parseSkintTime(timeStr) : { start: null, end: null };
    startTime = parsed.start;
    endTime = parsed.end;

    // 2b. Extract series_end from "thru" in day prefix
    const thruMatch = dayGroup.match(/thru\s+(\S+)/i);
    if (thruMatch) {
      const thruTarget = thruMatch[1].toLowerCase();
      const refYear = parseInt(dateLocal.slice(0, 4), 10);
      seriesEnd = parseThruDate(thruTarget, refYear);
    }
    if (modifierStr) {
      modifierText = modifierStr.replace(/[()]/g, '').trim().toLowerCase();
      if (/monthly|biweekly|weekly|bimonthly/.test(modifierText)) {
        isRecurring = true;
      }
    }
  } else if (isBullet) {
    // ► sub-events don't have a day prefix — parse as plain "name: desc. venue (hood), price"
    // remaining is already stripped of the bullet
  } else {
    return null;
  }

  // 3. Split event name from description on the first colon
  const colonIdx = remaining.indexOf(':');
  let eventName, body;
  if (colonIdx > 0 && colonIdx < 120) {
    eventName = remaining.slice(0, colonIdx).trim();
    body = remaining.slice(colonIdx + 1).trim();
  } else if (isBullet) {
    // Venue-only bullet: "► venue (hood). price." — no colon, treat as body for extraction
    eventName = null;
    body = remaining.trim();
  } else {
    // No colon — entire remaining text is the event name
    eventName = remaining.trim();
    body = '';
  }

  if (!eventName && !isBullet) return null;

  // 4. Extract venue + neighborhood from body
  let venue = null;
  let neighborhood = null;
  let priceDisplay = null;
  let isFree = false;
  let description = body;

  // Find all parenthetical groups in the body
  const parenMatches = [...body.matchAll(/\(([^)]+)\)/g)];

  // Scan from right to left for a known neighborhood
  let hoodParenIdx = -1;
  let hoodParenEnd = -1;
  for (let i = parenMatches.length - 1; i >= 0; i--) {
    const content = parenMatches[i][1].trim();
    const resolved = resolveNeighborhood(content);
    if (resolved) {
      hoodParenIdx = parenMatches[i].index;
      hoodParenEnd = hoodParenIdx + parenMatches[i][0].length;
      neighborhood = resolved;
      break;
    }
  }

  if (hoodParenIdx >= 0) {
    // Price: text after neighborhood paren, strip leading comma and trailing period
    const afterHood = body.slice(hoodParenEnd).trim();
    if (afterHood) {
      const cleaned = afterHood.replace(/\.\s*$/, '').replace(/^,\s*/, '').trim();
      if (cleaned) {
        priceDisplay = cleaned.length > 100 ? cleaned.slice(0, 97) + '...' : cleaned;
        isFree = isFreePrice(priceDisplay);
      }
    }

    // Venue: text between last sentence break and neighborhood paren
    const beforeHood = body.slice(0, hoodParenIdx).trim();
    const sentenceBreaks = [...beforeHood.matchAll(/\.\s+/g)];
    let venueStart = 0;
    for (let i = sentenceBreaks.length - 1; i >= 0; i--) {
      const match = sentenceBreaks[i];
      const rest = beforeHood.slice(match.index + match[0].length).trim();
      // Skip abbreviation-like breaks (very short text to next period)
      if (rest.length >= 3) {
        venueStart = match.index + match[0].length;
        break;
      }
    }
    const rawVenue = beforeHood.slice(venueStart).trim().replace(/,\s*$/, '');
    const refined = refineVenue(rawVenue);
    venue = refined.venue;
    description = venueStart > 0
      ? beforeHood.slice(0, venueStart).replace(/\.\s*$/, '').trim()
      : '';
    if (refined.extraDescription) {
      description = description ? description + '. ' + refined.extraDescription : refined.extraDescription;
    }
  } else {
    // No neighborhood — try to extract price from end of body
    const priceMatch = body.match(/[,.]?\s*(\$\d+(?:\.\d{2})?[^.]*)\.\s*$/i);
    if (priceMatch) {
      priceDisplay = priceMatch[1].trim();
      isFree = false;
      description = body.slice(0, priceMatch.index).trim().replace(/\.\s*$/, '');
    } else {
      const freeMatch = body.match(/[,.]?\s*((?:free(?:\s+(?:admission|entry|rsvp))?|pay[- ]?what[- ]?you[- ]?(?:can|wish|want)|pwyc|donation[- ]?based)[^.]*)\.\s*$/i);
      if (freeMatch) {
        priceDisplay = freeMatch[1].trim();
        isFree = true;
        description = body.slice(0, freeMatch.index).trim().replace(/\.\s*$/, '');
      }
    }
  }

  // Detect free from body text if not already found
  if (!priceDisplay && /\bfree\b/i.test(body) && !/free[- ]?(form|range|style|dom|lance|wheeling)/i.test(body)) {
    isFree = true;
  }

  // 4b. For venue-only bullets (no colon, no event name), use venue as the event name
  if (!eventName && isBullet) {
    eventName = venue || body.replace(/\.\s*$/, '').trim();
    if (!eventName) return null;
  }

  // 5. Infer category
  const category = inferCategory(eventName + (description ? ' ' + description : ''));

  // 6. Append recurrence modifier to description if present
  if (modifierText && isRecurring) {
    description = description
      ? `${description} (${modifierText})`
      : `(${modifierText})`;
  }

  // Cap description at 200 chars
  if (description && description.length > 200) {
    description = description.slice(0, 197) + '...';
  }

  // 7. Confidence based on evidence field coverage (aligns with audit expectations)
  const evidenceFields = [eventName, timeStr, venue, priceDisplay].filter(Boolean).length;
  let confidence = 0.4 + evidenceFields * 0.15; // 0.4 base → 0.55/0.70/0.85/1.0

  // Compute end date — if end hour < start hour, it crosses midnight
  let endDate = dateLocal;
  if (startTime && endTime && dateLocal) {
    const startH = parseInt(startTime.split(':')[0], 10);
    const endH = parseInt(endTime.split(':')[0], 10);
    if (endH < startH) {
      const d = new Date(dateLocal + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      endDate = d.toISOString().slice(0, 10);
    }
  }

  return {
    _rawText: text,
    name: eventName,
    description_short: description || null,
    venue_name: venue || null,
    venue_address: null,
    neighborhood: neighborhood || null,
    date_local: dateLocal,
    start_time_local: startTime && dateLocal ? `${dateLocal}T${startTime}:00` : startTime,
    end_time_local: endTime && endDate ? `${endDate}T${endTime}:00` : endTime,
    is_free: isFree,
    price_display: priceDisplay,
    category,
    extraction_confidence: confidence,
    source_url: null,
    series_end: seriesEnd || null,
    is_recurring: isRecurring || undefined,
    evidence: {
      name_quote: eventName ? eventName.toLowerCase() : null,
      time_quote: timeStr || null,
      location_quote: venue ? venue.toLowerCase() : null,
      price_quote: priceDisplay ? priceDisplay.toLowerCase() : null,
    },
  };
}

/**
 * Split a <p> element that may contain multiple ► bullet items separated by <br>.
 * Returns an array of { text, link } objects. If the <p> has no multi-bullet structure,
 * returns a single entry with the full text and last link.
 */
function splitBulletParagraph($, el, fullText) {
  // Quick check: does the full text contain multiple ► markers?
  const bulletCount = (fullText.match(/►/g) || []).length;
  if (bulletCount <= 1) {
    // Single event or no bullets — return as-is with last link
    const lastLink = $(el).find('a').last();
    return [{ text: fullText, link: lastLink.length ? lastLink.attr('href') : null }];
  }

  // Multiple ► in one <p>: split by <br> tags and extract text + link per segment.
  // Replace <br> with a sentinel, then split.
  const html = $(el).html();
  const parts = html.split(/<br\s*\/?>/i);
  const results = [];

  for (const part of parts) {
    const fragment = cheerio.load(`<div>${part}</div>`);
    const segText = fragment('div').text().trim();
    if (!segText) continue;

    // Extract the last <a> href in this fragment
    const segLink = fragment('a').last();
    const href = segLink.length ? segLink.attr('href') : null;
    results.push({ text: segText, link: href });
  }

  // If splitting produced nothing useful, fall back to single entry
  if (results.length === 0) {
    const lastLink = $(el).find('a').last();
    return [{ text: fullText, link: lastLink.length ? lastLink.attr('href') : null }];
  }

  return results;
}

async function fetchSkintEvents() {
  console.log('Fetching The Skint...');
  try {
    const res = await fetch('https://theskint.com/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Skint fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const { todayIso, resolveDate, formatDate } = getNycDayContext();

    // Day header pattern — short paragraphs like "friday", "saturday", "ongoing"
    const dayHeaderPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|ongoing)$/i;
    const eventPattern = /^(mon|tue|wed|thu|fri|sat|sun|thru|today|tonight|daily|\d{1,2}\/\d{1,2}|►|•)/i;

    // Find .entry-content blocks that contain day headers (skip sponsored/promo posts)
    const allEntries = $('.entry-content');
    if (!allEntries.length) {
      console.warn('Skint: .entry-content not found');
      return [];
    }

    const eventEntries = [];
    allEntries.each((i, el) => {
      let hasDayHeader = false;
      $(el).find('p').each((j, p) => {
        if (dayHeaderPattern.test($(p).text().trim())) {
          hasDayHeader = true;
          return false; // break
        }
      });
      if (hasDayHeader) eventEntries.push($(el));
    });

    if (eventEntries.length === 0) {
      console.warn('Skint: no .entry-content blocks with day headers (page may be all promos)');
      return [];
    }

    console.log(`Skint: found ${eventEntries.length} event block(s), skipped ${allEntries.length - eventEntries.length} promo block(s)`);

    const eventParagraphs = []; // strings with day headers, for LLM fallback
    const rawParagraphs = [];   // { text, dateLocal, groupSeriesEnd } for deterministic parse
    let currentDayDate = null;
    let skipSection = false;
    let groupSeriesEnd = null; // series_end from a "thru" group header for ► sub-events

    // Process all event-containing entry blocks
    const refYear = parseInt(todayIso.slice(0, 4), 10);
    for (const entry of eventEntries) {
    currentDayDate = null;
    skipSection = false;
    groupSeriesEnd = null;

    // Find the heading for this entry block to anchor date resolution.
    // WordPress structure: <article><header><h1 class="entry-title">THURS-MON, 3/13-16: ...</h1></header><div class="entry-content">...</div></article>
    let entryResolveDate = resolveDate; // default fallback
    const heading = entry.closest('article').find('.entry-title, h1, h2').first();
    if (heading.length) {
      const headingText = heading.text().trim();
      const dateRange = parsePostDateRange(headingText, refYear);
      if (dateRange) {
        entryResolveDate = createAnchoredResolveDate(dateRange.startDate, dateRange.startDow);
        console.log(`Skint: anchored date resolution for "${headingText.slice(0, 40)}..." → start ${dateRange.startDate}`);
      }
    }

    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text) return;

      // Handle day headers — resolve to date and skip past sections
      if (dayHeaderPattern.test(text)) {
        const dayName = text.toLowerCase();
        groupSeriesEnd = null; // reset group header on new day section
        if (dayName === 'ongoing') {
          currentDayDate = null;
          skipSection = false;
          eventParagraphs.push(`\n--- ONGOING ---`);
        } else {
          currentDayDate = entryResolveDate(dayName);
          skipSection = currentDayDate && currentDayDate < todayIso;
          if (!skipSection) {
            const label = currentDayDate ? formatDate(currentDayDate) : text.toUpperCase();
            eventParagraphs.push(`\n--- ${label} ---`);
          }
        }
        return;
      }

      // Split multi-bullet <p> tags: when a single <p> contains multiple ► items
      // separated by <br>, split into individual { text, link } pairs.
      const segments = splitBulletParagraph($, el, text);

      for (const seg of segments) {
        const segText = seg.text;
        const segLink = seg.link;

        // "thru" events span multiple days — include even from past sections
        const isThru = /^thru\b/i.test(segText);
        const isBullet = /^[►•]/.test(segText);
        if (skipSection && !isThru && !isBullet) continue;
        if (segText.length < 30) continue;
        if (segText.toLowerCase().startsWith('sponsored')) continue;

        // Detect group headers: "thru 3/15: three film fests" style lines
        // that introduce ► sub-events. These have a short body after the colon.
        if (isThru || /^(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+thru\b/i.test(segText)) {
          const thruHeaderMatch = segText.match(/thru\s+(\S+)/i);
          if (thruHeaderMatch) {
            const target = thruHeaderMatch[1].replace(/:$/, '').toLowerCase();
            groupSeriesEnd = parseThruDate(target, refYear, resolveDate);
          }
        } else if (!isBullet) {
          // Non-thru, non-bullet event resets group context
          groupSeriesEnd = null;
        }

        if (eventPattern.test(segText)) {
          eventParagraphs.push(segText);
          rawParagraphs.push({
            text: segText,
            dateLocal: currentDayDate || todayIso,
            groupSeriesEnd: isBullet ? groupSeriesEnd : null,
            eventUrl: segLink || null,
          });
        }
      }
    });
    } // end for (const entry of eventEntries)

    if (rawParagraphs.length === 0) {
      console.warn('Skint: no upcoming events in parsed content (page may not be updated yet)');
      return [];
    }

    // Phase 1: Deterministic parse
    const parsed = [];
    for (const { text, dateLocal, groupSeriesEnd, eventUrl } of rawParagraphs) {
      const event = parseSkintParagraph(text, dateLocal);
      if (event) {
        // ► sub-events inherit series_end from group header
        if (groupSeriesEnd && !event.series_end) {
          event.series_end = groupSeriesEnd;
        }
        // Use the direct event link instead of theskint.com
        if (eventUrl) {
          event.source_url = eventUrl;
        }
        parsed.push(event);
      }
    }

    const captureRate = parsed.length / rawParagraphs.length;
    console.log(`Skint: deterministic parse → ${parsed.length}/${rawParagraphs.length} events (${Math.round(captureRate * 100)}%)`);

    let events;
    if (captureRate >= 0.6) {
      // Deterministic path — _rawText carried through for post-scrape enrichment
      events = parsed
        .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9))
        .filter(e => e.name && e.completeness >= 0.5);
      console.log(`Skint: ${events.length} events (deterministic)`);
    } else {
      // LLM fallback — send all paragraphs
      const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const content = `Published: ${today}\n\n` + eventParagraphs.slice(0, 30).join('\n\n');
      console.log(`Skint content: ${content.length} chars (${eventParagraphs.length} event paragraphs)`);
      captureExtractionInput('theskint', content, 'https://theskint.com/');
      const result = await extractEvents(content, 'theskint', 'https://theskint.com/');
      events = (result.events || [])
        .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9))
        .filter(e => e.name && e.completeness >= 0.5);
      console.log(`Skint: ${events.length} events (LLM fallback, deterministic was ${Math.round(captureRate * 100)}%)`);
    }

    return events;
  } catch (err) {
    console.error('Skint error:', err.message);
    return [];
  }
}

// === Ongoing events page scraper ===

/**
 * Parse a "thru" date string into an ISO date.
 * Handles: "3/8" → 2026-03-08, "february" → last day of month, "spring" → approximate season end.
 */
function parseThruDate(text, refYear, resolveDate) {
  const trimmed = text.trim().toLowerCase();

  // Day name: "sun", "sunday", "fri", "friday", "tues" etc.
  const dayAbbrevs = {
    sun: 'sunday', mon: 'monday', tue: 'tuesday', tues: 'tuesday',
    wed: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday',
    fri: 'friday', sat: 'saturday',
  };
  const fullDay = dayAbbrevs[trimmed] || trimmed;
  if (['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].includes(fullDay)) {
    if (resolveDate) return resolveDate(fullDay);
    // Fallback: use getNycDayContext if no resolveDate passed
    const ctx = getNycDayContext();
    return ctx.resolveDate(fullDay);
  }

  // Numeric: "3/8", "12/31"
  const numMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (numMatch) {
    const month = parseInt(numMatch[1], 10);
    const day = parseInt(numMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${refYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }

  // Month name: "february", "march", "jan"
  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  if (months[trimmed]) {
    const m = months[trimmed];
    // Last day of the month
    const lastDay = new Date(refYear, m, 0).getDate();
    return `${refYear}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }

  // Season: approximate end dates
  const seasons = {
    spring: '06-20', summer: '09-22', fall: '12-20', autumn: '12-20', winter: '03-20',
  };
  if (seasons[trimmed]) {
    return `${refYear}-${seasons[trimmed]}`;
  }

  return null;
}

/**
 * Parse a single ongoing event paragraph into structured fields.
 * Returns null if the paragraph can't be parsed.
 *
 * Handles three formats:
 * A: "thru 3/5: event name: description. venue (hood), price. >>"
 * B: "► venue name (hood) thru 3/8 >>"
 * C: "thru spring: event name: description. venue (hood), price. >>"
 */
function parseOngoingParagraph(text, todayIso, refYear) {
  let remaining = text;

  // Strip bullet prefix and trailing >> link text
  remaining = remaining.replace(/^\s*[►•]\s*/, '');
  remaining = remaining.replace(/\s*>{1,2}\s*$/, '').replace(/\s*»\s*$/, '').trim();

  if (!remaining || remaining.length < 10) return null;

  let seriesEnd = null;

  // Format A/C: "thru <date>: ..." prefix
  const thruPrefixMatch = remaining.match(/^thru\s+([^:]+?):\s*/i);
  if (thruPrefixMatch) {
    const dateStr = thruPrefixMatch[1].trim();
    seriesEnd = parseThruDate(dateStr, refYear);
    remaining = remaining.slice(thruPrefixMatch[0].length);
  }

  // Format B: inline "thru <date>" at end (no colon prefix)
  if (!seriesEnd) {
    const thruSuffixMatch = remaining.match(/\s+thru\s+(\d{1,2}\/\d{1,2})\s*$/i);
    if (thruSuffixMatch) {
      seriesEnd = parseThruDate(thruSuffixMatch[1].trim(), refYear);
      remaining = remaining.slice(0, thruSuffixMatch.index).trim();
    }
  }

  // Split name from description on first colon
  const colonIdx = remaining.indexOf(':');
  let eventName, body;
  if (colonIdx > 0 && colonIdx < 120) {
    eventName = remaining.slice(0, colonIdx).trim();
    body = remaining.slice(colonIdx + 1).trim();
  } else {
    eventName = remaining.trim();
    body = '';
  }

  if (!eventName) return null;

  // Format B: no body but name contains (neighborhood) — extract it
  if (!body) {
    const nameParenMatch = eventName.match(/\s*\(([^)]+)\)\s*$/);
    if (nameParenMatch) {
      const parenContent = nameParenMatch[1].trim();
      const resolved = resolveNeighborhood(parenContent) || extractNeighborhood(parenContent);
      if (resolved) {
        eventName = eventName.slice(0, nameParenMatch.index).trim();
        return {
          _rawText: text,
          name: eventName,
          description_short: null,
          venue_name: null,
          venue_address: null,
          neighborhood: resolved,
          date_local: todayIso,
          start_time_local: null,
          end_time_local: null,
          is_free: false,
          price_display: null,
          category: inferCategory(eventName),
          extraction_confidence: 0.4 + (eventName ? 0.15 : 0),
          source_url: 'https://theskint.com/ongoing-events/',
          series_end: seriesEnd,
        };
      }
    }
  }

  // Extract venue + neighborhood from body (reuse daily parser logic)
  let venue = null;
  let neighborhood = null;
  let priceDisplay = null;
  let isFree = false;
  let description = body;

  // Find all parenthetical groups in the body
  const parenMatches = [...(body || '').matchAll(/\(([^)]+)\)/g)];

  // Scan from right to left for a known neighborhood (try extractNeighborhood for landmarks)
  let hoodParenIdx = -1;
  let hoodParenEnd = -1;
  for (let i = parenMatches.length - 1; i >= 0; i--) {
    const content = parenMatches[i][1].trim();
    const resolved = resolveNeighborhood(content) || extractNeighborhood(content);
    if (resolved) {
      hoodParenIdx = parenMatches[i].index;
      hoodParenEnd = hoodParenIdx + parenMatches[i][0].length;
      neighborhood = resolved;
      break;
    }
  }

  if (hoodParenIdx >= 0) {
    // Price: text after neighborhood paren
    const afterHood = body.slice(hoodParenEnd).trim();
    if (afterHood) {
      const cleaned = afterHood.replace(/\.\s*$/, '').replace(/^,\s*/, '').trim();
      if (cleaned) {
        priceDisplay = cleaned.length > 100 ? cleaned.slice(0, 97) + '...' : cleaned;
        isFree = isFreePrice(priceDisplay);
      }
    }

    // Venue: text between last sentence break and neighborhood paren
    const beforeHood = body.slice(0, hoodParenIdx).trim();
    const sentenceBreaks = [...beforeHood.matchAll(/\.\s+/g)];
    let venueStart = 0;
    for (let i = sentenceBreaks.length - 1; i >= 0; i--) {
      const match = sentenceBreaks[i];
      const rest = beforeHood.slice(match.index + match[0].length).trim();
      if (rest.length >= 3) {
        venueStart = match.index + match[0].length;
        break;
      }
    }
    const rawVenue = beforeHood.slice(venueStart).trim().replace(/,\s*$/, '');
    const refined = refineVenue(rawVenue);
    venue = refined.venue;
    description = venueStart > 0
      ? beforeHood.slice(0, venueStart).replace(/\.\s*$/, '').trim()
      : '';
    if (refined.extraDescription) {
      description = description ? description + '. ' + refined.extraDescription : refined.extraDescription;
    }
  } else {
    // No neighborhood — try to extract price from end of body
    const priceMatch = body.match(/[,.]?\s*(\$\d+(?:\.\d{2})?[^.]*)\.\s*$/i);
    if (priceMatch) {
      priceDisplay = priceMatch[1].trim();
      isFree = false;
      description = body.slice(0, priceMatch.index).trim().replace(/\.\s*$/, '');
    } else {
      const freeMatch = body.match(/[,.]?\s*((?:free(?:\s+(?:admission|entry|rsvp))?|pay[- ]?what[- ]?you[- ]?(?:can|wish|want)|pwyc|donation[- ]?based)[^.]*)\.\s*$/i);
      if (freeMatch) {
        priceDisplay = freeMatch[1].trim();
        isFree = true;
        description = body.slice(0, freeMatch.index).trim().replace(/\.\s*$/, '');
      }
    }
  }

  // Detect free from body text if not already found
  if (!priceDisplay && /\bfree\b/i.test(body) && !/free[- ]?(form|range|style|dom|lance|wheeling)/i.test(body)) {
    isFree = true;
  }

  const category = inferCategory(eventName + (description ? ' ' + description : ''));

  if (description && description.length > 200) {
    description = description.slice(0, 197) + '...';
  }

  // Confidence based on extracted fields
  // Confidence based on evidence field coverage (ongoing events rarely have time)
  const evidenceFields = [eventName, null /* no time for ongoing */, venue, priceDisplay].filter(Boolean).length;
  let confidence = 0.4 + evidenceFields * 0.15; // 0.4 base → 0.55/0.70/0.85/1.0

  return {
    _rawText: text,
    name: eventName,
    description_short: description || null,
    venue_name: venue || null,
    venue_address: null,
    neighborhood: neighborhood || null,
    date_local: todayIso,
    start_time_local: null,
    end_time_local: null,
    is_free: isFree,
    price_display: priceDisplay,
    category,
    extraction_confidence: confidence,
    source_url: 'https://theskint.com/ongoing-events/',
    series_end: seriesEnd,
  };
}

async function fetchSkintOngoingEvents() {
  console.log('Fetching The Skint ongoing events...');
  try {
    const res = await fetch('https://theskint.com/ongoing-events/', {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Skint ongoing fetch failed: ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const entry = $('.entry-content').first();
    if (!entry.length) {
      console.warn('Skint ongoing: .entry-content not found');
      return [];
    }

    const { todayIso } = getNycDayContext();
    const refYear = parseInt(todayIso.slice(0, 4), 10);

    // Non-event detection: listicles, CTAs, social media plugs
    const nonEventPattern = /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s+.*(places|things|ways|spots|bars|restaurants|fountains|artworks|murals|stores|shops|bakeries|delis|cafes|gardens|parks)\b|^where\s+to\s+(find|see|get|eat|drink)\b|^(subscribe|sign up|follow|be social|join us)\b/i;

    const parsed = [];

    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text || text.length < 30) return;
      if (text.toLowerCase().startsWith('sponsored')) return;
      if (nonEventPattern.test(text)) return;

      const event = parseOngoingParagraph(text, todayIso, refYear);
      if (event) {
        // Extract the href from the >> link (last <a> in the paragraph)
        const lastLink = $(el).find('a').last();
        const linkHref = lastLink.length ? lastLink.attr('href') : null;
        if (linkHref) {
          event.source_url = linkHref;
        }
        parsed.push(event);
      }
    });

    // Filter out expired events (series_end < today)
    const active = parsed.filter(e => {
      if (!e.series_end) return true; // keep events without end dates
      return e.series_end >= todayIso;
    });

    const events = active
      .map(e => normalizeExtractedEvent(e, 'theskint', 'curated', 0.9))
      .filter(e => e.name && e.completeness >= 0.5);

    const expired = parsed.length - active.length;
    console.log(`Skint ongoing: ${events.length} events (${parsed.length} parsed, ${expired} expired)`);

    return events;
  } catch (err) {
    console.error('Skint ongoing error:', err.message);
    return [];
  }
}

module.exports = { fetchSkintEvents, fetchSkintOngoingEvents, parseSkintParagraph, parseOngoingParagraph, parseThruDate, parsePostDateRange, createAnchoredResolveDate, splitBulletParagraph };
