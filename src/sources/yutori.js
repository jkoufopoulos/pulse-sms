const fs = require('fs');
const path = require('path');
const { extractEvents } = require('../ai');
const { fetchYutoriEmails } = require('../gmail');
const { normalizeExtractedEvent } = require('./shared');
const { captureExtractionInput } = require('../extraction-capture');

const YUTORI_DIR = path.join(__dirname, '../../data/yutori');
const PROCESSED_DIR = path.join(YUTORI_DIR, 'processed');
const PROCESSED_IDS_FILE = path.join(YUTORI_DIR, 'processed-ids.json');

/**
 * Strip HTML to plain text, preserving <a href> URLs as "text (URL)" format.
 */
function stripHtml(html) {
  return html
    // Convert <a href="url">text</a> to "text (url)"
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, (_, url, text) => {
      const cleanText = text.replace(/<[^>]*>/g, '').trim();
      // If the link text is the URL itself, just keep the URL
      if (cleanText === url || !cleanText) return url;
      return `${cleanText} (${url})`;
    })
    // Convert <br> and block elements to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]*>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace but preserve paragraph breaks
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Load the set of already-processed Gmail message IDs.
 */
function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_IDS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf8')));
    }
  } catch (err) {
    console.warn('Yutori: failed to load processed-ids.json:', err.message);
  }
  return new Set();
}

/**
 * Save the set of processed Gmail message IDs.
 */
function saveProcessedIds(ids) {
  try {
    fs.mkdirSync(YUTORI_DIR, { recursive: true });
    fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify([...ids], null, 2));
  } catch (err) {
    console.warn('Yutori: failed to save processed-ids.json:', err.message);
  }
}

/**
 * Create a filename slug from a subject and date string.
 */
function makeFilename(subject, dateStr) {
  const date = dateStr ? new Date(dateStr) : new Date();
  const ymd = isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
  const slug = (subject || 'briefing')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${ymd}-${slug}.html`;
}

/**
 * Fetch Yutori emails from Gmail and save new ones to data/yutori/ as .html files.
 * Returns the number of new emails saved.
 */
async function ingestFromGmail() {
  const emails = await fetchYutoriEmails(48);
  if (emails.length === 0) {
    return 0;
  }

  const processedIds = loadProcessedIds();
  fs.mkdirSync(YUTORI_DIR, { recursive: true });

  let saved = 0;
  for (const email of emails) {
    if (processedIds.has(email.id)) {
      continue;
    }

    const filename = makeFilename(email.subject, email.date);
    const filepath = path.join(YUTORI_DIR, filename);

    // Skip if a file with this name already exists (from manual placement or prior run)
    if (fs.existsSync(filepath)) {
      processedIds.add(email.id);
      continue;
    }

    try {
      fs.writeFileSync(filepath, email.body, 'utf8');
      processedIds.add(email.id);
      saved++;
      console.log(`Yutori: saved Gmail email → ${filename}`);
    } catch (err) {
      console.warn(`Yutori: failed to save ${filename}:`, err.message);
    }
  }

  saveProcessedIds(processedIds);
  return saved;
}

async function fetchYutoriEvents() {
  console.log('Fetching Yutori agent briefings...');
  try {
    // Step 1: Try fetching from Gmail (no-op if credentials not configured)
    const gmailCount = await ingestFromGmail();
    if (gmailCount > 0) {
      console.log(`Yutori: ${gmailCount} new email(s) from Gmail`);
    }

    // Step 2: Process files in data/yutori/ (from Gmail or manual placement)
    if (!fs.existsSync(YUTORI_DIR)) {
      console.log('Yutori: data/yutori/ directory not found, skipping');
      return [];
    }

    const files = fs.readdirSync(YUTORI_DIR)
      .filter(f => /\.(txt|html?)$/i.test(f))
      .sort();

    if (files.length === 0) {
      console.log('Yutori: no briefing files found');
      return [];
    }

    // Read and concatenate all briefings with source markers
    const sections = [];
    for (const file of files) {
      const raw = fs.readFileSync(path.join(YUTORI_DIR, file), 'utf8');
      const content = /\.html?$/i.test(file) ? stripHtml(raw) : raw;
      if (content.length >= 50) {
        sections.push(`[Yutori Agent: ${file}]\n${content}`);
      }
    }

    if (sections.length === 0) {
      console.log('Yutori: all briefing files too short, skipping');
      return [];
    }

    const combined = sections.join('\n\n---\n\n');
    console.log(`Yutori content: ${combined.length} chars (${files.length} files)`);
    captureExtractionInput('yutori', combined, null);

    const result = await extractEvents(combined, 'yutori', null);
    const events = (result.events || [])
      .map(e => normalizeExtractedEvent(e, 'yutori', 'aggregator', 0.8))
      .filter(e => e.name && e.completeness >= 0.5);

    // Move processed files to processed/ directory
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
    for (const file of files) {
      const src = path.join(YUTORI_DIR, file);
      const dest = path.join(PROCESSED_DIR, file);
      try {
        fs.renameSync(src, dest);
      } catch (err) {
        console.warn(`Yutori: failed to move ${file}: ${err.message}`);
      }
    }

    console.log(`Yutori: ${events.length} events from ${files.length} briefings`);
    return events;
  } catch (err) {
    console.error('Yutori error:', err.message);
    return [];
  }
}

module.exports = { fetchYutoriEvents, stripHtml };
