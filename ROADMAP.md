# Pulse — Roadmap

> Single source of truth for architecture principles, evolution strategy, open issues, and planned work.
> Last updated: 2026-03-03 (Skint thru parsing + description coverage for Luma/Songkick/DoNYC)

---

## Architecture Principles

These principles govern how Pulse splits work between deterministic code and LLM calls. They were developed from regression eval failures, reviewed across multiple models, and represent consensus.

### P1. Code Owns State, LLM Owns Language

The LLM is never the system of record for structured data. Session state, filters, neighborhood resolution, event selection logic — all owned by deterministic code. The LLM reads well-formed tagged inputs and produces natural language output.

**In practice:** `mergeFilters()` compounds filters deterministically. `buildTaggedPool()` tags matching events with `[MATCH]` (hard match) or `[SOFT]` (broad category match where subcategory is set — e.g. jazz within live_music). The LLM sees the tagged pool and writes copy — it doesn't manage or report filter state.

**Anti-pattern:** Reading `filters_used` from LLM output and merging it into session state. This makes the LLM a secondary source of truth. If it hallucinates a filter, we persist it. We tried this (2026-02-22) and reverted it because it violates this principle.

### P2. Separate Reasoning from Rendering

If the LLM must both understand intent and write compelling copy, those should be separate operations. The reasoning pass returns a small validated struct. The rendering pass takes well-formed data and returns text.

**Current state:** One unified Haiku call does both. Its output contract has 4 structured fields — `type`, `sms_text`, `picks`, `filter_intent`. Step 3 removed the 4 redundant state-management fields. The `filter_intent` migration (2026-03-01) replaced the `clear_filters` boolean with a granular `{ action, updates }` object. The unified path now uses `tool_use` with `tool_choice` for guaranteed structured output (2026-03-01 prompt audit).

**Target state:** Reasoning call → `{ type, picks[], filter_intent }` (3 fields, validated via tool_use). Rendering call → `sms_text` (pure copy, lightweight parser). Everything else derived by code.

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

**Current:** Contract has 4 fields: `type`, `sms_text`, `picks`, `filter_intent` (was 8 fields before Step 3). `filter_intent: { action: "none"|"clear_all"|"modify", updates }` enables granular filter modifications from LLM, not just clear-all. Schema enforced via `tool_use` with `tool_choice` on unified path (2026-03-01 prompt audit) — eliminates JSON parsing failures.

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
2. **Flat session merge** — `setSession` does `{ ...existing, ...data }`. If a handler doesn't explicitly set a field, the previous value persists.
3. **Geographic pool vs semantic scope** — `getEvents(hood)` returns events by proximity radius. When MORE exhausts in-hood events, it shows nearby-neighborhood events without telling the user.

### Target Architecture

```
message → pre-router (compound extraction) → filter merge → tagged pool
  → LLM-reason(type, picks, filter_intent) → validate boundary → code derives all state
  → LLM-render(events + context → sms_text) → atomic save → SMS
```

### Migration Status

| Step | What | Principle | Status |
|------|------|-----------|--------|
| 1a | Atomic session frames — `setResponseState()` | P4 | **Done** |
| 1b | Unify all session saves — every SMS path ends with `saveResponseFrame` | P4 | **Done** |
| 1c | Validate event IDs against pool before save | P7 | **Done** |
| 2 | Compound pre-router extraction — "free comedy", "late jazz" | P1, P6 | **Done** |
| 2b | Structural filter drift fix — gate `filter_intent`, expand compounds, validate categories | P1, P3, P6 | **Done** |
| 3 | Derive state fields deterministically — remove 4 redundant LLM fields (8→4) | P1, P5 | **Done** |
| 4 | Reasoning/rendering split — separate intent+selection from copywriting | P2, P5 | **Abandoned** — code exists (`REASON_SYSTEM`, `RENDER_SYSTEM`, `reasonIntent`, `renderSms`) but never called; no feature flag; dead code. Unified path with `tool_use` covers the structured output need. |
| 5 | *(merged into step 3)* | — | **Done** |
| 6 | Finer category taxonomy — three-tier soft match | — | **Done** |
| 7 | `executeQuery` pipeline — single prompt path for unified flow | P4 | **Done** (unified path). Legacy `routeMessage`, `composeResponse`, `ROUTE_SYSTEM`, `COMPOSE_SYSTEM` still exist for `handleMore` path. |
| 8 | Scoped event fetching — `neighborhood`/`borough` scope | — | Planned |

Steps 1-3, 6-7 are done. Step 4 was implemented but abandoned — the unified path with `tool_use` achieves structured output without the complexity of two calls. Step 8 is planned.

**Key decision:** The unified path uses `tool_use` with `tool_choice` for guaranteed structured output (prompt audit, 2026-03-01). This eliminates the primary motivation for the reasoning/rendering split (P2) — schema compliance is now enforced without a separate reasoning call.

---

## Resilience Gaps

| Gap | What | Principle | Status |
|-----|------|-----------|--------|
| 1 | `clear_filters` — LLM → code state bridge | P1 | **Superseded** — replaced with `filter_intent` schema (2026-03-01) |
| 2 | Unified call couples reasoning and rendering | P2 | **Abandoned** — split code exists but unused; `tool_use` on unified path mitigates the schema risk |
| 3 | Pool padding gives LLM material to violate filter intent | P1 | **Fixed** — eliminated unmatched padding (2026-03-01) |
| 4 | No degraded-mode recovery when LLM fails | — | **Fixed** — deterministic fallback from tagged pool (2026-03-01) |

### Gap 2: Reasoning/Rendering Coupling (Abandoned)

`unifiedRespond` produces both structured fields (`type`, `picks`, `filter_intent`) and natural language (`sms_text`) in a single call. The split-mode implementation (`REASON_SYSTEM`, `RENDER_SYSTEM`, `reasonIntent`, `renderSms`, `callSplitUnified`) exists in code but is never called — no feature flag activates it. The prompt audit (2026-03-01) added `tool_use` with `tool_choice` to the unified path, which enforces schema compliance without a separate reasoning call. The split code is dead code that can be cleaned up.

---

## Open Issues

### ~~Gemini Flash Model Strategy~~ — **Resolved 2026-03-02**

Implemented three-tier fallback chain: Gemini 2.5 Flash → Gemini 2.5 Flash Lite → Claude Haiku. All three Gemini call sites (`unifiedRespond`, `extractEvents`, `composeDetails`) detect 429/quota errors via `isQuotaError()` and cascade to the next model. Non-quota errors skip Flash Lite and fall directly to Haiku. A/B eval (Flash Lite vs Haiku): 53% Haiku preference but Flash Lite is 13x cheaper ($0.006 vs $0.078 per 15-case run).

### ~~Pre-Router False Positives on Common Words (#8)~~ — **Fixed 2026-03-01**

Ambiguous words (rock, funk, soul, house, swing, rap, dance, music, art) now require a second signal on first message. "late" requires event context (night/tonight/shows). Multi-word patterns (live music, hip hop, stand up, open mic) split into separate regex map.

### ~~Conversational-with-Pool~~ — **Fixed 2026-03-01**

Code guardrail overrides `type: conversational` → `event_picks` when pool has `matchCount > 0`, using top 3 matched events.

### ~~Yutori Extraction — Remaining Gaps~~ — **Fixed 2026-03-01**

- ~~Non-recurring series events ("running through March") not yet handled by recurrence system~~ — **Fixed:** `detectDateRange()` in `general-parser.js` expands date ranges ("Mar 3-8", "through March 31") into individual dated events at parse time. Three patterns: same-month range, cross-month range, "through" end date. Capped at 14 dates. Deterministic expansion, no LLM needed.
- One-off events with dates >7 days out stored in SQLite but only surface when date falls within 7-day serving window (correct behavior)

### ~~Pre-Router Mechanical Paths Don't Save Session State~~ — **Fixed 2026-03-01**

Pre-router mechanical shortcuts (greetings, help, thanks, bye) go through `handleConversational`/`handleHelp` which never call `saveResponseFrame`. Conversation history IS saved (via `addToHistory`), but deterministic session state (lastPicks, lastNeighborhood, lastFilters) is NOT.

**What works today:** "hi" → canned greeting → "jazz" → unified LLM sees conversation history, serves citywide jazz correctly. The conversation history bridge is sufficient.

**Three gaps (all resolved):**

| Gap | Example | Status |
|-----|---------|--------|
| No deterministic filter state from opener context | "hi" → "jazz" → "west village" — jazz filter not carried deterministically | **Works correctly** — `saveResponseFrame` persists filters, `mergeFilters` compounds them. No fix needed. |
| Pre-router category detection skipped when no hood/picks in session | "jazz" → ask_neighborhood → "how about comedy" — falls to unified instead of $0 pre-router | **Fixed** — Added `\|\| hasActiveFilters` to filter follow-up guard in `pre-router.js`. Filters saved by prior turn now enable $0 detection. |
| Citywide picks don't set `visitedHoods` | "surprise me" → citywide → "bushwick" → exhaust → no suggestion | **Fixed** — `visitedHoods` now uses `'citywide'` sentinel instead of filtering out null. Updated in `pipeline.js`, `unified-flow.js`, `handler.js`. |

**Earlier partial fix (2026-03-01):** Expanded `filter_intent` prompt for bare openers — "jazz", "free stuff", "comedy tonight" now report `filter_intent: modify` on turn 1, enabling P1-compliant filter persistence through citywide→neighborhood flows.

### ~~"Later in the week" not recognized as date range~~ — **Addressed by Agent Brain (2026-03-02)**

**Description:** User texts "later in the week" or "later this week" and Pulse responds with "I only see tonight's events" despite having 7 days of data in cache.

**Root cause:** `parseDateRange()` in `pre-router.js:62-102` has no pattern for "later in the week", "later this week", or similar phrases. The `isFutureQuery` regex in `build-compose-prompt.js:33` also misses it, so `tonightPriority` skill fires incorrectly — the LLM is told to prioritize tonight's events when the user explicitly asked for later in the week.

**Regression principle:** P5 (Temporal Accuracy)

**Fix strategy:** Add "later in/this week" pattern to `parseDateRange()` returning a date range from tomorrow through end of week. Add the same pattern to `isFutureQuery` regex so `tonightPriority` skill does not fire. Consider also handling "end of the week", "this weekend" variants if not already covered.

### ~~`date_range` absent from `filter_intent` schema — temporal context drops between turns~~ — **Addressed by Agent Brain (2026-03-02)**

**Description:** After Pulse suggests "text a neighborhood for later-in-week events", the user texts a neighborhood and Pulse drops the temporal context entirely, serving tonight's events instead of the later-in-week events the conversation established.

**Root cause:** `filter_intent.updates` schema in `ai.js:92-99,718-725` and `prompts.js:353-370` has no `date_range` field. The LLM cannot report temporal intent back to the handler. `pendingMessage` saves the user's text but nothing converts it to a persisted date range filter on the next turn. The handler has no mechanism to carry temporal context across the ask_neighborhood → neighborhood flow.

**Regression principle:** P7 (Session Context), P1 (Code owns state)

**Fix strategy:** Two options, in order of preference: (1) Detect date range in the pre-router and persist it in session filters (P1-compliant — code owns state). This means `parseDateRange()` output gets saved as a session field like `lastDateRange` and `mergeFilters` compounds it across turns. (2) Add `date_range` to `filter_intent.updates` schema so the LLM can report it — but this expands the LLM output contract (P5 tension) and requires boundary validation (P3).

### ~~Mid-session compound requests bypass pre-router — stale filters persist~~ — **Addressed by Agent Brain (2026-03-02)**

**Description:** A returning user (with existing session and active filters) texts a compound category+neighborhood request like "trivia or art stuff in greenpoint" but the previous filter (e.g. comedy) persists. The user is trapped in a filter they cannot escape through natural conversation.

**Root cause:** Three interacting issues: (1) First-message compound detection in `pre-router.js:249` is gated by `!sessionHoodEarly && !session?.lastPicks?.length` — skipped entirely for returning users with session history. (2) Session-aware filter detection (lines 308-393) cannot parse compound category+neighborhood requests like "trivia or art in greenpoint". (3) When `mergeFilters(lastFilters, null)` receives no pre-detected filters, it falls back to stale session filters. The zero-match bypass in `handler.js:328-332` fires BEFORE the LLM call, preventing the LLM from seeing the user's intent and reporting a filter change via `filter_intent`.

**Regression principle:** P1 (Code owns state), P3 (Category Fidelity), P10 (Explicit Filter Removal)

**Fix strategy:** Three-part fix: (1) Allow compound detection for mid-session messages — remove or relax the `!session?.lastPicks?.length` gate so returning users get the same compound parsing as first-time users. (2) When zero-match fires, check if the user's message contains a different category than the active filter — if so, let the LLM handle it instead of the deterministic bypass, so `filter_intent` can report the category change. (3) Consider multi-category support ("trivia or art") as a pre-router pattern, returning multiple categories that `buildTaggedPool` can match against.

### Deferred (post-MVP)

| Issue | Why deferred | Status |
|-------|-------------|--------|
| ~~Concurrent session race conditions~~ | ~~Rare at current traffic~~ | **Fixed** — per-phone mutex in session.js (fragility audit #16) |
| No processing ack during slow Claude calls | Adds extra Twilio cost; degraded-mode fallback covers the worst case | Deferred |
| No horizontal scalability | Single-process fine at current traffic | Deferred |
| No structured logging or correlation IDs | Operational improvement for scale | Deferred |
| ~~No integration tests or mocking~~ | ~~Important eventually, not blocking~~ | **Done** — `test/integration/sms-flow.test.js` (12+ integration tests) |

---

## Pre-Launch Fragility Audit

### High Priority

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 5 | `visitedHoods` resets on every new neighborhood | pipeline.js | **Fixed 2026-03-01** — default now accumulates from prevSession |
| 6 | Hanging scraper blocks all future cache refreshes | events.js timedFetch | **Fixed 2026-03-01** — 60s Promise.race timeout in timedFetch |
| 7 | Anthropic fallback max_tokens: 512 truncation | ai.js | **Fixed 2026-03-01** — both Anthropic paths now use max_tokens: 1024 |
| 8 | Pre-router false-positives on common words | pre-router.js | **Fixed 2026-03-01** — ambiguous words require second signal; multi-word patterns split |

### Medium Priority

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 9 | `isLastBatch`/`exhaustionSuggestion` skills dropped | pipeline.js, ai.js | **Fixed 2026-03-01** — forwarded through executeQuery and unifiedRespond to skillOptions |
| 10 | `tonightPriority` conflicts with "tomorrow" queries | build-compose-prompt.js | **Fixed 2026-03-01** — future-query regex skips tonightPriority |
| 11 | Unbounded `short_detail` in prompt | ai.js | **Fixed 2026-03-01** — capped to 120 chars, name capped to 80 via shared cap() helper |
| 12 | Graceful shutdown kills in-flight handlers after 5s | server.js | **Fixed 2026-03-01** — inflightRequests counter + 30s drain wait |
| 13 | Gemini finishReason logged but not acted on | ai.js | **Fixed 2026-03-01** — checkGeminiFinish() throws on SAFETY/MAX_TOKENS in all 3 Gemini functions |
| 14 | `extractEvents` returns unvalidated JSON shape | ai.js | **Fixed 2026-03-01** — normalizes venues/array/object shapes to events array |
| 15 | Non-atomic disk writes for cache/sessions | events.js, session.js, preference-profile.js, referral.js | **Fixed 2026-03-01** — atomicWriteSync (write .tmp + rename) on all 6 critical write sites |

### Deferred (all resolved)

| # | Issue | Status |
|---|-------|--------|
| 16 | Race condition on parallel messages from same phone | **Fixed 2026-03-01** — per-phone promise-based mutex in session.js, handleMessage wrapped with lock |
| 17 | Dead `core` skill with conflicting output schema | **Fixed 2026-03-01** — deleted from compose-skills.js, cleaned up references |
| 18 | Event name dedup merges distinct same-venue events | **Fixed 2026-03-01** — `makeEventId` includes optional startTime (HH:MM) in hash; all 15 scrapers + db.js updated |
| 19 | Events in undefined neighborhoods invisible to geo queries | **Accepted 2026-03-01** — see "Neighborhood Resolution Gap" below; remaining 120/1911 (6%) are structural limits |

### Neighborhood Resolution Gap (#19)

**Impact:** 171/1,533 events (11%) have no neighborhood. These are invisible for neighborhood-based queries (the primary use case) due to the 3km proximity filter in `rankEventsByProximity()`. Only surfaced in citywide flows.

**Breakdown by source:**

| Source | Missing | Total | Rate | Root Cause |
|--------|---------|-------|------|------------|
| NYC Parks | 53 | 119 | 45% | Generic venue names ("Multipurpose Room", "Athletic Courts"), intersection-style addresses Nominatim can't resolve |
| RA | 53 | 180 | 29% | No geo data from API; depends entirely on static venue map |
| DoNYC | 48 | 427 | 11% | Mix of non-NYC venues (~15) and NYC venues not in venue map |
| Ticketmaster | 7 | 433 | 2% | Non-NYC events leaking through (NJ PAC, Stamford, Westbury) |
| BrooklynVegan | 3 | 41 | 7% | Non-NYC venues (Port Chester, etc.) |
| Yutori/Songkick/EB | 7 | 167 | 4% | Sparse |

**~28 events are outside NYC entirely** (NJ, CT, Westchester) — these should be filtered, not geocoded.
**~143 are NYC events** at venues the system can't resolve.

**Fix (three parts, all done 2026-03-01):**

| # | Fix | Recovery | Status |
|---|-----|----------|--------|
| 19a | Add ~40 NYC venues to static venue map (bars, comedy clubs, libraries, parks facilities, community centers) | ~63 events resolved | **Done** |
| 19b | NYC bounding box filter in Ticketmaster, DoNYC, BrooklynVegan + venue blocklists for non-NYC venues without coords | ~28 non-NYC events removed | **Done** |
| 19c | Add Rockaway + St. George neighborhoods (+ Staten Island borough support) | Enables resolution for events in Rockaways and north shore SI | **Done** |

**Result:** 171 → ~80 missing (53% reduction). Remaining ~80 are mostly RA "TBA" secret locations (~25, inherently unresolvable), NYC Parks community centers needing individual geocoding (~15), and a handful of DoNYC/RA venues without addresses. Shared `isInsideNYC()` bbox helper extracted to `shared.js` for reuse across scrapers (Luma refactored to use it).

**Updated diagnostic (2026-03-01, #16-#19 audit):** 120/1911 events (6.3%) unresolved. Breakdown: ~38 outside-NYC leakage (DoNYC NJ/CT venues), ~28 RA "TBA" secret locations (intentionally unresolvable), ~22 venues in VENUE_MAP but beyond 36-neighborhood 3km radii, ~32 misc one-off venues. No additional VENUE_MAP entries would materially reduce the gap — remaining unresolved events are structural limits of the 36-neighborhood model.

---

## Eval Trajectory & Trends

### Pass Rate Timeline

| Date | Scenarios | Pass Rate | What Changed |
|------|-----------|-----------|--------------|
| Feb 22 (AM) | 51 | 66.7% | First eval run |
| Feb 22 (PM) | 51 | 76.5% | Hard time gate, compound pre-router |
| Feb 23 | 71 | 54.9% | Suite expanded (new edge cases, poor_experience) |
| Feb 24 | 130 | 35.4% | Suite expanded to 130, stricter Haiku judge |
| Feb 25 | 130 | 54.6% | Sonnet judge restored, systemic fixes |
| Feb 28 | 130 | 48.5% | Session persistence, Gemini Flash switch |
| Mar 1 | 48 (hp) | **90%** | Zero-match bypass, cascade fixes, sign-off handlers |
| Mar 1 (PM) | 159 (+29) | — | Non-neighborhood opener scenarios, CC agent analysis |
| Mar 1 (late) | 159 | **99.8%** code | Code eval accuracy overhaul (11650/11676) |

### Category-Level Trends

| Category | Feb 22 (51) | Feb 25 (130) | Mar 1 (48 hp) | Trend |
|----------|-------------|--------------|---------------|-------|
| happy_path | 73.3% | 75.0% | **90%** | Strong improvement |
| edge_case | 93.3% | 64.5% | ~60% | New scenarios exposed gaps |
| filter_drift | — | 15.4% | — | Structural fix landed (Step 2b): gated `filter_intent`, expanded compound detection |
| poor_experience | 60.0% | 30.0% | ~65% | Data-sparsity dependent |
| abuse_off_topic | 83.3% | 100.0% | — | Stable |

### Key Patterns

- **Eval non-determinism (~25% scenario variance):** Identical code on different days produces 5-15% swings due to daily event cache changes. Scenarios depending on specific events in thin neighborhoods flip pass/fail based on what was scraped that morning.
- **Pool padding was the structural enabler of filter drift (Gap 3 — fixed):** Eliminating unmatched padding when filters are active means the LLM only sees matched events. Expected to resolve remaining filter_drift failures.
- **Outer-borough scenarios are cache-dependent, not code-dependent:** Thin neighborhoods (Washington Heights, Red Hook, Sunset Park) fail when the daily cache has few events there. Not code bugs — coverage gaps.

### Eval Coverage Audit (2026-03-01)

255 golden scenarios (176 multi-turn + 79 regression, 384 assertions). Suite is strong on filter persistence (P1), session context (P7), graceful degradation (P6). Nine gaps identified:

| # | Gap | Priority | Status |
|---|-----|----------|--------|
| 1 | **Temporal accuracy (P5)** — 7 assertions total. Zero explicit clock-time tests ("after 10pm"), zero after-midnight wrapping, zero time+category compounds. Dangerous given new compound pre-router. | **High** | **Done** — 6 multi-turn + 6 regression scenarios added |
| 2 | **First-message compounds** — No end-to-end test of "comedy in bushwick" or "free jazz tonight" as openers. Unit tests verify pre-router struct but not full pipeline through filter_intent gating. | **High** | **Done** — 4 multi-turn + 4 regression scenarios added |
| 3 | **filter_intent gating observability** — The P1 gate (ignore LLM filter_intent when pre-router set filters) has no code eval to verify it fires. | **High** | **Done** — `filter_intent_gating` code eval added |
| 4 | **Abuse/off-topic** — 5 scenarios (3%). Missing: hostility, identity questions, other-city requests, persistent off-topic. Target: 8-10%. | Medium | **Done** — 4 multi-turn + 4 regression scenarios added (now 5.1%) |
| 5 | **handleMore path** — No dedicated MORE eval. Dedup across 3+ cycles, filter persistence through MOREs, compose-only prompt path untested. | Medium | **Done** — 3 multi-turn + 3 regression scenarios added |
| 6 | **Tavily scenarios vestigial** — 3 regression scenarios tested Tavily fallback (removed from hot path). | Medium | **Done** — updated to test deterministic exhaustion behavior, removed P8 references |
| 7 | **TCPA/opt-out** — Zero scenarios for STOP/UNSUBSCRIBE compliance. Deterministic but legally required. | Low | **Done** — 2 regression scenarios (4 keywords + 3 non-match edge cases) |
| 8 | **Neighborhood skew** — EV 13x, Bushwick 7x, Wburg 5x. Many outer-borough neighborhoods absent. Failures are cache-dependent, not code-dependent. | Low | **Done** — 8 multi-turn + 4 regression scenarios added (Mott Haven, Fordham, Staten Island, Jackson Heights, Flushing, Bay Ridge, Washington Heights, Ridgewood) |
| 9 | Trace fetch race condition — could grab wrong trace under concurrent load | Low | **Done** — `handleMessageAI` returns `trace.id`, test endpoint uses `getTraceById` |

**Distribution assessment:** happy_path 35.9%, edge_case 26.6%, filter_drift 18.5%, poor_experience 14.1%, abuse_off_topic 4.9%. All categories in healthy range. 196 multi-turn + 90 regression = **286 total** golden scenarios.

---

## Source Coverage

### Current Sources (19 active)

| Source | Weight | Method | Strength |
|--------|--------|--------|----------|
| Skint | 0.9 | HTML → Claude | Free/cheap curated picks |
| Skint Ongoing | 0.9 | HTML → deterministic parser | Series events (exhibitions, festivals) |
| Nonsense NYC | 0.9 | Newsletter → Claude | Underground/DIY/weird |
| Screen Slate | 0.9 | Newsletter → Claude | Indie/repertory film |
| RA | 0.85 | GraphQL | Electronic/dance/nightlife |
| Dice | 0.8 | `__NEXT_DATA__` JSON (6 categories) | Ticketed shows, DJ sets, comedy, theater |
| BrooklynVegan | 0.8 | DoStuff JSON | Free shows, indie/rock |
| BAM | 0.8 | JSON API | Film, theater, music, dance |
| SmallsLIVE | 0.8 | AJAX HTML | Jazz (Smalls + Mezzrow) |
| Yutori | 0.8 | Gmail + file briefings → Claude | Curated newsletters |
| NYC Parks | 0.75 | Schema.org | Free parks/outdoor events |
| DoNYC | 0.75 | Cheerio HTML | Music, comedy, theater |
| Songkick | 0.75 | JSON-LD | Concerts/music |
| Ticketmaster | 0.75 | Discovery API | Indie filter: blocklist + $100 cap |
| Eventbrite | 0.7 | JSON-LD / `__SERVER_DATA__` | Broad aggregator |
| Luma | 0.7 | JSON API | Community, food, art, social (~330/week) |
| NYPL | 0.7 | Eventbrite organizer | Free library events |
| EventbriteComedy/Arts | 0.7 | Same parser, category URLs | Comedy/art-specific |

**Inactive (scrapers preserved):** OhMyRockness (80% loss rate, all duplicates), Tavily (removed from hot path, used as exhaustion fallback only).

### Category Gaps

| Category | Coverage | Gap |
|----------|----------|-----|
| Electronic/dance | Strong (RA, Dice) | — |
| Indie/rock/punk | Good (Songkick, BrooklynVegan, Dice) | — |
| Comedy | Moderate (EventbriteComedy, DoNYC, Dice) | No dedicated comedy source |
| Art/galleries | Moderate (EventbriteArts, Skint, Luma) | No gallery opening calendar |
| Theater | Moderate (DoNYC, BAM, Dice) | No Broadway/off-Broadway source |
| Community/social | Good (Luma, NYC Parks, Eventbrite) | — |
| Food/drink | Moderate (Luma) | Single source for food events |
| Underground/DIY | Single source (Nonsense NYC) | If it breaks, entire vibe gone |
| Jazz | Good (SmallsLIVE, Skint, DoNYC) | — |
| Film | Good (Screen Slate, BAM, Skint Ongoing) | — |

---

## Feature Roadmap

### Near-term — Community Layer (Priority)

The core thesis: Pulse's scraped event data gives it verified, temporal knowledge that LLMs like Gemini cannot provide. The most underserved audience is people new to NYC trying to build community. They need recurring, intimate, social events — not novelty. Gemini confidently recommends closed bookstores and nonexistent events. Pulse can be right.

**Phase 1: Recurrence detection** — **Done 2026-03-02**
- `detectRecurringPatterns()` in `db.js`: SQL GROUP BY on `normalized_name + venue_name + day_of_week` across 30 days of events, upserts patterns for 2+ distinct date occurrences. Runs after every `refreshCache()`.
- `normalized_name` column added to events table (migration + backfill). `processRecurrencePatterns()` generalized from Yutori, shared by NYC Trivia League.
- NYC Trivia League wired in (~165 patterns). Yutori delegates to shared version.
- `stampRecurrence()` in `events.js`: Set lookup of active pattern keys stamps `is_recurring` + `recurrence_label` (e.g. "every Tuesday") on serving cache events. Runs on boot + every cache rebuild.
- `recurring` field added to LLM event serialization in `ai.js`. `recurringEvent` compose skill tells LLM to mention recurrence naturally.
- `/health` endpoint includes `recurringPatterns` count.
- Production verified: 485 active patterns, 790 events stamped, LLM naturally says "every Tues!" in picks.

**Phase 2: Venue size classification + interaction format** (manual + static mapping, no API cost)

The key insight: category alone is too coarse. Comedy at Tiny Cupboard (30 seats) vs Carnegie Hall is categorically different. Venue size and interaction format are independent signals that must combine.

**2a. Venue size classification** — Add `venue_size` field to VENUE_MAP for the ~150-200 venues we actually see events at. Four tiers:
  - **intimate** (<~100): Smalls, Mezzrow, Tiny Cupboard, Brooklyn CC, most bars hosting trivia
  - **medium** (~100-500): House of Yes, Baby's All Right, most comedy clubs
  - **large** (~500-1500): Brooklyn Steel, Terminal 5, Webster Hall
  - **massive** (1500+): Barclays, MSG, Radio City, Avant Gardner

One-time manual effort, maintained as new venues appear via learned venues. Much more accurate than any API-derived proxy (Google Places review count is noisy — beloved tiny places can have tons of reviews).

**2b. Interaction format** — Derive from `subcategory` + event name keyword scan. Three tiers:
  - **interactive** (structure forces stranger interaction): trivia, board games, workshops, dance classes (salsa/bachata/swing), communal dining, run clubs, potlucks, drink-and-draw
  - **participatory** (you might perform, audience is active): open mic, karaoke, drag, jam sessions, comedy (small room), art openings, food tastings
  - **passive** (audience faces stage): concerts, DJ sets (big room), screenings, lectures, readings
  - Name keywords supplement subcategory: "workshop", "jam session", "meetup", "potluck", "drink and draw", "run club"

**2c. Source curation signal** — Map `source_name` to curation tier:
  - **curated**: Nonsense NYC, Skint, Screen Slate (editorially selected, tend intimate/underground)
  - **single-venue**: Tiny Cupboard, Brooklyn CC, SmallsLIVE (intimate by definition)
  - **broad**: RA, Dice, DoNYC, Eventbrite, Ticketmaster (mixed size, no curation signal)

**2d. Community score** — Compound signal from all available data:
  - `recurring` (Phase 1) → +3
  - `interactive_format` → +2
  - `intimate_venue` → +2
  - `free_or_cheap` → +1
  - `curated_source` → +1
  - `large_venue` → -2
  - `massive_venue` → -3
  - `broad_source` → 0 (neutral, not negative)

Google Places deferred — the signals it provides (Popular Times, review count, rating) are noisy proxies for things we can classify more accurately by hand. Revisit if we need validation data for recurrence patterns or a specific question only that API answers.

**Phase 3: Community-oriented agent path**
- Detect community-seeking intent: "new here", "solo tonight", "where can I meet people", "build community", first-time texters with no session history
- Route to community-aware curation: prioritize events with high community score
- Frame picks differently: "Trivia at Black Rabbit — every Tuesday, same crowd, easy to join solo" vs. "Trivia Night at Black Rabbit, 8pm, free"
- This is a compose skill + pick-ranking change, not a new pipeline

### Near-term — Source + Quality

- Comedy source — Dedicated scraper for Comedy Cellar, UCB, Caveat, QED
- Gallery/art source — Gallery listing aggregator or DoNYC art category
- Happy hour detection — Identify recurring happy hours from event data and venue pages; surface as a filterable category ("happy hours near me")
- Niche/local-first ranking — Bias pick selection toward intimate, creative, communal, underground events over mainstream ticketed shows. Leverage source tiers (Nonsense NYC, Skint, Screen Slate already weighted highest) and add scoring signals: small venue capacity, free/cheap, DIY keywords, community-tagged

### Medium-term — Intelligence

- Scout worker — Background process to fill neighborhood gaps after daily scrape
- Perennial picks evolution — Auto-detect candidates from scrape data
- ~~Second daily scrape~~ — **Done**: `SCRAPE_HOURS = [10, 18]` — 10am ET + 6pm ET catches same-day evening newsletters
- Self-healing scraper pipeline — Daily automated health check that detects scraper failures (0 events, parse errors, schema changes) and attempts self-repair: retry with backoff, fall back to cached data, alert on structural breakage. Build on existing `source-health.js` alerts + scrape audit
- Web discovery crawlers — Scheduled crawlers that search for niche/interesting events beyond whitelisted sources. Targeted web searches (Tavily or similar) for neighborhood-specific terms ("bushwick pop-up", "LES gallery opening", "DIY warehouse show"), deduplicate against existing cache, feed into extraction pipeline
- "Stumble" mode — Text "stumble" or "surprise me" and get 1-3 genuinely unexpected picks: hidden gems, one-night-only events, weird/unique happenings. Selection heuristic: low source frequency (appears in ≤1 source), unusual category, non-recurring, small venue. Different from citywide scan — optimizes for serendipity, not coverage
- Better interest capture — Expand onboarding to capture 2-3 preference signals early ("what are you into?" or infer from first few interactions). Feed into preference-profile.js to build richer user profiles faster

### Long-term — Infrastructure + Product

- PostgreSQL — Persistent event storage, user sessions, conversation history
- Preference learning — Profile capture done; next: inject profile into compose prompt for personalized picks
- Profile-based event ranking — Score and re-rank the tagged event pool using user profile signals (preferred categories, neighborhoods, price sensitivity, past engagement). Profile-weighted events surface higher in picks without replacing filter logic
- Proactive user alerts — For users with established profiles, send unsolicited texts when high-match events are discovered: "Hey, there's a free jazz thing in your neighborhood tonight." Requires opt-in, frequency caps, and a match-quality threshold to avoid spam
- SMS map sharing — Generate a shareable map image or link showing picked event locations. Options: static map image (Mapbox/Google Static Maps API) embedded in MMS, or a short link to a lightweight map page. MMS costs more (~$0.02 vs $0.008) but visual impact is high for multi-pick responses
- Group planning / voting — Multi-user coordination: one person texts "plan saturday with @friend1 @friend2", Pulse sends each person the same picks, collects votes (text back 1/2/3), reports consensus. Requires multi-phone session linking and a voting state machine. Could start simpler: shareable pick list link where friends vote via web
- Referral analytics — Dashboard for referral code generation, card views, conversion rates
- Paid tier — Stripe billing, $5-10/month unlimited
- Push notifications — "Free rooftop thing near you starting in 30 min"
- Multi-city — Same architecture, different sources
- SQLite user profiles — implicit personalization, "my usual", weekend digest

---

## Tech Debt

| Item | Risk | Notes |
|------|------|-------|
| ~~`annotateTrace()` is O(n)~~ | ~~Low~~ | **Stale** — `annotateTrace` no longer exists; traces are write-once append to JSONL |
| ~~No integration tests~~ | ~~Medium~~ | **Done** — `test/integration/sms-flow.test.js` covers help, greetings, TCPA, details, filters, off-topic |
| ~~`eval.js` scores events sequentially~~ | ~~Low~~ | **Done** — parallelized via `Promise.all` (2026-03-01) |
| Price data gap (21% unknown) | Low | Down from 71.6% after scraper improvements; remaining is structurally unavailable |
| No horizontal scalability | Low | Single-process, in-memory sessions |
| ~~Dead split-mode code~~ | ~~Low~~ | **Done** — deleted `REASON_SYSTEM`, `RENDER_SYSTEM`, `reasonIntent`, `renderSms`, `buildReasonPrompt`, `buildRenderPrompt`, `callSplitUnified`, `REASON_TOOL`, `REASON_GEMINI_SCHEMA`, `PULSE_SPLIT_MODE` gate (2026-03-01) |
| ~~Legacy `handleMore` prompts~~ | ~~Low~~ | **Already done** — `routeMessage`, `composeResponse`, `ROUTE_SYSTEM`, `COMPOSE_SYSTEM` were already removed; `handleMore` uses `unifiedRespond` via `executeQuery` |
| Preference learning not yet active | Low | Profiles captured but not injected into prompts |
| ~~`cityScan` skill activation mismatch~~ | ~~Low~~ | **Removed** — dead code (`cityScan` + `venueFraming`), never activated |
| ~~`architecture.html` references deleted flow~~ | ~~Low~~ | **Fixed** — removed two-call flow refs, updated session field description |
| ~~UNIFIED/REASON prompt duplication~~ | ~~Low~~ | **Fixed** — extracted `SHARED_UNDERSTANDING(verb)` + `SHARED_GEOGRAPHY` constants (prompt audit, 2026-03-01) |
| ~~31 ALL-CAPS directives in prompts~~ | ~~Low~~ | **Fixed** — rewritten as rationale-based constraints for Claude 4.5/4.6 (prompt audit, 2026-03-01) |

---

## Completed Work

| Date | What | Key Impact |
|------|------|------------|
| Mar 3 | Skint multi-day thru parsing + description coverage | Skint daily parser handles `tues thru sun:`, `tues thru 3/14:`, `(monthly)`/`(biweekly)` modifiers, and `►` bulleted sub-events with inherited `series_end`. `parseThruDate` now resolves day names. Description extraction added to Luma (API `description` field), Songkick (performer names from JSON-LD), DoNYC (detail page `.ds-event-description`). DoNYC `enrichPrices` → `enrichFromDetailPages` fetches for events missing price OR description. |
| Mar 2 | Cross-source recurrence detection (Community Layer Phase 1) | `detectRecurringPatterns()` finds 205 patterns from 30-day historical data via SQL GROUP BY. NYC Trivia League + Yutori feed shared `processRecurrencePatterns()`. 790 events stamped `is_recurring` in serving cache. LLM surfaces "every Tues!" naturally via `recurringEvent` compose skill. `/health` shows pattern count. 485 active patterns in production. |
| Mar 2 | Agent Brain prototype (`src/agent-brain.js`) | Parallel LLM routing path via Gemini Flash tool calling, gated behind `PULSE_AGENT_BRAIN=true`. Replaces regex pre-router for semantic messages. 3 tools: `search_events` (neighborhood/category/time/date_range/free_only + intent), `get_details`, `respond`. Mechanical pre-check ($0) for help/numbers/more. Gemini→Anthropic fallback on MALFORMED_FUNCTION_CALL/quota errors. `resolveDateRange()` converts enum→date objects. Addresses all 3 open bugs (date range recognition, temporal persistence, compound category pivot). ~$0.0004/msg vs ~$0.001 current. |
| Mar 2 | Gemini Flash → Flash Lite → Haiku fallback chain | Three-tier model cascade on quota errors across all 3 Gemini call sites; `isQuotaError()` helper; Flash default restored (was Flash Lite) |
| Mar 2 | Broad query support (citywide category + date range) | party/parties + film/films/cinema/movie/movies in catMap, `parseDateRange()` for "this week"/"this weekend"/"tomorrow", filter-aware citywide pool (`filterAwareSort`), borough+neighborhood resolution fix ("brooklyn/williamsburg"), MULTI-DAY DATA prompt, 12 multi-turn + 5 regression scenarios |
| Mar 1 | Prompt audit: best practices overhaul | tool_use for unified path (guaranteed JSON), self-verification checklist, tone reduction (31 ALL-CAPS → rationale-based), examples trimmed 18→8, negative→positive rewrites, shared prompt sections extracted (`SHARED_UNDERSTANDING`/`SHARED_GEOGRAPHY`), XML skill tags, user prompt restructured (data top, query bottom) |
| Mar 1 | Pre-router filter follow-up guard fix | Added `hasActiveFilters` to pre-router guard — filter follow-ups work after ask_neighborhood flows ($0 path) |
| Mar 1 | Citywide visitedHoods tracking fix | `'citywide'` sentinel replaces null filtering in pipeline.js, unified-flow.js, handler.js — citywide visits tracked for exhaustion suggestions |
| Mar 1 | Yutori series event date range expansion | `detectDateRange()` in general-parser.js expands "Mar 3-8", "through March 31" into individual dated events (P6 deterministic, capped at 14) |
| Mar 1 | A/B eval script model routing fix | `run-ab-eval.js` now passes `MODEL_A`/`MODEL_B` to `executeQuery` — was comparing same model against itself |
| Mar 1 | Fragility audit #16-#19 | Per-phone mutex (#16), dead `core` skill removed (#17), `makeEventId` includes startTime for same-venue dedup (#18), neighborhood gap accepted as structural (#19) |
| Mar 1 | Quick wins: dead skill cleanup, stale docs, TCPA evals | Removed `cityScan` + `venueFraming` dead skills, fixed architecture.html stale two-call refs, added 2 TCPA regression scenarios (7 assertions) |
| Mar 1 | Neighborhood resolution gap fix (#19) | 171 → ~80 missing neighborhoods (53% reduction). +40 venues in map, NYC bbox filter on 4 scrapers, Rockaway + St. George neighborhoods added, Staten Island borough support |
| Mar 1 | Structural filter drift fix (Step 2b) | Gated `filter_intent` when pre-router set filters (P1), expanded compound detection (first-message + time+category + free+category), VALID_CATEGORIES validation (P3) |
| Mar 1 | Degraded-mode LLM fallback + MORE dedup hardening | Gap 4 fixed — deterministic picks from tagged pool on LLM failure |
| Mar 1 | Code eval accuracy overhaul | 99.8% code eval pass rate (was 99.5%); fixed CATEGORY_PARENTS sync, filter_match_alignment, zero-match exemption |
| Mar 1 | Non-neighborhood opener eval expansion | +29 multi-turn + 16 regression scenarios for greetings, bare categories, vibes, meta questions |
| Mar 1 | Event name match routing fix | Pre-router no longer hijacks neighborhood names that match event titles |
| Mar 1 | Replace regex semantic routing with LLM `filter_intent` | Replaced `clear_filters` boolean + CLEAR_SIGNALS regex + ~100 lines pre-router regex with `filter_intent: { action, updates }` schema |
| Mar 1 | Filter-active dismissal prompt fix | P10 regression: 66.7% → 83.3%; "nvm"/"forget it" with active filter now clears filters |
| Mar 1 | Model router filter interaction signal | Ambiguous filter messages (+35 complexity) route to Haiku for semantic understanding |
| Mar 1 | Fix time filter persistence + details filter compliance | Compound first messages persist time via `filter_intent`; details handler rejects stale picks violating active filters |
| Mar 1 | Gap 3 fix — remove unmatched pool padding | LLM only sees matched events when filters active; structural fix for filter drift |
| Mar 1 | Step 7: `executeQuery` pipeline | Unified flow uses single prompt path. Legacy `routeMessage`/`composeResponse`/`ROUTE_SYSTEM`/`COMPOSE_SYSTEM` retained for `handleMore` path only |
| Mar 1 | Model comparison eval (Haiku/Flash/Flash-Lite) | Flash best (50%), Flash-Lite ties Haiku (42%) but weaker on neighborhood/price accuracy |
| Mar 1 | Zero-match bypass + cascade protection | `handleZeroMatch` wired up; happy_path 50% → 90% |
| Mar 1 | Nudge-accept flow fix (Root Cause D) | Added `neighborhood` to `ask_neighborhood` pending object — one-line fix for ~10% of filter failures |
| Mar 1 | Yutori junk event filter | Blocked ~50 prose bullets (self-help, tax, career) via category + filename + structural filters |
| Mar 1 | Skint Ongoing events scraper | 31 series events (exhibitions, festivals) via deterministic parser; weight 0.9 |
| Mar 1 | Friday/Saturday newsletter event loss fix | Yesterday included in scrape filter + 6pm evening scrape added |
| Mar 1 | Systemic failure fixes (8 changes) | handler.js events bug, borough detection, sign-off handling, early/tonight conflict, zero-match prompt hardening |
| Mar 1 | Fix eval gaps #8 + #9 | Neighborhood skew: 8 multi-turn + 4 regression scenarios for outer boroughs. Trace race: `getTraceById` replaces phone-based lookup in test endpoint |
| Mar 1 | Fix 4 open bugs | Multi-word categories, false positives (#8), graceful shutdown (#12), conversational-with-pool guardrail |
| Mar 1 | Luma event scraper | JSON API, ~330 events/week; fills community/food/art/social gap; NYC bounding box filter |
| Mar 1 | Fragility audit bulk fix (9 issues) | Issues #5-7, #9-11, #13-15 fixed in one commit; visitedHoods, scraper timeout, max_tokens, atomicWriteSync |
| Mar 1 | Dice multi-category scraping | 6 category pages in parallel; 26 → 115 raw events |
| Mar 1 | OhMyRockness removal | 80% loss rate, all duplicates; removed from SOURCES |
| Mar 1 | Scrape audit dashboards + data quality fixes | Pass rate 30.5% → 73.7%; time_format_valid regex fixed; price coverage improvements |
| Mar 1 | Price analytics + scraper price improvements | Price coverage 27% → 79% across 6 sources |
| Mar 1 | NYC Parks neighborhood resolution + refreshSources bug fix | 31 → 46 parks with neighborhoods; normalize() fix for source matching |
| Mar 1 | Extraction audit evidence fix | Pass rate 7.4% → 78.9% via `backfillEvidence()` |
| Mar 1 | SQLite event store + recurring patterns | 30-day durable store; recurring events generate dated occurrences |
| Mar 1 | Screen Slate scraper | Gmail newsletter → Claude extraction; weight 0.9, unstructured tier |
| Mar 1 | `filter_intent` prompt expansion for bare openers | "jazz", "free stuff", "comedy tonight" persist filters from turn 1 |
| Feb 28 | Deterministic Yutori non-trivia parser | 92.5% capture rate; 28/38 files skip LLM extraction |
| Feb 28 | Gemini Flash pipeline switch | ~10x cost reduction; all 4 call sites switched |
| Feb 28 | Session persistence + test endpoint timeout | Sessions survive restarts; 25s timeout prevents 502 cascades |
| Feb 28 | Event mix analytics on health dashboard | Date, category, neighborhood, free/paid distribution panels |
| Feb 24 | Filter drift fix — 5 bugs across 4 files | `mergeFilters` explicit-key semantics, targeted clearing, bare category detection |
| Feb 24 | Eval fidelity: factual verification + source completeness | 4 new code evals + per-source field-completeness checks |
| Feb 24 | City-wide scan | "where is there trivia tonight?" → scans full cache, returns top 5 neighborhoods |
| Feb 23 | Eval system fix: judge calibration, golden fixes, difficulty tiers | Pass rate 35.4% → 53.8%; must_pass 81% |
| Feb 22 | Code health: Steps 7, 8, scraper cleanup | Decomposed handleMessageAI, broke circular dep, removed dead source_weight |
| Feb 22 | Referral card & acquisition loop | 8-char codes, event card pages with OG tags, referral intake flow |
| Feb 22 | User preference profile | Silent cross-session signal capture; foundation for personalization |
| Feb 22 | Hard time gate — P5 fix | Events before `time_after` never reach the LLM |
| Feb 22 | Atomic session frames (Steps 1a, 1b, 1c) | `saveResponseFrame` replaces merge-based `setSession` for all terminal writes |
| Feb 22 | Compound pre-router extraction (Step 2) | "free jazz tonight", "underground techno in bushwick" compound filters |
| Feb 22 | Three-tier soft match for tagged pool (Step 6) | `[MATCH]`/`[SOFT]`/unmatched; subcategory preserved through pipeline |
| Feb 22 | Derive state fields deterministically (Step 3) | LLM output contract 8→4 fields |
| Feb 21 | Unified LLM + tagged pool | Single `unifiedRespond` Haiku call; A/B: 71% preference, 89% tone at 73% lower cost |
| Feb 21 | Filter drift fixes (initial) | Strict category pre-filtering in handleMore and handleEventsDefault |

---

## Not Building

- ~~Happy hours / venue busyness / bar discovery~~ — Happy hour detection moved to near-term roadmap; Google Places enrichment (Popular Times, review signals) moved to community layer Phase 3 for community-score heuristics; general bar discovery (no event connection) still out of scope
- Yelp/Foursquare venue DB — Google Places covers the venue metadata we need (Popular Times, review count, price level); no need for additional venue APIs
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- ~~General web crawling — whitelist sources only~~ — Targeted niche crawlers moved to medium-term roadmap; untargeted general crawling still out of scope
- Real-time scraping — SMS users don't need sub-daily freshness
