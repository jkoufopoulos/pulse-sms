const { check } = require('../helpers');
const path = require('path');
const fs = require('fs');

// ---- Skint: raw-text fallback prevention ----
console.log('\nSkint scraper:');

// We can't easily call fetchSkintEvents (it does a live fetch + AI extraction),
// but we can test the parsing logic by simulating what the scraper does internally.
// The key invariant: when all day sections are past, eventParagraphs should be empty
// and the scraper should NOT fall through to a raw-text dump.

// Simulate the Skint parsing loop with a page that has only past-day content
function parseSkintParagraphs(texts, todayDow, todayIso) {
  const dayHeaderPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|ongoing)$/i;
  const eventPattern = /^(mon|tue|wed|thu|fri|sat|sun|thru|today|tonight|daily|\d{1,2}\/\d{1,2})/i;

  const dayMap = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

  function resolveDate(dayName) {
    const dayIndex = dayMap.indexOf(dayName.toLowerCase());
    if (dayIndex === -1) return null;
    let delta = dayIndex - todayDow;
    if (delta < -3) delta += 7;
    const today = new Date(todayIso + 'T12:00:00');
    const target = new Date(today.getTime() + delta * 86400000);
    return target.toISOString().slice(0, 10);
  }

  const eventParagraphs = [];
  let skipSection = false;

  for (const text of texts) {
    if (!text) continue;

    if (dayHeaderPattern.test(text)) {
      const dayName = text.toLowerCase();
      if (dayName === 'ongoing') {
        skipSection = false;
        eventParagraphs.push('\n--- ONGOING ---');
      } else {
        const date = resolveDate(dayName);
        skipSection = date && date < todayIso;
        if (!skipSection) {
          eventParagraphs.push(`\n--- ${dayName.toUpperCase()} ---`);
        }
      }
      continue;
    }

    // Key fix: "thru" events pass through even from past sections
    if (skipSection && !/^thru\b/i.test(text)) continue;
    if (text.length < 30) continue;
    if (text.toLowerCase().startsWith('sponsored')) continue;

    if (eventPattern.test(text)) {
      eventParagraphs.push(text);
    }
  }

  return eventParagraphs;
}

// Scenario: Saturday scrape, page only has Friday content
const saturdayParagraphs = parseSkintParagraphs(
  [
    'friday',
    'fri 7pm: Jazz at Smalls Jazz Club, 183 W 10th St, $20 cover',
    'fri 9pm: DJ Night at Good Room, 98 Meserole Ave, $15',
  ],
  6, // Saturday = dow 6
  '2026-02-28'
);
check('past-day-only page yields 0 event paragraphs', saturdayParagraphs.length === 0);

// Scenario: Saturday scrape, page has Friday + Saturday content
const mixedParagraphs = parseSkintParagraphs(
  [
    'friday',
    'fri 7pm: Jazz at Smalls Jazz Club, 183 W 10th St, $20 cover',
    'saturday',
    'sat 8pm: Comedy at Union Hall, 702 Union St, $10 cover minimum',
  ],
  6,
  '2026-02-28'
);
check('mixed page keeps only upcoming events', mixedParagraphs.length === 2); // header + 1 event

// Scenario: "thru" events rescued from past sections
const thruParagraphs = parseSkintParagraphs(
  [
    'friday',
    'fri 7pm: Jazz at Smalls Jazz Club, 183 W 10th St, $20 cover',
    'thru sun: ADIFF Black History Month Film Series at BAM, various times, free',
    'saturday',
    'sat 8pm: Comedy at Union Hall, 702 Union St, $10 cover minimum',
  ],
  6,
  '2026-02-28'
);
check('thru event rescued from past section', thruParagraphs.some(p => /thru sun/i.test(p)));
check('thru + saturday events both present', thruParagraphs.filter(p => !p.startsWith('\n---')).length === 2);

// Scenario: Ongoing section not skipped
const ongoingParagraphs = parseSkintParagraphs(
  [
    'friday',
    'fri 7pm: Jazz at Smalls Jazz Club, 183 W 10th St, $20 cover',
    'ongoing',
    'daily 10am: Free museum admission at Brooklyn Museum, 200 Eastern Pkwy',
  ],
  6,
  '2026-02-28'
);
check('ongoing events preserved despite past-day sections', ongoingParagraphs.some(p => /museum/i.test(p)));


// ---- Nonsense NYC: cache fallback ----
console.log('\nNonsense NYC cache fallback:');

// Test the cache load/save cycle
const NONSENSE_DIR = path.join(__dirname, '../../data/nonsense');
const CACHE_FILE = path.join(NONSENSE_DIR, 'cached-events.json');

// Check that loadCachedEvents works (the function is not exported, so we test the file directly)
const nonsenseMod = require('../../src/sources/nonsense');
check('nonsense module exports fetchNonsenseNYC', typeof nonsenseMod.fetchNonsenseNYC === 'function');
check('nonsense module exports splitByDay', typeof nonsenseMod.splitByDay === 'function');

// Test splitByDay — the parsing function IS exported
const { splitByDay } = nonsenseMod;

const sampleNewsletter = `
Some intro text here.

XXXXX FRIDAY, FEBRUARY 27 XXXXX
Event 1: Jazz at Smalls, 183 W 10th St. 7pm. $20. This is a great show with wonderful musicians playing all night long.
Event 2: Comedy at Union Hall, 702 Union St. 9pm. $10. Stand up comedy featuring NYC's best comics and special guests.

XXXXX SATURDAY, FEBRUARY 28 XXXXX
Event 3: Art Opening at some gallery in Chelsea with free drinks and snacks for everyone who shows up early enough.
Event 4: DJ Night at Good Room, 98 Meserole Ave. 10pm. $15. Electronic music party with great sound system.
`;

const sections = splitByDay(sampleNewsletter);
check('splitByDay finds 2 day sections', sections.length === 2);
check('splitByDay first section is Friday', /FRIDAY/.test(sections[0].day));
check('splitByDay second section is Saturday', /SATURDAY/.test(sections[1].day));
check('splitByDay sections have content', sections[0].content.length >= 100);

// Test that cache file exists (it should from previous scrapes)
const cacheExists = fs.existsSync(CACHE_FILE);
check('nonsense cache file exists on disk', cacheExists);
if (cacheExists) {
  const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  check('cached data has id field', typeof cached.id === 'string');
  check('cached data has events array', Array.isArray(cached.events));
}
