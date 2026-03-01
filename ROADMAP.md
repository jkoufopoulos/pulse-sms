# Pulse — Roadmap

> Single source of truth for architecture principles, evolution strategy, open issues, and planned work.
> Last updated: 2026-03-01

---

## Architecture Principles

These principles govern how Pulse splits work between deterministic code and LLM calls. They were developed from regression eval failures, reviewed across multiple models, and represent consensus.

### P1. Code Owns State, LLM Owns Language

The LLM is never the system of record for structured data. Session state, filters, neighborhood resolution, event selection logic — all owned by deterministic code. The LLM reads well-formed tagged inputs and produces natural language output.

**In practice:** `mergeFilters()` compounds filters deterministically. `buildTaggedPool()` tags matching events with `[MATCH]` (hard match) or `[SOFT]` (broad category match where subcategory is set — e.g. jazz within live_music). The LLM sees the tagged pool and writes copy — it doesn't manage or report filter state.

**Anti-pattern:** Reading `filters_used` from LLM output and merging it into session state. This makes the LLM a secondary source of truth. If it hallucinates a filter, we persist it. We tried this (2026-02-22) and reverted it because it violates this principle.

### P2. Separate Reasoning from Rendering

If the LLM must both understand intent and write compelling copy, those should be separate operations. The reasoning pass returns a small validated struct. The rendering pass takes well-formed data and returns text.

**Current state:** One unified Haiku call does both. Its output contract has 4 structured fields — `type`, `sms_text`, `picks`, `filter_intent`. Step 3 removed the 4 redundant state-management fields. The `filter_intent` migration (2026-03-01) replaced the `clear_filters` boolean with a granular `{ action, updates }` object.

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

**Current:** Contract has 4 fields: `type`, `sms_text`, `picks`, `filter_intent` (was 8 fields before Step 3). `filter_intent: { action: "none"|"clear_all"|"modify", updates }` enables granular filter modifications from LLM, not just clear-all.

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
| 3 | Derive state fields deterministically — remove 4 redundant LLM fields (8→4) | P1, P5 | **Done** |
| 4 | Reasoning/rendering split — separate intent+selection from copywriting | P2, P5 | Needs A/B eval |
| 5 | *(merged into step 3)* | — | **Done** |
| 6 | Finer category taxonomy — three-tier soft match | — | **Done** |
| 7 | `executeQuery` pipeline — single prompt path, ~550 lines deleted | P4 | **Done** |
| 8 | Scoped event fetching — `neighborhood`/`borough` scope | — | Planned |

Steps 1-3, 6-7 are done. Step 4 is a structural bet requiring A/B evaluation. Step 8 builds on the foundation.

**Key decision:** Use `tool_use` for reasoning call (step 4). Nothing from reasoning passes to rendering except event data.

---

## Resilience Gaps

| Gap | What | Principle | Status |
|-----|------|-----------|--------|
| 1 | `clear_filters` — LLM → code state bridge | P1 | **Superseded** — replaced with `filter_intent` schema (2026-03-01) |
| 2 | Unified call couples reasoning and rendering | P2 | **Open** — Step 4 A/B eval required |
| 3 | Pool padding gives LLM material to violate filter intent | P1 | **Fixed** — eliminated unmatched padding (2026-03-01) |
| 4 | No degraded-mode recovery when LLM fails | — | **Fixed** — deterministic fallback from tagged pool (2026-03-01) |

### Gap 2: Reasoning/Rendering Coupling (Open)

`unifiedRespond` produces both structured fields (`type`, `picks`, `filter_intent`) and natural language (`sms_text`) in a single call. When the model makes a poor selection (e.g., picks unmatched events despite filter instructions), there's no checkpoint to catch it before the copy is written. The structured output and prose are entangled.

**Fix direction:** Migration Step 4 — split into reasoning call (`type`, `picks`, `filter_intent` via `tool_use`) and rendering call (`sms_text` from validated picks). Code validates picks between calls. Needs A/B eval to confirm no quality regression.

---

## Open Issues

### Gemini Flash Model Strategy (pending post-fix comparison)

Gemini 2.5 Flash is the production model (50% pass rate, best of 3 models tested, ~10x cheaper than Haiku). Haiku baseline was 42%. A fresh post-fix comparison is needed — the 13 both-fail systemic scenarios have been addressed since the original comparison.

### Pre-Router False Positives on Common Words (#8 from fragility audit)

"sorry I'm late" sets `time_after:22:00`; "I'll rock up" sets `category:live_music`. Single-dimension compounds fire during active sessions. Fix: require anchor phrases or `filterDims >= 2`.

### "live music" Pre-Router Gap

Standalone "live music" not detected as category filter by pre-router. 2 eval scenarios affected.

### Conversational-with-Pool (3 scenarios)

LLM returns `type: conversational` despite events in pool. Scenarios #2, #12, #21 from behavioral eval.

### Yutori Extraction — Remaining Gaps

- Non-recurring series events ("running through March") not yet handled by recurrence system
- One-off events with dates >7 days out stored in SQLite but only surface when date falls within 7-day serving window (correct behavior)

### Pre-Router Mechanical Paths Don't Save Session State

Pre-router mechanical shortcuts (greetings, help, thanks, bye) go through `handleConversational`/`handleHelp` which never call `saveResponseFrame`. Conversation history IS saved (via `addToHistory`), but deterministic session state (lastPicks, lastNeighborhood, lastFilters) is NOT.

**What works today:** "hi" → canned greeting → "jazz" → unified LLM sees conversation history, serves citywide jazz correctly. The conversation history bridge is sufficient.

**Three gaps:**

| Gap | Example | Impact |
|-----|---------|--------|
| No deterministic filter state from opener context | "hi" → "jazz" → "west village" — jazz filter not carried deterministically | Category context fragile — works via LLM memory, not guaranteed |
| Pre-router category detection skipped | "hi" → "jazz" → "how about comedy" — falls to unified instead of $0 pre-router path | Minor cost increase, no UX impact |
| Citywide picks don't set `visitedHoods` | "surprise me" → citywide → "bushwick" → exhaust → no Tavily fallback | Tavily fallback unreachable for citywide→narrow flows |

**Partial fix (2026-03-01):** Expanded `filter_intent` prompt for bare openers — "jazz", "free stuff", "comedy tonight" now report `filter_intent: modify` on turn 1, enabling P1-compliant filter persistence through citywide→neighborhood flows.

### Deferred (post-MVP)

| Issue | Why deferred |
|-------|-------------|
| Concurrent session race conditions | Rare at current traffic |
| No processing ack during slow Claude calls | Adds extra Twilio cost; degraded-mode fallback covers the worst case |
| No horizontal scalability | Single-process fine at current traffic |
| No structured logging or correlation IDs | Operational improvement for scale |
| No integration tests or mocking | Important eventually, not blocking |

---

## Pre-Launch Fragility Audit

### High Priority — Open

| # | Issue | Location | What Breaks | Fix Effort |
|---|-------|----------|-------------|------------|
| 5 | `visitedHoods` resets on every new neighborhood | pipeline.js, handler.js | Multi-neighborhood exploration history lost; Tavily fallback never triggers for revisited hoods | Quick |
| 6 | Hanging scraper blocks all future cache refreshes | events.js timedFetch | One hung fetch() permanently blocks refreshCache; cache goes stale until restart | Quick |
| 7 | Anthropic fallback max_tokens: 512 truncation | ai.js | Gemini→Anthropic fallback produces truncated JSON → parse failure → dead-end response | Quick |
| 8 | Pre-router false-positives on common words | pre-router.js | "sorry I'm late" sets time_after:22:00; "I'll rock up" sets category:live_music | Structural |

### Medium Priority — Open

| # | Issue | Location | What Breaks | Fix Effort |
|---|-------|----------|-------------|------------|
| 9 | `isLastBatch`/`exhaustionSuggestion` skills dropped in MORE path | intent-handlers.js | Last-batch MORE still says "Reply MORE" (compensated by regex strip) | Quick |
| 10 | `tonightPriority` and `conversationAwareness` conflict on "tomorrow" queries | compose-skills.js | Both skills active with contradictory time instructions | Quick |
| 11 | Prompt injection via unbounded `short_detail` | ai.js | Event descriptions interpolated into prompt with no length cap | Quick |
| 12 | Graceful shutdown kills in-flight handlers after 5s | server.js | Railway SIGTERM during Tavily fallback kills handler mid-flight | Medium |
| 13 | Gemini finishReason logged but not acted on | ai.js | MAX_TOKENS/SAFETY finish reasons produce truncated response | Quick |
| 14 | `extractEvents` returns unvalidated JSON shape | ai.js | LLM returns `{venues: [...]}` instead of `{events: [...]}` | Quick |
| 15 | Non-atomic disk writes for cache/sessions | events.js, session.js | Process kill during writeFileSync → corrupted JSON → empty cache on boot | Quick |

### Deferred

| # | Issue | Why Deferred |
|---|-------|-------------|
| 16 | Race condition on parallel messages from same phone | Rare at current traffic; Twilio serializes per-number |
| 17 | Dead `core` skill with conflicting output schema | Zero impact today |
| 18 | Event name dedup merges distinct same-venue events | Edge case for jazz venues with multiple sets |
| 19 | Events in undefined neighborhoods invisible to geo queries | 3km hard filter + null-neighborhood; structural design choice |

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
| filter_drift | — | 15.4% | — | Stuck — structural, not prompt-fixable |
| poor_experience | 60.0% | 30.0% | ~65% | Data-sparsity dependent |
| abuse_off_topic | 83.3% | 100.0% | — | Stable |

### Key Patterns

- **Eval non-determinism (~25% scenario variance):** Identical code on different days produces 5-15% swings due to daily event cache changes. Scenarios depending on specific events in thin neighborhoods flip pass/fail based on what was scraped that morning.
- **Pool padding was the structural enabler of filter drift (Gap 3 — fixed):** Eliminating unmatched padding when filters are active means the LLM only sees matched events. Expected to resolve remaining filter_drift failures.
- **Outer-borough scenarios are cache-dependent, not code-dependent:** Thin neighborhoods (Washington Heights, Red Hook, Sunset Park) fail when the daily cache has few events there. Not code bugs — coverage gaps.

### Eval Fidelity Gaps (remaining)

| # | Gap | Priority | Status |
|---|-----|----------|--------|
| 7 | Trace fetch race condition — could grab wrong trace under concurrent load | P2 | Planned |
| 8 | No dedicated handleMore path eval | P2 | Planned |

---

## Source Coverage

### Current Sources (17 active)

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
| NYPL | 0.7 | Eventbrite organizer | Free library events |
| EventbriteComedy/Arts | 0.7 | Same parser, category URLs | Comedy/art-specific |

**Inactive (scrapers preserved):** OhMyRockness (80% loss rate, all duplicates), Tavily (removed from hot path, used as exhaustion fallback only).

### Category Gaps

| Category | Coverage | Gap |
|----------|----------|-----|
| Electronic/dance | Strong (RA, Dice) | — |
| Indie/rock/punk | Good (Songkick, BrooklynVegan, Dice) | — |
| Comedy | Moderate (EventbriteComedy, DoNYC, Dice) | No dedicated comedy source |
| Art/galleries | Weak (EventbriteArts, Skint) | No gallery opening calendar |
| Theater | Moderate (DoNYC, BAM, Dice) | No Broadway/off-Broadway source |
| Underground/DIY | Single source (Nonsense NYC) | If it breaks, entire vibe gone |
| Jazz | Good (SmallsLIVE, Skint, DoNYC) | — |
| Film | Good (Screen Slate, BAM, Skint Ongoing) | — |

---

## Feature Roadmap

### Near-term — Source + Quality

- Comedy source — Dedicated scraper for Comedy Cellar, UCB, Caveat, QED
- Gallery/art source — Gallery listing aggregator or DoNYC art category

### Medium-term — Intelligence

- Scout worker — Background process to fill neighborhood gaps after daily scrape
- Perennial picks evolution — Auto-detect candidates from scrape data
- Second daily scrape — 5pm ET pass catches events posted mid-day (6pm scrape already added for newsletters)

### Long-term — Infrastructure + Product

- PostgreSQL — Persistent event storage, user sessions, conversation history
- Preference learning — Profile capture done; next: inject profile into compose prompt for personalized picks
- Referral analytics — Dashboard for referral code generation, card views, conversion rates
- Paid tier — Stripe billing, $5-10/month unlimited
- Push notifications — "Free rooftop thing near you starting in 30 min"
- Multi-city — Same architecture, different sources
- SQLite user profiles — implicit personalization, "my usual", weekend digest

---

## Tech Debt

| Item | Risk | Notes |
|------|------|-------|
| `annotateTrace()` is O(n) | Low | Rewrites entire JSONL file for one trace update |
| No integration tests | Medium | No way to test handler → AI → session flow without live API calls |
| `eval.js` scores events sequentially | Low | Not parallelized; slow for large caches |
| Price data gap (21% unknown) | Low | Down from 71.6% after scraper improvements; remaining is structurally unavailable |
| No horizontal scalability | Low | Single-process, in-memory sessions |
| Preference learning not yet active | Low | Profiles captured but not injected into prompts |
| `cityScan` skill activation mismatch | Low | Skill defined but handler uses `cityScanResults` — verify or remove |
| `architecture.html` references deleted flow | Low | Still references `routeMessage`/`composeResponse` |

---

## Completed Work

| Date | What | Key Impact |
|------|------|------------|
| Mar 1 | Degraded-mode LLM fallback + MORE dedup hardening | Gap 4 fixed — deterministic picks from tagged pool on LLM failure |
| Mar 1 | Code eval accuracy overhaul | 99.8% code eval pass rate (was 99.5%); fixed CATEGORY_PARENTS sync, filter_match_alignment, zero-match exemption |
| Mar 1 | Non-neighborhood opener eval expansion | +29 multi-turn + 16 regression scenarios for greetings, bare categories, vibes, meta questions |
| Mar 1 | Event name match routing fix | Pre-router no longer hijacks neighborhood names that match event titles |
| Mar 1 | Replace regex semantic routing with LLM `filter_intent` | Replaced `clear_filters` boolean + CLEAR_SIGNALS regex + ~100 lines pre-router regex with `filter_intent: { action, updates }` schema |
| Mar 1 | Filter-active dismissal prompt fix | P10 regression: 66.7% → 83.3%; "nvm"/"forget it" with active filter now clears filters |
| Mar 1 | Model router filter interaction signal | Ambiguous filter messages (+35 complexity) route to Haiku for semantic understanding |
| Mar 1 | Fix time filter persistence + details filter compliance | Compound first messages persist time via `filter_intent`; details handler rejects stale picks violating active filters |
| Mar 1 | Gap 3 fix — remove unmatched pool padding | LLM only sees matched events when filters active; structural fix for filter drift |
| Mar 1 | Step 7: `executeQuery` pipeline | All paths unified; deleted ~550 lines (routeMessage, composeResponse, ROUTE_SYSTEM, COMPOSE_SYSTEM) |
| Mar 1 | Model comparison eval (Haiku/Flash/Flash-Lite) | Flash best (50%), Flash-Lite ties Haiku (42%) but weaker on neighborhood/price accuracy |
| Mar 1 | Zero-match bypass + cascade protection | `handleZeroMatch` wired up; happy_path 50% → 90% |
| Mar 1 | Nudge-accept flow fix (Root Cause D) | Added `neighborhood` to `ask_neighborhood` pending object — one-line fix for ~10% of filter failures |
| Mar 1 | Yutori junk event filter | Blocked ~50 prose bullets (self-help, tax, career) via category + filename + structural filters |
| Mar 1 | Skint Ongoing events scraper | 31 series events (exhibitions, festivals) via deterministic parser; weight 0.9 |
| Mar 1 | Friday/Saturday newsletter event loss fix | Yesterday included in scrape filter + 6pm evening scrape added |
| Mar 1 | Systemic failure fixes (8 changes) | handler.js events bug, borough detection, sign-off handling, early/tonight conflict, zero-match prompt hardening |
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

- Happy hours / venue busyness / bar discovery — different product
- Yelp/Foursquare venue DB — venue discovery != event discovery
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- General web crawling — whitelist sources only
- Real-time scraping — SMS users don't need sub-daily freshness
