# Pulse — Roadmap

> Single source of truth for issues, coverage gaps, and planned work.
> Consolidates: ISSUES.md, DATA-SOURCES.md, SCOUT.md, SPEC.md
> Last updated: 2026-02-18

---

## Completed Work

### Code Quality (23 original issues + 15 UX issues — all fixed)

Every issue from the initial code review and pipeline review has been addressed:
- Timezone-aware date parsing (`parseAsNycTime` in geo.js)
- AI flow try/catch with error SMS fallback (handler.js)
- TCPA opt-out keyword handling — STOP/UNSUBSCRIBE/CANCEL/QUIT (handler.js)
- Null-safe Claude response parsing (`response.content?.[0]?.text || ''`)
- Twilio sendSMS 10s timeout via `Promise.race` (twilio.js)
- Session TTL extended to 2 hours (session.js)
- Express body limit 5kb (server.js)
- Category filtering from user intent (handler.js)
- Free-only pre-filtering when `free_only: true` (handler.js)
- `routeMessage` fallback returns `conversational` intent, not `events` (ai.js)
- Pick validation — event_ids checked against actual event list (ai.js)
- `formatEventDetails` includes time + price (formatters.js)
- Rate limiter with user feedback message (handler.js, currently disabled)
- Legacy flow removed — all routing via AI + deterministic pre-router
- Unknown intent guard with neighborhood check (handler.js)
- Borough-aware travel nudges for thin neighborhoods (handler.js)
- `boroughMap` moved to module scope (geo.js)
- Lazy-init for Anthropic + Twilio clients
- `setInterval` callbacks wrapped in try/catch
- Full details list via unnumbered DETAILS, numbered pick via `composeDetails` (handler.js)
- "Quiet night" responses suggest nearby neighborhoods with events

### Architecture (consolidated review Tier 1 — all fixed)

| ID | Issue | Status |
|----|-------|--------|
| C1 | Timezone-naive date parsing on UTC servers | Fixed — `parseAsNycTime()` appends NYC offset |
| C2 | AI flow errors cascade to legacy double-run | Fixed — try/catch with error SMS, no legacy fallback |
| C3 | No STOP/UNSUBSCRIBE handling (TCPA) | Fixed — `OPT_OUT_KEYWORDS` regex at top of handler |
| C4 | `content[0].text` without null-safety | Fixed — optional chaining everywhere |
| C5 | No timeout on Twilio sendSMS | Fixed — 10s `Promise.race` |
| C6 | Concurrent session race conditions | Deferred — rare at current traffic |

### Source Expansion (from 3 to 16 sources)

Original: Skint, Eventbrite, Songkick + Tavily fallback.

Added: RA (GraphQL), Dice (JSON), Nonsense NYC (Claude extraction), Oh My Rockness (Claude extraction), BrooklynVegan (DoStuff JSON), NYC Parks (Schema.org), DoNYC (Cheerio), BAM (JSON API), SmallsLIVE (AJAX HTML), NYPL (Eventbrite organizer pages), EventbriteComedy, EventbriteArts.

### Infrastructure Improvements

- **Source registry** — Single `SOURCES` config array in events.js drives all fetch/merge/health logic. Boot-time validation. No positional coupling.
- **Cross-source dedup** — Event IDs hashed from name+venue+date (source-agnostic). Same event from Dice and BrooklynVegan merges automatically.
- **Venue auto-learning** — Sources with lat/lng (Dice, Songkick, Eventbrite, BrooklynVegan) teach venue coords to shared map at scrape time.
- **Venue persistence** — Learned venues saved to `data/venues-learned.json` after each scrape, loaded on boot. 175+ venues.
- **Perennial picks** — Curated JSON of reliably-good venues by neighborhood + day. Blended into compose as first-class event objects.
- **Source health dashboard** — `/health` endpoint with per-source timing, status, history sparklines.
- **Deterministic pre-router** — Greetings, details, more, free, bare neighborhoods, boroughs resolved without Claude API call.
- **AI trust hierarchy** — All 16 sources listed in compose prompt with weights.
- **Source health alerting** — Email alerts via Resend API when sources fail 3+ consecutive scrapes. 6-hour cooldown. Graceful no-op without API key.
- **Security middleware** — Helmet (CSP, HSTS, X-Frame-Options) + `trust proxy` for Railway.
- **Health endpoint auth** — `/health` gated behind test mode or `HEALTH_AUTH_TOKEN`. Public `/` returns only `{ status: 'ok' }`.

---

## Open Issues

### High Priority

All high-priority issues resolved.

### Medium Priority

| ID | Issue | Impact | LOE | Notes |
|----|-------|--------|-----|-------|
| L18 | `.slice(0, 480)` can cut mid-word or mid-URL | 4 instances of naive truncation (ai.js:602, ai.js:791, handler.js:220, handler.js:237). Garbled SMS on edge cases. | ~15 min | Word-boundary-aware truncation helper |
| L15 | HELP message lacks examples | Doesn't mention landmarks, subway stops, categories, numbered details | ~5 min | Expand help text with concrete examples |
| L19 | Long event names (200+ chars) consume SMS budget | Event names pass to Claude untruncated in compose input (ai.js:507). 480-char output cap mitigates but wastes budget. | ~5 min | Truncate event name to ~80 chars in compose input |
| NEW | Scraper `source_weight` hardcoded in 14 files | Individual scrapers still set `source_weight` but it's now overridden by the SOURCES registry in events.js. Dead code. | ~20 min | Remove hardcoded weights from all scraper files |

### Resolved (removed from prior version)

| ID | Issue | Finding |
|----|-------|---------|
| ~~M15~~ | `makeEventId` collisions for null/empty fields | Fixed — falls back to `source + source_url` hash when core fields are empty (`sources/shared.js`) |
| ~~L13~~ | Dedup registers MessageSid before processing | Fixed — registration moved to `.then()` after `handleMessage` succeeds (`handler.js`) |
| ~~L10~~ | Health check exposes source health without auth | Fixed — `/` returns only `{ status: 'ok' }`, `/health` gated behind test mode or auth token (`server.js`) |
| ~~L11~~ | No Express security middleware | Fixed — `helmet()` + `trust proxy` added (`server.js`) |
| ~~L16~~ | Songkick includes tomorrow's events | Not a problem — `getEvents()` filters to today-only before returning. Tomorrow events cached but never surfaced. |
| ~~L22~~ | CTA shows DETAILS/MORE/FREE with zero picks | Not a problem — handler has explicit zero-events paths (perennial picks, travel nudge, "quiet night" message). None send inappropriate CTA. |
| ~~L26~~ | Eventbrite `addressLocality` "New York" → Midtown | Already mitigated — Eventbrite parser has regex check that returns `null` for "New York"/"Brooklyn"/"Manhattan"/"Queens" when no lat/lng available. |

### Deferred (post-MVP)

| ID | Issue | Why deferred |
|----|-------|-------------|
| C6 | Concurrent session race conditions | Requires rapid-fire texting, rare in practice |
| M1 | All in-memory state lost on restart | Fine for single-process MVP |
| M6 | No first-time user onboarding | Users who text the number already know what it does |
| M11 | No processing ack during slow Claude calls | Adds extra Twilio cost per message |
| M16 | `parseJsonFromResponse` returns first valid fragment | Edge case, works 99% of the time |
| L1 | No horizontal scalability | Single-process is fine at current traffic |
| L2 | Claude API single point of failure | No viable local fallback |
| L3 | No compose response caching | Cost optimization for later |
| L4 | No concurrency control on Claude API | Stampede unlikely at current scale |
| L5 | No structured logging or correlation IDs | Operational improvement for scale |
| L17 | Prompt injection defense | Low risk for SMS app with no financial actions |
| L20 | Cross-source dedup only by exact hash, not fuzzy | Occasional near-duplicate acceptable |
| L21 | No integration tests or mocking | Important eventually, not blocking |
| L25 | No acknowledgment on neighborhood switch | Polish feature |

---

## Source Coverage

### Current Sources (16)

| Source | Weight | Method | Geo Quality | Strength |
|--------|--------|--------|-------------|----------|
| Skint | 0.9 | HTML → Claude | Venue lookup | Free/cheap curated picks |
| Nonsense NYC | 0.9 | HTML → Claude | Venue lookup | Underground/DIY/weird |
| RA | 0.85 | GraphQL API | Venue lookup | Electronic/dance/nightlife |
| Oh My Rockness | 0.85 | HTML → Claude | Venue lookup | Indie/rock/punk |
| Dice | 0.8 | `__NEXT_DATA__` JSON | Lat/lng (reliable) | Ticketed shows, DJ sets |
| BrooklynVegan | 0.8 | DoStuff JSON | Lat/lng (reliable) | Free shows, indie/rock |
| BAM | 0.8 | JSON API | Hardcoded venue | Film, theater, music, dance |
| SmallsLIVE | 0.8 | AJAX HTML | Hardcoded venue | Jazz (Smalls + Mezzrow) |
| NYC Parks | 0.75 | Schema.org | Event location | Free parks/outdoor events |
| DoNYC | 0.75 | Cheerio HTML | Venue lookup | Music, comedy, theater |
| Songkick | 0.75 | JSON-LD | Lat/lng (reliable) | Concerts/music |
| Eventbrite | 0.7 | JSON-LD / `__SERVER_DATA__` | Lat/lng (reliable) | Broad aggregator |
| NYPL | 0.7 | Eventbrite organizer | Lat/lng | Free library events |
| EventbriteComedy | 0.7 | Same parser, comedy URL | Lat/lng | Comedy-specific |
| EventbriteArts | 0.7 | Same parser, arts URL | Lat/lng | Art-specific |
| Tavily | 0.6 | Web search → Claude | Claude-inferred | Free events catch-all |

### Source Reliability

| Risk Level | Sources | Notes |
|------------|---------|-------|
| Low | RA, Songkick, BAM, SmallsLIVE, NYPL | Stable APIs/JSON |
| Medium | Dice, Eventbrite, Skint, Tavily, NYC Parks | HTML structure could change |
| High | Nonsense NYC, Oh My Rockness, DoNYC | Generic CSS selectors, fragile |

Health tracking exists (consecutive-zero warnings + dashboard) but has no external alerting. A source can silently die for days.

### Category Gaps

| Category | Coverage | Gap |
|----------|----------|-----|
| Electronic/dance | Strong (RA, Dice) | — |
| Indie/rock/punk | Good (OMR, Songkick, BrooklynVegan) | OMR scraper fragility |
| Comedy | Moderate (EventbriteComedy, DoNYC) | No dedicated comedy source (Comedy Cellar, UCB, Caveat missing) |
| Art/galleries | Weak (EventbriteArts, Skint) | No gallery opening calendar |
| Theater | Moderate (DoNYC, BAM) | No Broadway/off-Broadway dedicated source |
| Underground/DIY | Single source (Nonsense NYC) | If it breaks, entire vibe is gone |
| Jazz | Good (SmallsLIVE, Skint, DoNYC) | — |
| Parks/outdoor | Good (NYC Parks) | — |
| Late-night (post-midnight) | Decent for electronic (RA, Dice) | Nothing for non-electronic late night |

### Neighborhood Coverage

**Well-covered** (8-15 daily events): East Village, Williamsburg, LES, Bushwick

**Thin** (1-5 daily events): Greenpoint, Bed-Stuy, UWS, West Village, Cobble Hill/Brooklyn Heights, Fort Greene

**Zero/near-zero**: Bay Ridge, Bensonhurst, Brighton Beach, Morningside Heights, Hamilton Heights, South Bronx/Mott Haven

Perennial picks partially compensate for thin neighborhoods by providing reliable venue recommendations.

---

## Feature Roadmap

### Near-term — Source + Quality

**Comedy source** — Dedicated scraper for Comedy Cellar, UCB, Caveat, QED. These venues have structured calendar pages. Would fill the biggest category gap.

**Gallery/art source** — Gallery listing aggregator or DoNYC art category. Currently the weakest coverage area.

**Scraper cleanup** — Remove hardcoded `source_weight` from individual scraper files (now overridden by the SOURCES registry in events.js).

### Medium-term — Intelligence

**Scout worker** — Background process that runs after daily scrape to fill neighborhood gaps:
1. Assess: which neighborhoods have < N events tonight?
2. Plan: which venue calendars or sources should be queried?
3. Fetch: bounded requests to a whitelist of sources
4. Extract: prefer structured data (JSON-LD, APIs) over Claude extraction
5. Validate: confidence gating, dedup against cache
6. Upsert: merge into event cache

Only additive — never removes events. Runs after 10am scrape and optionally at 5pm for evening refresh.

**Perennial picks evolution** — Currently hand-curated JSON. Could auto-detect perennial candidates from scrape data (venues appearing 3+ times/month become candidates). Start curated, grow automatically.

**Second daily scrape** — 5pm ET pass catches events posted mid-day for that evening. Simple timer addition.

### Long-term — Infrastructure + Product

**PostgreSQL** — Persistent event storage, user sessions across restarts, conversation history. Replace in-memory stores. Enables preference learning.

**Preference learning** — Track which events users ask details on, which neighborhoods they revisit. Adjust taste profile over time.

**Paid tier** — Stripe billing, $5-10/month unlimited. Free tier: 10 texts/month.

**Push notifications** — "Free rooftop thing near you starting in 30 min." Requires phone number → location mapping or opt-in location sharing.

**Multi-city** — Same architecture, different sources. LA, Chicago, etc.

---

## Not Building

- Happy hours / venue busyness / bar discovery — different product
- Yelp/Foursquare venue DB — venue discovery != event discovery
- X/Twitter — expensive API, poor geo, ToS risk
- Email inbox ingestion — operationally complex
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- General web crawling — whitelist sources only
- Real-time scraping — SMS users don't need sub-daily freshness
