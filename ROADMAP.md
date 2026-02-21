# Pulse — Roadmap

> Single source of truth for architecture evolution, open issues, and planned work.
> Last updated: 2026-02-21 (migration progress updated same day)

---

## Architecture v2: Pipeline + Structured Session

### Why

Eval results (52.4% pass rate across 21 multi-turn scenarios) revealed three root architectural patterns causing failures:

1. **Split-brain filtering** — Filtering is reimplemented across 4 handlers (`handleFree`, `handleNudgeAccept`, `handleEventsDefault`, `handleMore`), each with different behavior. No single enforcement layer. Category taxonomy too coarse (jazz → live_music includes rock/indie/folk).

2. **Flat session merge** — `setSession` does `{ ...existing, ...data }`. If a handler doesn't explicitly set `lastPicks`, the previous value persists. When a response has no picks (e.g. "no jazz, want nearby?"), old picks survive and details returns stale data.

3. **Geographic pool vs semantic scope** — `getEvents(hood)` returns events by proximity radius including nearby neighborhoods. When MORE exhausts in-hood events, it falls back to geographic pool, showing Williamsburg events when the user asked about Greenpoint.

### Target Architecture

Replace 4 independent handler implementations with one shared pipeline:

```
route → buildContext → fetchPool → filter → compose → respond → saveFrame
```

Every handler becomes a thin **context builder** (5-10 lines) that produces a query context. The pipeline handles everything else uniformly.

### 1. Query Context (replaces ad-hoc handler logic)

```js
context = {
  neighborhood: 'williamsburg',
  scope: 'neighborhood' | 'borough' | 'citywide',
  timeRange: 'tonight' | 'weekend' | 'tomorrow',
  filters: { free_only: true, category: 'comedy', time_after: '22:00' },
  mode: 'fresh' | 'more' | 'details',
  excludeIds: Set([...]),   // already shown
}
```

Each handler builds a context, then calls `executeQuery(context)`. One function does fetch → filter → compose for all intents.

### 2. Structured Session (replaces flat merge)

```js
session = {
  // Conversation state (persists across turns)
  neighborhood: 'williamsburg',
  scope: 'neighborhood',
  filters: { free_only: true, category: 'comedy' },
  visitedHoods: ['williamsburg'],

  // Response frame (atomically replaced on every response)
  frame: {
    picks: [...],           // what user can reference by number
    eventPool: { id→event },// full pool for MORE
    offeredIds: [...],      // everything shown so far
  },

  // Pending (nudge state)
  pending: { neighborhood: 'greenpoint', filters: {...} },

  history: [...],
}
```

Key change: `frame` is **replaced wholesale** on every response. No more stale `lastPicks` surviving transitions.

### 3. Scoped Event Fetching (replaces geographic radius bleed)

```js
function scopeEvents(events, context) {
  if (context.scope === 'neighborhood')
    return events.filter(e => e.neighborhood === context.neighborhood);
  if (context.scope === 'borough')
    return events.filter(e => BOROUGH_HOODS[context.borough].includes(e.neighborhood));
  return events; // citywide
}
```

MORE always stays within the original scope. No geographic fallback bleeding.

### 4. Single Filter Pipeline (replaces 4 implementations)

```js
function buildEventPipeline(events, context) {
  let pool = events;
  pool = scopeByGeo(pool, context.scope, context.neighborhood);
  pool = applyAllFilters(pool, context.filters, { strict: context.isFollowUp });
  pool = pool.filter(e => !context.shownIds.has(e.id));
  pool = rankByRelevance(pool, context);
  return pool;
}
```

Used by every handler. Filtering bugs fixed once, fixed everywhere.

### 5. Borough + Multi-Day Queries

**Borough queries** ("what's in brooklyn this weekend?"):
- Pre-router recognizes "brooklyn", "manhattan", "queens" as borough-level queries
- Sets `context.scope = 'borough'`
- Compose prompt groups picks by neighborhood within the borough

**Multi-day queries** ("this weekend"):
- Daily scrape stores next-3-days events tagged by date
- `getEvents` accepts a date range
- Compose mentions the day for each pick when query spans multiple days

### 6. User Profiles (eventual)

**Storage**: SQLite — one file, no infra, survives deploys. Phone number is the key.

```sql
CREATE TABLE profiles (
  phone TEXT PRIMARY KEY,
  preferences JSON,     -- { categories: ['comedy','jazz'], neighborhoods: ['LES','bushwick'] }
  created_at INTEGER,
  last_active INTEGER
);
```

**What profiles enable**:
- Implicit personalization — if a user always asks for comedy, bias compose toward comedy
- "My usual" — shortcut for their most common query
- Weekend digest — proactive Saturday morning text matching their profile
- Frequency cap — don't show events they've already seen details for

**Where profiles plug in**: They feed into the `context` object. Soft bias, not hard filter.

### Migration Path

| Step | What | Fixes | Status |
|------|------|-------|--------|
| 1 | Atomic session frames — `setResponseState()` replaces flat `setSession` merge | 4 stale-picks failures + 2 nudge-context failures | **Done** |
| 2 | Finer category taxonomy — split `live_music` into jazz/rock/indie/folk/etc. | 3 jazz→live_music failures | Next |
| 3 | `executeQuery(context)` pipeline — thin handlers, single filter path | Prevents split-brain filtering from recurring | Planned |
| 4 | Scoped event fetching — `neighborhood` / `borough` scope on context | Fixes geographic bleed in MORE | Planned |
| 5 | Multi-day support — scraper stores next-3-days, context accepts date range | Enables "this weekend" queries | Planned |
| 6 | SQLite profiles | Enables personalization | Planned |

Each step is additive and independently shippable.

#### Step 1: Atomic Session Frames (done)

Added `setResponseState(phone, frame)` to `session.js` — atomically replaces all event-related fields (picks, events, filters, pending state), only preserves `conversationHistory`. Extracted shared utilities into `pipeline.js`:

- `applyFilters(events, filters, { strict })` — unified filter with soft/strict modes
- `resolveActiveFilters(route, session)` — single filter resolution: route > pending > session > fallback
- `saveResponseFrame(phone, opts)` — atomic session save wrapping `setResponseState`
- `buildEventMap(events)` / `buildExhaustionMessage(hood, opts)` — replaced inline patterns

All 4 event-serving handlers (`handleEventsDefault`, `handleMore`, `handleFree`, `handleNudgeAccept`) now go through atomic state replacement. One merge-based `setSession` call remains: the handleFree "where are you headed?" clarification, where preserving the previous session is intentional.

#### Step 2: Finer Category Taxonomy (next)

`inferCategory()` in `geo.js` maps jazz, rock, indie, folk, singer-songwriter all to `live_music`. When a user asks for jazz and the filter matches `live_music`, they can get rock shows. This causes 3 eval failures — the filter is working correctly, but the categories are too coarse.

Fix: split `live_music` into finer categories (`jazz`, `rock`, `indie`, `electronic`, etc.). Affects:
- `geo.js:inferCategory` — finer regex mapping
- Extraction prompts — instruct Claude to use finer categories
- `applyFilters` — may need sub-category matching (e.g. "music" matches all music sub-categories)
- Compose prompt skills — `requestedCategory` needs to use new taxonomy

#### Step 3: executeQuery Pipeline (planned)

The target architecture from the design section above. Handlers become thin context builders, one function does fetch → scope → filter → exclude → rank → compose → save. This is structural — it prevents the filtering divergence that led to Step 1's bugs from ever coming back.

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
- Full details list via unnumbered DETAILS, numbered pick via `composeDetails` (handler.js)
- "Quiet night" responses suggest nearby neighborhoods with events

### Atomic Session Frames (2026-02-21)

- `setResponseState()` in session.js — atomically replaces all event-related fields, only preserves `conversationHistory`
- `saveResponseFrame()` in pipeline.js — wraps `setResponseState` with MORE accumulation logic
- `applyFilters()` moved to pipeline.js with `strict` mode (soft fallback vs hard filter)
- `resolveActiveFilters()` in pipeline.js — unified filter resolution across all 4 handlers
- `buildEventMap()` / `buildExhaustionMessage()` in pipeline.js — replaced inline patterns
- All 4 event-serving handlers migrated from merge-based `setSession` to atomic `setResponseState`
- 4 no-picks transition paths (quiet night, free exhaustion, nudge exhaustion) now clear stale picks
- Fixed: missing `lastFilters` on handleMore perennial path, missing `allOfferedIds`/`visitedHoods` on handleFree and handleNudgeAccept
- Added 13 unit tests for atomic replacement behavior

### Filter Drift Fixes (2026-02-21)

- `handleMore`: added `applyFilters(allRemainingRaw, activeFilters, { strict: true })` pre-filtering
- `handleEventsDefault`: added soft category pre-filtering
- `applyFilters`: added `{ strict }` option for strict category matching
- Exhaustion messages: now mention active filters ("That's all the free comedy picks...")
- Gemini routing: bumped maxOutputTokens 256→1024, added parse-failure fallback to Anthropic
- Test infra: `PULSE_NO_RATE_LIMIT` env var, bumped test mode budget to $10
- Added 21 multi-turn eval scenarios (11 filter_drift, 10 multi-turn lifecycle)

### Infrastructure

- **Source registry** — Single `SOURCES` config array in events.js drives all fetch/merge/health logic
- **Cross-source dedup** — Event IDs hashed from name+venue+date (source-agnostic)
- **Venue auto-learning** — Sources with lat/lng teach venue coords to shared map at scrape time
- **Venue persistence** — Learned venues saved to `data/venues-learned.json`, 175+ venues
- **Perennial picks** — Curated JSON of reliably-good venues by neighborhood + day
- **Source health dashboard** — `/health` endpoint with per-source timing, status, history sparklines
- **Deterministic pre-router** — Greetings, details, more, free, neighborhoods, follow-up filters resolved without AI
- **Session-aware follow-up filters** — "how about theater", "later tonight" deterministically matched
- **Conversation history** — Session tracks last 6 turns, threaded into compose prompt
- **AI trust hierarchy** — All 18 sources listed in compose prompt with weights
- **Source health alerting** — Email alerts via Resend when sources fail 3+ consecutive scrapes
- **Security middleware** — Helmet (CSP, HSTS, X-Frame-Options) + `trust proxy` for Railway

---

## Open Issues

### Medium Priority — Routing Gaps

Eval run (2026-02-21, 27/43 = 62.8%) revealed several messages the pre-router and AI router fail to handle:

| Message | Expected | Actual | Fix area |
|---------|----------|--------|----------|
| "anything tonight?" | Warm prompt for neighborhood | "Sorry, I didn't catch that" error | Pre-router: add vague-opener pattern |
| "nah" / "nah im good" | Graceful decline of suggestion | "Sorry, I didn't catch that" error | Pre-router: add decline patterns (nah, no thanks, im good) |
| "free jazz tonight" (no hood) | Ask for neighborhood, preserve filters | "Sorry, I didn't catch that" error | AI router: compound filter without neighborhood |
| "underground techno in bushwick" | Serve closest matches with honest framing | "Sorry, I didn't catch that" error | AI router: sub-genre + neighborhood compound |
| "what time is it" | Playful deflection | "Sorry, I didn't catch that" error | Pre-router or AI router: off-topic deflection |
| "any more free comedy stuff" | Continue compound filter session | "Sorry, I didn't catch that" error | AI router: compound follow-up with active session |
| "any other trivia options in bk" | Search trivia across borough | "Sorry, I didn't catch that" error | AI router: category + borough follow-up |

### Medium Priority — Bugs

| ID | Issue | Impact | Notes |
|----|-------|--------|-------|
| NEW | Scraper `source_weight` hardcoded in 14 files | Dead code — now overridden by SOURCES registry | Remove hardcoded weights |
| ~~NEW~~ | ~~Jazz/rock/indie/folk all map to `live_music`~~ | ~~Category taxonomy too coarse~~ | Moved to Migration Step 2 |
| NEW | MORE sometimes repeats events from initial batch | Williamsburg MORE repeated "Cassian at Brooklyn Storehouse" | Possible exclude-IDs gap in handleMore |
| NEW | "later tonight" time filter repeats same event | Hell's Kitchen "later tonight" returned same event again | Time filter not excluding already-shown events |
| NEW | Comedy in Midtown — details fail after thin results | "1" returns "no picks loaded" after being offered pick 1 | Session state gap: thin/no-comedy response may not save picks |

### Deferred (post-MVP)

| ID | Issue | Why deferred |
|----|-------|-------------|
| C6 | Concurrent session race conditions | Rare at current traffic |
| M1 | All in-memory state lost on restart | Fine for single-process MVP |
| M11 | No processing ack during slow Claude calls | Adds extra Twilio cost per message |
| L1 | No horizontal scalability | Single-process fine at current traffic |
| L5 | No structured logging or correlation IDs | Operational improvement for scale |
| L21 | No integration tests or mocking | Important eventually, not blocking |

---

## Source Coverage

### Current Sources (18)

| Source | Weight | Method | Strength |
|--------|--------|--------|----------|
| Skint | 0.9 | HTML → Claude | Free/cheap curated picks |
| Nonsense NYC | 0.9 | HTML → Claude | Underground/DIY/weird |
| RA | 0.85 | GraphQL API | Electronic/dance/nightlife |
| Oh My Rockness | 0.85 | HTML → Claude | Indie/rock/punk |
| Dice | 0.8 | `__NEXT_DATA__` JSON | Ticketed shows, DJ sets |
| BrooklynVegan | 0.8 | DoStuff JSON | Free shows, indie/rock |
| BAM | 0.8 | JSON API | Film, theater, music, dance |
| SmallsLIVE | 0.8 | AJAX HTML | Jazz (Smalls + Mezzrow) |
| Yutori | 0.8 | Gmail API + file briefings → Claude | Curated newsletters/agent briefings |
| NYC Parks | 0.75 | Schema.org | Free parks/outdoor events |
| DoNYC | 0.75 | Cheerio HTML | Music, comedy, theater |
| Songkick | 0.75 | JSON-LD | Concerts/music |
| Ticketmaster | 0.75 | Discovery API | Indie filter: venue blocklist + $100 cap |
| Eventbrite | 0.7 | JSON-LD / `__SERVER_DATA__` | Broad aggregator |
| NYPL | 0.7 | Eventbrite organizer | Free library events |
| EventbriteComedy | 0.7 | Same parser, comedy URL | Comedy-specific |
| EventbriteArts | 0.7 | Same parser, arts URL | Art-specific |
| Tavily | 0.6 | Web search → Claude | Free events catch-all |

### Category Gaps

| Category | Coverage | Gap |
|----------|----------|-----|
| Electronic/dance | Strong (RA, Dice) | — |
| Indie/rock/punk | Good (OMR, Songkick, BrooklynVegan) | OMR scraper fragility |
| Comedy | Moderate (EventbriteComedy, DoNYC) | No dedicated comedy source |
| Art/galleries | Weak (EventbriteArts, Skint) | No gallery opening calendar |
| Theater | Moderate (DoNYC, BAM) | No Broadway/off-Broadway source |
| Underground/DIY | Single source (Nonsense NYC) | If it breaks, entire vibe gone |
| Jazz | Good (SmallsLIVE, Skint, DoNYC) | — |

---

## Feature Roadmap

### Near-term — Source + Quality

- **Comedy source** — Dedicated scraper for Comedy Cellar, UCB, Caveat, QED
- **Gallery/art source** — Gallery listing aggregator or DoNYC art category
- **Scraper cleanup** — Remove hardcoded `source_weight` from individual scraper files

### Medium-term — Intelligence

- **Scout worker** — Background process to fill neighborhood gaps after daily scrape
- **Perennial picks evolution** — Auto-detect candidates from scrape data (venues appearing 3+ times/month)
- **Second daily scrape** — 5pm ET pass catches events posted mid-day

### Long-term — Infrastructure + Product

- **PostgreSQL** — Persistent event storage, user sessions, conversation history
- **Preference learning** — Track detail requests and neighborhood revisits, adjust taste profile
- **Paid tier** — Stripe billing, $5-10/month unlimited
- **Push notifications** — "Free rooftop thing near you starting in 30 min"
- **Multi-city** — Same architecture, different sources

---

## Not Building

- Happy hours / venue busyness / bar discovery — different product
- Yelp/Foursquare venue DB — venue discovery != event discovery
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- General web crawling — whitelist sources only
- Real-time scraping — SMS users don't need sub-daily freshness
