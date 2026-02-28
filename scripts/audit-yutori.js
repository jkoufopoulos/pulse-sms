#!/usr/bin/env node
/**
 * Audit all processed Yutori emails — validate preprocessing, filtering, and event catalog.
 *
 * Usage: node scripts/audit-yutori.js [--verbose]
 */
const { stripHtml, preprocessYutoriHtml, isEventEmail } = require('../src/sources/yutori');
const fs = require('fs');
const path = require('path');

const verbose = process.argv.includes('--verbose');
const dir = path.join(__dirname, '..', 'data', 'yutori', 'processed');

if (!fs.existsSync(dir)) {
  console.log('No processed directory found at', dir);
  process.exit(1);
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort();

const skip = /TL;DR|summary|brief|Report generated|adjust|Know someone|Anything I should|align with the brief|listings match/;
let totalEvents = 0;
let skippedFiles = 0;
let eventFiles = 0;
const allEvents = [];

console.log(`\n=== Yutori Email Audit (${files.length} files) ===\n`);

for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const label = f.slice(11, -5); // strip date prefix and .html

  // Test isEventEmail filter
  if (!isEventEmail(f, raw)) {
    skippedFiles++;
    console.log(`  SKIP  ${label} (non-event)`);
    continue;
  }

  eventFiles++;

  // Compare preprocessing: old stripHtml vs new preprocessYutoriHtml
  const oldText = stripHtml(raw);
  const newText = preprocessYutoriHtml(raw);
  const reduction = Math.round((1 - newText.length / oldText.length) * 100);

  // Count events in preprocessed text
  const eventBlocks = (newText.match(/\[Event\]/g) || []).length;

  // Fallback: count em-dash lines in old text
  const lines = oldText.split('\n').filter(l => l.trim().length > 20);
  const emDashEvents = lines.filter(l => l.includes('\u2014') && !skip.test(l));

  const eventCount = eventBlocks || emDashEvents.length;
  totalEvents += eventCount;

  if (eventCount > 0) {
    console.log(`  EVENT ${label} (${eventCount} events, ${reduction}% smaller)`);
    if (verbose) {
      if (eventBlocks > 0) {
        // Show [Event] blocks from preprocessed text
        const blocks = newText.split('\n').filter(l => l.startsWith('[Event]'));
        for (const b of blocks) {
          const name = b.replace('[Event] ', '').split('\u2014')[0].trim().slice(0, 70);
          allEvents.push({ file: f, name });
          console.log(`         ${name}`);
        }
      } else {
        for (const e of emDashEvents) {
          const name = e.trim().split('\u2014')[0].trim().slice(0, 70);
          allEvents.push({ file: f, name });
          console.log(`         ${name}`);
        }
      }
    }
  } else {
    console.log(`  EVENT ${label} (0 events detected)`);
  }
}

console.log(`\n--- SUMMARY ---`);
console.log(`Total files:   ${files.length}`);
console.log(`Skipped:       ${skippedFiles} (non-event emails filtered out)`);
console.log(`Event files:   ${eventFiles}`);
console.log(`Total events:  ${totalEvents} event-like items`);
console.log(`Filter rate:   ${Math.round(skippedFiles / files.length * 100)}% emails skipped\n`);
