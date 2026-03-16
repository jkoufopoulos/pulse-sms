# Skint Scraper Audit — 2026-03-15

## Context

Skint daily scraper returned 0 events for 4 consecutive scrapes (Mar 12-14). Investigated root causes and compared deterministic parser output against LLM extraction of the same page content.

## Root Cause: `.entry-content').first()` hits promo posts

The Skint homepage has multiple `.entry-content` blocks. When the latest post is a sponsored promo (e.g., "Selected Shorts" ad on 3/15), `.first()` grabs that block — which has no day headers and no event paragraphs — returning 0 events. The actual event listings are in subsequent blocks.

**Fix applied:** Skip `.entry-content` blocks that don't contain day headers (friday, saturday, etc.). This correctly identified 2 event blocks and 1 promo block on 3/15, yielding 59 events.

## LLM vs Scraper Comparison

Ran deterministic parser and LLM (Claude Sonnet) on the same page content side-by-side.

| Metric | Scraper | LLM |
|--------|---------|-----|
| Total events | 59 | 78 |
| Matched pairs | 37 | 37 |
| Perfect match | 1 | - |
| With differences | 36 | - |
| Only in one | 22 | 41 |

### Diff Breakdown (of 37 matched events)

| Field | Wrong | Examples |
|-------|-------|----------|
| Date | 31 | "friday" resolved to 3/20 instead of 3/13 (scraper resolves relative to today, not post date) |
| Venue | 21 | TBA or full description instead of venue name ("this women-produced comedy show..." instead of "Halyards") |
| Neighborhood | 17 | Missing when venue parse fails |
| Category | 17 | "socially relevant film festival" → comedy, "scientific controversies" → food |
| Free/paid | 6 | "pay-what-you-can" and "free admission (rsvp)" not detected as free |

### Events the scraper missed entirely (LLM captured)

1. **Brooklyn Flea** — `sat thru december (weekends 10am-5pm)` format not matched by event pattern regex
2. **15 individual Oscars watch parties** — bullet format `► venue (hood). price. >>` collapsed into single mega-event
3. **Free Krispy Kreme** — `► mon-tues:` bullet with no venue
4. **Smash Bash** — `sat 9pm doors:` "doors" suffix not parsed
5. **Brooklyn Seltzer Fest** — `sun 11am-2pm, 2pm-6pm:` dual time range
6. **Infinite Good Times Movie Club** — `sun 3pm doors:` same doors issue
7. Events from Tues-Thurs post that matched by name but had truncated names in scraper

### Events the scraper captured but LLM missed

Some scraper events had names too different from LLM names to match (e.g., `union pool's fouth annual free tuesdays` vs `Union Pool's Fourth Annual Free Tuesdays`). These are name normalization mismatches, not actual misses.

## Systemic Issues (ranked by impact)

### 1. Date resolution resolves relative to today, not post date (31 events wrong)

`getNycDayContext().resolveDate("friday")` computes day offset from today. On Saturday 3/15, "friday" = 3/20 (next week). But the post header says "THURS-MON, 3/13-16" — events labeled "friday" mean 3/13.

**Root cause:** The scraper ignores the post date range header entirely. The `resolveDate` function has a `-3 day` wraparound heuristic but it's not enough — Friday is only 1 day behind Saturday, so it wraps forward.

**Fix needed:** Parse the post date range header ("THURS-MON, 3/13-16") and use it to anchor date resolution, OR adjust the wraparound heuristic so day names in the immediate past resolve correctly.

### 2. Venue extraction fails on many paragraph formats (21 events wrong)

The parser expects `description. venue (neighborhood), price.` but many Skint paragraphs don't follow this cleanly:
- When there's no clear sentence break before the venue, the parser grabs everything from the last sentence break
- When venue name is embedded in a longer clause, it captures the whole clause
- Some venues have no `(neighborhood)` paren at all, so the entire venue extraction chain fails

### 3. Bullet sub-events not split (15+ events lost)

The `► venue (hood). price. >>` format under a group header (like "15 academy awards watch parties") should produce one event per bullet. Currently they concatenate into one giant event.

### 4. Category regex patterns too narrow (17 events wrong)

The `CATEGORY_PATTERNS` array misses obvious cases and has false positives:
- "film festival" containing "social" → comedy (via "storytelling" pattern)
- "quantum physics" discussion → food (via "tasting" false positive? or misparse)
- "pop quiz" at a cinema → film instead of trivia

### 5. Free/paid detection gaps (6 events wrong)

"pay-what-you-can", "free admission (rsvp)", "free rsvp (required)" not detected as free.

## Recommendations

1. **Fix date resolution** (P0) — ✅ done: `parsePostDateRange` + `createAnchoredResolveDate` parse `<h2>` date range and anchor day names to post start date
2. **Fix `.first()` promo skip** (P0) — done in this session
3. **Split bullet sub-events** (P1) — ✅ done: `splitBulletParagraph` splits multi-bullet `<p>` tags by `<br>`, and `parseSkintParagraph` handles venue-only bullet format
4. **Improve venue extraction** (P2) — ✅ done: `refineVenue` trims over-long venues by comma/"at" boundaries. Remaining no-paren cases deferred to LLM enrichment
5. **Expand category patterns** (P2) — ✅ done: trivia before film, "tasting" narrowed, "cinema" removed from film pattern
6. **Expand free detection** (P3) — ✅ done: `isFreePrice` helper catches pay-what-you-can, pwyc, donation-based, suggested donation, free rsvp, free admission (rsvp)
