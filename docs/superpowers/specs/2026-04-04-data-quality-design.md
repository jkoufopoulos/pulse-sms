# Data Quality & Pool Coverage — Design Spec

**Date:** 2026-04-04
**Status:** Draft
**Inputs:** Gemini brainstorm, Claude brainstorm, user testing observations

## The User Scenario

A person is standing on a corner in Bushwick with friends, deciding what to do right now. They have their own ideas already ("we could just go to that bar we always go to") and they're texting Pulse to see if there's something better they don't know about. They need a fast answer. They're weighing Pulse's suggestions against their own ideas.

This means:
- "Nothing tonight, try tomorrow" is useless — they need an answer NOW
- Generic Eventbrite filler is also useless — they already know the obvious stuff
- What they want: "here's something you wouldn't have found on your own, happening right now near you"
- Asking a quick clarifying question ("comedy or music?") is fine — it's fast and narrows to better picks
- Nearby neighborhoods are fair game — "quiet in Bushwick but great set in Bed-Stuy 10 min away" is a good answer

## Architecture: Four Layers

The system already has most of the plumbing. The work is enrichment, diagnostics, and filling gaps.

### Layer 0: Coverage Diagnostics (know what you're missing)

**Problem:** We don't know where the pool is thin. We optimize blind.

**Solution:** Daily coverage matrix computed at scrape time, exposed on health dashboard.

- **Dimensions:** neighborhood (75) × category (10) × day-of-week (7)
- **Metrics per cell:** event count, % with complete data (time + venue + neighborhood), % editorial vs structured
- **Dashboard:** heatmap on `/health` showing coverage gaps — red cells = no events, yellow = thin, green = solid
- **Alerts:** if any top-20 neighborhood has 0 events for 2+ consecutive days, flag it

**What exists today:** `getHealthStatus()` returns cache size and source health. `computeEventMix()` now returns composition and data gaps. The events dashboard has a data gaps chart. But there's no neighborhood × category × day matrix.

**Work required:** Add `computeCoverageMatrix()` to `source-health.js`, wire into health API, add heatmap to health UI. ~1 day.

### Layer 1: Enrichment Pipeline (fix what you have)

**Problem:** 449 events serving but many are unusable due to missing fields. Yutori: 41% missing URLs, 30% missing descriptions, 12% missing times. An event without a time is unrecommendable for someone deciding "what to do right now."

**Priority of gaps (for the "standing on a corner" scenario):**
1. **Time** — most critical. Can't answer "what's happening now" without it. 46 Yutori events missing.
2. **Neighborhood** — second most critical. Can't match to user's location. 23 Yutori events missing.
3. **URL** — needed for detail requests ("tell me more about #2"). 123 missing.
4. **Description** — agent brain can pick by name/category/venue without it, but SMS copy is generic. 113 missing.

**Approach: scrape-time waterfall (runs after extraction, before cache persistence)**

```
For each event missing time, URL, or description:
  1. Search: "{event_name}" "{venue_name}" NYC → first result URL
  2. Fetch: GET first result, extract og:url, og:description, structured time data
  3. Verify: Haiku call — "Does this URL match this event? Extract start time if present." (~$0.0005)
  4. Flag: Set enrichment_attempted: true so we don't retry failures daily
```

**Cost estimate:** ~200 events/day need enrichment × $0.01-0.02 each = $2-4/day.

**What exists today:** `extractEvents()` in `ai.js` runs at scrape time. Tavily is available but not used in the enrichment path. `venues.js` has auto-learning coords. No enrichment step exists between extraction and cache persistence.

**Work required:** New `enrichEvents()` function called in `refreshCache()` after extraction, before `saveCachedEvents()`. Needs a search API (Tavily already available, or SerpAPI/Serper for ~$50/mo). ~2-3 days.

### Layer 1.5: Venue Index (canonical venue knowledge)

**Problem:** If Yutori says "The Sultan Room" and Skint says "Sultan Room," they should resolve to the same venue with known neighborhood, vibe, and hours. A known venue fills 80% of metadata gaps automatically.

**What exists today:** `venues.js` already has:
- `VENUE_ALIASES` — maps variant names to canonical (47 aliases)
- `VENUE_MAP` — ~870 venues with coordinates
- `VENUE_SIZE` — capacity classification (intimate/medium/large)
- `learnVenueCoords()` — auto-learns new venue locations via geocoding
- `batchGeocodeEvents()` — runs during scrape to resolve neighborhoods

**What's missing:**
- **Venue hours/vibe** — we know WHERE a venue is but not WHEN it's open or WHAT it's like
- **Venue → neighborhood backfill** — if an event has venue_name "House of Yes" but no neighborhood, we should auto-fill "Bushwick" from the venue map. `backfillNeighborhoodFromVenue()` exists in `events.js` but only runs at query time, not at scrape time.
- **Venue → default times** — if a club is known to have events at 10pm-2am, a missing time can be inferred

**Work required:** 
- Move `backfillNeighborhoodFromVenue()` to run at scrape time (trivial, ~1 hour)
- Add `venue_vibe` and `default_hours` fields to VENUE_MAP for top 50 venues (~1 day, partially manual)
- Use venue defaults to fill time gaps when enrichment pipeline fails (~half day)

### Layer 2: Smarter Pool Matching (answer "now" and "near here")

**Problem:** User texts at 11pm, pool has 7pm events. User texts "Bushwick," pool has 2 events there but 15 in adjacent Williamsburg/Bed-Stuy.

**What exists today:**
- `time_after` filter in search tool params — model can filter by time
- `failsTimeGate()` in `events.js` — filters events before user's requested time
- `getAdjacentNeighborhoods()` in `geo.js` — returns nearby hoods
- `computeNearbyHighlight()` in `brain-execute.js` — highlights better nearby options
- `suggestedHood` in pool results — suggested alternative when results are sparse
- Clarifying questions — model asks "comedy or music?" for ambiguous requests

**What's missing:**
- **"Happening now" awareness** — no concept of "this event is currently in progress" vs "this starts in 2 hours." For the "standing on a corner" user, currently-happening events should rank highest.
- **Automatic neighborhood expansion** — the system suggests nearby hoods but doesn't automatically include them. If Bushwick has 1 event and Williamsburg has 8, the model should proactively include the best Williamsburg picks without being asked.
- **Sparse pool behavior** — when `matchCount < 3`, the model should broaden (adjacent hoods, relax category filters) before saying "nothing found."

**Work required:**
- Add `isHappeningNow()` helper and boost score for in-progress events (~half day)
- Modify `buildSearchPool` to auto-expand to adjacent hoods when `matchCount < 3` (~1 day)
- Update system prompt to instruct model on sparse-pool behavior (~half day)

### Layer 3: Selective Source Expansion (more editorial sources)

**Problem:** 6 sources, Yutori is 83% of the pool. Other sources (SkintOngoing, BKMag) contribute little to the serving window. Coverage is thin for comedy, underground/DIY, and specific neighborhoods.

**The filter for new sources:** "Would a human who reads this source text their friend about events from it?"

**High-value additions:**
- **Resident Advisor** — genuine curation for electronic/dance. NYC-specific listings with editorial context. Code exists in `sources/` (was disabled).
- **Comedy venue calendars** — Comedy Cellar, Union Hall, QED Astoria, Caveat. Single "NYC comedy venues" scraper hitting 8-10 venue sites. This is the weakest vertical with real demand.
- **Ohmyrockness** — indie music, strong editorial voice. Code may exist in sources/.
- **Gothamist weekend picks** — editorial curation, weekly cadence.

**Sources to NOT re-enable:**
- Eventbrite/Ticketmaster — generic, no editorial signal, same stuff ChatGPT surfaces
- Songkick — largely duplicates RA and venue calendars
- Generic listing aggregators — volume without taste

**Work required:** ~1-2 days per source (scraper + extraction tuning + eval). Start with RA (code exists) and comedy venues (new scraper).

### Layer 4: Real-Time Search Fallback (last resort)

**Problem:** When the curated pool has genuinely nothing for a query, the user gets a weak response.

**Trigger:** `matchCount === 0` after neighborhood expansion and filter relaxation.

**Approach: two-message pattern**
1. **Instant acknowledgment** (< 1s): "Searching for that — one sec..."
2. **Search result** (3-6s later): Tavily search → normalize to event schema → tag as `[SEARCH]` → model picks from combined pool

**Quality gate:** Search results go through the same model curation. Agent brain sees `[SEARCH]` tag and can apply taste — "would Pulse recommend this?" Only surface results from trusted domains (RA, venue sites, editorial outlets), not random Eventbrite pages.

**UX risk:** This is where the "canned" problem lives. Google results for "comedy bushwick tonight" return the same SEO-optimized venues every time. The editorial pool is Pulse's taste — search results don't have it. This layer is a safety net, not the product.

**Work required:** ~2-3 days. Two-message Twilio sequencing, Tavily integration in agent loop, quality gate prompt, `[SEARCH]` tagging.

## Priority Order

| Phase | Layer | Work | Impact | Time |
|-------|-------|------|--------|------|
| 1 | L0: Coverage diagnostics | Coverage matrix + dashboard heatmap | Know where you're thin | 1 day |
| 2 | L1: Enrichment pipeline | Scrape-time URL/time/description fill | 449 events → 449 *usable* events | 2-3 days |
| 3 | L1.5: Venue backfill | Move neighborhood backfill to scrape time, venue defaults | Auto-fill gaps from known venues | 1 day |
| 4 | L2: Smarter matching | "Happening now" boost, auto neighborhood expansion, sparse-pool broadening | Better answers for "what's happening NOW near HERE" | 2 days |
| 5 | L3: Source expansion | Re-enable RA, build comedy venue scraper | Fill category gaps (electronic, comedy) | 3-4 days |
| 6 | L4: Real-time fallback | Two-message pattern, Tavily in agent loop | Always have an answer | 2-3 days |

**Total: ~12-14 days of work, phased so each layer delivers value independently.**

Phase 1-3 can ship together (~4-5 days) and will dramatically improve the product for the "standing on a corner" user without adding any new sources. Phase 4 makes matching smarter. Phase 5-6 expand coverage.

## Success Metrics

- **Usable event rate:** % of events with time + neighborhood + venue (target: >90%, currently ~60%)
- **Zero-match rate:** % of user queries that return 0 events (target: <5%, measure from traces)
- **Coverage breadth:** # of top-20 neighborhoods with ≥5 events on any given day (target: 15+)
- **Enrichment cost:** daily spend on enrichment pipeline (budget: <$5/day)
- **Response relevance:** % of recommendations that are happening within 3 hours of query time (measure from traces + event times)

## Design Decisions

- **Editorial pool is the product, not a limitation.** The curated sources are Pulse's taste. Structured sources fill gaps; they don't replace curation.
- **Enrich at scrape time, not SMS time.** Costs pennies once/day vs adding latency to every message.
- **Venue knowledge is a force multiplier.** A known venue fills most metadata gaps automatically.
- **"Happening now" beats "happening tonight."** For the sidewalk user, time proximity is the strongest relevance signal.
- **Adjacent neighborhoods are always fair game.** Don't say "nothing in Bushwick" when Bed-Stuy is 10 minutes away.
- **Real-time search is a safety net, not the foundation.** It should feel like effort ("let me check..."), not like the default path.
