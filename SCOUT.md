# Scout — Brainstorm

> What if Pulse had a background worker that proactively fills data gaps before users hit them?
> This is a brainstorm, not a spec. See DATA-SOURCES.md for the current state audit.

---

## The Problem Scout Solves

The daily scrape fetches from 10 sources in parallel at 10am ET. It works well for nightlife hubs (EV, Williamsburg, Bushwick) but leaves entire neighborhoods nearly empty — especially the ones where our actual users live (Greenpoint, Bed-Stuy, UWS, West Village, Cobble Hill).

The daily scrape is **source-first**: it asks "what does Dice have today?" Scout would be **neighborhood-first**: it asks "what does Greenpoint need?" and goes looking.

---

## What Scout Does

### 1. Assess ("What are we thin on?")

After the daily scrape runs, Scout looks at the cache and computes a gap report:

- Which neighborhoods have < N events for tonight/tomorrow?
- Which category buckets are empty? (nightlife, art, comedy, music, free)
- Which time windows are thin? (afternoon, evening, late-night)
- Are any priority neighborhoods (friend-group neighborhoods) empty?

Output: a ranked list of gaps to fill. "Greenpoint has 0 events tonight. Bed-Stuy has 1. UWS has 2 but no variety."

### 2. Plan ("What should I fetch?")

Based on the gap report, Scout picks actions from a **fixed whitelist of sources** — not the open web. Different gaps trigger different sources:

| Gap | Sources to try |
|-----|---------------|
| Thin neighborhood | Venue calendars for that hood, DoNYC filtered by area |
| Comedy empty | Comedy Cellar, UCB, Caveat, QED calendars |
| Art empty | Gallery listing aggregators, DoNYC art category |
| Free events thin | NYC Parks API, BrooklynVegan free shows, NYPL calendar |
| Late-night thin | Venue calendars for late-night spots |
| Single-source category (e.g. underground = only Nonsense) | Try DoNYC "offbeat" or deeper Nonsense parsing |

### 3. Fetch ("Go get it")

Bounded fetching with:
- Per-domain throttling
- Caching (ETag/Last-Modified for feeds)
- Max fetch count per run (e.g. 25 pages)
- Timeouts
- Wall-clock budget (e.g. 2 minutes total)

### 4. Extract ("Turn pages into events")

Same layered approach as current sources:
1. **Structured data first** — JSON-LD, APIs, RSS (no Claude needed, high confidence)
2. **Known-format HTML** — venue calendar pages with predictable layouts (cheerio/regex)
3. **Claude fallback** — only when the above fail. Strict JSON schema, evidence quotes for key fields.

### 5. Validate + Upsert ("Is this real? Merge it in.")

- Hard gates: must have time + location + source_url
- Dedupe fingerprint against existing cache
- Confidence scoring (0.9+ for structured, 0.7-0.85 for partial, skip <0.5)
- Merge into the in-memory event cache (or Postgres if we move to that)

### 6. Stop ("Good enough or budget exhausted")

Loop for max N iterations. Stop when:
- Every priority neighborhood has >= 3 events, or
- No meaningful improvement over prior iteration, or
- Fetch/time budget exhausted

---

## The Perennial Picks Layer

Some things aren't events — they're places that are reliably good:
- Comedy Cellar has shows every night
- Smalls Jazz Club has live jazz every night
- Smoke has jazz 7 nights a week on the UWS
- Good Room has DJs on weekends

When the cache is thin for a neighborhood, a real friend wouldn't say "quiet night" — they'd say "Ode to Babel on Franklin usually has something going on."

### How it would work

A small curated data file — `perennial-picks.json`:

```json
{
  "Bed-Stuy": [
    {
      "venue": "Ode to Babel",
      "vibe": "Wine bar with live music/DJs on weekends",
      "days": ["thu", "fri", "sat"],
      "category": "nightlife",
      "address": "772 Dean St"
    }
  ],
  "UWS": [
    {
      "venue": "Smoke Jazz & Supper Club",
      "vibe": "Live jazz every night, intimate room",
      "days": ["any"],
      "category": "live_music"
    }
  ]
}
```

**When used:** Only as fallback when cache has < 2 events for a neighborhood. The compose prompt gets both the (thin) event list and perennial picks, with instructions to mention them as "this place usually has something going on" suggestions.

**How Scout grows it:** Over time, Scout observes which venues appear repeatedly across sources. Venues that show up 3+ times per month become perennial candidates. Initially, hand-seed for priority neighborhoods.

---

## Venue Knowledge Base (the highest-leverage thing Scout could build)

The single biggest quality issue is geo resolution (see DATA-SOURCES.md). Scout could build and maintain a venue lookup:

- Every time a structured source (Dice, Songkick, Eventbrite) provides a venue name + coordinates, Scout adds it to the lookup
- `normalizeExtractedEvent()` checks the lookup before falling back to Claude's neighborhood guess
- The lookup grows automatically over time

Initial seed: expand `RA_VENUE_MAP` from 40 entries to ~200, prioritizing venues in thin neighborhoods.

---

## When Scout Runs

Options:
- **After the 10am daily scrape** — assess gaps, fill them. 10-15 min window.
- **Second pass at 5pm ET** — refresh for the evening crowd. Events posted mid-day (especially for that night) get caught.
- **On-demand** — triggered when a user hits a thin neighborhood (more complex, adds latency concerns).

The daily-scrape-then-Scout pattern is simplest. Scout is purely additive — it never removes events, only adds.

---

## What Scout Is NOT

- Not a general web crawler. Fetches only from a configured source whitelist.
- Not in the SMS hot path. Runs in background, results appear in cache.
- Not real-time. Runs on a schedule (daily or twice-daily).
- Not AI-heavy. Prefers structured extraction over Claude calls.
- Not a replacement for the daily scrape. It supplements it.

---

## Open Questions

1. **In-memory vs Postgres?** Current cache is in-memory, lost on restart. Scout's value compounds over time (venue DB, perennial picks). Should we move to Postgres before building Scout, or start with in-memory and migrate later?

2. **How to handle the perennial picks UX?** Does the compose prompt blend them naturally ("not much listed tonight, but Smoke Jazz always has live music"), or are they a separate message type?

3. **How many venue calendars is realistic to maintain?** Each is a custom scraper. 10? 20? 50? Fragility scales linearly.

4. **Should Scout run on a separate process/worker?** Or as part of the same Express server on a timer? Separate process is cleaner but adds infra.

5. **Priority neighborhoods — hardcoded or learned?** Start hardcoded (the friend group), but eventually could be based on where users actually text from.
