#!/usr/bin/env node

/**
 * One-time cleanup: deactivate poisoned recurring patterns.
 *
 * Identifies patterns that are clearly not real recurring events:
 * - Non-event content (tech news, AI challenges, etc.)
 * - Names >80 chars (sentences, not event titles)
 * - Venue field contains sentence fragments or date ranges
 * - Day of week stored as venue name
 * - Limited-run events stored as recurring ("through Apr 4")
 * - Venue = Name for non-venue names (trivia nights, not jazz clubs)
 *
 * Usage:
 *   node scripts/purge-bad-patterns.js          # dry run (default)
 *   node scripts/purge-bad-patterns.js --apply   # actually deactivate
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : path.join(__dirname, '../data/pulse.db');

const apply = process.argv.includes('--apply');

const db = new Database(dbPath);
const patterns = db.prepare('SELECT * FROM recurring_patterns WHERE deactivated = 0').all();

console.log(`Auditing ${patterns.length} active recurring patterns...`);
console.log(apply ? '*** APPLY MODE — will deactivate bad patterns ***' : '(dry run — add --apply to deactivate)');
console.log();

// Known venue names that happen to also be event series names — don't purge these
const KNOWN_VENUES = new Set([
  'brownstoneJAZZ', 'JAZZ966', "Sistas' Place", 'Brooklyn Music Kitchen',
  'BrownstoneJAZZ',
].map(v => v.toLowerCase().replace(/[^\w]/g, '')));

const toPurge = [];

for (const p of patterns) {
  const name = p.name || '';
  const venue = p.venue_name || '';
  const reasons = [];

  // 1. Non-event content keywords
  if (/\b(llm|ai challenge|gsma|zindi|security leak|openai raise|trust safety|dealmaking|market rebound|mainstream|ipo|fundrais|series [a-c]\b|revenue|valuation)\b/i.test(name)) {
    reasons.push('non-event-content');
  }

  // 2. Name is a sentence (>80 chars)
  if (name.length > 80) {
    reasons.push('name-too-long');
  }

  // 3. Day of week as venue
  if (/^(mon|tue|wed|thu|fri|sat|sun)(day)?$/i.test(venue.trim())) {
    reasons.push('day-as-venue');
  }

  // 4. Venue is a sentence fragment (contains "continue", "through Month", "series")
  if (/continue|through\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(venue)) {
    reasons.push('sentence-as-venue');
  }

  // 5. Limited-run event stored as recurring ("through Apr 4", "Mar 5-15")
  if (/\b(through|thru)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d/i.test(name)) {
    reasons.push('limited-run');
  }

  // 6. Venue = Name, but only if the name doesn't match a known venue
  if (venue && name) {
    const venueNorm = venue.toLowerCase().replace(/[^\w]/g, '');
    const nameNorm = name.toLowerCase().replace(/[^\w]/g, '');
    if (venueNorm === nameNorm && !KNOWN_VENUES.has(venueNorm)) {
      reasons.push('venue=name');
    }
  }

  if (reasons.length > 0) {
    toPurge.push({ key: p.pattern_key, name, venue, reasons });
  }
}

console.log(`Found ${toPurge.length} bad patterns (${patterns.length - toPurge.length} healthy)\n`);

for (const p of toPurge) {
  console.log(`  [${p.reasons.join(', ')}]`);
  console.log(`    name:  ${p.name.slice(0, 70)}`);
  console.log(`    venue: ${p.venue.slice(0, 50)}`);
  console.log(`    key:   ${p.key}`);
  console.log();
}

if (apply && toPurge.length > 0) {
  const stmt = db.prepare('UPDATE recurring_patterns SET deactivated = 1, updated_at = ? WHERE pattern_key = ?');
  const now = new Date().toISOString();
  let count = 0;
  for (const p of toPurge) {
    stmt.run(now, p.key);
    count++;
  }
  console.log(`Deactivated ${count} patterns.`);
} else if (toPurge.length > 0) {
  console.log(`Run with --apply to deactivate these ${toPurge.length} patterns.`);
}

db.close();
