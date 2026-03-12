# Yutori Structured Parser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Yutori's broken preprocess → general parser → LLM fallback chain with a dedicated HTML parser that extracts events deterministically from the structured Yutori Scout email format.

**Architecture:** Parse raw HTML directly (before preprocessing) using DOM-like regex patterns. Each `<li>` or `<p>` event block contains all fields inline — extract name, venue, address, date/time, price, description, and source URL. Fall back to LLM only for emails the structured parser can't handle (< 40% extraction rate).

**Tech Stack:** Node.js, regex-based HTML parsing (no new dependencies), existing `normalizeExtractedEvent` + `inferCategory` from general-parser.

---

### Task 1: Tighten `isEventEmail()` filter

9 non-event emails leak through the current filter (AI, longevity, YC, social research, sports leagues).

**Files:**
- Modify: `src/sources/yutori/email-filter.js:4-37`
- Test: `test/unit/yutori-email-filter.test.js` (new)

**Step 1: Write the failing test**

```javascript
// test/unit/yutori-email-filter.test.js
const { isEventEmail } = require('../../src/sources/yutori/email-filter');

// Helper to make minimal HTML with a category label
function htmlWithCategory(cat) {
  return `<p style="text-transform:uppercase"><a style="text-decoration-line:none">${cat}</a></p>`;
}

describe('isEventEmail', () => {
  // Should pass
  test('passes NYC underground music', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('NYC underground music and film nights'))).toBe(true);
  });
  test('passes Manhattan Indie Events', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Manhattan Indie Events'))).toBe(true);
  });
  test('passes trivia', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Brooklyn Manhattan Trivia Nights'))).toBe(true);
  });
  test('passes film screenings', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('NYC curated film screenings'))).toBe(true);
  });

  // Should fail — currently leaking through
  test('blocks AI LLMs Top News', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('AI LLMs Top News'))).toBe(false);
  });
  test('blocks longevity', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Longevity anti-aging findings'))).toBe(false);
  });
  test('blocks YC Series A', () => {
    expect(isEventEmail('scout-yc-series-a.html', htmlWithCategory('YC Series A raises'))).toBe(false);
  });
  test('blocks by filename: longevity', () => {
    expect(isEventEmail('scout-longevity-klotho.html', htmlWithCategory('unknown'))).toBe(false);
  });
  test('blocks by filename: ai/llm', () => {
    expect(isEventEmail('scout-gpt-5-rolls-out.html', htmlWithCategory('unknown'))).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/yutori-email-filter.test.js --verbose`
Expected: FAIL on the "blocks AI", "blocks longevity", "blocks YC" tests

**Step 3: Add missing categories to filter lists**

In `email-filter.js`, add to `NON_EVENT_CATEGORIES`:
```javascript
  /\bAI\b/i, /\bLLM/i, /\bmachine\s+learn/i, /\bGPT\b/i,
  /longevity/i, /anti[- ]?aging/i,
  /\bYC\b/i, /series\s+[A-C]\b/i, /venture\s+capital/i,
  /social\s+luck/i, /social\s+event\s+research/i,
```

Add to `NON_EVENT_FILENAMES`:
```javascript
  /\bai\b/i, /\bllm/i, /\bgpt-/i, /\bnvidia/i, /\bblackwell/i,
  /longevity/i, /anti-aging/i, /\bklotho\b/i, /\bprogranulin\b/i,
  /\byc\b/i, /series-a/i,
  /social-luck/i, /social-event-research/i,
```

**Step 4: Run test to verify it passes**

Run: `npx jest test/unit/yutori-email-filter.test.js --verbose`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests pass

**Step 6: Commit**

```bash
git add src/sources/yutori/email-filter.js test/unit/yutori-email-filter.test.js
git commit -m "fix: tighten Yutori email filter to block AI/longevity/YC categories"
```

---

### Task 2: Create `structured-parser.js` — extract events from raw HTML

The core parser. Works on raw Yutori Scout HTML (before preprocessing). Handles 3 templates:
- **Template A**: Category-grouped `<ul>` with inline `<li>` items (each `<li>` = one event)
- **Template B**: Numbered `<ol>` with `<br/>`-separated fields per `<li>`
- **Template C**: Paragraph-separated `<p>` blocks with `<br/>`-separated fields

All templates share: source URL in tracking badge `<span>`, same field schema.

**Files:**
- Create: `src/sources/yutori/structured-parser.js`
- Test: `test/unit/yutori-structured-parser.test.js` (new)

**Step 1: Write the failing tests**

```javascript
// test/unit/yutori-structured-parser.test.js
const { parseStructuredYutoriHtml } = require('../../src/sources/yutori/structured-parser');

describe('parseStructuredYutoriHtml', () => {
  describe('Template A: inline <li> with source badge', () => {
    const html = `
      <h3>Test Email</h3>
      <p><b style="font-weight:700">Electronic music — immediate</b></p>
      <ul>
        <li style="color:rgb(51,65,85)">Dweller Thursday: Moor Mother b2b Hieroglyphic Being at Paragon, 990 Broadway, Brooklyn — Thu, Feb 19, 9:30 PM–3:00 AM. <span style="display:inline-block"><a href="https://scouts.yutori.com/api/view?url=https%3A%2F%2Fra.co%2Fevents%2F2354432&amp;referrer=email&amp;scout_id=abc&amp;destination=source"><img src="favicon"/><span>Event details</span></a></span>.</li>
        <li style="color:rgb(51,65,85)">Techno Tribe presents: Reflection at Rash, 941 Willoughby Ave, Brooklyn — Fri, Feb 20, 10:00 PM–4:00 AM. $15. <span style="display:inline-block"><a href="https://scouts.yutori.com/api/view?url=https%3A%2F%2Fra.co%2Fevents%2F2354819&amp;referrer=email&amp;scout_id=abc&amp;destination=source"><img src="favicon"/><span>Event details</span></a></span>.</li>
      </ul>
      <p>Report generated by 191 agents</p>
    `;

    test('extracts 2 events', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events.length).toBe(2);
    });

    test('extracts event name', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events[0].name).toMatch(/Dweller Thursday/);
    });

    test('extracts venue', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events[0].venue_name).toBe('Paragon');
    });

    test('extracts venue address', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events[0].venue_address).toMatch(/990 Broadway/);
    });

    test('extracts date', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events[0].date_local).toBe('2026-02-19');
    });

    test('extracts start time', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events[0].start_time_local).toMatch(/21:30/);
    });

    test('decodes source URL from tracking redirect', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events[0].source_url).toBe('https://ra.co/events/2354432');
    });

    test('extracts price when present', () => {
      const events = parseStructuredYutoriHtml(html, '2026-02-20');
      expect(events[1].price_display).toBe('$15');
    });
  });

  describe('Template B: numbered <ol> with <br/> fields', () => {
    const html = `
      <h3>Fresh Indie Picks</h3>
      <ol>
        <li>"Mitski Residency" at The Shed<br/>545 W 30th St, Chelsea, Manhattan<br/>Tue Mar 3, 8:00 PM<br/>Price not listed<br/>Indie-pop artist in a six-night run.<br/>Details: https://www.theshed.org</li>
        <li>"Ten Dollar Tuesdays" at St. Marks Comedy Club<br/>12 St. Marks Place, East Village, Manhattan<br/>Tue Mar 3, 7:30 PM<br/>$10<br/>Early-week showcase of rising underground comedians.<br/>Details: https://www.stmarkscomedy.com</li>
      </ol>
      <p>Report generated by 200 agents</p>
    `;

    test('extracts 2 events', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-04');
      expect(events.length).toBe(2);
    });

    test('extracts quoted name', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-04');
      expect(events[0].name).toBe('Mitski Residency');
    });

    test('extracts venue from "at Venue" pattern', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-04');
      expect(events[0].venue_name).toBe('The Shed');
    });

    test('extracts address from <br/> line', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-04');
      expect(events[0].venue_address).toMatch(/545 W 30th St/);
    });

    test('extracts details URL', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-04');
      expect(events[0].source_url).toBe('https://www.theshed.org');
    });

    test('extracts price', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-04');
      expect(events[1].price_display).toBe('$10');
    });
  });

  describe('Template C: paragraph-separated with <br/> fields', () => {
    const html = `
      <h3>Curated Indie in Manhattan</h3>
      <p style="color:rgb(55,65,81)">1) "The Legend of You" at Caveat<br/>21A Clinton St, Lower East Side<br/>Sat Mar 7, 1:30 PM<br/>$15–$20<br/>Comedy meets catharsis.<br/>Details: https://www.caveat.nyc/events</p>
      <p style="color:rgb(55,65,81)">2) "On the Watchlist" at Caveat<br/>21A Clinton St, Lower East Side<br/>Sat Mar 7, 4:00 PM<br/>$15–$20<br/>Live show that dismantles media narratives.<br/>Details: https://www.caveat.nyc/events</p>
      <p>Report generated by 200 agents</p>
    `;

    test('extracts 2 events', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-05');
      expect(events.length).toBe(2);
    });

    test('extracts name from numbered paragraph', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-05');
      expect(events[0].name).toBe('The Legend of You');
    });

    test('extracts venue', () => {
      const events = parseStructuredYutoriHtml(html, '2026-03-05');
      expect(events[0].venue_name).toBe('Caveat');
    });
  });

  describe('edge cases', () => {
    test('returns empty array for non-event HTML', () => {
      const html = '<h3>AI News</h3><p>GPT-5 is out.</p><p>Report generated by 10 agents</p>';
      const events = parseStructuredYutoriHtml(html, '2026-03-06');
      expect(events.length).toBe(0);
    });

    test('handles HTML entities in names', () => {
      const html = `<ol><li>"Rock &amp; Roll Night" at Joe&#x27;s Pub<br/>425 Lafayette St<br/>Fri Mar 7, 9:00 PM<br/>$20<br/>Great show.</li></ol><p>Report generated by 10 agents</p>`;
      const events = parseStructuredYutoriHtml(html, '2026-03-07');
      expect(events[0].name).toMatch(/Rock & Roll/);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/yutori-structured-parser.test.js --verbose`
Expected: FAIL — module not found

**Step 3: Implement `structured-parser.js`**

```javascript
// src/sources/yutori/structured-parser.js
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
  if (badgeMatch) return decodeTrackingUrl(badgeMatch[1]);

  // Any tracking URL
  const anyTracker = html.match(
    /href=["'](https?:\/\/scouts\.yutori\.com\/api\/view\?url=[^"']+)["']/i
  );
  if (anyTracker) return decodeTrackingUrl(anyTracker[1]);

  // Details: URL in text
  const detailsMatch = stripTags(html).match(/Details:\s*(https?:\/\/\S+)/i);
  if (detailsMatch) return detailsMatch[1].replace(/[.,;)]+$/, '');

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

  // Extract time: "H:MM AM/PM" with optional end time
  const timeMatch = text.match(/(\d{1,2}:\d{2})\s*([AP]M)\s*(?:[-–]\s*(\d{1,2}:\d{2})\s*([AP]M))?/i);
  if (timeMatch) {
    startTime = dateLocal + 'T' + parseTo24h(timeMatch[1] + ' ' + timeMatch[2]);
    if (timeMatch[3] && timeMatch[4]) {
      endTime = dateLocal + 'T' + parseTo24h(timeMatch[3] + ' ' + timeMatch[4]);
    }
  }

  return { date_local: dateLocal, start_time_local: startTime, end_time_local: endTime };
}

/**
 * Parse price from text.
 */
function parsePrice(text) {
  const priceMatch = text.match(/\$\d+(?:\.\d{1,2})?(?:\s*[-–]\s*\$?\d+(?:\.\d{1,2})?)?/);
  if (priceMatch) return { price_display: priceMatch[0], is_free: false };

  if (/\bfree\b/i.test(text) && !/price not/i.test(text)) {
    return { price_display: 'Free', is_free: true };
  }
  return { price_display: null, is_free: false };
}

/**
 * Parse a single event from an inline <li> (Template A/D).
 * Format: "Name at Venue, Address — Day, Date, Time. Description. [badge]"
 */
function parseInlineLi(liHtml, fallbackDate) {
  const sourceUrl = extractSourceUrl(liHtml);

  // Strip badge spans and tags to get clean text
  let text = liHtml
    .replace(/<span[^>]*>[\s\S]*?<\/span>/gi, '') // Remove badge spans
    .replace(/<[^>]*>/g, '')                       // Strip remaining tags
    .replace(/\s+/g, ' ')
    .trim();
  text = decodeEntities(text);

  if (text.length < 20) return null;

  // Extract quoted name
  let name = null;
  const quotedMatch = text.match(/"([^"]+)"/);
  if (quotedMatch) {
    name = quotedMatch[1].trim();
  }

  // Extract "at Venue, Address" or "at Venue — "
  let venueName = null;
  let venueAddress = null;
  const atVenue = text.match(/\bat\s+([A-Z][^—–,]+?)(?:,\s*(\d+[^—–]+?))?(?:\s*[—–]|\s*$)/i);
  if (atVenue) {
    venueName = atVenue[1].trim().replace(/\.\s*$/, '');
    if (atVenue[2]) venueAddress = atVenue[2].trim().replace(/,\s*(?:Brooklyn|Manhattan|Queens|Bronx|New York|NY).*$/i, '').trim();
  }

  // If no quoted name, derive from text before "at Venue"
  if (!name) {
    const beforeAt = text.match(/^(.+?)\s+at\s+[A-Z]/i);
    if (beforeAt) {
      name = beforeAt[1].replace(/^\d+[.)]\s*/, '').replace(/\.\s*$/, '').trim();
    } else {
      name = text.split(/\s*[—–]\s*/)[0].replace(/^\d+[.)]\s*/, '').trim().slice(0, 120);
    }
  }

  if (!name || name.length < 5) return null;

  const dt = parseDateTimeLine(text, fallbackDate);
  const price = parsePrice(text);

  // Description: everything after the date/time/price/venue, before source badge
  let description = null;
  const descParts = text.split(/\s*[—–]\s*/);
  if (descParts.length >= 3) {
    const rawDesc = descParts.slice(2).join(' — ').replace(/\.\s*$/, '').trim();
    if (rawDesc.length > 15) description = rawDesc;
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
    const afterQuote = firstLine.slice(firstLine.indexOf('"', firstLine.indexOf(name) + name.length) + 1);
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

  // Remaining lines: address, date/time, price, description, details URL
  let venueAddress = null;
  let dateText = '';
  let priceText = '';
  let description = null;
  let detailsUrl = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Address line: starts with a number (street address)
    if (/^\d+\s/.test(line) && !venueAddress && !/^\d{1,2}:\d{2}/.test(line)) {
      venueAddress = line.replace(/,\s*(?:Brooklyn|Manhattan|Queens|Bronx|New York|NY)(?:\s*,?\s*(?:NY)?\s*\d{5})?.*$/i, '').trim();
      continue;
    }

    // Date/time line: contains month name or day-of-week
    if (/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(line) && !dateText) {
      dateText = line;
      continue;
    }

    // Price line: starts with $ or "Free" or "Price not"
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

    // Everything else is description
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

  // Strategy 1: Extract events from <li> items
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liPattern.exec(body)) !== null) {
    const liHtml = liMatch[1];

    // Skip very short items or TL;DR lines
    if (stripTags(liHtml).trim().length < 30) continue;

    let event;
    if (isBrSeparated(liHtml)) {
      event = parseBrSeparatedBlock(liHtml, fallbackDate);
    } else {
      event = parseInlineLi(liMatch[0], fallbackDate);
    }

    if (event && event.name) events.push(event);
  }

  // Strategy 2: If no <li> events found, try <p> blocks (Template C)
  if (events.length === 0) {
    const pPattern = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pPattern.exec(body)) !== null) {
      const pHtml = pMatch[1];
      const pText = stripTags(pHtml).trim();

      // Only parse paragraphs that look like numbered events or have <br/> structure
      if (!/^\d+[.)]\s/.test(pText) && !/<br\s*\/?>/i.test(pHtml)) continue;
      if (pText.length < 40) continue;
      // Skip TL;DR, category headers, summary lines
      if (/^(?:TL;DR|Here'?s a summary|Free\/low-cost)/i.test(pText)) continue;
      if (/<b[^>]*style="font-weight:700">[^<]{3,30}<\/b>/i.test(pHtml) && pText.length < 80) continue;

      const event = parseBrSeparatedBlock(pHtml, fallbackDate);
      if (event && event.name) events.push(event);
    }
  }

  return events;
}

module.exports = { parseStructuredYutoriHtml, decodeTrackingUrl, extractSourceUrl };
```

**Step 4: Run tests to verify they pass**

Run: `npx jest test/unit/yutori-structured-parser.test.js --verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sources/yutori/structured-parser.js test/unit/yutori-structured-parser.test.js
git commit -m "feat: add structured Yutori HTML parser for deterministic event extraction"
```

---

### Task 3: Create dataset validation script

Run the structured parser against all 92 dataset emails and measure extraction quality.

**Files:**
- Create: `scripts/validate-yutori-parser.js`

**Step 1: Write the validation script**

```javascript
// scripts/validate-yutori-parser.js
/**
 * Run the structured parser against the Yutori dataset and report extraction quality.
 * Usage: node scripts/validate-yutori-parser.js
 */
const fs = require('fs');
const path = require('path');
const { parseStructuredYutoriHtml } = require('../src/sources/yutori/structured-parser');
const { isEventEmail } = require('../src/sources/yutori/email-filter');

const DATASET_DIR = path.join(__dirname, '..', 'data', 'yutori-dataset');

function main() {
  const indexPath = path.join(DATASET_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('Run scripts/build-yutori-dataset.js first');
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let totalEvents = 0;
  let withName = 0, withVenue = 0, withDate = 0, withTime = 0;
  let withPrice = 0, withUrl = 0, withDesc = 0;
  let fullyComplete = 0;
  let emptyFiles = 0;
  let filteredOut = 0;

  const perFile = [];

  for (const entry of index.emails) {
    const filepath = path.join(DATASET_DIR, entry.filename);
    if (!fs.existsSync(filepath)) continue;

    const html = fs.readFileSync(filepath, 'utf8');

    // Check if updated filter would skip this
    if (!isEventEmail(entry.filename, html)) {
      filteredOut++;
      continue;
    }

    const dateMatch = entry.filename.match(/^(\d{4}-\d{2}-\d{2})/);
    const fallbackDate = dateMatch ? dateMatch[1] : null;

    const events = parseStructuredYutoriHtml(html, fallbackDate);
    totalEvents += events.length;

    if (events.length === 0) {
      emptyFiles++;
      perFile.push({ file: entry.filename, events: 0, fields: 'N/A' });
      continue;
    }

    for (const e of events) {
      if (e.name) withName++;
      if (e.venue_name) withVenue++;
      if (e.date_local) withDate++;
      if (e.start_time_local) withTime++;
      if (e.price_display) withPrice++;
      if (e.source_url) withUrl++;
      if (e.description_short) withDesc++;
      if (e.name && e.venue_name && e.date_local && e.start_time_local && e.source_url) fullyComplete++;
    }

    perFile.push({ file: entry.filename, events: events.length, sample: events[0]?.name });
  }

  const active = index.emails.length - filteredOut;
  console.log('=== YUTORI STRUCTURED PARSER VALIDATION ===\n');
  console.log(`Dataset: ${index.emails.length} emails (${filteredOut} now filtered out, ${active} active)`);
  console.log(`Total events extracted: ${totalEvents}`);
  console.log(`Empty files (0 events): ${emptyFiles}`);
  console.log(`\nField coverage:`);
  console.log(`  Name:        ${withName}/${totalEvents} (${(withName/totalEvents*100).toFixed(0)}%)`);
  console.log(`  Venue:       ${withVenue}/${totalEvents} (${(withVenue/totalEvents*100).toFixed(0)}%)`);
  console.log(`  Date:        ${withDate}/${totalEvents} (${(withDate/totalEvents*100).toFixed(0)}%)`);
  console.log(`  Time:        ${withTime}/${totalEvents} (${(withTime/totalEvents*100).toFixed(0)}%)`);
  console.log(`  Price:       ${withPrice}/${totalEvents} (${(withPrice/totalEvents*100).toFixed(0)}%)`);
  console.log(`  Source URL:  ${withUrl}/${totalEvents} (${(withUrl/totalEvents*100).toFixed(0)}%)`);
  console.log(`  Description: ${withDesc}/${totalEvents} (${(withDesc/totalEvents*100).toFixed(0)}%)`);
  console.log(`  COMPLETE:    ${fullyComplete}/${totalEvents} (${(fullyComplete/totalEvents*100).toFixed(0)}%)`);

  console.log(`\nComparison vs current LLM extraction:`);
  console.log(`  URL:  ${(withUrl/totalEvents*100).toFixed(0)}% vs 18% (was 82% missing)`);
  console.log(`  Time: ${(withTime/totalEvents*100).toFixed(0)}% vs 58% (was 42% missing)`);
  console.log(`  Complete: ${(fullyComplete/totalEvents*100).toFixed(0)}% vs 9%`);

  // Show files with 0 events
  if (emptyFiles > 0) {
    console.log(`\nFiles with 0 events extracted:`);
    perFile.filter(f => f.events === 0).forEach(f => console.log(`  ${f.file}`));
  }

  // Show sample from first 5 files
  console.log(`\nSample events (first 5 files):`);
  perFile.filter(f => f.events > 0).slice(0, 5).forEach(f => {
    console.log(`  ${f.file}: ${f.events} events (e.g., "${f.sample}")`);
  });
}

main();
```

**Step 2: Run the validation**

Run: `node scripts/validate-yutori-parser.js`
Expected: extraction stats showing improvement over current LLM extraction. Target: >80% URL coverage, >85% time coverage, >50% fully complete.

**Step 3: Iterate on parser if needed**

If any email formats aren't handled, add test cases and fix `structured-parser.js`. Repeat until validation passes targets.

**Step 4: Commit**

```bash
git add scripts/validate-yutori-parser.js
git commit -m "feat: add Yutori parser dataset validation script"
```

---

### Task 4: Wire structured parser into `fetch.js`

Replace the preprocess → general parser path with the structured parser for non-trivia Yutori emails. Keep LLM fallback for emails the structured parser can't handle.

**Files:**
- Modify: `src/sources/yutori/fetch.js:148-165`

**Step 1: Add the import**

At top of `fetch.js`, add:
```javascript
const { parseStructuredYutoriHtml } = require('./structured-parser');
```

**Step 2: Replace the non-trivia deterministic parse block**

Replace lines 148-165 (the block starting `// Non-trivia event emails: try deterministic parse first (P6)`) with:

```javascript
      // Non-trivia event emails: try structured HTML parse first (P6)
      if (/\.html?$/i.test(file)) {
        const parsed = parseStructuredYutoriHtml(raw, baseDateMatch ? baseDateMatch[1] : null);
        if (parsed.length > 0) {
          console.log(`Yutori: structured parse → ${parsed.length} events from ${file}`);
          captureExtractionInput('yutori', raw.slice(0, 2000), null);
          const normalized = parsed
            .map(e => normalizeExtractedEvent(e, 'yutori', 'aggregator', 0.85))
            .filter(e => e.name && e.completeness >= 0.25);
          triviaEvents.push(...normalized);
          continue;
        }
        // Fall through to LLM if structured parse found nothing
      }
```

Note: `baseDateMatch` is already defined at the top of the for loop — we need to extract it before this block. Actually, looking at fetch.js, the `baseDateMatch` isn't defined at this scope. We need to extract it from the filename:

```javascript
      // Non-trivia event emails: try structured HTML parse first (P6)
      if (/\.html?$/i.test(file)) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        const parsed = parseStructuredYutoriHtml(raw, dateMatch ? dateMatch[1] : null);
        if (parsed.length > 0) {
          console.log(`Yutori: structured parse → ${parsed.length} events from ${file}`);
          captureExtractionInput('yutori', raw.slice(0, 2000), null);
          const normalized = parsed
            .map(e => normalizeExtractedEvent(e, 'yutori', 'aggregator', 0.85))
            .filter(e => e.name && e.completeness >= 0.25);
          triviaEvents.push(...normalized);
          continue;
        }
        // Fall through to LLM if structured parse found nothing
      }
```

**Step 3: Run existing tests**

Run: `npm test`
Expected: All existing tests pass

**Step 4: Commit**

```bash
git add src/sources/yutori/fetch.js
git commit -m "feat: wire structured Yutori parser into fetch pipeline, LLM fallback for unhandled"
```

---

### Task 5: End-to-end validation

**Step 1: Reprocess Yutori emails to test the full pipeline**

Run: `node -e "require('./src/sources/yutori/fetch').fetchYutoriEvents({ reprocess: true }).then(e => console.log(e.length + ' events')).catch(console.error)"`

This moves all 149 processed files back and reprocesses them through the updated pipeline.

**Step 2: Check extraction quality**

Run the check script against the local server to verify the spot-check events are now found.

**Step 3: Deploy and verify**

Run: `railway up`

After deploy (~2-3 min), run: `node scripts/check-yutori-events.js`

Expected: Some of the 10 spot-check events now appear in the cache.

**Step 4: Commit results**

Update the analysis doc with results and commit.
