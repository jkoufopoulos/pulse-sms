# Pulse — Roadmap

> Single source of truth for architecture principles, evolution strategy, open issues, and planned work.
> Last updated: 2026-03-01 (SQLite store, pre-router filter fix)

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

### Filter Drift — Root Cause Analysis (2026-02-25)

**Status:** 2/26 scenarios passing (8%). The 2026-02-24 code fixes (mergeFilters, targeted clearing, CLEAR_SIGNALS guard, bare category, handleMore exhaustion) address **~4-6 of 24 failures**. Realistic estimate: **~25-33% pass rate** after fixes deploy. The 80% target requires work beyond filter state code.

**Analysis of all 24 failures by root cause:**

#### Cause A: LLM Composition Failure (8 scenarios) — code is correct, LLM ignores it

The filter state is correct. The tagged pool has `ACTIVE_FILTER` and `[MATCH]` tags. But when `matchCount === 0` (no events match the filter), the LLM shows unmatched events without acknowledging the active filter. This is the **single biggest failure category**.

| # | Scenario | What LLM does wrong |
|---|----------|---------------------|
| 4 | comedy across hood switch | Shows mixed Bushwick picks, ignores `ACTIVE_FILTER: comedy` |
| 11 | "what about comedy" | Says "comedy's not really my lane" despite comedy-tagged pool |
| 13 | live music → electronic/DJ | Picks nightlife events for live_music filter (category taxonomy gap) |
| 17 | jazz in cobble hill | Offers "film instead at BAM" — proactively abandons filter |
| 21 | comedy in cobble hill | Shows trivia/folk events despite comedy filter |
| 22 | free + live music | Shows karaoke (community) for live_music filter |
| 3 | free stacking | Shows 1 event as recommendation instead of filtered list |
| 18 | jazz in harlem → perennial | handleMore perennial path ignores active category (code bug, see Cause E) |

**Fix needed:** Prompt hardening in `UNIFIED_SYSTEM` — when `matchCount === 0` and `ACTIVE_FILTER` is set, the LLM MUST say "no [filter] in [hood] tonight" and offer alternatives, never silently show unfiltered events. This is the highest-impact change.

#### Cause B: Thin Data Coverage (7 scenarios) — no matching events exist

The filter persists correctly but the neighborhood has 0 events matching the filter. The system handles this gracefully ("not much jazz tonight") but the judge expects numbered picks. These are **not product bugs** — they're either data gaps or judge calibration issues.

| # | Scenario | Coverage gap |
|---|----------|-------------|
| 1 | free comedy in Red Hook | 0 free comedy events in Red Hook + nearby |
| 5 | jazz in Cobble Hill/Park Slope | 0 jazz events across 3 hoods on Monday |
| 9 | live music in Astoria | 0 live music events |
| 15 | free comedy in Harlem | 0 matching events → no picks saved → detail requests fail |
| 20 | late in Astoria | 0 late events on Monday |
| 24 | late night Crown Heights | 0 late events |
| 6 | free in Prospect Heights | 1 event, user says "6" (invalid pick number) |

**Fix needed:** Judge recalibration — pass scenarios where filter is acknowledged even with 0 picks. Separately, source coverage improvements help long-term. **Partial mitigation (2026-03-01):** Tavily live-search fallback now fires when cached events are exhausted, supplementing thin neighborhoods with live web search results.

#### Cause C: Semantic Partial Clearing (5 scenarios) — LLM can't partially modify filters

Users say "paid is fine too" or "show me paid ones too" (clear free_only, keep category). The LLM output contract has `clear_filters: boolean` (all-or-nothing). There's no way for the LLM to communicate *which* filter to clear. Our pre-router targeted clearing (Fix 2) only catches exact phrases like "forget the comedy", not semantic variants.

| # | Scenario | User phrase | Expected behavior |
|---|----------|-------------|-------------------|
| 8 | compound cleared partially | "paid is fine too" | Clear free_only, keep jazz |
| 12 | filter clear mid-compound | "paid is cool too just keep it jazz" | Clear free_only, keep jazz |
| 23 | price filter removal | "show me paid ones too" | Clear free_only, keep jazz |
| 16 | category removal preserves price | "actually just show me everything free" | Clear category, keep free_only |
| 7 | time filter cleared by 'anytime' | "what else is going on tonight" | Ambiguous — judge expects time clear |

**Fix needed:** Expand LLM contract: `clear_filters: string[]` (list of filter keys to clear). Handler maps keys to explicit nulls via `mergeFilters`. P1-sensitive: must validate LLM-reported keys against known filter names, never trust arbitrary strings.

**P1 tension:** This gives the LLM limited state-writing power (naming which filters to clear). Mitigated by: (1) whitelist validation — only accept `category`, `subcategory`, `free_only`, `time_after`, `vibe`; (2) LLM only clears, never sets filter values; (3) code still owns what the filter values *are*.

#### Cause D: Pre-Router Prefix/Filler Gaps (3 scenarios)

Conversational prefixes prevent the pre-router from catching intent.

| # | Scenario | User says | Why pre-router misses |
|---|----------|-----------|----------------------|
| 2 | comedy → jazz | "actually jazz" | "actually" prefix blocks bare category `^(?:jazz)$` |
| 19 | clear stacked filters | "nah lemme just see whats happening" | Not in CLEAR_SIGNALS. "whats happening" = clear intent |
| 14 | free filter survives pivot | MORE after 0 results | Fix 4 helps; thin coverage in NoHo is the real issue |

**Fix options (tradeoffs):**
- Add conversational prefixes ("actually", "hmm", "nah") to regex → increasingly brittle, risks false positives
- Add "whats happening" to CLEAR_SIGNALS → specific fix, low risk
- Accept that these are genuinely ambiguous and belong in the LLM path → principled per P6, but requires the LLM to report filter changes (see Cause C)

**P6 assessment:** "actually jazz" is arguably deterministic (the word "jazz" is unambiguous), but "nah lemme just see whats happening" is genuinely ambiguous language. Adding ever-more regex patterns to the pre-router violates the spirit of P6: "reserve the LLM for genuinely ambiguous language."

#### Cause E: handleMore / Perennial Path Issues (2 scenarios)

| # | Scenario | Issue |
|---|----------|-------|
| 10 | jazz → MORE → hood switch | Exhaustion + hood switch → "no picks loaded" for detail request |
| 18 | jazz → MORE → non-jazz perennial | Perennial path shows DJ venue for jazz-filtered session |

**Fix needed:** `handleMore`'s perennial fallback at line 196-231 should filter perennials by active category before composing. Pure code fix, P1-compliant, no LLM involvement. **Note (2026-03-01):** Tavily fallback now sits between perennial exhaustion and the final exhaustion message in `handleMore`, providing one more layer of content before dead-ending.

---

#### Summary: What Moves the Needle

| Lever | Scenarios fixed | Effort | Principle risk |
|-------|----------------|--------|----------------|
| **Prompt hardening for zero-match pools** | ~8 (Cause A) | Low — prompt change only | None |
| **Judge recalibration for thin coverage** | ~7 (Cause B) | Low — eval change only | None |
| **Partial filter clearing via `clear_filters: string[]`** | ~5 (Cause C) | Medium — LLM contract + handler | P1 tension (mitigated by whitelist) |
| **Perennial path filter respect** | ~2 (Cause E) | Low — pure code | None |
| **Pre-router prefix tolerance** | ~2 (Cause D) | Low but brittle | P6 tension |

Prompt hardening + judge recalibration alone would move pass rate from ~8% to ~50-60%. Adding partial clearing and perennial fix gets to ~70-80%.

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

### Yutori Extraction — Series Events Missing Times (2026-02-25)

**Status:** Partially addressed by SQLite recurring patterns (2026-03-01). 19 Yutori events in cache had null `start_time_local` and `date_local`.

**Root cause:** The extraction prompt in `src/prompts.js` has a rule: "For permanent venues with no specific date/time, set date_local and start_time_local to null." Claude interprets series/recurring events (e.g. "every Wednesday at 8pm", "running through March") as perennials and nulls their date/time fields, even when the newsletter text contains enough information to resolve a specific date.

**Partial fix (2026-03-01):** Added RECURRENCE DETECTION rules to extraction prompt — Claude now extracts `is_recurring`, `recurrence_day`, `recurrence_time` when explicitly stated. Yutori post-extraction `processRecurrencePatterns()` upserts these into the `recurring_patterns` table, which generates dated occurrences at serving time. This means "every Wednesday at 8pm" now produces concrete events with proper dates and times. However, non-recurring series events ("running through March") are not yet handled.

**Remaining gap:** Non-recurring series events and one-off Yutori events with dates >7 days out are now stored in SQLite (30-day window) but only appear in the serving cache when their date falls within the 7-day serving window. This is correct behavior — they'll surface when their date arrives.

### Price Data Gap — 71.6% Missing Across Sources (2026-02-25)

**Status:** 71.6% of events in the sent pool have no `price_display`. Worst offenders by source: DoNYC (96% missing), BAM (100%), RA (100%), Songkick (100%), SmallsLIVE (100%).

**Impact:** The `free_claim_accuracy` code eval can't fully verify free filter correctness when most events lack price data. Users asking for "free" events get results where we can't confirm pricing.

**Fix strategy:** Scraper-level improvements per source. Some sources have price data on detail pages but not list pages (would require extra fetches). Others genuinely don't expose pricing. Low priority — `is_free` boolean is more reliably populated than `price_display`.

### Deferred (post-MVP)

| Issue | Why deferred |
|-------|-------------|
| Concurrent session race conditions | Rare at current traffic |
| All in-memory state lost on restart | Mitigated: events now persist in SQLite, sessions still in-memory |
| No processing ack during slow Claude calls | Adds extra Twilio cost |
| No horizontal scalability | Single-process fine at current traffic |
| No structured logging or correlation IDs | Operational improvement for scale |
| No integration tests or mocking | Important eventually, not blocking |

---

## Completed Work

### SQLite Event Store + Recurring Patterns (2026-03-01)

Replaced the JSON-only event cache with SQLite (`data/pulse.db`) as a durable 30-day event store, while keeping the 7-day window at serving time. Recurring patterns table detects weekly events from Yutori extractions and generates occurrences automatically.

**Problem solved:** Yutori scouts find hundreds of events but Pulse only saw ~12 at any given time. Three compounding losses: (1) 7-day ingestion window killed 65% of Yutori events with dates >7 days out, (2) recurring events (weekly trivia, open mics) treated as one-offs and dropped when outside the window, (3) JSON cache only held the latest extraction batch.

**Changes:**
- `src/db.js` **(new)** — SQLite connection (WAL mode), schema (events + recurring_patterns tables), CRUD operations. `upsertEvents()` with higher-`source_weight`-wins conflict resolution. `generateOccurrences()` walks active patterns and emits event objects with `makeEventId` for natural dedup against scraped one-offs. Generated events get `source_weight: 0.65` (below all scraped sources). `importFromJsonCache()` for one-time migration.
- `src/events.js` — Boot tries SQLite first (auto-imports JSON cache on first boot), falls back to JSON. `refreshCache()` ingests 30-day window into SQLite, rebuilds 7-day serving cache from SQLite + recurring occurrences. `refreshSources()` same pattern. JSON cache still written for backward compat.
- `src/prompts.js` — Added RECURRENCE DETECTION rules and 3 fields (`is_recurring`, `recurrence_day`, `recurrence_time`) to `EXTRACTION_PROMPT`.
- `src/sources/shared.js` — `normalizeExtractedEvent()` carries `_raw` recurrence fields through for downstream pattern detection (transient, not persisted to events table).
- `src/sources/yutori.js` — Updated extraction preamble with recurrence guidance. Added `processRecurrencePatterns()` — scans for `_raw.is_recurring`, upserts to `recurring_patterns` table via `db.upsertPattern()`.
- `src/server.js` — `closeDb()` in shutdown.
- `test/unit/db.test.js` **(new)** — 17 tests: schema, upsert, weight conflict, date range, pruning, boolean/JSON round-trips, pattern lifecycle, occurrence generation, ID dedup consistency.

**Architecture notes:**
- Hot path unchanged — SMS requests read from in-memory `eventCache` only, never touch SQLite. SQLite is queried once per scrape to rebuild the serving cache.
- P1 compliant — recurring patterns are detected by extraction prompt + deterministic post-processing, not LLM state management.
- P4 compliant — no new session save paths.
- Recurring patterns have 6-month lifetime (`active_until = last_confirmed + 6 months`), `deactivated` flag for manual kills, and low `source_weight: 0.65` so scraped one-offs always win dedup.
- `better-sqlite3` native addon — compiles on Railway via Nixpacks. Fallback: entire SQLite layer is wrapped in try/catch, JSON cache still works if SQLite fails.

**Eval results (post-deploy):** Code evals 96.1-96.3% (unchanged from baseline). 7 scenario failures were transient 502s during Railway deploy — all passed on rerun. No regressions introduced.

### Pre-Router Filter Stacking Fix (2026-03-01)

Fixed a bug where pre-router filter detection would overwrite existing session filters instead of compounding them. When a user said "how about comedy" after already filtering for "free", the pre-router returned `{ ...base.filters, ...catInfo }` which spread `base.filters` (containing `category: null, free_only: null, time_after: null`) into the result, overwriting the session's existing `free_only: true` with `null`.

**Root cause:** `base.filters` contains all filter keys initialized to `null`. Spreading it into the returned filters object inserted explicit `null` values for every key, which `mergeFilters` interpreted as "explicitly clear this filter" (per the explicit-key semantics from the 2026-02-24 fix).

**Fix:** All pre-router filter detection paths now return only the detected filter keys (e.g. `{ category: 'comedy' }` instead of `{ ...base.filters, category: 'comedy' }`). Absent keys fall back to existing session filters via `mergeFilters` key-presence semantics, enabling proper compounding.

**Files changed:** `src/pre-router.js` — 11 return statements across filter detection (category, free, time, vibe) and targeted clearing paths.

### Tavily Live-Search Fallback for Exhausted Neighborhoods (2026-03-01)

When a user exhausts all cached events and perennials in a neighborhood, Tavily now fires as a last-resort live search before showing the dead-end exhaustion message. Three trigger conditions (all must be true): no unseen events in pool, user has already visited the hood, hood is known (not citywide). Adds ~5-13s latency only on exhaustion.

**Changes:**
- `pipeline.js` — `buildTavilyQuery(hood, filters)` builds filter-aware search strings (e.g. "free comedy events Bushwick NYC tonight"). `tryTavilyFallback(hood, filters, excludeIds, trace)` wraps `searchTavilyEvents`, filters already-shown events, records `trace.tavily_fallback` metadata, injects fresh results into the event cache via `injectEvents()`.
- `events.js` — `injectEvents(events)` merges live-fetched events into `eventCache` (dedup by ID, no disk persistence). Enriches the cache so subsequent requests also benefit.
- `handler.js` — Tavily fallback in `resolveUnifiedContext` after events + perennials are merged: if unseen count is 0 and hood is visited, fires `tryTavilyFallback` and merges results into the pool.
- `intent-handlers.js` — Tavily fallback in `handleMore` after perennial block exhausts: same trigger logic, composes/saves/sends following the perennial pattern.
- `sources/tavily.js` — Surfaced API errors: both `searchTavilyEvents` and `fetchTavilyFreeEvents` now parse error bodies on non-2xx responses and check for `detail.error` on 200s. Logs specific reason with `[TAVILY]` prefix (previously silent empty returns on usage limit, auth failures).

**Architecture notes:**
- P1 compliant — Tavily results are tagged `filter_match: false` (code owns state). The LLM composes from whatever pool it receives.
- P4 compliant — Both insertion points use existing `saveResponseFrame` paths.
- Circular dep avoided — `pipeline.js → events.js` uses late `require()` inside function body since `events.js` already imports from `pipeline.js`.
- Tavily daily scrape source was returning 0 events due to exhausted API plan (HTTP 432). Previously silent; now logged. Plan upgraded to paid tier.

### Filter Drift Fix — 5 Bugs Across 4 Files (2026-02-24)

Fixed the dominant product bug (filter_drift category at 23% pass rate). Five root causes identified and fixed:

1. **`mergeFilters` explicit-key semantics** (`pipeline.js`) — Rewrote from OR logic (`next.value || base.value`) to `'key' in next` check. If a key EXISTS in incoming (even `null`/`false`), it overrides. If ABSENT, falls back to existing. Enables: category replacement (`{category:'jazz'}` overrides `{category:'comedy'}`), partial clearing (`{category:null}` clears category only), free clearing (`{free_only:false}` explicitly turns off free filter). Backward-compatible: existing callers only set keys they detect.

2. **Targeted filter clearing** (`pre-router.js`) — Split single `clear_filters` regex into targeted + full branches. "forget the comedy" / "never mind the jazz" → extracts target, matches against `catMap`, returns `intent:'events'` with explicit null filter (feeds into `mergeFilters` for partial clear). "forget the free" → `{free_only:false}`. "forget the late" → `{time_after:null}`. Generic phrases ("nvm", "start over", "show me everything") → `intent:'clear_filters'` as before.

3. **LLM `clear_filters` guard** (`handler.js`) — `CLEAR_SIGNALS` regex gates the LLM's `clear_filters:true` against user message content. Prevents hallucination on normal conversational turns while preserving semantic clearing ("just show me what's good", "surprise me"). P1 compliant: code validates LLM claim against user input.

4. **handleMore exhaustion `saveResponseFrame`** (`intent-handlers.js`) — Final exhaustion path was sending SMS without calling `saveResponseFrame`, so `pendingNearby` was never set for nudge acceptance. Added `saveResponseFrame` before `sendSMS`.

5. **Bare category detection** (`pre-router.js`) — Added bare category matching ("comedy", "jazz", "theater", "comedy shows") after structured prefix check, within `lastNeighborhood` guard. Catches single-word categories that previously fell through to LLM without filter persistence. Excludes "tonight" suffix (falls through to compound extraction for category+time).

Test coverage: Updated `mergeFilters` tests for new explicit-key semantics (partial clearing, category replacement, free clearing). Added targeted clearing tests (category, free, time, subcategory). Added bare category tests. All 639 tests pass.

### Eval Fidelity: Factual Verification, Source Completeness, P10 Expansion (2026-02-24)

Phase 6+7 of the eval suite improvement plan — closes the gap between structural eval coverage and factual verification.

- **Factual verification evals** — Enriched trace picks with event metadata (name, venue, neighborhood, category, is_free, start_time_local) at both pick-enrichment sites in handler.js. Added `active_filters` and `pool_meta` (matchCount, hardCount, softCount, isSparse) to traces. Added `active_skills` list for prompt debugging.
- **4 new code evals** — `pick_count_accuracy` (numbered SMS items match picks), `neighborhood_accuracy` (picks are in claimed hood), `category_adherence` (≥75% match when filter active, with subcategory→category mapping), `free_claim_accuracy` (≥75% free when free filter active). Total evals: 15.
- **Price transparency eval** — Checks that event pick SMS text contains price/free mention. Catches the "no price info" gap (P4 had 1 regression assertion).
- **Schema compliance eval** — Checks LLM raw response is valid JSON with `sms_text` field. Detects the "hit a snag" fallback from JSON parse failures.
- **Source field-completeness eval** (`src/evals/source-completeness.js`) — Per-source field expectations for 13 structured sources. Universal checks (id, name, venue_name, is_free, category) + source-specific required fields (BAM: neighborhood=Fort Greene, SmallsLIVE: subcategory=jazz, etc.) + invariant checks (NYC Parks: is_free=true). Runs automatically after each scrape via `refreshCache`. Logs warnings per source with sample failures.
- **P10 clear_filters expansion** — Added 6 new regression scenarios (total: 10 P10 scenarios, 12 assertions). Tests pre-router exact patterns ("forget it", "nvm", "drop it"), LLM semantic clearing ("just show me what's good", "I'm open to anything"), and clear-then-reapply flows. Added 8 new pre-router unit tests including negative cases (prefix messages, compound messages).
- **Pre-router regex fix** — `forget the .+` and `never mind the .+` patterns changed from `.+` to `[a-z ]+` to prevent matching compound messages like "forget the comedy, how about jazz" (which should fall through to the LLM for proper handling).

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

### Event Mix Analytics on Health Dashboard (2026-02-28)

- `computeEventMix()` in `events.js` — aggregates event cache into date, category, neighborhood, free/paid, and source distributions. Added to `getHealthStatus()` return as `eventMix` field (available via `/health?json=1`).
- Health dashboard (`health-ui.html`) — new "Event Mix" section between summary cards and scrape timing. Four panels: date distribution (7 vertical bars, today highlighted), category distribution (horizontal bars, top 12), neighborhood distribution (horizontal bars, top 15), free vs paid (stacked bar with percentages). Pure CSS bars, no external libs, matches dark theme.
- First deploy shows: 1,625 events across 7 days, 9 categories, 36 neighborhoods, 11% free. Provides visibility into cache composition after expanding to 7-day scraping and 18 sources.

### Infrastructure

- 18-source scraper registry with cross-source dedup and venue auto-learning
- Source health dashboard with alerting and event mix analytics
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
| 6 | **Factual verification evals** — Enrich trace picks with event metadata, add 4 deterministic evals: pick_count_accuracy, neighborhood_accuracy, category_adherence, free_claim_accuracy | **Done** (2026-02-24) |
| 7 | **Eval fidelity gaps** — Tighten thresholds, add price/schema/pool-metadata evals (see gap table below) | In progress |

### Eval Fidelity Gaps

Gaps that separate the current eval system from high-fidelity production quality. Prioritized by impact on user-facing failures.

| # | Gap | Priority | Status | Notes |
|---|-----|----------|--------|-------|
| 1 | **Filter thresholds too lenient (50%)** — `category_adherence` and `free_claim_accuracy` pass when only half of picks match. Should be ≥75%. | P0 | **Done** (2026-02-24) | |
| 2 | **No price transparency eval** — Prompt promises price info but no eval verifies it appears in SMS text. P4 has only 1 regression assertion. | P0 | **Done** (2026-02-24) | |
| 3 | **No schema compliance eval** — `parseJsonFromResponse` has elaborate fallback logic but no metric on JSON parse failure rate. Failures produce "hit a snag" errors. | P0 | **Done** (2026-02-24) | |
| 4 | **Tagged pool metadata not on traces** — `matchCount`, `hardCount`, `softCount`, `isSparse`, active skills not captured. Can't diagnose whether failures are pool tagging or LLM selection. | P0 | **Done** (2026-02-24) | |
| 5 | **P10 clear_filters at 33% with only 4 assertions** — Three code paths (pre-router regex, LLM `clear_filters`, handler wipe) with minimal test coverage. | P1 | **Done** (2026-02-24) | 4→10 scenarios, 6→12 assertions. Fixed compound-message regex bug. |
| 6 | **No structured source parser eval** — 13/18 sources use structured parsing with no field-completeness checks. Parser regressions only surface via downstream symptoms. | P1 | **Done** (2026-02-24) | `source-completeness.js` with per-source field expectations + invariants. Runs after each scrape. |
| 7 | **Trace fetch race condition** — Pipeline eval runner fetches "most recent trace" after 500ms delay. Could grab wrong trace under concurrent load. | P2 | Planned | Correlate by input_message + phone |
| 8 | **No dedicated handleMore path eval** — Legacy two-call flow not specifically tested. Filter state bugs in this path surface as vague scenario failures. | P2 | Planned | |

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

**Post-fix eval results (2026-02-23):** 70/130 passed (53.8%), consistent with estimated ~54% true pass rate. must_pass: 81% (21/26). By category: abuse_off_topic 100%, happy_path 69%, edge_case 61%, poor_experience 35%, filter_drift 23%. The 5 remaining must_pass failures are real product bugs (MORE errors, LIC not recognized). filter_drift at 23% was the dominant real product problem — addressed by filter drift fix (2026-02-24): `mergeFilters` explicit-key semantics, targeted clearing, `CLEAR_SIGNALS` guard, bare category detection, handleMore exhaustion fix. Target: 80%+ filter_drift pass rate.

---

## Not Building

- Happy hours / venue busyness / bar discovery — different product
- Yelp/Foursquare venue DB — venue discovery != event discovery
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- General web crawling — whitelist sources only
- Real-time scraping — SMS users don't need sub-daily freshness
