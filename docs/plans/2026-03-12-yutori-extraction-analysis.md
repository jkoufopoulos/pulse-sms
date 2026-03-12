# Yutori Extraction Analysis — 2026-03-12

## Problem

Yutori is our highest-volume email source (439 events in cache, 1560 pre-dedup), but extraction quality is poor. A spot check of 10 events from a recent Yutori Scout email found **zero** in our cache.

## Current Pipeline

1. **Gmail fetch** — `fetchYutoriEmails(48)` pulls emails from `notifications@yutori.com` with 48-hour lookback
2. **Email filter** — `isEventEmail()` skips non-event categories (fintech, sports, streaming, etc.)
3. **Preprocessing** — `preprocessYutoriHtml()` strips email chrome, decodes tracking URLs, converts `<li>` items to `[Event]` markers
4. **Deterministic parser** — `parseNonTriviaEvents()` tries to extract from `[Event]` lines
5. **LLM fallback** — if deterministic captures <40% of `[Event]` lines, sends to Haiku

## Three Problems Found

### 1. No new emails since March 7

The most recent processed file is `2026-03-07`. Gmail fetch hasn't pulled new emails in 5 days. The scrape runs every few hours on Railway but returns cached events — Yutori reports 1560 events each scrape, all from the stale `cached-events.json`.

### 2. Deterministic parser skips the richest email format

Yutori's structured emails put event data in `<li>` items:
```
[Event] Date & time: Thursday, February 26, 2026 | 7:00 PM – 11:00 PM
[Event] Venue: Wonderville, 1186 Broadway, Brooklyn, NY 11221
[Event] Event type: Experimental electronic showcase
[Event] Entry: RSVP required
```

Line 157 of `general-parser.js` **explicitly skips these**:
```js
if (/^(?:Date & time|Venue|Event type|Entry|Tickets):\s/i.test(text)) return null;
```

The parser expects each `[Event]` line to be a complete event, not separate fields. Result: 0 events extracted deterministically → falls through to LLM.

### 3. LLM extraction loses most of the data

Of 439 Yutori events currently in cache:

| Field | Missing | % |
|-------|---------|---|
| URL | 358 | 82% |
| Price | 198 | 45% |
| Time | 184 | 42% |
| Description | 154 | 35% |
| Venue | 87 | 20% |
| Category | 56 | 13% |
| Neighborhood | 54 | 12% |
| **Fully complete** | **38** | **9%** |

Known bad patterns:
- Day-of-week as venue name: `name=Elsewhere, venue=Fri`
- Venue includes "through" date: `venue=Film at Lincoln Center through Mar 15`
- URLs from decoded source badges not reliably extracted by LLM

## Spot Check: 10 Events from Scout Email

Email: "Electronic/experimental music and indie film picks" (screenshotted Mar 11)

| Event | In Cache? |
|-------|-----------|
| Cherm / JesseK / RaidenX at Berlin | No |
| Mamady Kouyate's Mandingo Ambassadors at Barbès | No |
| Crescent: Open Decks at Keybar | No |
| Beginner DJ Workshop at Caffeine Underground | No |
| DJ Kuff B2B Egipto at 96 Morgan Ave | No |
| Sabo at House of Yes | No |
| abunDANCE at Eris | No |
| FOMO Secret Cinema — KIDS (1995) | No |
| Art House Cinema Week (Mar 20-26) | No |
| DCTV Firehouse Cinema | No |

**0 of 10 found.** These events exist in other sources (Berlin has 3 donyc events, Eris has 21 RA events, House of Yes has 3) but the Yutori versions — which have richer descriptions and source URLs — are completely missing.

## Root Cause

The email contains perfectly structured data that requires no LLM:
- Event name + description in `<p>` paragraph
- Source URL badges (decoded from `scouts.yutori.com/api/view?url=...`)
- Explicit labeled fields in `<li>`: date/time, venue + address, event type, price/entry

The fix is a dedicated parser for this structured format. The data is already clean — it just needs to be reassembled from paragraph + list items into events.

## Dataset Analysis (Completed)

Built a filtered dataset from 149 locally processed Yutori emails → **92 event emails**, 57 filtered out (fintech, streaming, etc.).

### Three Email Templates, One Field Schema

All event emails share the same fields — laid out in 3 templates:

| Template | ~Count | Structure |
|----------|--------|-----------|
| **A: Category-grouped** | ~60 | Bold category headers (`Electronic music — immediate`) → `<ul>` lists per category |
| **B: Numbered list** | ~20 | Single `<ol>` with numbered entries |
| **C: Paragraph-separated** | ~12 | `<p>` blocks with `#)` prefix |

### Field Consistency

| Field | Present | Notes |
|-------|---------|-------|
| Event name | 100% | In `<b>` tags or quoted text |
| Venue + address | 100% | Address on `<br/>` line after venue name |
| Date/time | 99% | 1 instance missing time |
| Description | 100% | 1-3 sentences, curator voice |
| Source URL | 100% | Tracking redirect: `scouts.yutori.com/api/view?url=<encoded>&referrer=email` |
| Source badge | 100% | Favicon `<img>` + domain label (RA, Eventbrite, venue site) |
| Price | ~95% | ~5% marked "Price not listed" or omitted |

### Structural Stats

- **98% have `<li>` items** (structured fields our parser currently skips)
- **100% have source badges** (decoded tracking URLs we're losing)
- **51% have bold event names** (the other 49% use list-only format)
- Average email: 20KB, 11.8 `<li>` items, 10 source badges

### Quality Flags

**9 emails misclassified as events** (leaked through `isEventEmail()`):
- 4 "AI LLMs Top News"
- 2 "Longevity anti-aging findings"
- 1 "YC Series A raises"
- 1 personal research prompt (social luck)
- 1 "Sports & Adult Leagues" (borderline)

**Only 1 email** has zero structural markers (no bold, no `<li>`) — uses paragraph-only template.

**45 of 92 emails have 0 bold event names** — rely entirely on `<li>` structure, which the parser throws away.

### HTML Patterns

All emails use Resend email template framework:
- Nested `<table>` layout, inline styles only (no CSS classes)
- Event boundaries: `</li>` + spacing, category headers, or `</p>` breaks
- Source links: `<span>` wrappers with favicon `<img>` + domain text
- URL encoding: `scouts.yutori.com/api/view?url=<URL-encoded-destination>&referrer=email&scout_id=<UUID>`
- Key inline styles: `font-weight:700` (bold), `color:rgb(51,65,85)` (text), `margin-bottom:0.25rem` (spacing)

### Extraction Challenges

1. **`<li>` fields are separate lines, not complete events** — parser expects one event per `[Event]` line
2. **Source URLs triple-encoded** behind tracking redirect — need `decodeURIComponent` to reach RA/Eventbrite URLs
3. **Venue address on `<br/>` line** — naive `.textContent` concatenates venue + address into one string
4. **Price inconsistent** — sometimes `$XX`, sometimes `Free`, sometimes omitted
5. **No CSS classes** — must parse by inline styles and tag structure
