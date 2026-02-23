# Pulse — Roadmap

> Single source of truth for architecture principles, evolution strategy, open issues, and planned work.
> Last updated: 2026-02-22

---

## Architecture Principles

These principles govern how Pulse splits work between deterministic code and LLM calls. They were developed from regression eval failures, reviewed across multiple models, and represent consensus.

### P1. Code Owns State, LLM Owns Language

The LLM is never the system of record for structured data. Session state, filters, neighborhood resolution, event selection logic — all owned by deterministic code. The LLM reads well-formed tagged inputs and produces natural language output.

**In practice:** `mergeFilters()` compounds filters deterministically. `buildTaggedPool()` tags matching events with `[MATCH]` (hard match) or `[SOFT]` (broad category match where subcategory is set — e.g. jazz within live_music). The LLM sees the tagged pool and writes copy — it doesn't manage or report filter state.

**Anti-pattern:** Reading `filters_used` from LLM output and merging it into session state. This makes the LLM a secondary source of truth. If it hallucinates a filter, we persist it. We tried this (2026-02-22) and reverted it because it violates this principle.

### P2. Separate Reasoning from Rendering

If the LLM must both understand intent and write compelling copy, those should be separate operations. The reasoning pass returns a small validated struct. The rendering pass takes well-formed data and returns text.

**Current state:** One unified Haiku call does both. Its output contract has 4 structured fields — `type`, `sms_text`, `picks`, `clear_filters`. Step 3 removed the 4 redundant state-management fields (`filters_used`, `neighborhood_used`, `suggested_neighborhood`, `pending_filters`).

**Target state:** Reasoning call → `{ type, picks[], clear_filters }` (3 fields, validated via tool_use). Rendering call → `sms_text` (pure copy, lightweight parser). Everything else derived by code.

**Constraint:** The previous two-call architecture was abandoned because calls disagreed on state. The new split must have code own all state between calls — nothing from reasoning output passes to the rendering call except event data.

### P3. Extract at the Boundary, Then Trust Internal Types

Wherever the LLM produces structured data, validate and normalize it once at the ingestion boundary. After that boundary, internal code trusts internal types. Don't normalize some LLM fields and trust others — inconsistent validation is worse than none.

**In practice:** `normalizeFilters()` maps subcategories to canonical values (jazz→live_music) at the boundary. This should apply uniformly to every structured field the LLM returns.

### P4. One Save Path, Not Parallel Paths That Must Agree

Every code path that sends an SMS must end with the same atomic session save function. No hand-built `setSession` merges, no conditional field sets, no paths that "forget" to save filters.

**Current state (12 save sites):** 8 `setSession` merges + 4 `saveResponseFrame` atomics. Each `setSession` sets a different subset of fields. Every bug in the P1 regression traced to a path that saved state differently.

**Target state (2 categories):** Ephemeral writes (staging before LLM call) use `setSession`. Terminal writes (after every SMS send) use `saveResponseFrame`. No exceptions.

### P5. Minimal LLM Output Contract

Every structured field in the LLM output is a surface for hallucination and drift. Fields the code already knows before calling the LLM should never be in the LLM's output schema.

**Done (step 3, 2026-02-22):** Removed `filters_used`, `neighborhood_used`, `suggested_neighborhood`, `pending_filters` from `unifiedRespond`. Contract reduced from 8 to 4 fields: `type`, `sms_text`, `picks`, `clear_filters`.

### P6. Deterministic Extraction Covers Common Cases

Don't rely on the LLM for structure that pattern matching can handle. Reserve the LLM for genuinely ambiguous language (vibes, implicit intent, complex references).

**Pattern-matchable (should be in pre-router):** "free comedy", "late jazz", "free stuff tonight", "comedy in bushwick"

**Genuinely needs LLM:** "something lowkey", "what would you recommend for a first date", "that jazz thing from earlier"

**Risk mitigation:** The pre-router is additive — it returns detected filters for the LLM to see in the tagged pool. If it misses a compound, the LLM still sees untagged events and can select freely. Silent failure degrades to "unfiltered picks" rather than "wrong picks."

### P7. Validate the Contract, Not the Content

Validate structural contracts in the hot path (is `type` one of three values? do `picks[].event_id` values exist in the pool?). Let evals catch quality issues offline.

**Done (2026-02-22):** Event ID validation added — `validPicks` filters `result.picks` against `eventMap` before session save.

---

## Architecture v2: Pipeline + Structured Session

### Why

Eval results revealed three root architectural patterns causing failures:

1. **Split-brain filtering** — Filtering reimplemented across 4 handlers with different behavior. No single enforcement layer. Category taxonomy too coarse (jazz→live_music includes rock/indie/folk).

2. **Flat session merge** — `setSession` does `{ ...existing, ...data }`. If a handler doesn't explicitly set a field, the previous value persists. When a response has no picks, old picks survive and details returns stale data.

3. **Geographic pool vs semantic scope** — `getEvents(hood)` returns events by proximity radius. When MORE exhausts in-hood events, it shows nearby-neighborhood events without telling the user.

### Target Architecture

```
message → pre-router (compound extraction) → filter merge → tagged pool
  → LLM-reason(type, picks, clear_filters) → validate boundary → code derives all state
  → LLM-render(events + context → sms_text) → atomic save → SMS
```

Every handler becomes a thin context builder. The pipeline handles everything else uniformly.

### Migration Path

| Step | What | Principle | Fixes | Status |
|------|------|-----------|-------|--------|
| 1a | Atomic session frames — `setResponseState()` | P4 | Stale picks, nudge context | **Done** |
| 1b | Unify all session saves — every SMS path ends with `saveResponseFrame` | P4 | All stale-state bugs; `ask_neighborhood` and filter-clearing paths | **Done** |
| 1c | Validate event IDs against pool before save | P7 | Hallucinated event IDs | **Done** (with 1b) |
| 2 | Compound pre-router extraction — "free comedy", "late jazz", "comedy in bushwick" | P1, P6 | Compound filter persistence (P1 regression) | **Done** |
| 3 | Derive state fields deterministically — remove `filters_used`, `neighborhood_used`, `suggested_neighborhood`, `pending_filters` from LLM | P1, P5 | Contract bloat (8→4 fields) | **Done** |
| 4 | Reasoning/rendering split — separate intent+selection from copywriting | P2, P5 | Contract fully minimized; clean separation | Needs A/B eval |
| 5 | ~~Remove `filters_used` from LLM contract~~ | P1 | ~~Completes code-owns-state~~ | **Done** (merged into step 3) |
| 6 | Finer category taxonomy — split `live_music` into jazz/rock/indie/folk | — | 3 jazz→live_music eval failures | **Done** (three-tier soft match) |
| 7 | `executeQuery(context)` pipeline — thin handlers, single filter path | P4 | Prevents split-brain filtering from recurring | Planned |
| 8 | Scoped event fetching — `neighborhood`/`borough` scope | — | Geographic bleed in MORE | Planned |

Steps 1-3 are safe incremental improvements with no behavior change. Step 4 is a structural bet requiring A/B evaluation. Steps 5-8 build on the foundation.

### Decisions Made

**Use `tool_use` for reasoning call (step 4).** The 1% JSON parse failure rate matters more on the reasoning call because `type`, `picks[]`, `clear_filters` drive code execution directly. Keep the lightweight regex parser for the rendering call where the only output is text.

**No hybrid approach.** Considered keeping unified call for simple messages and splitting only for compound/filter-heavy. Rejected because maintaining two modes creates the path divergence P4 warns against.

**Nothing from reasoning passes to rendering except event data.** If we find ourselves passing `result.type` or `result.clear_filters` into the render prompt, we've recreated the old two-call problem.

---

## Step 1a: Atomic Session Frames (done, 2026-02-21)

Added `setResponseState(phone, frame)` to `session.js` — atomically replaces all event-related fields (picks, events, filters, pending state), only preserves `conversationHistory`. Extracted shared utilities into `pipeline.js`:

- `applyFilters(events, filters, { strict })` — unified filter with soft/strict modes
- `resolveActiveFilters(route, session)` — single filter resolution: route > pending > session > fallback
- `saveResponseFrame(phone, opts)` — atomic session save wrapping `setResponseState`
- `buildEventMap(events)` / `buildExhaustionMessage(hood, opts)` — replaced inline patterns

All 4 event-serving handlers migrated from merge-based `setSession` to atomic `setResponseState`. Added 13 unit tests for atomic replacement behavior.

## Step 1b: Unify All Session Saves (done, 2026-02-22)

**Goal:** Every code path that sends an SMS ends with `saveResponseFrame`. Eliminate `setSession` as a terminal write.

**Changes made:**

- **handler.js:452-456** — Removed `setSession` filter wipe / pending cleanup. Replaced with `activeFilters = {}` when `clear_filters` is true. Downstream `saveResponseFrame` calls now naturally persist empty filters and clear pending state (since `saveResponseFrame` sets pending fields to null unless explicitly provided).
- **handler.js:460-475** — `ask_neighborhood` now passes `pendingMessage` through `saveResponseFrame` instead of a separate `setSession({ pendingMessage })` call.
- **pipeline.js** — `saveResponseFrame` now accepts and passes through `pendingMessage` to `setResponseState`.
- **handler.js:497-498** — Added P7 event ID validation: `validPicks = result.picks.filter(p => eventMap[p.event_id])` before session save.

**Remaining `setSession` calls (5, all ephemeral staging):**

| Location | Purpose | Why kept |
|----------|---------|----------|
| handler.js:270 | Session init | Creates session before history tracking |
| handler.js:287 | `clear_filters` pre-route | Wipes filters before unified branch computes `activeFilters` |
| handler.js:329 | Clear pending on pre-routed intent | Clears nudge state before help/conversational/details handlers |
| handler.js:355 | Inject pre-detected filters | Stages filters for unified branch |
| handler.js:373 | Clear stale pending on new neighborhood | Prevents stale pending from affecting new hood query |

All 5 are pre-LLM staging — they set up state that the downstream `saveResponseFrame` will atomically replace.

---

## Open Issues

### P1 — Filter Persistence (was 50%, expected fixed)

**Fixed by step 2** (compound pre-router extraction, 2026-02-22). The pre-router now detects multi-dimension compounds ("free comedy", "late jazz", "comedy in bushwick") via word-boundary matching on free/time/category signals + `extractNeighborhood`. Requires 2+ filter dimensions OR 1 filter + detected neighborhood to trigger. Filters are persisted deterministically — no LLM involvement.

**Previous root cause:** The pre-router only detected single-dimension filters. Compounds fell through to the unified LLM, which picked correctly but didn't persist filters.

**Needs verification:** Run regression evals (`--principle P1`) against live server to confirm improvement from 50%.

### P10 — Explicit Filter Removal (regression at 33%)

Users saying "forget the comedy" or "show me everything" should clear filters. The pre-router catches common phrases, but semantic clearing ("just show me what's good") depends on the LLM's `clear_filters: true` response field.

**Status:** Pre-router regex covers the common cases. LLM semantic clearing works when it fires. The 33% failure rate needs investigation — may be pre-router regex gaps or LLM inconsistency.

### P5 — Temporal Accuracy (regression at 25%)

Events labeled "tonight" that are actually tomorrow, or vice versa. Root cause unclear — may be timezone handling, scraper date tagging, or compose prompt confusion.

**Status:** Needs investigation. Not related to the filter persistence architecture.

### Medium Priority — Routing Gaps

| Message | Expected | Actual | Fix area |
|---------|----------|--------|----------|
| "anything tonight?" | Warm prompt for neighborhood | Error | Pre-router: vague-opener pattern |
| "nah" / "nah im good" | Graceful decline | Error | Pre-router: decline patterns |
| "free jazz tonight" (no hood) | Ask for neighborhood, preserve filters | **Fixed** | Step 2: compound extraction (2026-02-22) |
| "underground techno in bushwick" | Closest matches | **Fixed** | Step 2: compound extraction (2026-02-22) |
| "any more free comedy stuff" | Continue compound session | **Fixed** | Step 2: compound extraction (2026-02-22) |
| "any other trivia options in bk" | Borough-wide search | Error | Step 2 + borough support |

### Medium Priority — Bugs

| Issue | Impact | Notes |
|-------|--------|-------|
| Scraper `source_weight` hardcoded in 14 files | Dead code — overridden by SOURCES registry | Remove hardcoded weights |
| MORE sometimes repeats events from initial batch | Possible exclude-IDs gap in handleMore | Needs investigation |
| "later tonight" time filter repeats same event | Time filter not excluding already-shown events | Needs investigation |
| Comedy in Midtown — details fail after thin results | Session state gap: thin response may not save picks | May be fixed by step 1b |

### Deferred (post-MVP)

| Issue | Why deferred |
|-------|-------------|
| Concurrent session race conditions | Rare at current traffic |
| All in-memory state lost on restart | Fine for single-process MVP |
| No processing ack during slow Claude calls | Adds extra Twilio cost |
| No horizontal scalability | Single-process fine at current traffic |
| No structured logging or correlation IDs | Operational improvement for scale |
| No integration tests or mocking | Important eventually, not blocking |

---

## Completed Work

### Atomic Session Frames (2026-02-21)

- `setResponseState()` in session.js — atomic replacement of all event-related fields
- `saveResponseFrame()` in pipeline.js — wraps `setResponseState` with MORE accumulation
- All 4 event-serving handlers migrated from merge-based `setSession` to atomic save
- 4 no-picks transition paths now clear stale picks
- 13 unit tests for atomic replacement behavior

### Compound Pre-Router Extraction (2026-02-22)

- Word-boundary matching extracts free (`\bfree\b`), time (`\btonight\b`, `\blate\b`, `\bafter midnight\b`), and category (shared `catMap`) signals from any message
- `extractNeighborhood()` detects neighborhood mentions ("comedy in bushwick")
- Triggers when 2+ filter dimensions detected, OR 1 filter + detected neighborhood
- Falls through to unified LLM for single-dimension messages without session/hood context (bare "jazz", "free", "tonight")
- 60+ test cases covering: category+free, category+time, category+hood, free+time, triple compounds, midnight, complex multi-signal messages
- Fixes P1 filter persistence regression — compound filters now persisted deterministically
- Fixes 3 routing gaps: "free jazz tonight", "underground techno in bushwick", "any more free comedy stuff"

### Three-Tier Soft Match for Tagged Pool (2026-02-22)

- `eventMatchesFilters()` now returns `'hard'` / `'soft'` / `false` instead of boolean
- `buildTaggedPool()` returns `hardCount` + `softCount` alongside `matchCount`
- `subcategory` field added to filter objects — preserved through `mergeFilters()`, `normalizeFilters()`, and pre-router
- Pre-router `catMap` broken into objects with optional `subcategory` (e.g. jazz → `{ category: 'live_music', subcategory: 'jazz' }`)
- `[SOFT]` tag tier in event pool — LLM uses judgment to select sub-genre matches from broad category
- Prompt updated: `[MATCH]` = verified match (must prefer), `[SOFT]` = broad match (read event details to judge fit)
- Fixes step 6 (finer category taxonomy) without fragmenting the category system

### Unified LLM + Tagged Pool (2026-02-21)

- Single `unifiedRespond` Haiku call replaces two-call route+compose flow
- `buildTaggedPool()` tags filter-matched events with `[MATCH]`, provides `isSparse` flag
- `mergeFilters()` compounds filters across turns deterministically
- Pre-router filter detection injects `preDetectedFilters` into unified branch
- A/B eval: Haiku unified matched Sonnet compose (71% preference, 89% tone) at 73% lower cost

### Derive State Fields Deterministically — Step 3 (2026-02-22)

- Removed 4 redundant fields from `unifiedRespond` LLM output contract: `filters_used`, `neighborhood_used`, `suggested_neighborhood`, `pending_filters`
- Unified output contract now has 4 fields: `type`, `sms_text`, `picks`, `clear_filters`
- Handler derives `suggestedHood` deterministically from `isSparse && nearbyHoods[0]`
- Handler uses resolved `hood` directly instead of reading `neighborhood_used` from LLM
- `ask_neighborhood` path uses `activeFilters` instead of LLM-reported `pending_filters`
- `nearbySuggestion` skill updated: dynamic prompt injects specific hood name instead of asking LLM to report it in JSON
- Also subsumes step 5 (`filters_used` removal) — field was already dead code after Bug 1 revert

### Conversational + Empty Picks Atomic Save (2026-02-22)

- Conversational and empty-picks unified branch paths converted from `setSession` merge to `saveResponseFrame`
- `ask_neighborhood` path converted from `setSession` to `saveResponseFrame` + targeted `setSession` for `pendingMessage`
- `normalizeFilters()` added to pipeline.js for future use in step 2 compound extraction
- 35 unit tests for `normalizeFilters`

### Filter Drift Fixes (2026-02-21)

- `handleMore`: strict category pre-filtering
- `handleEventsDefault`: soft category pre-filtering
- `applyFilters`: `{ strict }` option
- Exhaustion messages mention active filters
- Gemini routing: bumped maxOutputTokens, parse-failure fallback to Anthropic

### Code Quality (23 original + 15 UX issues — all fixed)

- Timezone-aware date parsing, TCPA opt-out, null-safe parsing, SMS timeout
- Session TTL 2hr, Express body limit 5kb, rate limiter with feedback
- Legacy flow removed, borough-aware nudges, conversation history threading

### Infrastructure

- 18-source scraper registry with cross-source dedup and venue auto-learning
- Source health dashboard with alerting
- Deterministic pre-router handling ~15% of messages at zero AI cost
- Composable prompt skills (12 conditional modules)
- Request tracing with JSONL + in-memory ring buffer

---

## Source Coverage

### Current Sources (18)

| Source | Weight | Method | Strength |
|--------|--------|--------|----------|
| Skint | 0.9 | HTML → Claude | Free/cheap curated picks |
| Nonsense NYC | 0.9 | Newsletter → Claude | Underground/DIY/weird |
| RA | 0.85 | GraphQL | Electronic/dance/nightlife |
| Oh My Rockness | 0.85 | HTML → Claude | Indie/rock/punk |
| Dice | 0.8 | `__NEXT_DATA__` JSON | Ticketed shows, DJ sets |
| BrooklynVegan | 0.8 | DoStuff JSON | Free shows, indie/rock |
| BAM | 0.8 | JSON API | Film, theater, music, dance |
| SmallsLIVE | 0.8 | AJAX HTML | Jazz (Smalls + Mezzrow) |
| Yutori | 0.8 | Gmail + file briefings → Claude | Curated newsletters |
| NYC Parks | 0.75 | Schema.org | Free parks/outdoor events |
| DoNYC | 0.75 | Cheerio HTML | Music, comedy, theater |
| Songkick | 0.75 | JSON-LD | Concerts/music |
| Ticketmaster | 0.75 | Discovery API | Indie filter: blocklist + $100 cap |
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

- Comedy source — Dedicated scraper for Comedy Cellar, UCB, Caveat, QED
- Gallery/art source — Gallery listing aggregator or DoNYC art category
- Scraper cleanup — Remove hardcoded `source_weight` from individual files

### Medium-term — Intelligence

- Scout worker — Background process to fill neighborhood gaps after daily scrape
- Perennial picks evolution — Auto-detect candidates from scrape data
- Second daily scrape — 5pm ET pass catches events posted mid-day
- Borough + multi-day queries — "what's in brooklyn this weekend?"

### Long-term — Infrastructure + Product

- PostgreSQL — Persistent event storage, user sessions, conversation history
- Preference learning — Track detail requests and revisits, adjust taste profile
- Paid tier — Stripe billing, $5-10/month unlimited
- Push notifications — "Free rooftop thing near you starting in 30 min"
- Multi-city — Same architecture, different sources
- SQLite user profiles — implicit personalization, "my usual", weekend digest

---

## Not Building

- Happy hours / venue busyness / bar discovery — different product
- Yelp/Foursquare venue DB — venue discovery != event discovery
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- General web crawling — whitelist sources only
- Real-time scraping — SMS users don't need sub-daily freshness
