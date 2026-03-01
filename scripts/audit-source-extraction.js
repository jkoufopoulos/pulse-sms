#!/usr/bin/env node
/**
 * Audit source extraction quality for Skint and Nonsense NYC.
 *
 * Fetches raw content, runs the extraction pipeline, and logs:
 * - Raw extraction count vs post-gate count
 * - Which events were dropped and why (completeness breakdown)
 *
 * Usage:
 *   node scripts/audit-source-extraction.js [--source skint|nonsense] [--url <railway-url>]
 */

require('dotenv').config();

const { computeCompleteness } = require('../src/sources/shared');

const args = process.argv.slice(2);
const sourceArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'all';
const railwayUrl = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;

const COMPLETENESS_THRESHOLD = 0.5;

// ── Skint audit ──

async function auditSkint() {
  console.log('\n=== SKINT EXTRACTION AUDIT ===\n');

  const cheerio = require('cheerio');
  const { FETCH_HEADERS } = require('../src/sources/shared');
  const { extractEvents } = require('../src/ai');

  // Step 1: Fetch raw HTML
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const res = await fetch('https://theskint.com/', {
    headers: FETCH_HEADERS, signal: controller.signal,
  });
  clearTimeout(timeout);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Step 2: Parse paragraphs (mirrors skint.js logic)
  const content = $('.entry-content').first();
  const paragraphs = [];
  let totalParagraphs = 0;

  content.find('p').each((_, el) => {
    const text = $(el).text().trim();
    if (!text || text.length < 30) return;
    // Skip day headers and sponsored
    if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|ongoing)$/i.test(text)) return;
    if (/sponsored/i.test(text)) return;

    totalParagraphs++;
    paragraphs.push(text);
  });

  console.log(`Raw HTML paragraphs (>30 chars): ${totalParagraphs}`);
  console.log(`Paragraphs sent to extraction: ${Math.min(paragraphs.length, 30)}`);

  // Step 3: Build extraction input (cap at 30 paragraphs)
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  const extractionInput = `Today is ${today}.\n\n` + paragraphs.slice(0, 30).join('\n\n');

  // Step 4: Run extraction
  console.log(`\nRunning extractEvents (${extractionInput.length} chars)...`);
  const result = await extractEvents(extractionInput, 'theskint', 'https://theskint.com/');
  const rawEvents = result.events || [];
  console.log(`\nLLM extracted: ${rawEvents.length} events`);

  // Step 5: Check quality gates
  let passed = 0;
  let dropped = 0;
  const dropReasons = [];

  for (const e of rawEvents) {
    const completeness = computeCompleteness(e);
    if (!e.name || completeness < COMPLETENESS_THRESHOLD) {
      dropped++;
      const missing = [];
      if (!e.name) missing.push('name');
      if (!e.date_local) missing.push('date');
      if (!e.venue_name || e.venue_name === 'TBA') missing.push('venue');
      if (!e.neighborhood) missing.push('neighborhood');
      if (!e.start_time_local) missing.push('time');
      dropReasons.push({
        name: e.name || '(no name)',
        completeness: completeness.toFixed(2),
        missing,
      });
    } else {
      passed++;
    }
  }

  console.log(`Passed gates: ${passed}`);
  console.log(`Dropped: ${dropped}`);
  if (dropReasons.length > 0) {
    console.log('\nDropped events:');
    for (const d of dropReasons) {
      console.log(`  - "${d.name}" (completeness=${d.completeness}, missing: ${d.missing.join(', ')})`);
    }
  }

  // Step 6: Compare with Railway if URL given
  if (railwayUrl) {
    await compareWithRailway('Skint', railwayUrl);
  }

  return { source: 'Skint', raw: totalParagraphs, extracted: rawEvents.length, passed, dropped };
}

// ── Nonsense NYC audit ──

async function auditNonsense() {
  console.log('\n=== NONSENSE NYC EXTRACTION AUDIT ===\n');

  const { fetchEmails } = require('../src/gmail');
  const { extractEvents } = require('../src/ai');

  // Step 1: Fetch newsletter from Gmail
  let newsletter;
  try {
    const emails = await fetchEmails('from:jstark@nonsensenyc.com subject:nonsense newer_than:8d', { maxResults: 1 });
    if (emails.length === 0) {
      console.log('No recent Nonsense NYC newsletters found via Gmail');
      return null;
    }
    newsletter = emails[0];
    console.log(`Newsletter: "${newsletter.subject}" (${newsletter.date})`);
  } catch (err) {
    console.error('Gmail fetch failed:', err.message);
    console.log('Ensure GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN are set');
    return null;
  }

  // Step 2: Strip HTML
  const { stripHtml } = require('../src/sources/yutori');
  const text = stripHtml(newsletter.body);
  console.log(`Newsletter text length: ${text.length} chars`);

  // Step 3: Split by day (mirrors nonsense.js logic)
  const { splitByDay } = require('../src/sources/nonsense');
  const sections = splitByDay(text);
  console.log(`Day sections: ${sections.length}`);

  // Step 4: Count events described per section (rough heuristic)
  let totalDescribed = 0;
  for (const { day, content } of sections) {
    // Rough estimate: count entries separated by double newlines or bullet patterns
    const chunks = content.split(/\n{2,}/).filter(c => c.trim().length > 30);
    totalDescribed += chunks.length;
    console.log(`  ${day}: ~${chunks.length} event descriptions (${content.length} chars)`);
  }

  // Step 5: Run extraction on each section
  let totalExtracted = 0;
  let totalPassed = 0;
  let totalDropped = 0;
  const allDropReasons = [];

  for (const { day, content } of sections) {
    if (content.length < 100) continue;

    console.log(`\nExtracting "${day}" (${content.length} chars)...`);
    const result = await extractEvents(content, 'nonsensenyc', 'https://nonsensenyc.com/');
    const rawEvents = result.events || [];
    totalExtracted += rawEvents.length;

    for (const e of rawEvents) {
      const completeness = computeCompleteness(e);
      if (!e.name || completeness < COMPLETENESS_THRESHOLD) {
        totalDropped++;
        const missing = [];
        if (!e.name) missing.push('name');
        if (!e.date_local) missing.push('date');
        if (!e.venue_name || e.venue_name === 'TBA') missing.push('venue');
        if (!e.neighborhood) missing.push('neighborhood');
        if (!e.start_time_local) missing.push('time');
        allDropReasons.push({
          day,
          name: e.name || '(no name)',
          completeness: completeness.toFixed(2),
          missing,
        });
      } else {
        totalPassed++;
      }
    }
    console.log(`  → ${rawEvents.length} extracted, ${rawEvents.length - (totalDropped - allDropReasons.filter(d => d.day !== day).length)} passed`);
  }

  console.log(`\n--- Nonsense Summary ---`);
  console.log(`Estimated events described: ~${totalDescribed}`);
  console.log(`LLM extracted: ${totalExtracted}`);
  console.log(`Passed gates: ${totalPassed}`);
  console.log(`Dropped: ${totalDropped}`);
  if (allDropReasons.length > 0) {
    console.log('\nDropped events:');
    for (const d of allDropReasons) {
      console.log(`  - [${d.day}] "${d.name}" (completeness=${d.completeness}, missing: ${d.missing.join(', ')})`);
    }
  }

  if (railwayUrl) {
    await compareWithRailway('NonsenseNYC', railwayUrl);
  }

  return { source: 'NonsenseNYC', estimated: totalDescribed, extracted: totalExtracted, passed: totalPassed, dropped: totalDropped };
}

// ── Railway comparison ──

async function compareWithRailway(sourceName, baseUrl) {
  try {
    const url = `${baseUrl}/health?json=1`;
    const res = await fetch(url);
    const health = await res.json();
    const sourceData = health.sources?.[sourceName];
    if (sourceData) {
      console.log(`\nRailway ${sourceName}: ${sourceData.last_count} events (status: ${sourceData.status}, last scrape: ${sourceData.last_scrape})`);
    } else {
      console.log(`\nRailway: ${sourceName} not found in health data`);
    }
  } catch (err) {
    console.log(`\nRailway comparison failed: ${err.message}`);
  }
}

// ── Main ──

async function main() {
  const results = [];

  if (sourceArg === 'all' || sourceArg === 'skint') {
    results.push(await auditSkint());
  }
  if (sourceArg === 'all' || sourceArg === 'nonsense') {
    results.push(await auditNonsense());
  }

  console.log('\n=== FINAL SUMMARY ===');
  for (const r of results.filter(Boolean)) {
    console.log(`${r.source}: ${r.extracted || 0} extracted → ${r.passed} passed (${r.dropped} dropped)`);
  }
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
