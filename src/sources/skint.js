const cheerio = require('cheerio');
const { extractEvents } = require('../ai');
const { FETCH_HEADERS, normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');
const { resolveNeighborhood } = require('../geo');

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

// === Deterministic Skint parser (P6: deterministic extraction first) ===

const CATEGORY_PATTERNS = [
  { pattern: /\b(comedy|stand[- ]?up|improv|sketch|roast)\b/i, category: 'comedy' },
  { pattern: /\b(storytelling|stories|story\s+show|tale\b|open mic)\b/i, category: 'comedy' },
  { pattern: /\b(jazz|dj\b|hip[- ]?hop|concert|live music|band\b|singer|songwriter|punk|rock\b|electronic|techno|house music|soul\b|funk|r&b|rap\b|classical|orchestra|symphony|opera)\b/i, category: 'music' },
  { pattern: /\b(art\s+(opening|show|exhibition)|gallery|exhibition|sculpture|installation|mural)\b/i, category: 'art' },
  { pattern: /\b(film|movie|screening|cinema|documentary)\b/i, category: 'film' },
  { pattern: /\b(theater|theatre|play\b|musical|broadway|drama)\b/i, category: 'theater' },
  { pattern: /\b(dance\b|ballet|salsa|swing dance|tango)\b/i, category: 'dance' },
  { pattern: /\b(tour|walking tour|trolley tour)\b/i, category: 'tours' },
  { pattern: /\b(food|chili|tasting|cook-?off|supper club)\b/i, category: 'food' },
  { pattern: /\b(trivia|quiz|game night|bingo)\b/i, category: 'trivia' },
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

  // 1. Strip trailing >> link text and whitespace
  remaining = remaining.replace(/\s*>{1,2}\s*$/, '').replace(/\s*»\s*$/, '').trim();

  // 2. Extract day prefix + optional time + optional modifier
  // Handles: "fri 7pm:", "sat 1pm:", "mon 7pm (monthly):", "thru sun:", "today 7pm:", "daily 10am:"
  const dayTimeMatch = remaining.match(
    /^(mon|tue|wed|thu|fri|sat|sun|thru\s+\w+|today|tonight|daily)\w*(?:\s*\+\s*\w+)?(?:\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))?))?(?:\s*\([^)]*\))?\s*:\s*/i
  );
  if (!dayTimeMatch) return null;

  const timeStr = dayTimeMatch[2] || null;
  remaining = remaining.slice(dayTimeMatch[0].length);

  const { start: startTime, end: endTime } = timeStr
    ? parseSkintTime(timeStr)
    : { start: null, end: null };

  // 3. Split event name from description on the first colon
  const colonIdx = remaining.indexOf(':');
  let eventName, body;
  if (colonIdx > 0 && colonIdx < 120) {
    eventName = remaining.slice(0, colonIdx).trim();
    body = remaining.slice(colonIdx + 1).trim();
  } else {
    // No colon — entire remaining text is the event name
    eventName = remaining.trim();
    body = '';
  }

  if (!eventName) return null;

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
        isFree = /^free\b/i.test(priceDisplay) || /\bfree admission\b/i.test(priceDisplay);
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
    venue = beforeHood.slice(venueStart).trim().replace(/,\s*$/, '');
    description = venueStart > 0
      ? beforeHood.slice(0, venueStart).replace(/\.\s*$/, '').trim()
      : '';
  } else {
    // No neighborhood — try to extract price from end of body
    const priceMatch = body.match(/[,.]?\s*(\$\d+(?:\.\d{2})?[^.]*)\.\s*$/i);
    if (priceMatch) {
      priceDisplay = priceMatch[1].trim();
      isFree = false;
      description = body.slice(0, priceMatch.index).trim().replace(/\.\s*$/, '');
    } else {
      const freeMatch = body.match(/[,.]?\s*(free(?:\s+(?:admission|entry|rsvp))?[^.]*)\.\s*$/i);
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

  // 5. Infer category
  const category = inferCategory(eventName + (description ? ' ' + description : ''));

  // 6. Cap description at 200 chars
  if (description && description.length > 200) {
    description = description.slice(0, 197) + '...';
  }

  // 7. Confidence based on extracted field count
  let confidence = 0.5;
  if (eventName) confidence += 0.1;
  if (dateLocal) confidence += 0.1;
  if (venue) confidence += 0.1;
  if (startTime) confidence += 0.1;
  if (neighborhood) confidence += 0.1;

  return {
    name: eventName,
    description_short: description || null,
    venue_name: venue || null,
    venue_address: null,
    neighborhood: neighborhood || null,
    date_local: dateLocal,
    start_time_local: startTime,
    end_time_local: endTime,
    is_free: isFree,
    price_display: priceDisplay,
    category,
    extraction_confidence: confidence,
    source_url: null,
  };
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

    const entry = $('.entry-content').first();
    if (!entry.length) {
      console.warn('Skint: .entry-content not found');
      return [];
    }

    const { todayIso, resolveDate, formatDate } = getNycDayContext();

    // Day header pattern — short paragraphs like "friday", "saturday", "ongoing"
    const dayHeaderPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|ongoing)$/i;
    const eventPattern = /^(mon|tue|wed|thu|fri|sat|sun|thru|today|tonight|daily|\d{1,2}\/\d{1,2})/i;

    const eventParagraphs = []; // strings with day headers, for LLM fallback
    const rawParagraphs = [];   // { text, dateLocal } for deterministic parse
    let currentDayDate = null;
    let skipSection = false;

    entry.find('p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text) return;

      // Handle day headers — resolve to date and skip past sections
      if (dayHeaderPattern.test(text)) {
        const dayName = text.toLowerCase();
        if (dayName === 'ongoing') {
          currentDayDate = null;
          skipSection = false;
          eventParagraphs.push(`\n--- ONGOING ---`);
        } else {
          currentDayDate = resolveDate(dayName);
          skipSection = currentDayDate && currentDayDate < todayIso;
          if (!skipSection) {
            const label = currentDayDate ? formatDate(currentDayDate) : text.toUpperCase();
            eventParagraphs.push(`\n--- ${label} ---`);
          }
        }
        return;
      }

      // "thru" events span multiple days — include even from past sections
      if (skipSection && !/^thru\b/i.test(text)) return;
      if (text.length < 30) return;
      if (text.toLowerCase().startsWith('sponsored')) return;

      if (eventPattern.test(text)) {
        eventParagraphs.push(text);
        rawParagraphs.push({ text, dateLocal: currentDayDate || todayIso });
      }
    });

    if (rawParagraphs.length === 0) {
      console.warn('Skint: no upcoming events in parsed content (page may not be updated yet)');
      return [];
    }

    // Phase 1: Deterministic parse
    const parsed = [];
    for (const { text, dateLocal } of rawParagraphs) {
      const event = parseSkintParagraph(text, dateLocal);
      if (event) parsed.push(event);
    }

    const captureRate = parsed.length / rawParagraphs.length;
    console.log(`Skint: deterministic parse → ${parsed.length}/${rawParagraphs.length} events (${Math.round(captureRate * 100)}%)`);

    let events;
    if (captureRate >= 0.6) {
      // Deterministic path — skip LLM entirely
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

module.exports = { fetchSkintEvents, parseSkintParagraph };
