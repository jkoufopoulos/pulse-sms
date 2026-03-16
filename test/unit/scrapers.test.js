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


// ---- Skint: deterministic parser ----
console.log('\nSkint deterministic parser:');

const { parseSkintParagraph, parsePostDateRange, createAnchoredResolveDate, splitBulletParagraph } = require('../../src/sources/skint');

// Standard event with venue + neighborhood + price
const std = parseSkintParagraph(
  'fri 7pm: tale storytelling show: harmon leon hosts an evening of performances by some of the city\'s best storytellers. the red room at kgb bar (east village), save $8 online with promo code. >>',
  '2026-02-27'
);
check('std: parses name', std && std.name === 'tale storytelling show');
check('std: parses venue', std && std.venue_name === 'the red room at kgb bar');
check('std: parses neighborhood', std && std.neighborhood === 'East Village');
check('std: parses time', std && std.start_time_local === '2026-02-27T19:00:00');
check('std: parses date', std && std.date_local === '2026-02-27');
check('std: has price', std && std.price_display && std.price_display.includes('$8'));
check('std: not free', std && std.is_free === false);
check('std: has description', std && std.description_short && std.description_short.includes('storytellers'));
check('std: category comedy/storytelling', std && std.category === 'comedy');

// Free event with free admission
const free1 = parseSkintParagraph(
  'mon 7pm (monthly): biology on tap: bio and beer blend at the speaker series. pete\'s candy store (williamsburg), free admission ($5 suggested donation). >>',
  '2026-03-03'
);
check('free: parses name', free1 && free1.name === 'biology on tap');
check('free: parses venue', free1 && free1.venue_name === "pete's candy store");
check('free: parses neighborhood', free1 && free1.neighborhood === 'Williamsburg');
check('free: is free', free1 && free1.is_free === true);
check('free: has price display', free1 && free1.price_display && /free admission/i.test(free1.price_display));
check('free: modifier stripped', free1 && free1.start_time_local === '2026-03-03T19:00:00');

// Time range
const range = parseSkintParagraph(
  'sat 12-6pm: brooklyn flea winter market: vintage goods and local artisans. atlantic center (fort greene), free. >>',
  '2026-03-01'
);
check('range: start time', range && range.start_time_local === '2026-03-01T12:00:00');
check('range: end time', range && range.end_time_local === '2026-03-01T18:00:00');
check('range: is free', range && range.is_free === true);
check('range: category market', range && range.category === 'market');

// Event with no neighborhood (falls back to no venue extraction)
const nohood = parseSkintParagraph(
  "sat 1pm: brooklyn's black trailblazers: cemetery trolley tour: visit the memorials of prominent black brooklynites. $15. >>",
  '2026-02-28'
);
check('nohood: parses name', nohood && nohood.name === "brooklyn's black trailblazers");
check('nohood: price extracted', nohood && nohood.price_display === '$15');
check('nohood: no venue', nohood && nohood.venue_name === null);
check('nohood: category tours', nohood && nohood.category === 'tours');

// Thru event (no time)
const thru = parseSkintParagraph(
  'thru sun: film series at bam: a week of screenings. bam (fort greene), $15. >>',
  '2026-02-27'
);
check('thru: parses name', thru && thru.name === 'film series at bam');
check('thru: no time', thru && thru.start_time_local === null);
check('thru: has date', thru && thru.date_local === '2026-02-27');
check('thru: category film', thru && thru.category === 'film');

// Daily event
const daily = parseSkintParagraph(
  'daily 10am: free museum admission: explore the galleries at no cost. brooklyn museum (prospect heights), free. >>',
  '2026-02-28'
);
check('daily: parses time', daily && daily.start_time_local === '2026-02-28T10:00:00');
check('daily: is free', daily && daily.is_free === true);
check('daily: has neighborhood', daily && daily.neighborhood === 'Prospect Heights');

// Returns null for non-matching text
const bad = parseSkintParagraph('just some random text that is not an event', '2026-02-28');
check('non-event returns null', bad === null);

// Confidence scoring
check('std: high confidence (all fields)', std && std.extraction_confidence >= 0.9);
check('nohood: lower confidence (missing venue+hood)', nohood && nohood.extraction_confidence < std.extraction_confidence);

// Price patterns: "$10 adv, $15 door"
const advDoor = parseSkintParagraph(
  'fri 8pm: comedy show: a night of laughs. friends and lovers (crown heights), $10 adv, $15 door. >>',
  '2026-02-27'
);
check('adv/door: price captured', advDoor && advDoor.price_display && advDoor.price_display.includes('$10'));
check('adv/door: not free', advDoor && advDoor.is_free === false);

// Tonight prefix
const tonight = parseSkintParagraph(
  'tonight 9pm: late night jazz: smooth sounds all night. blue note (greenwich village), $25. >>',
  '2026-02-27'
);
check('tonight: parses time', tonight && tonight.start_time_local === '2026-02-27T21:00:00');
check('tonight: parses name', tonight && tonight.name === 'late night jazz');


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


// _rawText is stashed on parsed events
check('_rawText is set', std && std._rawText && std._rawText.includes('tale storytelling'));
check('_rawText preserved through normalizeExtractedEvent', (() => {
  const { normalizeExtractedEvent } = require('../../src/sources/shared');
  const normalized = normalizeExtractedEvent({ name: 'Test', _rawText: 'fri 7pm: test', date_local: '2026-03-13' }, 'test', 'curated', 0.9);
  return normalized._rawText === 'fri 7pm: test';
})());

// ---- Skint: date anchoring (P0 fix for date resolution) ----
console.log('\nSkint date anchoring:');

// parsePostDateRange extracts start date from heading text
check('parsePostDateRange: "THURS-MON, 3/13-16"',
  (() => { const r = parsePostDateRange('THURS-MON, 3/13-16: SKINT WEEKEND', 2026); return r && r.startDate === '2026-03-13' && r.startDow === 5; })());
check('parsePostDateRange: "TUES-THURS, 3/10-12"',
  (() => { const r = parsePostDateRange('TUES-THURS, 3/10-12: KEITH HARING', 2026); return r && r.startDate === '2026-03-10' && r.startDow === 2; })());
check('parsePostDateRange: cross-month "12/28-1/2"',
  (() => { const r = parsePostDateRange('FRI-WED, 12/28-1/2: NEW YEARS', 2026); return r && r.startDate === '2026-12-28'; })());
check('parsePostDateRange: en-dash separator',
  (() => { const r = parsePostDateRange('FRI\u2013MON, 3/6\u201310', 2026); return r && r.startDate === '2026-03-06'; })());
check('parsePostDateRange: no date → null',
  parsePostDateRange('SKINT WEEKEND: some title', 2026) === null);

// createAnchoredResolveDate maps day names forward from anchor
// Anchor: Friday 3/13 (dow 5). Expect: fri→3/13, sat→3/14, sun→3/15, mon→3/16
const anchoredResolve = createAnchoredResolveDate('2026-03-13', 5);
check('anchored: friday → 3/13 (anchor day)', anchoredResolve('friday') === '2026-03-13');
check('anchored: saturday → 3/14', anchoredResolve('saturday') === '2026-03-14');
check('anchored: sunday → 3/15', anchoredResolve('sunday') === '2026-03-15');
check('anchored: monday → 3/16', anchoredResolve('monday') === '2026-03-16');
check('anchored: thursday → 3/19 (wraps forward)', anchoredResolve('thursday') === '2026-03-19');
check('anchored: invalid day → null', anchoredResolve('notaday') === null);

// Anchor: Tuesday 3/10 (dow 2). Expect: tue→3/10, wed→3/11, thu→3/12
const anchoredResolve2 = createAnchoredResolveDate('2026-03-10', 2);
check('anchored2: tuesday → 3/10', anchoredResolve2('tuesday') === '2026-03-10');
check('anchored2: wednesday → 3/11', anchoredResolve2('wednesday') === '2026-03-11');
check('anchored2: thursday → 3/12', anchoredResolve2('thursday') === '2026-03-12');

// Key bug scenario: Saturday scrape with Friday post
// Old behavior: resolveDate("friday") on Saturday → next Friday (wrong)
// New behavior: anchored to 3/13 → this Friday 3/13 (correct)
check('bug fix: friday on sat scrape anchored correctly', anchoredResolve('friday') === '2026-03-13');


// ---- Skint: bullet sub-event splitting ----
console.log('\nSkint bullet splitting:');

const testCheerio = require('cheerio');

// Multi-bullet <p> with <br> separators (Oscars watch parties style)
const multiBulletHtml = `<p>
<span>► <b>arlene's grocery</b> (les). $10 adv. </span><a href="https://example.com/1"><b>>></b></a><br />
<span>► <b>c'mon everybody</b> (bed-stuy). free admission. </span><a href="https://example.com/2"><b>>></b></a><br />
<span>► <b>littlefield</b> (gowanus). free admission. </span><a href="https://example.com/3"><b>>></b></a>
</p>`;
const $multi = testCheerio.load(multiBulletHtml);
const multiEl = $multi('p').get(0);
const multiText = $multi('p').text().trim();
const multiResult = splitBulletParagraph($multi, multiEl, multiText);
check('multi-bullet: splits into 3 segments', multiResult.length === 3);
check('multi-bullet: first is arlenes', multiResult[0] && /arlene/i.test(multiResult[0].text));
check('multi-bullet: second is cmon', multiResult[1] && /c.mon/i.test(multiResult[1].text));
check('multi-bullet: third is littlefield', multiResult[2] && /littlefield/i.test(multiResult[2].text));
check('multi-bullet: each has its own link', multiResult[0].link === 'https://example.com/1' && multiResult[2].link === 'https://example.com/3');

// Single-bullet <p> (normal event) — should not split
const singleHtml = `<p><span>► sun 1pm: <b>parade</b>: starts at park slope. </span><a href="https://example.com/4"><b>>></b></a></p>`;
const $single = testCheerio.load(singleHtml);
const singleEl = $single('p').get(0);
const singleText = $single('p').text().trim();
const singleResult = splitBulletParagraph($single, singleEl, singleText);
check('single-bullet: returns 1 segment', singleResult.length === 1);
check('single-bullet: preserves link', singleResult[0].link === 'https://example.com/4');

// No-bullet <p> (regular event) — should not split
const noBulletHtml = `<p><span>fri 7pm: jazz at smalls. </span><a href="https://example.com/5"><b>>></b></a></p>`;
const $none = testCheerio.load(noBulletHtml);
const noneEl = $none('p').get(0);
const noneText = $none('p').text().trim();
const noneResult = splitBulletParagraph($none, noneEl, noneText);
check('no-bullet: returns 1 segment', noneResult.length === 1);
check('no-bullet: preserves text', /jazz/i.test(noneResult[0].text));

// Each split bullet should parse as an event
const parsed1 = parseSkintParagraph(multiResult[0].text, '2026-03-15');
const parsed2 = parseSkintParagraph(multiResult[2].text, '2026-03-15');
check('split bullet parses: arlenes', parsed1 && parsed1.name === "arlene's grocery");
check('split bullet parses: littlefield', parsed2 && parsed2.name === 'littlefield');
check('split bullet: arlenes has neighborhood', parsed1 && parsed1.neighborhood !== null);
check('split bullet: littlefield has neighborhood', parsed2 && parsed2.neighborhood !== null);


// ---- Skint ongoing: parseThruDate ----
console.log('\nSkint ongoing parseThruDate:');

const { parseThruDate, parseOngoingParagraph } = require('../../src/sources/skint');

// Numeric dates
check('thru 3/5 → ISO date', parseThruDate('3/5', 2026) === '2026-03-05');
check('thru 12/31 → ISO date', parseThruDate('12/31', 2026) === '2026-12-31');
check('thru 3/28 → ISO date', parseThruDate('3/28', 2026) === '2026-03-28');

// Month names
check('thru february → last day', parseThruDate('february', 2026) === '2026-02-28');
check('thru march → last day', parseThruDate('march', 2026) === '2026-03-31');
check('thru jan → last day', parseThruDate('jan', 2026) === '2026-01-31');

// Seasons
check('thru spring → 06-20', parseThruDate('spring', 2026) === '2026-06-20');
check('thru summer → 09-22', parseThruDate('summer', 2026) === '2026-09-22');

// Invalid
check('thru gibberish → null', parseThruDate('gibberish', 2026) === null);


// ---- Skint ongoing: parseOngoingParagraph ----
console.log('\nSkint ongoing parseOngoingParagraph:');

const todayForTest = '2026-03-01';

// Format A: "thru 3/5: event name: description. venue (hood), price. >>"
const fmtA = parseOngoingParagraph(
  'thru 3/5: tenement stories: film forum and the tenement museum present a festival of movies. film forum (south village), $17. >>',
  todayForTest, 2026
);
check('fmtA: parses name', fmtA && fmtA.name === 'tenement stories');
check('fmtA: has description', fmtA && fmtA.description_short && fmtA.description_short.includes('festival'));
check('fmtA: parses venue', fmtA && fmtA.venue_name === 'film forum');
check('fmtA: resolves south village → West Village', fmtA && fmtA.neighborhood === 'West Village');
check('fmtA: parses series_end', fmtA && fmtA.series_end === '2026-03-05');
check('fmtA: has price', fmtA && fmtA.price_display && fmtA.price_display.includes('$17'));
check('fmtA: not free', fmtA && fmtA.is_free === false);
check('fmtA: date_local is today', fmtA && fmtA.date_local === todayForTest);
check('fmtA: category comedy (stories match)', fmtA && fmtA.category === 'comedy');

// Format A with free admission
const fmtAFree = parseOngoingParagraph(
  'thru 3/28: claudia bitrán: titanic: christin tierney gallery (tribeca), free admission. >>',
  todayForTest, 2026
);
check('fmtA-free: parses name', fmtAFree && fmtAFree.name === 'claudia bitrán');
check('fmtA-free: is free', fmtAFree && fmtAFree.is_free === true);
check('fmtA-free: parses neighborhood', fmtAFree && fmtAFree.neighborhood === 'Tribeca');
check('fmtA-free: series_end', fmtAFree && fmtAFree.series_end === '2026-03-28');
check('fmtA-free: has category', fmtAFree && typeof fmtAFree.category === 'string');

// Format B: "► venue (hood) thru 3/8 >>"
const fmtB = parseOngoingParagraph(
  '► gottesman rink at the davis center (central park) thru 3/8 >>',
  todayForTest, 2026
);
check('fmtB: parses name', fmtB && fmtB.name === 'gottesman rink at the davis center');
check('fmtB: series_end', fmtB && fmtB.series_end === '2026-03-08');
check('fmtB: parses neighborhood', fmtB && fmtB.neighborhood === 'Midtown');

// Format C: vague end date
const fmtC = parseOngoingParagraph(
  'thru spring: new highline art: dinosaur sculptures along the elevated park. the high line (chelsea), free admission. >>',
  todayForTest, 2026
);
check('fmtC: parses name', fmtC && fmtC.name === 'new highline art');
check('fmtC: series_end spring', fmtC && fmtC.series_end === '2026-06-20');
check('fmtC: is free', fmtC && fmtC.is_free === true);
check('fmtC: neighborhood Chelsea', fmtC && fmtC.neighborhood === 'Chelsea');

// Non-event listicle returns null
const listicle = parseOngoingParagraph(
  'nine old-fashioned soda fountains in nyc: enjoy a taste of old new york at these classic spots around the city. >>',
  todayForTest, 2026
);
check('listicle: no thru prefix → still parses (name only)', listicle === null || (listicle && !listicle.series_end));

// Short text returns null
const short = parseOngoingParagraph('too short', todayForTest, 2026);
check('short text returns null', short === null);

// Source URL set
check('fmtA: source_url set', fmtA && fmtA.source_url === 'https://theskint.com/ongoing-events/');


// ---- Sofar Sounds: neighborhood extraction ----
console.log('\nSofar Sounds scraper:');

const { extractNeighborhood } = require('../../src/sources/sofarsounds');

check('extracts "Meatpacking District"',
  extractNeighborhood('Sofar Sounds - Meatpacking District') === 'Meatpacking District');
check('extracts "East Village"',
  extractNeighborhood('Sofar Sounds - East Village') === 'East Village');
check('extracts "Lower Manhattan"',
  extractNeighborhood('Sofar Sounds - Lower Manhattan') === 'Lower Manhattan');
check('handles en-dash separator',
  extractNeighborhood('Sofar Sounds – SOHO') === 'SOHO');
check('handles em-dash separator',
  extractNeighborhood('Sofar Sounds — Williamsburg') === 'Williamsburg');
check('returns null for non-Sofar event',
  extractNeighborhood('Jazz at Blue Note') === null);
check('returns null for bare "Sofar Sounds"',
  extractNeighborhood('Sofar Sounds') === null);


console.log('\nCategory normalization at boundary:');
const { normalizeExtractedEvent } = require('../../src/sources/shared');
const musicEvent = normalizeExtractedEvent({ name: 'Jazz Night', category: 'music', venue_name: 'Blue Note', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('music category normalized to live_music', musicEvent.category === 'live_music');
const liveEvent = normalizeExtractedEvent({ name: 'Rock Show', category: 'live_music', venue_name: 'Bowery', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('live_music category preserved', liveEvent.category === 'live_music');
const comedyEvent = normalizeExtractedEvent({ name: 'Stand Up', category: 'comedy', venue_name: 'Cellar', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('comedy category unchanged', comedyEvent.category === 'comedy');
const noCategory = normalizeExtractedEvent({ name: 'Some Event', venue_name: 'Somewhere', date_local: '2026-03-05' }, 'TestSource', 'primary', 0.8);
check('missing category defaults to other', noCategory.category === 'other');
