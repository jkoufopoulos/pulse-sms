# Sofar Sounds Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Sofar Sounds as a dedicated source by scraping DoNYC's Sofar venue page, ensuring full coverage of ~24+ secret concerts/month across 15+ NYC neighborhoods.

**Architecture:** Cheerio HTML scraper fetching `donyc.com/venues/sofar-sounds-secret-location` (server-rendered), parsing event cards with the same CSS selectors DoNYC uses (`.ds-listing.event-card`), extracting neighborhood from event name ("Sofar Sounds - Meatpacking District" → "Meatpacking"), paginating up to 3 pages. Registered in source-registry.js with weight 0.8, `discovery` vibe.

**Tech Stack:** Cheerio (already a dependency), shared scraper utilities from `src/sources/shared.js`

---

### Task 1: Create the scraper module

**Files:**
- Create: `src/sources/sofarsounds.js`

**Step 1: Write the scraper**

```js
const cheerio = require('cheerio');
const { makeEventId, FETCH_HEADERS } = require('./shared');
const { resolveNeighborhood, getNycDateString } = require('../geo');

const VENUE_URL = 'https://donyc.com/venues/sofar-sounds-secret-location';
const MAX_PAGES = 3;

/**
 * Extract neighborhood from Sofar event name.
 * "Sofar Sounds - Meatpacking District" → "Meatpacking District"
 * "Sofar Sounds - Lower Manhattan" → "Lower Manhattan"
 */
function extractNeighborhood(name) {
  const m = name.match(/^Sofar Sounds\s*[-–—]\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseCards($, cards) {
  const today = getNycDateString(0);
  const maxDate = getNycDateString(14); // 2-week window for Sofar (they list further out)
  const parsed = [];

  cards.each((_, el) => {
    const card = $(el);
    const name = card.find('.ds-listing-event-title-text').text().trim();
    if (!name) return;

    const eventPath = card.find('a[itemprop="url"]').attr('href');
    const sourceUrl = eventPath ? `https://donyc.com${eventPath}` : null;

    // Date from schema startDate
    const startDate = card.find('meta[itemprop="startDate"]').attr('content') || null;
    let dateLocal = null;
    if (startDate) {
      const dm = startDate.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dm) dateLocal = dm[1];
    }
    if (!dateLocal) return;
    if (dateLocal < today || dateLocal > maxDate) return;

    // Neighborhood from event name
    const hoodName = extractNeighborhood(name);
    const neighborhood = hoodName ? resolveNeighborhood(hoodName, null, null) : null;

    // Price
    const cardText = card.text();
    const isFree = /\bfree\b/i.test(cardText);
    let priceDisplay = isFree ? 'free' : null;
    if (!isFree) {
      const rangeMatch = cardText.match(/\$(\d+(?:\.\d{2})?)\s*[-–]\s*\$?(\d+(?:\.\d{2})?)/);
      if (rangeMatch) {
        priceDisplay = `$${rangeMatch[1]}-$${rangeMatch[2]}`;
      } else {
        const priceMatch = cardText.match(/\$(\d+)/);
        if (priceMatch) priceDisplay = `$${priceMatch[1]}`;
      }
    }

    // Ticket URL — prefer sofarsounds.com affiliate link if present
    let ticketUrl = sourceUrl;
    const buyLink = card.find('a[href*="sofarsounds"]').attr('href') ||
                    card.find('a[href*="sofar"]').attr('href');
    if (buyLink) ticketUrl = buyLink;

    const id = makeEventId(name, 'Sofar Sounds', dateLocal, 'sofarsounds', sourceUrl, startDate);

    parsed.push({
      id,
      source_name: 'SofarSounds',
      source_type: 'venue',
      name,
      description_short: 'Intimate secret concert featuring 3 diverse acts at a surprise venue',
      short_detail: 'Intimate secret concert featuring 3 diverse acts at a surprise venue',
      venue_name: 'Sofar Sounds - Secret Location',
      venue_address: null,
      neighborhood,
      start_time_local: startDate || null,
      end_time_local: null,
      date_local: dateLocal,
      time_window: null,
      is_free: isFree,
      price_display: priceDisplay,
      category: 'live_music',
      subcategory: null,
      ticket_url: ticketUrl,
      source_url: sourceUrl,
      map_url: null,
      map_hint: hoodName || null,
    });
  });

  return parsed;
}

async function fetchSofarSoundsEvents() {
  console.log('Fetching Sofar Sounds...');
  try {
    const allEvents = [];
    const seen = new Set();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? VENUE_URL : `${VENUE_URL}?page=${page}`;
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        console.error(`SofarSounds: page ${page} failed (${res.status})`);
        break;
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      const cards = $('.ds-listing.event-card');

      if (cards.length === 0) break;

      for (const evt of parseCards($, cards)) {
        if (seen.has(evt.id)) continue;
        seen.add(evt.id);
        allEvents.push(evt);
      }

      // Check for next page link
      const hasNext = $('a[href*="page="]').filter((_, a) =>
        /next\s*page/i.test($(a).text())
      ).length > 0;
      if (!hasNext) break;
    }

    console.log(`SofarSounds: ${allEvents.length} events`);
    return allEvents;
  } catch (err) {
    console.error('SofarSounds error:', err.message);
    return [];
  }
}

module.exports = { fetchSofarSoundsEvents, extractNeighborhood };
```

**Step 2: Verify scraper runs**

Run: `node -e "require('./src/sources/sofarsounds').fetchSofarSoundsEvents().then(e => console.log(JSON.stringify(e.slice(0,2), null, 2)))"`
Expected: JSON array with Sofar events, each having `neighborhood` resolved

**Step 3: Commit**

```bash
git add src/sources/sofarsounds.js
git commit -m "feat: add Sofar Sounds scraper via DoNYC venue page"
```

---

### Task 2: Write unit tests for extractNeighborhood

**Files:**
- Modify: `test/unit/scrapers.test.js`

**Step 1: Add test cases**

Add to the end of `test/unit/scrapers.test.js`:

```js
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
```

**Step 2: Run tests**

Run: `npm test`
Expected: All new Sofar tests PASS

**Step 3: Commit**

```bash
git add test/unit/scrapers.test.js
git commit -m "test: add Sofar Sounds neighborhood extraction tests"
```

---

### Task 3: Register in source-registry.js and wire up exports

**Files:**
- Modify: `src/sources/index.js` — add import + export
- Modify: `src/source-registry.js` — add to SOURCES array, SOURCE_TIERS
- Modify: `src/events.js` — add to SOURCE_VIBE map

**Step 1: Add to `src/sources/index.js`**

Add import:
```js
const { fetchSofarSoundsEvents } = require('./sofarsounds');
```

Add to `module.exports`:
```js
fetchSofarSoundsEvents,
```

**Step 2: Add to `src/source-registry.js`**

Add to the import at the top:
```js
fetchSofarSoundsEvents
```

Add to SOURCE_TIERS:
```js
SofarSounds: 'secondary',
```

Add to SOURCES array (after BKMag entry):
```js
{ label: 'SofarSounds', fetch: fetchSofarSoundsEvents, weight: 0.8, mergeRank: 4, endpoint: 'https://donyc.com/venues/sofar-sounds-secret-location' },
```

**Step 3: Add to SOURCE_VIBE in `src/events.js`**

Add `'SofarSounds': 'discovery'` to the discovery tier line:
```js
'theskint': 'discovery', 'nonsensenyc': 'discovery',
'brooklynvegan': 'discovery', 'ScreenSlate': 'discovery', 'bkmag': 'discovery',
'yutori': 'discovery', 'SofarSounds': 'discovery',
```

**Step 4: Verify boot + tests pass**

Run: `npm test`
Expected: All tests pass, no import errors

**Step 5: Commit**

```bash
git add src/sources/index.js src/source-registry.js src/events.js
git commit -m "feat: register SofarSounds in source-registry, events vibe map"
```

---

### Task 4: Smoke test full scrape

**Step 1: Run the server with test mode and verify Sofar events appear**

Run: `PULSE_TEST_MODE=true node -e "
const { refreshSources } = require('./src/events');
refreshSources().then(events => {
  const sofar = events.filter(e => e.source_name === 'SofarSounds');
  console.log('SofarSounds events:', sofar.length);
  sofar.slice(0, 3).forEach(e => console.log(JSON.stringify({name: e.name, neighborhood: e.neighborhood, price: e.price_display, date: e.date_local})));
  process.exit(0);
});
"`

Expected: 10+ SofarSounds events with neighborhoods resolved

**Step 2: Verify dedup with DoNYC**

Check that Sofar events from DoNYC are deduped (SofarSounds weight 0.8 > DoNYC 0.75 means SofarSounds wins):
```bash
node -e "
const { refreshSources } = require('./src/events');
refreshSources().then(events => {
  const sofar = events.filter(e => /sofar/i.test(e.name));
  const bySource = {};
  sofar.forEach(e => { bySource[e.source_name] = (bySource[e.source_name]||0) + 1; });
  console.log('Sofar events by source:', bySource);
  process.exit(0);
});
"
```

Expected: Most/all Sofar events attributed to `SofarSounds` (not `donyc`)

**Step 3: Run unit tests one final time**

Run: `npm test`
Expected: All pass

---

### Task 5: Update CLAUDE.md and MEMORY.md

**Files:**
- Modify: `CLAUDE.md` — update source count (22→23 entries, 20→21 modules) in architecture diagram and module table
- Modify: `~/.claude/projects/-Users-justinkoufopoulos-Projects-pulse-sms/memory/MEMORY.md` — add Sofar Sounds entry to Source Changes section

**Step 1: Update CLAUDE.md**

Update the architecture diagram source count line and the source-registry description.

**Step 2: Update MEMORY.md**

Add entry to Source Changes section:
```
- **Sofar Sounds added** (2026-03-03): Cheerio HTML scraper (`src/sources/sofarsounds.js`). Scrapes DoNYC's Sofar venue page (`donyc.com/venues/sofar-sounds-secret-location`). ~24+ events/month across 15+ NYC neighborhoods. Secret concerts — venue revealed 24h before, 3 diverse acts. $18 consistent price. Weight 0.8 (primary), vibe `discovery`. Neighborhood parsed from event name ("Sofar Sounds - Meatpacking District" → resolveNeighborhood). Dedupes with DoNYC (higher weight wins). Up to 3 pages paginated.
```

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Sofar Sounds to source documentation"
```
