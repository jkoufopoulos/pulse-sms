# Pulse — Roadmap

> Single source of truth for architecture principles, evolution strategy, open issues, and planned work.
> Last updated: 2026-02-24

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

### P5 — Temporal Accuracy (was 25%, expected fixed)

**Fixed by hard time gate (2026-02-22).** When users say "later tonight" or "after midnight", the system correctly detected `time_after` and tagged matching events with `[MATCH]` — but the LLM still picked pre-time events because `buildTaggedPool` included time-failing events as unmatched padding and `filterByTimeAfter` was a soft filter that fell back to all events when zero passed.

**Root cause:** Time was enforced as a soft signal (tagged pool + soft fallback) rather than a hard gate. Per P1 (code owns state), events before `time_after` should never reach the LLM.

**Fix:** Three changes: (1) `failsTimeGate()` extracted in pipeline.js — `buildTaggedPool` pre-filters events before classification, so time-failing events never enter the pool. (2) `filterByTimeAfter` in geo.js made hard — returns empty array instead of falling back to all events. (3) `handleMore` now applies `filterByTimeAfter` after the in-hood filter, closing the MORE path leak.

**Needs verification:** Run regression evals (`--principle P5`) against live server to confirm improvement from 25%.

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
| ~~Scraper `source_weight` hardcoded in 14 files~~ | ~~Dead code — overridden by SOURCES registry~~ | **Fixed** (2026-02-22) |
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

### Eval System Fix: Judge Calibration, Golden Fixes, Difficulty Tiers (2026-02-23)

- **Judge prompt** — 4 new grading rules in `JUDGE_SYSTEM` (sign-offs, nearby expansion, thin coverage, MORE numbering)
- **Golden renumbering** — 17 pulse turns after MORE fixed from sequential (4-6) to restarted (1-3) numbering
- **Sign-off goldens** — 10 terse sign-offs ("enjoy!") replaced with warm-but-brief versions ("Enjoy! Hit me up anytime you want more picks.")
- **Failure modes** — 8 failure_modes updated (e.g. "Awkward sign-off" → "Robotic or excessively long sign-off (3+ sentences)")
- **Difficulty tiers** — 4 cache-dependent scenarios downgraded must_pass → should_pass. Now 26/72/32 must/should/stretch.
- **Result**: Pass rate 35.4% → 53.8% (46→70 of 130). must_pass 81%. Remaining failures are real product bugs, not eval noise.

### Alert History Import (2026-02-23)

- `scripts/import-alert-history.js` — One-off script to backfill `data/alerts.jsonl` from historical Gmail alert emails
- Uses `fetchEmails()` from `src/gmail.js` (same pattern as nonsense.js/yutori.js scrapers)
- Parses email subject to classify health vs runtime alerts, strips HTML from body
- Dedup: skips entries with matching subject within 1-minute window (safe to re-run)
- Imported 29 alerts (9 health, 20 runtime) spanning Feb 19–22 — dashboard now shows full history

### Code Health: Steps 7, 8, Scraper Cleanup (2026-02-22)

- **Decompose `handleMessageAI`** — Extracted 4 sub-functions (`dispatchPreRouterIntent`, `resolveUnifiedContext`, `callUnified`, `handleUnifiedResponse`) from the 331-line orchestrator. Orchestrator now ~80 lines. Zero behavior change.
- **Break `ai.js` ↔ `formatters.js` circular dependency** — Moved `isSearchUrl` from `ai.js` to `formatters.js` (its natural home). Converted 3 deferred inline `require('./formatters')` calls in `ai.js` to a single top-level import. No more circular `require()`.
- **Remove dead `source_weight` from scrapers** — Removed hardcoded `source_weight` from 11 scraper files (13 occurrences). The SOURCES registry in `events.js` overwrites these unconditionally. Left `perennial.js` alone (not in registry, its value is authoritative).

### Referral Card & Acquisition Loop (2026-02-22)

- **Referral codes** (`src/referral.js`) — 8-char alphanumeric codes per phone+event pair, 7-day expiry, dedup, first-touch attribution. Persistence: `data/referrals.json` with hashed phone keys, debounced disk writes, 30-min cleanup interval.
- **Event card pages** (`src/card.js`) — Server-side rendered HTML at `/e/:eventId?ref=CODE` with OG meta tags for iMessage/WhatsApp link previews. Dark theme matching `site/index.html`. Platform-aware `sms:` URI (iOS `&body=` vs Android `?body=`). Stale card fallback when event not in cache.
- **Details flow wired** — `handleDetails` generates referral code and Pulse URL, passes to both `composeDetails` and fallback `formatEventDetails`. Only single-pick details get referral URLs (not multi-event summaries).
- **Referral intake** — Pre-router detects `ref:CODE` prefix (tight regex: 6-12 alphanumeric). Handler looks up code, records attribution, seeds preference profile with cold-start signal, sends onboarding SMS. Expired/invalid codes get generic onboarding. Zero AI cost.
- **P1 compliant** — All state deterministic. No LLM call in referral flow.
- **P4 compliant** — Referral path saves via `saveResponseFrame`.
- `getEventById(id)` added to `events.js` — linear scan of cache, sub-millisecond.
- `formatEventDetails` and `composeDetails` accept `{ pulseUrl }` option — backward-compatible signature change.
- `PULSE_CARD_DOMAIN` env var — configurable domain for card URLs, defaults to Railway URL.

### User Preference Profile (2026-02-22)

- `src/preference-profile.js` — silent background signal capture across sessions
- Tracks neighborhoods, categories, subcategories, price preference, time preference per phone number
- Fire-and-forget `updateProfile` after each `saveResponseFrame` — never blocks SMS response
- Signal only increments on `event_picks` and `more` responses (user got actual picks); `sessionCount` increments on every response
- Derived fields: `pricePreference` (free if >50% of picks sessions), `timePreference` (late/early if >50% of timed sessions)
- Persistence: `data/profiles.json` with debounced disk writes (1s), loaded at boot
- Helper functions: `deriveFiltersFromProfile`, `getTopNeighborhood`, `getTopCategories`, `getOptInEligibleUsers`
- Foundation for proactive Friday picks, personalization, and paid tier differentiation
- 30+ unit tests covering signal extraction, derivation rules, error handling, persistence

### Hard Time Gate — P5 Fix (2026-02-22)

- `failsTimeGate(event, timeAfter)` extracted in pipeline.js — same after-midnight wrapping logic, events without parseable times pass through
- `buildTaggedPool` pre-filters events through `failsTimeGate` before classification — time-failing events never enter the pool or reach the LLM
- Time check removed from `eventMatchesFilters` — enforced upstream, no double-checking
- `filterByTimeAfter` in geo.js made hard — returns empty array instead of soft fallback to all events
- `handleMore` in intent-handlers.js now applies `filterByTimeAfter` after in-hood filter, closing the MORE path time leak
- 20+ unit tests for `failsTimeGate` and `buildTaggedPool` time gating (including after-midnight wrapping, midnight filter, no-time passthrough)

### Atomic Session Frames (2026-02-21)

- `setResponseState()` in session.js — atomic replacement of all event-related fields
- `saveResponseFrame()` in pipeline.js — wraps `setResponseState` with MORE accumulation
- All 4 event-serving handlers migrated from merge-based `setSession` to atomic save
- 4 no-picks transition paths now clear stale picks
- 13 unit tests for atomic replacement behavior

### City-Wide Scan (2026-02-24)

- When user texts a filter query without a neighborhood ("where is there trivia tonight?"), Pulse now scans the full event cache and tells them which neighborhoods have matching events
- `scanCityWide(filters)` in events.js — pure JS over in-memory cache, no I/O, <1ms. Applies same quality gates as `getEvents()`, groups matches by neighborhood, returns top 5 sorted by count
- `cityScan` skill in compose-skills.js — guides LLM to present neighborhoods naturally ("I've got trivia tonight in East Village, Williamsburg, and Gowanus — which one?")
- Trigger: deterministic gate in `resolveUnifiedContext` — `hood === null` AND at least one substantive filter (category, free_only, or time_after). No scan when there are no filters (preserves existing ask_neighborhood behavior)
- Follow-up: user picks a neighborhood → existing `pendingFilters` + `pendingMessage` session flow serves filtered picks
- P1 compliant — scan is deterministic, LLM only composes natural language from scan results
- 5 files changed: events.js (+scanCityWide), handler.js (+scan gate), ai.js (+cityScanBlock in prompt), compose-skills.js (+cityScan skill), build-compose-prompt.js (+skill activation)

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
- ~~Scraper cleanup — Remove hardcoded `source_weight` from individual files~~ **Done** (2026-02-22)

### Medium-term — Intelligence

- Scout worker — Background process to fill neighborhood gaps after daily scrape
- Perennial picks evolution — Auto-detect candidates from scrape data
- Second daily scrape — 5pm ET pass catches events posted mid-day
- ~~Borough + multi-day queries — "what's in brooklyn this weekend?"~~ City-wide scan partially addresses this (see below)

### Long-term — Infrastructure + Product

- PostgreSQL — Persistent event storage, user sessions, conversation history
- Preference learning — Profile capture done; next: inject profile into compose prompt for personalized picks
- Referral analytics — Dashboard for referral code generation, card views, and conversion rates
- Paid tier — Stripe billing, $5-10/month unlimited
- Push notifications — "Free rooftop thing near you starting in 30 min"
- Multi-city — Same architecture, different sources
- SQLite user profiles — implicit personalization, "my usual", weekend digest

---

## Eval Suite Improvement

5-phase plan to make the eval suite reliable, grounded, and cost-efficient.

| Phase | What | Status |
|-------|------|--------|
| 1 | **Pin deterministic paths** — exact/contains assertions for pre-router responses, difficulty tiers (`must_pass`/`should_pass`/`stretch`), assertion-based eval skips LLM judge for fully-asserted scenarios | **Done** (2026-02-23) |
| 2+3 | **Golden data + rebalance** — expand parenthetical placeholders into golden examples via Claude, generate new scenarios to rebalance distribution toward 50/20/15/15 target | **Done** (2026-02-23) |
| 3.5 | **Judge calibration + golden fixes** — calibrate judge prompt, fix MORE numbering and terse sign-offs in goldens, downgrade cache-dependent `must_pass` scenarios | **Done** (2026-02-23) |
| 4 | **Difficulty tiers in practice** — `must_pass` failures block deploys, `should_pass` tracked as regression metric | Planned |
| 5 | **Stability baseline** — `--repeat N` flag, per-scenario variance measurement, noise floor identification | Planned |

**Phase 1 details (done):**
- 70 scenarios assigned difficulty tiers: 5 `must_pass`, 33 `should_pass`, 32 `stretch`
- 8 pulse turns pinned with assertions (5 `exact`, 3 `contains`) across 7 scenarios
- Eval runner checks assertions before LLM judge — assertion failures reported with expected vs actual
- `--difficulty` filter flag: `node scripts/run-scenario-evals.js --difficulty must_pass`
- Difficulty tier breakdown in summary output

**Phase 2+3 details (done):**
- `scripts/ground-scenarios.js` — two modes: expand parentheticals, generate new scenarios
- **Expand mode**: Uses Claude to write golden SMS responses for 106 parenthetical placeholder turns across 20 scenarios. Golden examples show ideal tone/structure/behavior for the LLM judge to compare against (events differ daily, judge grades behavior not content).
- **Generate mode** (`--generate N`): Creates new scenarios for under-represented categories. Computes generation plan against target distribution (50% happy_path, 20% filter_drift, 15% edge_case, 15% poor_experience). Prior distribution was 17% happy / 44% edge / 26% poor / 6% filter_drift.
- Flags: `--dry-run`, `--reground`, `--category`, `--name`, `--generate N`
- Validates generated scenarios (480-char limit, no parentheticals, required fields)

**Phase 3.5 details (done):**

First full 130-scenario eval run showed 35.4% pass rate (46/130). Analysis found ~24 of 84 failures were false failures from eval system issues. Three fixes applied:

1. **Judge prompt calibration** — Added 4 rules to `JUDGE_SYSTEM`: warm sign-offs acceptable (only fail 3+ sentences or robotic), nearby expansion is correct behavior, thin coverage handling judged on grace not event count, MORE restarts numbering at 1.
2. **Golden fixes** — 17 pulse turns renumbered after MORE (4→1, 5→2, 6→3), 10 terse sign-off goldens replaced with warm-but-brief versions matching real system output, 8 failure_modes updated to stop penalizing warm sign-offs, 1 failure_mode flipped for correct MORE numbering expectation.
3. **Difficulty downgrades** — 4 cache-dependent scenarios moved from `must_pass` to `should_pass`: Harlem jazz, FiDi→Brooklyn Heights, Prospect Heights MORE, Greenpoint quick pick. Tiers now: 26 must_pass, 72 should_pass, 32 stretch.

**Post-fix eval results (2026-02-23):** 70/130 passed (53.8%), consistent with estimated ~54% true pass rate. must_pass: 81% (21/26). By category: abuse_off_topic 100%, happy_path 69%, edge_case 61%, poor_experience 35%, filter_drift 23%. The 5 remaining must_pass failures are real product bugs (MORE errors, LIC not recognized). filter_drift at 23% is the dominant real product problem — filters consistently drop across neighborhood switches, MORE commands, and compound stacking.

---

## Not Building

- Happy hours / venue busyness / bar discovery — different product
- Yelp/Foursquare venue DB — venue discovery != event discovery
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- General web crawling — whitelist sources only
- Real-time scraping — SMS users don't need sub-daily freshness
