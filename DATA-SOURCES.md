# Pulse Data Sources — Audit

> Comprehensive review of current data sources, coverage gaps, and quality issues.
> Last updated: 2026-02-16

---

## Current Sources (10 fetchers in daily scrape)

| Source | Weight | Extraction method | Geo quality | Category strength |
|--------|--------|-------------------|-------------|-------------------|
| The Skint | 0.9 | HTML → Claude extraction | Claude-inferred (inconsistent) | Free/cheap curated picks |
| Nonsense NYC | 0.9 | HTML → Claude extraction | Claude-inferred | Underground/DIY/weird |
| Resident Advisor | 0.85 | GraphQL API | Hardcoded venue map (~40 venues) | Electronic/dance/nightlife |
| Oh My Rockness | 0.85 | HTML → Claude (Haiku) | Claude-inferred | Indie/rock/punk |
| Dice | 0.8 | `__NEXT_DATA__` JSON parse | Lat/lng in data (reliable) | Ticketed shows, DJ sets |
| Songkick | 0.75 | JSON-LD parse | Lat/lng in JSON-LD (reliable) | Concerts/music |
| Eventbrite (main) | 0.7 | `__SERVER_DATA__` / JSON-LD | Lat/lng available (reliable) | Broad aggregator |
| Eventbrite Comedy | 0.7 | Same parser, comedy URL | Same | Comedy-specific slice |
| Eventbrite Arts | 0.7 | Same parser, arts URL | Same | Art-specific slice |
| Tavily Free | 0.6 | Web search → Claude extraction | Claude-inferred (lowest confidence) | Free events catch-all |

Plus **Tavily on-demand** (not in daily scrape) as a last-resort live fallback when cache is empty.

---

## Source Reliability

| Source | Fragility | Notes |
|--------|-----------|-------|
| RA | Low | GraphQL API is stable, but could block user-agent |
| Songkick | Low | Standard JSON-LD |
| Dice | Medium | `__NEXT_DATA__` could disappear if they change frameworks |
| Eventbrite | Medium | `__SERVER_DATA__` format already needed a JSON-LD fallback |
| The Skint | Medium | Depends on `.entry-content` CSS selector + paragraph regex pattern |
| Nonsense NYC | High | Very generic selectors (`.entry-content, .post-content, article`). Newsletter format may not match. Weekly publish cycle (Fridays) means stale mid-week. |
| Oh My Rockness | High | Shotgun CSS selectors (`article, .show, .event, .listing, .card`). No structured data. |
| Tavily | Medium | Web search quality is unpredictable; results often stale or off-topic |

**Health tracking exists** (`sourceHealth` with consecutive-zero warnings) **but has no alerting.** A source can silently die for days — the only signal is a console log after 3 consecutive zero-result scrapes.

---

## Geo Resolution: The Hidden Bottleneck

Events with `neighborhood: null` are effectively invisible. `rankEventsByProximity()` uses a 3km radius — events without a neighborhood can't be ranked and won't surface to users.

| Geo method | Sources using it | Quality |
|-----------|-----------------|---------|
| Lat/lng from source → nearest neighborhood | Dice, Songkick, Eventbrite | Reliable — always resolves |
| Hardcoded venue map (40 entries) | RA | Works for known venues. New/small venues → `null` |
| Claude-inferred from text | Skint, Nonsense NYC, Oh My Rockness, Tavily | Hit-or-miss. Claude often says "Brooklyn" (too vague) or guesses wrong neighborhood |

**Example of the problem:** The Skint mentions an event at Good Room (Greenpoint). Claude might tag it "Williamsburg" (the border is fuzzy). A user who texts "Greenpoint" never sees it.

**The fix is infrastructural, not per-source.** A shared venue → coordinates lookup (expanding the existing `RA_VENUE_MAP` from 40 to ~200+ venues) would fix geo resolution across all Claude-extracted sources at once. Every source mentioning a known venue name would get correct geo automatically.

---

## Category Coverage

| Category | Sources covering it | Depth | Notes |
|----------|-------------------|-------|-------|
| Electronic/dance/nightlife | RA, Dice | **Strong** | Well-covered |
| Indie/rock/punk | Oh My Rockness, Songkick, Dice | Decent | OMR scraper fragility is a risk |
| Comedy | Eventbrite Comedy, Skint (sometimes) | Moderate | No dedicated comedy source — Comedy Cellar, UCB, Caveat, etc. all missing |
| Art/galleries | Eventbrite Arts, Skint (sometimes) | **Weak** | No gallery opening calendar |
| Free/cheap | Skint, Tavily Free | Moderate | Skint is great but capped at 12 paragraphs. BrooklynVegan `/freeshows` is purpose-built and we don't have it |
| Underground/DIY/weird | Nonsense NYC | **Single source** | If it breaks, this entire vibe is gone |
| Theater/performance | Eventbrite (incidental) | **Very weak** | Nothing dedicated |
| Parks/outdoor/free city | **Nothing** | **Zero** | NYC Open Data API is free, clean JSON, every event has a location |
| Late-night (after midnight) | RA, Dice | Decent for electronic | Nothing for late-night non-electronic |
| "Always-good spots" | **Nothing** | **Zero** | No knowledge of what's reliably good at a given venue/neighborhood on a given night |

---

## Neighborhood Coverage

### Defined neighborhoods (35 total)

- **Manhattan below 96th:** 17 neighborhoods (well-defined)
- **Brooklyn (north/west):** 14 neighborhoods
- **Queens:** 4 (Astoria, LIC, Jackson Heights, Flushing)
- **Bronx:** 0
- **Staten Island:** 0
- **South Brooklyn:** Only Sunset Park — no Bay Ridge, Bensonhurst, Brighton Beach
- **Upper Manhattan:** Only Washington Heights/Inwood — no Morningside Heights, Hamilton Heights

### Missing neighborhoods

- **Brooklyn Heights** — not in the system at all. "Brooklyn Heights" → no match → "What neighborhood?"
- **Bay Ridge, Bensonhurst, Brighton Beach** — zero coverage
- **Morningside Heights, Hamilton Heights** — zero coverage
- **South Bronx / Mott Haven** — growing scene, zero coverage

### Friend-group neighborhood analysis

The user's social circle clusters around: **Greenpoint, Bed-Stuy, UWS, West Village, Cobble Hill/Brooklyn Heights.**

| Neighborhood | Est. daily events in cache | What's actually happening | Why we're thin |
|-------------|---------------------------|--------------------------|----------------|
| **Greenpoint** | 1-3 | 10+ | RA venue map has zero GP venues. Skint/Nonsense rarely mention it by name. Good Room sometimes appears but may geo-resolve to Williamsburg. |
| **Bed-Stuy** | 0-2 | 8+ | Venues exist (Ode to Babel, Pearl's Social, Lovers Rock) but don't appear in any aggregator. No sources specifically cover Bed-Stuy. |
| **UWS** | 0-2 | 10+ | RA has zero UWS venues. Skint/Nonsense rarely cover above 59th St. Lincoln Center, Beacon Theatre, Symphony Space, Smoke Jazz — all missing. |
| **West Village** | 3-6 | 15+ | Better covered than most but small venues (jazz clubs, comedy spots, intimate bars) fall through cracks. Comedy Cellar, Village Vanguard, Le Poisson Rouge underrepresented. |
| **Cobble Hill/BK Heights** | 0-1 | 5+ | BK Heights not even in the neighborhood list. Cobble Hill defined but almost nothing resolves there. Nearby Fort Greene/Downtown Brooklyn might catch a few. |

**The neighborhoods where the actual users live are the worst-covered neighborhoods.** The system is strongest for Williamsburg, East Village, LES, and Bushwick — classic nightlife hubs, but not where the friend group is on a weeknight.

For comparison, well-covered neighborhoods:

| Neighborhood | Est. daily events in cache | Why |
|-------------|---------------------------|-----|
| East Village | 8-15 | High venue density, multiple sources cover it |
| Williamsburg | 8-12 | RA venue map is Williamsburg-heavy, Dice/Songkick too |
| LES | 5-10 | Similar to EV |
| Bushwick | 5-8 | RA venues + DIY scene covered by Nonsense |

---

## Cross-Source Dedup

`makeEventId()` hashes `name + venue + date + source`. The `source` component means the same event appearing on both Dice and Songkick gets two separate cache entries. No cross-source fuzzy dedup exists.

This isn't critical yet (users see curated picks, not raw lists) but will matter as we add more sources.

---

## Next Sources to Add

### Priority 1 — High impact, low effort

**NYC Parks Events API** (weight: 0.75)
- Socrata REST API: `GET /resource/w3wp-dpdi.json?$where=start_date_time > '{date}'`
- Clean JSON, no scraping, every event has a park name (geolocatable)
- Fills the parks/outdoor/free gap completely
- All events are free
- Effort: Very low

**BrooklynVegan NYC Shows** (weight: 0.8)
- `https://nyc-shows.brooklynvegan.com/` (all) + `/freeshows` (free)
- Structured calendar, deterministic parsing likely possible
- Free shows page gives high-confidence `is_free: true` data
- Effort: Low

### Priority 2 — High impact, moderate effort

**DoNYC** (weight: 0.7)
- `https://donyc.com/`
- Aggregates museums, theater, comedy, institutional events
- One scraper replaces 5+ individual institution scrapers
- Effort: Medium — need to identify page structure

**Expanded venue lookup** (infrastructure, not a source)
- Extract `RA_VENUE_MAP` into shared lookup, grow from 40 → 200+ venues
- Seed with key venues in thin neighborhoods (Greenpoint, Bed-Stuy, UWS, West Village, Cobble Hill)
- Use in `normalizeExtractedEvent()` for all Claude-extracted sources
- Effort: Medium (initial manual seeding, then auto-grow)

### Priority 3 — Targeted gap-filling

**Venue calendar scraping** (selected venues, especially in thin neighborhoods)
- Greenpoint: Good Room, Warsaw, Greenpoint Terminal
- Bed-Stuy: Ode to Babel, Pearl's Social & Billy Club, Lovers Rock, Sistas' Place
- UWS: Beacon Theatre, Symphony Space, Smoke Jazz, Jazz at Lincoln Center
- West Village: Comedy Cellar, Village Vanguard, Le Poisson Rouge, Smalls Jazz
- Cobble Hill area: Jalopy Theatre, Roulette (Downtown BK)
- Effort: High per venue, but many have structured calendar pages

**NYPL / Brooklyn Public Library events** (weight: 0.7)
- Free, community-oriented, spread across all neighborhoods including thin ones
- NYPL has an events API

### Not building

- **Happy hours / venue busyness / bar discovery** — different product
- **Yelp/Foursquare venue DB** — venue discovery != event discovery
- **X/Twitter** — expensive API, poor geo, ToS risk
- **Email inbox ingestion** — operationally complex
- **Per-museum scrapers** — DoNYC aggregates these
- **Time Out NY** — aggressive anti-bot, DoNYC covers similar
- **Gothamist/Hyperallergic/Eater** — news sites, not event calendars
- **Scraping frequency > 1x/day** — SMS users don't need real-time. 10am ET daily is right.
- **General web crawling** — whitelist sources only
