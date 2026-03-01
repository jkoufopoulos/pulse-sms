# Pulse — Roadmap

> Single source of truth for architecture principles, evolution strategy, open issues, and planned work.
> Last updated: 2026-03-01 (3-model comparison eval, Yutori junk event filter, eval trajectory & trends, Skint ongoing events scraper, Friday/Saturday newsletter event loss fix, systemic failure fixes, handler.js events bug, Haiku baseline, codebase audit, Gemini Flash migration eval, filter drift 5-cause analysis, session persistence, test endpoint timeout, resilience gap analysis)

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
| 7 | `executeQuery(context)` pipeline — thin handlers, single filter path | P4 | Prevents split-brain filtering from recurring | **Done** |
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

## Resilience Gaps — Transition Zone Vulnerabilities

The architecture principles (P1-P7) and migration steps address the core design. The remaining quality failures cluster at four transition zones — places where deterministic code hands off to the LLM or where the system has no fallback. These gaps explain why eval pass rates plateau even as individual bugs get fixed.

### Gap 1: `clear_filters` — Last P1 Bridge (LLM → Code State)

**What:** The LLM returns `clear_filters: true` and the handler uses it to wipe session filter state. This is the only remaining path where LLM output directly mutates code-owned state, violating P1.

**Current mitigation:** `CLEAR_SIGNALS` regex in `handler.js` gates the LLM's claim — `clear_filters: true` is only honored if the user message matches `/\b(everything|all|fresh|reset|forget|nvm|...)\b/i`. This reduces but doesn't eliminate the surface: any new clear-like phrase the LLM detects but the regex doesn't match gets silently ignored, and any hallucinated `clear_filters: true` on a matching message passes through.

**Impact:** Filter state can be unexpectedly wiped on conversational turns where the user didn't intend to clear. Conversely, semantic clearing ("just show me what's good") only works if the regex happens to cover the phrase. This is a P1 violation with a code-level guardrail — an improvement over raw LLM state writes, but not a principled solution.

**Fix direction:** Move all filter clearing to the pre-router (P6). Expand the clear-intent regex to cover the semantic cases currently delegated to the LLM. Remove `clear_filters` from the LLM output schema entirely, completing P1. This also reduces the output contract from 4 fields to 3 (P5).

**Related:** Filter Drift Fix #3 (2026-02-24), P1 anti-pattern note.

### Gap 2: Unified Call Couples Reasoning and Rendering (P2 Not Realized)

**What:** `unifiedRespond` produces both structured fields (`type`, `picks`, `clear_filters`) and natural language (`sms_text`) in a single call. The LLM simultaneously decides what to recommend and writes the SMS copy.

**Impact:** When the model makes a poor selection (e.g., picks unmatched events despite filter instructions), there's no checkpoint to catch it before the copy is written. The structured output and prose are entangled — you can't validate picks without also paying for rendering, and you can't re-render without also re-reasoning. This coupling is the root cause of Theme A (category filter drift) and Root Cause C (zero-match fallback): the LLM sees unmatched events in the pool, decides to recommend them, and writes persuasive copy about them, all in one pass.

**Fix direction:** Migration Step 4 — split into reasoning call (`type`, `picks`, `clear_filters` via `tool_use`) and rendering call (`sms_text` from validated picks). Code validates picks between calls. Needs A/B eval to confirm no quality regression.

**Related:** P2 principle, Migration Step 4, Theme A (category filter drift), Root Cause C (zero-match fallback).

### Gap 3: Pool Padding Gives LLM Material to Violate Filter Intent

**What:** `buildTaggedPool` includes up to 5 unmatched events as padding when filter matches are thin. These events are visible to the LLM with no `[MATCH]` tag, intended as context. But the LLM can and does pick from them — especially Gemini Flash, which is less disciplined about respecting `[MATCH]` boundaries.

**Impact:** This is the structural enabler of filter drift. The deterministic filter machinery works correctly — `mergeFilters` compounds filters, `eventMatchesFilters` classifies correctly, matched events are tagged `[MATCH]`. But then the pool hands the LLM 5+ tempting alternatives with no tag, and the LLM writes copy recommending them. Theme A (6 failures), Root Cause C (25% of filter drift), and Theme F (thin coverage) all trace back to this: the LLM has access to events it shouldn't recommend.

**Fix direction:** Three options, not mutually exclusive: (1) Reduce or eliminate unmatched padding — if filters match 3 events, send 3, not 15. This is the simplest and most P1-aligned fix. (2) Add an explicit `[NO_PICK]` tag to unmatched events so the prompt constraint is reinforced structurally. (3) Complete Gap 2 / Step 4 (reasoning/rendering split) so code validates picks against filter matches before rendering.

**Related:** Theme A (category filter drift), Root Cause C (zero-match fallback), Theme F (thin coverage).

### Gap 4: No Degraded-Mode Recovery When LLM Fails

**What:** If the unified LLM call fails (timeout, parse error, provider outage), the only fallback is a generic "Bestie, hit a snag" message. There's no intermediate recovery — no cached-response replay, no deterministic pick-from-pool, no retry with a simpler prompt.

**Impact:** Root Cause A (35% of filter eval failures) showed that a single failed turn cascades into the entire session. The user gets "hit a snag," the session may not save cleanly, and subsequent turns hit stale or missing state. The Gemini-fallback-to-Haiku pattern in `ai.js` is a provider hedge, not graceful degradation — if both fail, the user is stuck. System reliability is fully coupled to LLM provider uptime.

**Fix direction:** Add a deterministic fallback response path: when the LLM call fails, compose a minimal SMS from the tagged pool using code (top 3 `[MATCH]` events, formatted mechanically via `formatters.js`). This preserves session state and gives the user something useful. The fallback won't have the LLM's tone, but it maintains conversation flow. Also: ensure `saveResponseFrame` runs on error paths so sessions aren't corrupted by failures.

**Related:** Root Cause A (502/crashes), Deferred: "No processing ack during slow Claude calls."

### Gap Impact Summary

| Gap | Principle violated | Eval impact | Fix effort |
|-----|-------------------|-------------|------------|
| 1: `clear_filters` bridge | P1 (code owns state) | Filter wipe on non-clearing turns; semantic clearing misses | Medium — expand pre-router regex, remove LLM field |
| 2: Reasoning/rendering coupling | P2 (separate concerns) | Category drift, zero-match fallback (Theme A + Root Cause C) | High — Step 4 A/B eval required |
| 3: Pool padding | P1 (code owns state) | Structural enabler of filter drift (Theme A, C, F) | Low-Medium — reduce padding or add `[NO_PICK]` tag |
| 4: No degraded-mode recovery | (No principle yet) | 35% of eval failures cascade from single LLM failure | Medium — deterministic fallback formatter |

Gaps 2 and 3 are the primary blockers for filter drift improvement beyond the current plateau. Gap 1 is the last P1 violation. Gap 4 is the biggest operational risk.

---

## Open Issues

### Gemini Flash Migration — Eval Results + Remaining Work (2026-02-28)

**Status:** `src/ai.js` switched to Gemini 2.5 Flash for all pipeline calls (`unifiedRespond`, `composeResponse`, `extractEvents`, `composeDetails`). Eval: 28/48 happy_path passing (58%). Code evals 96.1% (on par with Haiku). Defaults can be reverted via env vars `PULSE_MODEL_COMPOSE` / `PULSE_MODEL_EXTRACT`.

**Why:** Gemini Flash is ~10x cheaper than Haiku ($0.10/$0.40 vs $1.00/$5.00 per M tokens). Eval suite drops from ~$7-10/run to ~$1-2/run. Production pipeline cost drops from ~$0.004/session to ~$0.0004/session.

**Haiku baseline (2026-02-28):** 27/48 happy_path passing (56%). Gemini is at parity — the 20 Gemini failures are not primarily model regressions. Breakdown:

| Category | Count | Scenarios |
|----------|-------|-----------|
| **Both fail** | 13 | Systemic issues (alias gaps, thin coverage, filter/time handling, geographic expansion) |
| **Gemini-only fail** | 7 | Gemini regressions — sign-off engagement, details quality, category drift |
| **Haiku-only fail** | 8 | Gemini actually outperforms Haiku here |
| **Both pass** | 20 | Stable scenarios |

**Both-fail scenarios (systemic, fix benefits both models):** BK slang → borough narrowing (alias gap), Boerum Hill/Carroll Gardens (alias gap), Astoria music (category filter on thin pool), Hell's Kitchen theater (category on MORE), Washington Heights music (category on MORE), LIC brief browse (expansion transparency), Tribeca quick pick (thin coverage → expansion), UES dance (thin coverage + expansion), live music Bed-Stuy (neighborhood jump), time filter early (time interpretation), progressive filter refinement (compound filters), time range specific window, user asks to recommend.

**Gemini-only failures (7):** Full evening flow, Astoria MORE detail, Cobble Hill late night, SoHo single pick, Sunset Park live music, Tribeca single pick, West Village late. These are the true Gemini delta — sign-off over-engagement, details quality, and category drift on sparse pools.

**Haiku-only failures (8):** Neighborhood hopping, Bed-Stuy detail, Bushwick late-night, Park Slope → Gowanus, Red Hook detail, free events filter, Gowanus live music, Ridgewood browse. Gemini handles these better — possibly due to different expansion and formatting behaviors.

**Conclusion:** Gemini Flash is production-ready as-is. The 13 both-fail scenarios are the real quality gap — fixing those lifts both models. The 7 Gemini-only failures are worth addressing but not blockers.

**Model Strategy (pending):** The Haiku vs Gemini comparison above was pre-systemic-fixes (before handler.js events bug, alias additions, sign-off detection, borough narrowing, prompt hardening). Those fixes addressed the 13 both-fail scenarios. A fresh post-fix comparison is needed to finalize the model decision. See eval trajectory section for run plan.

**What's done (ai.js only):**
- `unifiedWithGemini()` — temp=0.5, topP=0.9, maxOutputTokens=4096, `responseSchema` enforcing `{type, sms_text, picks[], clear_filters}`
- `composeWithGemini()` — temp=0.5, topP=0.9, maxOutputTokens=8192 (already existed, params tuned)
- `extractWithGemini()` — temp=0, maxOutputTokens=4096
- `detailsWithGemini()` — temp=0.8, maxOutputTokens=1024
- All four functions fall back to Anthropic Haiku on error
- Default models changed: `compose` and `extract` default to `gemini-2.5-flash`
- `_provider` field set correctly for cost tracking

**Tuning progression:**

| Run | Change | Pass Rate |
|-----|--------|-----------|
| 1 | Naive port (temp=1.0, 512 tokens) | 0% — all responses truncated mid-JSON |
| 2 | Fixed maxOutputTokens to 4096 | 50% |
| 3 | Added responseSchema + temp=0.7 + cleared stale sessions | 62.5% |
| 4 | temp=0.5 + topP=0.9 | 58% (28/48) |

**20 remaining failures — 6 root cause themes:**

#### Theme A: Category filter drift on thin pools (6 failures)

When `[MATCH]` events are sparse, Gemini fills with unmatched events without acknowledging the departure. Haiku says "no comedy in Bushwick tonight" — Gemini silently serves nightlife.

Scenarios: progressive filter refinement (comedy drops on hood switch), time range + comedy + free stacking (comedy silently dropped), Astoria live music (karaoke/DJ returned for "live music"), Sunset Park live music (karaoke returned), Hell's Kitchen theater (MORE returns comedy/orchestra), Washington Heights music (MORE drops music filter).

**Fix:** Prompt-level hardening is a mitigation. The structural fix is Gap 3 (reduce pool padding) + Gap 2 (reasoning/rendering split with pick validation). See Resilience Gaps section.

#### Theme B: Neighborhood expansion not transparent (5 failures)

Gemini expands to nearby neighborhoods without the "not much in X, but nearby Y has..." framing the judge expects. In one case (UES → Astoria), it expands far across the city.

Scenarios: SoHo → NoHo without framing, Tribeca → Greenwich Village/NoHo (×2), UES → Astoria (geographically wrong), BK treated as serveable instead of narrowed.

**Fix:** Prompt-level (`nearbySuggestion` skill + `UNIFIED_SYSTEM` expansion rules). Also a pool issue — `buildTaggedPool` shouldn't include Astoria events for a UES request. The BK case is a pre-router gap (no borough-narrowing logic).

#### Theme C: Sign-off over-engagement (4 failures)

Satisfied exit signals ("cool", "sick", "perfect", "perfect thanks") get re-engagement prompts instead of warm sign-offs. Gemini doesn't recognize these as conversation closers.

Scenarios: LIC brief browse ("cool"), Cobble Hill late night ("sick"), Bed-Stuy details ("perfect"), UES dance ("perfect thanks").

**Fix:** Prompt-level. The conversational handling rules could emphasize brief sign-offs for satisfied signals. Alternatively, the pre-router's conversational handler could detect satisfied-exit patterns and use a fixed warm sign-off (zero AI cost).

#### Theme D: Details failures (4 failures)

Mixed: (1) "tell me more" misinterpreted as "more picks" instead of "details on recommendation", (2) `composeDetails` returned "I can't give details" (system error — session lost picks), (3) details truncated mid-sentence at 1024 tokens, (4) details too hyperbolic / lacking venue character.

Scenarios: recommend flow ("tell me more" ambiguity), West Village (system error), Bed-Stuy (truncation), Tribeca (hyperbolic tone).

**Fix:** Bump `detailsWithGemini` maxOutputTokens to 2048 for truncation. Lower details temp to 0.6 for tone. The "tell me more" ambiguity is a pre-router issue — could add a pattern for "tell me more" when `lastPicks` exists to route to details. The system error needs investigation (session not saving picks).

#### Theme E: Alias / borough recognition (2 failures)

Not model-related. Pre-router / `neighborhoods.js` gaps.

Scenarios: "bk" not recognized as needing borough narrowing, Boerum Hill and Carroll Gardens not mapped as Cobble Hill aliases.

**Fix:** Add aliases to `neighborhoods.js`. Add borough-narrowing logic to pre-router.

#### Theme F: Thin coverage dead ends (3 failures)

When the event pool is genuinely empty for a filter+neighborhood combo, Gemini's handling is awkward — gives up too quickly, asks permission instead of delivering, or returns unrelated events.

Scenarios: Astoria MORE (says "that's everything" with 0 new picks, then detail fails), SoHo early (no early events, asks permission to show late), Washington Heights (no live music, returns comedy/salsa).

**Fix:** Partially overlaps with Theme A (filter drift). The `handleMore` exhaustion path could be improved to better communicate thin coverage. The permission-asking pattern ("want me to show late picks?") is a Gemini behavioral tendency — prompt could address it.

#### Summary: Fix priority for Gemini production readiness

| Theme | Count | Fix area | Effort |
|-------|-------|----------|--------|
| A: Category filter drift | 6 | Prompt (`UNIFIED_SYSTEM`, `COMPOSE_SYSTEM`) | Medium — prompt hardening |
| B: Expansion transparency | 5 | Prompt + `buildTaggedPool` geographic limits | Medium |
| C: Sign-off over-engagement | 4 | Prompt or pre-router exit detection | Low |
| D: Details failures | 4 | Token limit + temp + pre-router + debug | Mixed |
| E: Alias recognition | 2 | `neighborhoods.js` | Low |
| F: Thin coverage handling | 3 | Prompt + handler logic | Medium |

**Haiku baseline confirmed (2026-02-28):** Themes A, B, E, and F are systemic — Haiku fails the same scenarios. Only 7 of the 20 Gemini failures are Gemini-specific regressions. See Haiku baseline section above for full breakdown.

### Filter Drift — Root Cause Analysis (updated 2026-02-28)

**Status:** 59/130 scenario evals passing (45%), 7/47 regression evals passing (15%). Updated analysis below based on 47 filter persistence failures from 2026-02-28 eval run against Railway. **The deterministic filter machinery (`mergeFilters`, `buildTaggedPool`) is working correctly.** Failures are upstream (infrastructure), downstream (LLM compose), and at the edges (nudge-accept, pre-router session requirements).

#### Root Cause A: 502 errors / crashes (~35% of failures) — infrastructure, not filter logic

The test endpoint (`/api/sms/test`) is synchronous. If a Claude API call or Tavily fallback hangs, Railway's proxy returns 502 before the response completes. Sessions are in-memory, so a container restart wipes all state. Subsequent turns cascade — number requests hit null `lastPicks` → "I don't have picks loaded."

**Affected scenarios:** Every scenario where the first or second response is "Bestie hit a snag" — free stuff in prospect heights, later tonight in bed stuy, free dance music in greenpoint, late in astoria, free jazz in fort greene (cascading 4x), live music in bushwick later→earlier, free live music in bushwick, late night crown heights, misspelled neighborhood→greenpont 502, whats closest→free 502, free jazz EV. Plus every "I don't have picks loaded" that follows a 502 in the same scenario.

**Fixed (2026-02-28):** Test endpoint now has 25s `Promise.race` timeout — returns clean 500 before Railway's proxy kills the connection. Session disk persistence means sessions survive container restarts.

#### Root Cause B: Session loss → "I don't have picks loaded" (~15% of failures)

Even without a visible 502, users text a number (1-5) and get "I don't have picks loaded." Root causes: (1) server restarted between turns (sessions were in-memory only), (2) previous turn's `saveResponseFrame` never ran due to error, (3) previous turn returned `ask_neighborhood` type which saves `session?.lastPicks || []` — if there were no previous picks, it saves empty.

**Affected scenarios:** jazz in cobble hill→"ok"→"2", comedy in cobble hill→"more"→"1", jazz in harlem→"1", free comedy in harlem→"2", free stuff in greenpoint→"williamsburg"→"2", free jazz in soho→"tribeca"→"3", category survives ambiguous→"2".

**Partially fixed (2026-02-28):** Session disk persistence addresses cause (1). Causes (2) and (3) remain — `ask_neighborhood` still saves empty `lastPicks` when there are no prior picks.

#### Root Cause C: Filters persist correctly but match nothing — LLM abandons constraint (~25% of failures)

**The deterministic filter logic is working correctly.** `mergeFilters` compounds filters across turns. The tagged pool correctly has 0 `[MATCH]` events. But then the LLM sees 15 unmatched events with no `[MATCH]` tags, composes a response saying "nothing matches your filter," and presents alternatives from the unmatched pool. The eval judges this as "filter dropped" because the response contains non-matching events.

Example — comedy filter persists through neighborhood switch:
```
User: comedy in LES → Comedy picks shown ✓
User: try bushwick → "Bushwick tonight is all nightlife — no comedy shows on the radar"
                     (filter DID persist, just no comedy in Bushwick)
User: more → Shows non-comedy picks with "comedy's thin here"
```

Same pattern in: free+comedy stacking (compound applied, nothing matched, LLM shows alternatives), jazz→park slope (jazz filter persisted, no jazz in park slope), all "free+category in thin neighborhood" scenarios.

**Design question, not a code bug.** When filters match zero events, should Pulse: (a) show nothing and say "nothing matches" (strict, frustrating UX), (b) show alternatives with explanation (current behavior, scored as filter failure), or (c) distinguish in the eval between "filter dropped" vs "filter applied, no results"?

**Partial fix (2026-02-28):** Prompt hardening in `UNIFIED_SYSTEM` — zero-match instruction now says: "You MUST lead with 'No [filter] in [neighborhood] tonight'. Do NOT show numbered picks from unmatched events." This is a prompt-level mitigation. The structural cause is Gap 3 (pool padding gives the LLM unmatched events to recommend). See Resilience Gaps section.

#### Root Cause D: Nudge-accept ambiguity — "ok"/"sure" resets context (~10% of failures)

When the LLM suggests a nearby neighborhood ("want me to check Gowanus?"), the user says "ok" or "sure," but gets "Tell me what you're looking for" (casual ack path) instead of events from the suggested neighborhood.

**Why:** The `ask_neighborhood` response handler saved `pending: { filters: activeFilters }` but omitted the `neighborhood` key, so `pendingNearby` was always null for that path. The pre-router then caught "ok"/"bet" as casual acks (since `!session?.pendingNearby` was always true). The other three response paths (`event_picks`, `conversational`, `zero_match`) already correctly set `pending: { neighborhood: suggestedHood, filters: activeFilters }`.

**Fixed (2026-03-01):** Added `neighborhood: suggestedHood` to the `ask_neighborhood` handler's `pending` object in `handleUnifiedResponse` (handler.js:527-528), making it consistent with the other three paths. Verified on Railway: "jazz in red hook" → "sure" correctly resolves to the suggested nearby neighborhood via the `pendingNearby` → affirmation regex flow in `resolveUnifiedContext`.

#### Root Cause E: Filter stacking — pre-router gate blocks detection after zero-match turns (~15% of failures)

User has comedy filter → says "free" → gets free events but NOT free comedy. `mergeFilters({ category: 'comedy' }, { free_only: true })` → `{ category: 'comedy', free_only: true }` is correct — the machinery works. But the pre-router's session-aware filter detection requires `session?.lastPicks?.length > 0`. If the previous turn was a zero-match response, `lastPicks` is empty → pre-router skips filter detection → "free" goes to unified LLM as a fresh query → LLM interprets it without the compound context.

Two sub-cases: (1) Overlap with Root Cause C — compound filter matches nothing, LLM shows non-matching. (2) Pre-router gate — empty `lastPicks` prevents filter detection, so the new filter is treated as a standalone request.

**Fixed (2026-02-28):** Removed `lastPicks.length > 0` from the pre-router session-aware filter detection gate. Now only requires `lastNeighborhood`, so filter follow-ups work even after zero-match turns.

---

#### Summary: What Moves the Needle

| Root Cause | % of failures | Is it a code bug? | Fix | Status |
|---|---|---|---|---|
| **A: 502/crashes** | ~35% | Infrastructure | Test endpoint timeout + session persistence | **Fixed (2026-02-28)** |
| **B: Session loss** | ~15% | Yes | Session disk persistence | **Partially fixed (2026-02-28)** — `ask_neighborhood` empty picks remains |
| **C: Zero-match fallback** | ~25% | Design question | Prompt hardening: LLM must lead with "No [filter] in [hood]" before alternatives | **Fixed (2026-02-28)** |
| **D: Nudge-accept** | ~10% | Yes (missing field) | Add `neighborhood` to `ask_neighborhood` pending object | **Fixed (2026-03-01)** |
| **E: Stacking via pre-router** | ~15% | Yes (pre-router edge case) | Remove `lastPicks.length > 0` gate from filter detection | **Fixed (2026-02-28)** |

All five root causes (A-E) are now fixed. Remaining filter_drift failures are likely LLM compose-time issues (picking non-matching events from padded pool — Gap 3).

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
| ~~All in-memory state lost on restart~~ | ~~Mitigated: events persist in SQLite, sessions still in-memory~~ **Fixed (2026-02-28):** sessions now persist to `data/sessions.json` |
| No processing ack during slow Claude calls | Adds extra Twilio cost. See Gap 4 (degraded-mode recovery) for broader fallback strategy |
| No horizontal scalability | Single-process fine at current traffic |
| No structured logging or correlation IDs | Operational improvement for scale |
| No integration tests or mocking | Important eventually, not blocking |

---

## Eval Trajectory & Trends (as of 2026-03-01)

### Pass Rate Timeline

| Date | Scenarios | Pass Rate | Regression (scenarios) | What Changed |
|------|-----------|-----------|------------------------|--------------|
| Feb 22 (AM) | 51 | 66.7% | — | First eval run, 51-scenario suite |
| Feb 22 (PM) | 51 | 76.5% | 35.0% (7/20) | Hard time gate, compound pre-router, initial regression suite (20 scenarios) |
| Feb 23 | 71 | 54.9% | — | Suite expanded to 71 scenarios (new edge cases, poor_experience added) |
| Feb 24 | 130 | 35.4% | — | Suite expanded to 130 (added 26 filter_drift scenarios), Haiku judge (stricter) |
| Feb 25 | 130 | 54.6% | 36.4% (16/44) | Sonnet judge restored, regression suite expanded to 44, systemic fixes landed |
| Feb 28 | 130 | 48.5% | 31.8% (14/44) | Session persistence, test endpoint timeout, prompt hardening, Gemini Flash switch |

**Note on judge variance:** The Feb 24 drop (35.4%) was primarily caused by switching to Haiku as judge — Haiku is significantly stricter than Sonnet. Feb 25 restored Sonnet judge and added systemic fixes, producing the peak. The Feb 28 run uses the same judge (Sonnet) but a different event cache (daily cache changes alter which scenarios have matching events).

### Category-Level Trends

| Category | Feb 22 (51) | Feb 25 (130) | Feb 28 (130) | Trend |
|----------|-------------|--------------|--------------|-------|
| happy_path | 73.3% (11/15) | 75.0% (36/48) | 79.2% (38/48) | Steady improvement |
| edge_case | 93.3% (14/15) | 64.5% (20/31) | 51.6% (16/31) | Declining — more scenarios exposed gaps |
| filter_drift | — | 15.4% (4/26) | 0.0% (0/26) | Stuck — structural, not prompt-fixable |
| poor_experience | 60.0% (9/15) | 30.0% (6/20) | 25.0% (5/20) | Declining — cache-dependent scenarios |
| abuse_off_topic | 83.3% (5/6) | 100.0% (5/5) | 80.0% (4/5) | Stable (small N, high variance) |

### Key Patterns

- **Eval non-determinism (~25% scenario variance):** Identical code on different days produces 5-15% overall swings due to daily event cache changes. Scenarios that depend on specific events in specific neighborhoods (outer-borough, thin categories) flip pass/fail based on what was scraped that morning. This makes it hard to attribute pass rate changes to code vs cache.

- **Pool padding is the structural enabler of filter drift (Gap 3):** `buildTaggedPool` pads to 15 events with unmatched events. When filters match 0 events, the LLM sees 15 unmatched events and recommends from them, which judges score as "filter dropped." Prompt hardening ("lead with 'No [filter] in [hood]'") is a mitigation, not a fix. The structural fix is reducing or eliminating unmatched padding when matches are zero.

- **Regression eval decline (35% → 28%) needs investigation:** The regression suite has declined despite code fixes that should have improved it. Possible causes: (1) the Mar 1 run used Haiku as judge (stricter than Sonnet used in earlier runs), (2) suite expanded from 20 → 44 → 47 scenarios (new scenarios may have lower baseline pass rates), (3) assertion-level pass rate is relatively stable (70-76%), suggesting scenarios are partially passing but failing on 1-2 assertions.

- **Outer-borough scenarios are cache-dependent, not code-dependent:** Scenarios for thin neighborhoods (Washington Heights, Red Hook, Sunset Park) fail when the daily cache has few/no events there. These aren't code bugs — they're coverage gaps. The Tavily live-search fallback (landed 2026-03-01) may improve these, but the eval doesn't account for fallback latency.

### Extraction Audit Blind Spots

The extraction audit shows 82-100% pass rates on most days, but this is misleading. The audit only checks events that have raw text capture (`extraction-capture.js`), and most sources skip capture. Typical runs check 2-25 events out of 200+ in the cache. The Feb 24 drop (21.4%, 3/14) was a real signal — extraction confidence thresholds were too permissive for Skint events with ambiguous dates.

### What Moves the Needle

| Action | Expected Impact | Effort | Status |
|--------|----------------|--------|--------|
| Reduce pool padding for zero-match filters (Gap 3) | +10-15% filter_drift (structural fix) | Medium | Planned |
| Stabilize eval judge (pin Sonnet, add deterministic assertions) | Reduces noise, enables real A/B | Low | Planned |
| Tavily fallback for thin neighborhoods | +5-10% happy_path, poor_experience | Done (2026-03-01) | Verify in next run |
| Nudge-accept flow (`pendingNearby` + pre-router) | +5% filter_drift (Root Cause D) | Low | **Done (2026-03-01)** |
| Reasoning/rendering split (Step 4) | Unknown — needs A/B eval | High | Planned |

---

## Completed Work

### Step 7: executeQuery Pipeline — Single Prompt Path (2026-03-01)

Migrated `handleMore` from the legacy two-call flow (`routeMessage` → `composeResponse`) to the unified single-call flow via a shared `executeQuery()` function in pipeline.js. All message paths now use `unifiedRespond` with `buildUnifiedPrompt` + `UNIFIED_SYSTEM`.

**Deleted ~550 lines:**
- `routeMessage()`, `composeResponse()`, `buildRoutePrompt()`, route/compose Gemini helpers (ai.js)
- `ROUTE_SYSTEM` (~173 lines), `COMPOSE_SYSTEM` (~91 lines) (prompts.js)
- `buildComposePrompt()` (~102 lines) (build-compose-prompt.js)
- `composeAndSend` closure (handler.js)
- `/api/eval/simulate` endpoint (server.js)

**Added:** `executeQuery()` in pipeline.js (thin wrapper, late `require('./ai')` to avoid circular deps), `composeViaExecuteQuery()` helper in intent-handlers.js for handleMore trace recording. Updated eval scripts (run-ab-eval.js, parks-eval.js, bv-eval.js) and unit tests. All 77 smoke tests pass.

### 3-Model Comparison Eval — Haiku vs Gemini Flash vs Gemini Pro (2026-03-01)

Full 48 happy_path scenario eval run locally against all three models (concurrency 5, same event cache, same code revision `d42d33b`).

**Results:**

| Model | Pass | Fail | Err | Rate | Elapsed | Est. Cost/msg |
|-------|------|------|-----|------|---------|---------------|
| Claude Haiku 4.5 | 20 | 27 | 1 | **42%** | 117s | ~$0.001-0.002 |
| Gemini 2.5 Flash | 24 | 22 | 2 | **50%** | 191s | ~$0.0002-0.0004 |
| Gemini 2.5 Pro | 14 | 33 | 1 | **29%** | 312s | ~$0.004-0.008 |

**Key findings:**

1. **Gemini Flash wins on both quality and cost.** 50% pass rate at ~5-10x cheaper than Haiku. Flash is the clear production choice.
2. **Gemini Pro is the worst performer.** 29% pass rate at 3-4x the cost of Haiku. Slowest by far (312s vs 117s). 63 latency failures and 14 empty-response failures. Not viable for SMS.
3. **10 scenarios pass on all 3 models** — these are reliably solved (BK slang, Chelsea browse, Park Slope switch, etc.).
4. **20 scenarios fail on all 3 models** — these are structural/prompt issues, not model-dependent. Includes all 5 Extended scenarios, late-night requests, theater/jazz filters, MORE flows.
5. **18 scenarios have mixed results** — model-dependent. Flash uniquely passes filter scenarios (comedy, free, EV first-time). Haiku uniquely passes some detail grabs (Red Hook, Tribeca, Boerum Hill). Pro uniquely passes West Village late request.

**Code eval failures (lower is better):**

| Eval | Haiku | Flash | Pro |
|------|-------|-------|-----|
| latency_under_10s | 0 | 9 | **63** |
| response_not_empty | 0 | 0 | **14** |
| price_transparency | **29** | 7 | 13 |
| schema_compliance | 21 | 21 | 7 |
| off_topic_redirect | 16 | 9 | 14 |
| neighborhood_accuracy | 17 | 16 | 16 |
| pick_count_accuracy | 3 | 0 | 0 |
| **Total** | **90** | **64** | **132** |

Flash has the fewest code eval failures (64 vs 90 Haiku, 132 Pro). Pro's latency problem (63 failures) is disqualifying for SMS — users won't wait 10+ seconds. Haiku's price_transparency issue (29 failures) suggests it mentions prices less reliably.

**Model-exclusive passes:**

- Flash only (4): first-time EV user, comedy filter, free filter, Bed-Stuy live music details
- Haiku only (3): Red Hook detail, Tribeca single pick, Boerum Hill switch
- Pro only (1): West Village late request

**Overlap analysis:**

- Haiku+Flash agree (not Pro): 7 scenarios — Pro struggles with neighborhood switches and detail flows
- Flash+Pro agree (not Haiku): 3 scenarios — Haiku struggles with MORE and Tribeca
- Haiku+Pro agree (not Flash): 0 scenarios — no shared strength against Flash

**Decision:** Gemini Flash is the production model for compose/extract. 8 percentage points better than Haiku at 5-10x lower cost. The 20 shared failures are prompt/architecture issues to fix in code, not model-switchable.

**Reports:** `data/reports/scenario-eval-2026-03-01T06-42-39.json` (Haiku), `scenario-eval-2026-03-01T06-45-57.json` (Flash), `scenario-eval-2026-03-01T06-51-15.json` (Pro).

### Fix Nudge-Accept Flow — Root Cause D (2026-03-01)

The `ask_neighborhood` handler in `handleUnifiedResponse` saved `pending: { filters: activeFilters }` but omitted the `neighborhood` key, so `pendingNearby` was always null for that path. When the user replied "ok"/"sure"/"bet" to a nearby suggestion, the pre-router caught it as a casual ack instead of triggering the nudge-accept flow.

**Fix:** Added `neighborhood: suggestedHood` to the `pending` object in the `ask_neighborhood` handler (handler.js:527-528), making it consistent with the `event_picks`, `conversational`, and `zero_match` paths that already set it correctly. One-line change. Closes Root Cause D (~10% of filter persistence failures).

### Filter Junk Personal-Advice Events from Yutori (2026-03-01)

Yutori was extracting ~50 prose bullets from non-event scout categories (self-help, tax advice, relationship tips, career coaching) that passed quality gates with conf=0.7-0.8 and comp=0.50-0.70. Three complementary fixes in `src/sources/yutori.js`:

1. **Expanded `NON_EVENT_CATEGORIES`** — Added 13 patterns for personal development, psychology, relationships, career, tax/legal, and coaching. Blocks non-event emails before extraction via `isEventEmail()`.
2. **Expanded `NON_EVENT_FILENAMES`** — Added 12 filename slug patterns (`friendship`, `self-help`, `career-`, `tax-`, etc.) to catch the same categories by subject line.
3. **Post-extraction content filter** — After LLM extraction, drops events that lack all three structural signals: `start_time_local`, real `venue_name` (not TBA, not a prefix of the event name or vice versa), and URL (`ticket_url`/`source_url`). `date_local` alone doesn't count — the LLM assigns today's date to everything. Fake venue detection catches prose titles the LLM misparses as venues (e.g. `venue="Warm assumptions and consistency"`). Only applies to LLM-extracted events — deterministic-parsed ones already have structural validation.

**Verified on Railway:** Reprocess scrape dropped Yutori from 253 to 238 events (email-level filters blocked 15), content filter would catch 36 more stale items in SQLite. Real events at Spectacle Theater, Nitehawk, Metrograph, DROM, Black Forest Brooklyn all pass correctly.

**Principle alignment:** P6 (deterministic extraction covers common cases) — pattern-matching blocks junk before it reaches the LLM, and a structural invariant catches anything that slips through.

**Tests:** 77 passing.

### Skint Ongoing Events Scraper (2026-03-01)

Added a new source (`SkintOngoing`) that scrapes [theskint.com/ongoing-events/](https://theskint.com/ongoing-events/) for ~30-40 time-bounded series — film festivals, art exhibitions, ice skating rinks, theater runs. These are high-value curated picks that deepen thin neighborhood pools.

**New field: `series_end`** — ISO date string on the event model capturing how long a series runs. Added to `normalizeExtractedEvent` in `src/sources/shared.js`. Events with `series_end < today` are filtered at scrape time.

**Three ongoing page formats parsed deterministically (no LLM):**
- **Format A** (~70%): `thru 3/5: event name: description. venue (hood), price. >>` — prefix thru date
- **Format B** (~15%): `► venue name (hood) thru 3/8 >>` — bullet with inline suffix thru date
- **Format C** (~10%): `thru spring: event name: ...` — vague end date (month name or season)

**Key functions in `src/sources/skint.js`:**
- `parseThruDate(text, refYear)` — handles numeric (`3/8`), month name (`february` → last day), season (`spring` → `06-20`)
- `parseOngoingParagraph(text, todayIso, refYear)` — builds on daily parser infrastructure; Format B uses `extractNeighborhood` fallback for landmarks (e.g. "central park" → Midtown)
- `fetchSkintOngoingEvents()` — fetch + Cheerio parse + non-event filter + expired filter + normalize

**Non-event filter:** Catches listicles ("nine old-fashioned soda fountains"), CTAs ("subscribe to the skint"), and social plugs ("be social with us"). Pattern matches number words/digits + plural nouns, "where to find/see", and "subscribe/follow/be social" prefixes.

**Registration:** Weight 0.9, mergeRank 1 (daily Skint wins dedup), unstructured tier. Added `'south village'` alias for West Village in `src/neighborhoods.js`.

**Results:** 31 active events from live page (36 parsed, 5 expired filtered). 28 new unit tests. All 797+ tests passing.

### Fix Friday/Saturday Event Loss from Newsletter Sources (2026-03-01)

The Nonsense NYC newsletter arrives Friday ~7pm with events for Fri/Sat/Sun+. The daily 10am scrape meant all Friday events were dated yesterday by Saturday's scrape and dropped by the scrape-time date filter (`d >= today`). Saturday events similarly lost by Sunday. This lost ~40% of each newsletter's events.

**Two fixes in `src/events.js`:**

1. **Relaxed scrape-time date filter to include yesterday** — Changed lower bound from `getNycDateString(0)` to `getNycDateString(-1)` in all 3 ingestion filter locations (refreshCache main path, refreshCache SQLite fallback, refreshSources selective path). Yesterday's events now enter the cache as a safety net. Serving-time `filterUpcomingEvents` (which checks `end_time_local` with a 2-hour grace window) still handles actual expiry. No change to SQLite range queries or the 7-day serving window.

2. **Added 6pm ET evening scrape** — Changed `SCRAPE_HOUR = 10` to `SCRAPE_HOURS = [10, 18]`. Rewrote `msUntilNextScrape()` to find the next upcoming hour from the array using seconds-based arithmetic, which also fixes a pre-existing bug where `hoursUntil === 0` with remaining minutes produced negative ms (firing the scrape immediately). The evening scrape catches same-day newsletters while their events are still "today."

**Tests:** 77 passing.

### Systemic Failure Fixes — 8 changes across 5 files (2026-03-01)

Targeted the 13 both-fail (systemic) scenarios from the Haiku baseline. 8 code changes:

1. **handler.js: Fix `events` destructuring bug** — `handleUnifiedResponse` referenced `events` without destructuring it from `unifiedCtx`. This crashed every unified flow request with `events is not defined`. Pre-existing bug on main.
2. **neighborhoods.js: Merge Boerum Hill + Carroll Gardens → Cobble Hill aliases** — Expanded Cobble Hill radius 0.5→0.7km, removed standalone entries and BOROUGHS list entries.
3. **pre-router.js: Borough detection** — "bk", "brooklyn", "queens" etc. now return a conversational response asking user to narrow to a neighborhood, instead of falling through to the LLM.
4. **pre-router.js: Satisfied-exit sign-offs** — "cool", "perfect", "sick", "dope", "love it", "sounds good" (with optional "thanks") now return a warm sign-off at zero AI cost, instead of re-engaging.
5. **pre-router.js: "early" negates "tonight" time filter** — "soho tonight early" no longer maps to time_after=22:00. The `hasEarly` check prevents the "tonight" regex from firing.
6. **prompts.js: Strengthen zero-match rules in UNIFIED_SYSTEM** — "THIS IS CRITICAL" prefix, explicit wrong-behavior examples (DJ is NOT live music, comedy is NOT theater).
7. **prompts.js: Add FILTER-AWARE SELECTION to COMPOSE_SYSTEM** — The handleMore path now has the same zero-match rules as the unified path.
8. **geo.js: Cross-borough sort penalty** — 1.5x sort distance for events in a different borough (sort order only, not filtering). Deprioritizes cross-borough results while keeping genuinely nearby cross-river hoods accessible (e.g. East Village ↔ Williamsburg).

**Eval results (2 runs, Haiku):** 25/48 and 23/48 (52%/48%). High variance — 12 of 48 scenarios differ between identical back-to-back runs, indicating ~25% LLM non-determinism in eval scores. Of the original 13 systemic failures: 2 reliably fixed (BK borough, LIC browse), 3 partially fixed (Tribeca, Bed-Stuy, time filter), 8 still failing (mostly thin coverage + complex multi-turn). The handler.js `events` bug fix was critical — without it, 0/48 unified flow requests succeeded.

**Tests:** 727 unit + 77 eval passing. Updated pre-router tests to expect borough detection behavior.

### Deterministic Yutori Non-Trivia Parser (2026-02-28)

Added `parseGeneralEventLine()` and `parseNonTriviaEvents()` to `src/sources/yutori.js` — deterministic extraction for non-trivia Yutori event emails (P6: deterministic extraction covers common cases). Previously only trivia emails (84% capture) used deterministic parsing; non-trivia (film, underground, indie, comedy) went through LLM extraction where completeness/confidence gates dropped ~98% of events.

**Parser approach:** Ordered field extraction from `[Event]` lines — strip prefix → extract tags `[UPPERCASE]` → price → URL → time (with "doors close" neutralization) → date → venue/address (6 patterns: quoted-title-at, at-keyword, Venue:-KV, colon-prefix, standalone, parenthetical) → neighborhood → title → category inference. No format detection needed; heuristics work across numbered, venue-colon, em-dash, and field-labeled formats.

**Integration:** Non-trivia path sits between trivia check and LLM fallback in `fetchYutoriEvents()`. If the parser captures ≥40% of `[Event]` lines, the file skips LLM extraction. LLM completeness gate lowered from 0.35 to 0.25 for fallback path. Drop logging added for visibility.

**Results against 38 non-trivia processed emails:** 273/295 event lines parsed (92.5%), 28/38 files use deterministic path (no LLM cost), 0 false positives, all 274 events pass completeness ≥0.4. Expected total Yutori capture: ~285 events (up from ~118, or 32% → ~76%).

### Gemini Flash Pipeline Switch (2026-02-28)

Switched all pipeline LLM calls from Claude Haiku to Gemini 2.5 Flash in `src/ai.js`. ~10x cost reduction. All four call sites (`unifiedRespond`, `composeResponse`, `extractEvents`, `composeDetails`) now check if the model name starts with `gemini-` and dispatch to Gemini wrappers, falling back to Anthropic Haiku on error.

**Key tuning decisions:**
- `maxOutputTokens` must be much higher for Gemini than Haiku (4096 vs 512 for unified, 1024 vs 256 for details). Gemini's tokenizer counts differently — 512 Gemini tokens truncated mid-JSON every time.
- `responseSchema` enforcement on `unifiedWithGemini` (type/sms_text/picks/clear_filters) eliminated wrong-type responses (e.g. first message treated as MORE or detail request).
- `temperature: 0.5` + `topP: 0.9` for unified/compose (was 1.0). At temp=1.0, Gemini hallucinated neighborhoods and misinterpreted intents. 0.5 brought reliability close to Haiku.
- `temperature: 0.8` for details (prose needs some warmth), `temperature: 0` for extraction (needs determinism).
- Stale sessions from prior eval runs caused false failures — cleared `data/sessions.json` between runs.

**Files changed:** `src/ai.js` only. Prompts, handler, cost tracking all unchanged.

**Eval result:** 28/48 happy_path passing (58%), code evals 96.1%. 20 failures analyzed into 6 themes — see Open Issues for remediation plan.

### Session Persistence + Test Endpoint Timeout (2026-02-28)

Two fixes targeting ~50% of filter persistence eval failures:

1. **Test endpoint timeout (502 fix):** Wrapped `/api/sms/test` handler in `Promise.race` with 25s timeout. Previously, if Claude API or Tavily hung, Railway's proxy returned 502 after ~30s and wiped the in-flight session. Now returns a clean 500 with error message before the proxy kills the connection.

2. **Session disk persistence:** Sessions now persist to `data/sessions.json` via debounced disk writes (same pattern as `profiles.json` and `referrals.json`). Phone numbers are SHA-256 hashed on disk. `loadSessions()` on boot, `flushSessions()` on graceful shutdown. `getSession()` has hash-fallback lookup so disk-loaded sessions (keyed by hash) are found when looked up by raw phone.

**Impact:** ~35% of filter persistence eval failures were 502s killing sessions mid-conversation. ~15% were "I don't have picks loaded" from session loss after server restarts. Both are addressed by these changes.

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

## Codebase Audit (2026-02-28)

### By the Numbers

| Metric | Value |
|--------|-------|
| Source files (`src/`) | ~30 files, ~7,500 lines |
| Scrapers | 18 sources |
| Eval scenarios | 174 (130 multi-turn + 44 regression) |
| Code evals | 19 deterministic checks |
| Unit tests | 77+ (smoke, no API calls) |
| Architecture principles | 7 (P1-P7), actively enforced |
| Completed roadmap items | 20+ shipped, 5 open issues |

### Strengths

- **Architecture principles actively enforced** — P1-P7 referenced in code decisions, eval assertions, and revert decisions (P1 `filters_used` merge tried and reverted). Roadmap captures *why* decisions were made, not just what.
- **Eval system is production-grade** — Three-layer grading (deterministic assertions → 19 code evals → LLM judge), 174 golden scenarios with difficulty tiers, automated reports. More thorough than most startups' test suites.
- **Cost control is tight** — Per-user daily budgets ($0.10 prod, $10 test), provider-aware pricing, pre-router handling ~15% of messages at $0 AI cost. Typical session: ~$0.044 total (90% Twilio, not AI).
- **Data pipeline is resilient** — SQLite + JSON fallback, cross-source dedup via content hashing, venue auto-learning across sources, quality gates at extraction boundary, recurring pattern detection. 18 sources with weight-based conflict resolution.
- **Session architecture is sound** — Atomic `saveResponseFrame`, explicit-key `mergeFilters`, deterministic filter state ownership (P1). Filter drift root cause analysis (5 causes identified, 4 fixed) shows systematic debugging.

### Priority Issues

#### Priority 1 — Gemini Flash quality gap (blocks cost savings)

58% happy_path pass rate. 6 failure themes documented, none fixed. Quick wins (E+C+D truncation) would move from 28/48 → ~35/48 (73%). A+B+F need prompt work. **Critical missing step:** Haiku baseline on same scenarios to isolate Gemini-specific failures from systemic gaps.

#### Priority 2 — `handleMore` legacy divergence — **Fixed (2026-03-01)**

Migrated `handleMore` from legacy two-call flow (`routeMessage` → `composeResponse` with `COMPOSE_SYSTEM`) to single-call `executeQuery` → `unifiedRespond` with `UNIFIED_SYSTEM`. Deleted ~550 lines of dead code: `routeMessage`, `composeResponse`, `buildRoutePrompt`, `buildComposePrompt`, `ROUTE_SYSTEM`, `COMPOSE_SYSTEM`, route/compose Gemini helpers, `/api/eval/simulate` endpoint. All paths now use a single prompt builder (`buildUnifiedPrompt`) and single AI entry point (`executeQuery`).

#### Priority 3 — Root Cause D (nudge-accept) — **Fixed (2026-03-01)**

Was ~10% of filter persistence failures. The `ask_neighborhood` handler omitted `neighborhood` from the `pending` object, so `pendingNearby` was never set for that path. One-line fix: added `neighborhood: suggestedHood` to the pending object.

#### Priority 4 — Dead code and divergence risks

- `cityScan` skill defined but handler activation uses `cityScanResults` — verify working or remove
- `architecture.html` still references deleted `routeMessage`/`composeResponse` flow — low priority cosmetic update

### Tech Debt

| Item | Risk | Notes |
|------|------|-------|
| `annotateTrace()` is O(n) | Low (current traffic) | Rewrites entire JSONL file for one trace update |
| No integration tests | Medium | No way to test handler → AI → session flow without live API calls |
| `eval.js` scores events sequentially | Low | Not parallelized; slow for large caches |
| Price data gap (71.6% missing) | Medium | `is_free` boolean more reliable than `price_display` |
| No horizontal scalability | Low (current traffic) | Single-process, in-memory sessions |
| Preference learning not yet active | Low | Profiles captured but not injected into prompts |

### Strategic Position

The project is at an inflection point between "works for testing" and "works for users." Architecture, eval suite, and data pipeline are production-quality. Gaps are mostly UX polish (sign-offs, alias recognition, thin coverage messaging) and model quality (Gemini vs Haiku). Cost structure is favorable — even on Haiku, AI is ~10% of per-session cost. The bigger Gemini win is eval suite cost ($7-10 → $1-2/run) enabling faster iteration. The eval suite is the strongest asset — it makes model switching, prompt changes, and architectural refactors safe.

---

## Not Building

- Happy hours / venue busyness / bar discovery — different product
- Yelp/Foursquare venue DB — venue discovery != event discovery
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- General web crawling — whitelist sources only
- Real-time scraping — SMS users don't need sub-daily freshness
