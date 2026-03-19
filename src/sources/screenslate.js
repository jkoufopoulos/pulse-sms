const fs = require('fs');
const path = require('path');
const { fetchEmails } = require('../gmail');
const { backfillEvidence, stripHtml, extractEmailEvents } = require('./shared');

const SCREENSLATE_DIR = path.join(__dirname, '../../data/screenslate');
const CACHE_FILE = path.join(SCREENSLATE_DIR, 'cached-events.json');

function loadCachedEvents() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data?.events) backfillEvidence(data.events);
      return data;
    }
  } catch (err) {
    console.warn('ScreenSlate: failed to load cached-events.json:', err.message);
  }
  return null;
}

function saveCachedEvents(emailId, events) {
  try {
    fs.mkdirSync(SCREENSLATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ id: emailId, events }, null, 2));
  } catch (err) {
    console.warn('ScreenSlate: failed to save cached-events.json:', err.message);
  }
}

/**
 * Extract the editorial article, special screenings (Q&As, premieres, etc.),
 * and exhibitions from a ScreenSlate newsletter. Drops standard showtimes.
 */
function extractEditorialContent(text, emailDate) {
  const lines = text.split('\n');
  const sections = [];

  // 1. Everything before "TODAY'S LISTINGS" is the editorial article
  const listingsIdx = lines.findIndex(l => /TODAY.?S LISTINGS/i.test(l));
  if (listingsIdx > 0) {
    sections.push('--- FEATURED EDITORIAL RECOMMENDATION ---');
    sections.push(...lines.slice(0, listingsIdx));
    sections.push('');
  }

  // 2. Scan listings for special screenings by finding annotation lines
  const specialLine = /\*.*(?:Q&A|in-person|premiere|sneak preview|introduction|presented by)/i;
  const specialInline = /(?:Q&A|in-person|premiere|sneak preview|new york premiere|4K restoration|35mm|16mm)/i;
  const exhibIdx = lines.findIndex(l => /^EXHIBITIONS$/i.test(l.trim()));
  const listingsEnd = exhibIdx >= 0 ? exhibIdx : lines.length;
  const listingsStart = listingsIdx >= 0 ? listingsIdx : 0;

  // Find venue for each line (last ALL-CAPS header)
  let currentVenue = null;
  const specialBlocks = [];
  const usedLines = new Set();

  for (let i = listingsStart; i < listingsEnd; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Venue headers: ALL CAPS, not metadata, not a series/section name
    if (line === line.toUpperCase() && line.length > 3 &&
        !/^\d/.test(line) && !/^\*/.test(line) &&
        !/^[\d:]+[ap]m/i.test(line) && !/\d{4},\s*\d+M/.test(line) &&
        !/SUPPORT|SUBSCRIBE|PATREON/i.test(line)) {
      currentVenue = line;
    }

    // Check if this line signals a special screening
    if ((specialLine.test(line) || specialInline.test(line)) && currentVenue) {
      // Walk backwards to find the film name (first non-metadata, non-time line)
      let blockStart = i;
      for (let j = i - 1; j >= Math.max(listingsStart, i - 6); j--) {
        const prev = lines[j].trim();
        if (!prev) continue;
        // Stop at venue headers or previous showtimes
        if (prev === prev.toUpperCase() && prev.length > 3 && !/\d{4},\s*\d+M/.test(prev)) break;
        blockStart = j;
      }
      // Walk forward to capture showtimes and annotations
      let blockEnd = i;
      for (let j = i + 1; j < Math.min(listingsEnd, i + 4); j++) {
        const next = lines[j].trim();
        if (!next) break;
        if (next === next.toUpperCase() && next.length > 3 && !/\d{4},\s*\d+M/.test(next)) break;
        blockEnd = j;
      }

      // Skip if we already captured this block
      if (usedLines.has(blockStart)) continue;
      for (let k = blockStart; k <= blockEnd; k++) usedLines.add(k);

      specialBlocks.push({
        venue: currentVenue,
        lines: lines.slice(blockStart, blockEnd + 1).map(l => l.trim()).filter(l => l),
      });
    }
  }

  if (specialBlocks.length > 0) {
    sections.push(`--- SPECIAL SCREENINGS (${emailDate}) ---`);
    for (const b of specialBlocks) {
      sections.push(`\nVENUE: ${b.venue}`);
      sections.push(...b.lines);
    }
    sections.push('');
  }

  // 3. Extract the EXHIBITIONS section
  if (exhibIdx >= 0) {
    sections.push(`--- EXHIBITIONS (current, closing dates listed) ---`);
    sections.push(...lines.slice(exhibIdx));
  }

  return sections.join('\n');
}

async function fetchScreenSlateEvents() {
  console.log('Fetching Screen Slate...');
  try {
    const emails = await fetchEmails('from:jon@screenslate.com newer_than:5d', 3);
    const cached = loadCachedEvents();

    if (emails.length === 0) {
      if (cached && cached.events.length > 0) {
        console.log(`ScreenSlate: no emails found, returning ${cached.events.length} cached events`);
        return cached.events;
      }
      console.log('ScreenSlate: no newsletter emails found and no cache available');
      return [];
    }

    const latest = emails[0];

    if (cached && cached.id === latest.id && cached.events.length > 0) {
      console.log(`ScreenSlate: returning ${cached.events.length} cached events from "${latest.subject}"`);
      return cached.events;
    }

    console.log(`ScreenSlate: processing "${latest.subject}" (${latest.date})`);
    const stripped = stripHtml(latest.body);

    const emailDate = new Date(latest.date).toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    // Pre-filter to editorial content only — drops standard showtimes
    const editorial = extractEditorialContent(stripped, emailDate);
    console.log(`ScreenSlate: ${stripped.split('\n').length} raw lines → ${editorial.split('\n').length} editorial lines`);

    const events = await extractEmailEvents({
      text: editorial,
      sourceName: 'ScreenSlate',
      sourceType: 'unstructured',
      sourceWeight: 0.9,
      sourceUrl: 'https://screenslate.com',
      label: 'screenslate',
      categoryOverride: 'film',
      sourceHint: 'This is Screen Slate, a curated NYC film guide. Extract ALL items: (1) The featured editorial article — set editorial_signal=true and capture the editorial prose in editorial_note. (2) Every special screening listed (Q&As, premieres, restorations, in-person appearances). (3) Every exhibition with its venue and closing date. Each item is a separate event.',
    });

    saveCachedEvents(latest.id, events);
    console.log(`ScreenSlate: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('Screen Slate error:', err.message);
    const cached = loadCachedEvents();
    if (cached && cached.events.length > 0) {
      console.log(`ScreenSlate: error recovery, returning ${cached.events.length} cached events`);
      return cached.events;
    }
    return [];
  }
}

module.exports = { fetchScreenSlateEvents, extractEditorialContent };
