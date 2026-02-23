# Pulse Architecture Principles: LLM/Code Pipeline Design

## Context

Pulse is an SMS-based AI assistant for NYC nightlife. A user texts a neighborhood, gets curated event picks. Multi-turn conversations support filter follow-ups ("how about comedy"), compounding ("free comedy late tonight"), neighborhood switches, and natural language. The pipeline is: deterministic pre-router → filter resolution → tagged event pool → single Claude Haiku call → session save → SMS.

We're evaluating architectural principles for the LLM/code boundary. The system currently has filter persistence bugs (P1 regression at 50%) caused by inconsistent session saves and LLM-returned structured data that isn't persisted. We patched the bugs pragmatically but want to agree on principles before deeper refactoring.

**Question for reviewers:** Do you agree with these principles? Where would you push back, reorder, or add? Are there principles we're missing for a conversational SMS system specifically?

---

## The Principles

### P1. Code Owns State, LLM Owns Language

The LLM should never be the system of record for structured data. Session state, filters, neighborhood resolution, event selection — all owned by deterministic code. The LLM reads well-formed inputs and produces natural language output.

**Pulse example (good):** `mergeFilters(lastFilters, preDetectedFilters)` compounds filters deterministically. `buildTaggedPool(events, activeFilters)` marks matching events with `[MATCH]`. The LLM sees the tagged pool but doesn't manage filter logic.

**Pulse example (violation):** After the unified call, we now read `result.filters_used` from the LLM and merge it into `activeFilters`. The LLM is a secondary source of truth for filters on compound requests. If it hallucinates `{ category: "jazz" }` when the user said "anything good," we persist a false filter.

**Tension:** Compound requests like "free comedy late tonight" can't be fully extracted by the pre-router's regex. Someone needs to parse them. The question is where.

---

### P2. Separate Reasoning from Rendering

If you need the LLM to both *understand what the user wants* and *write compelling copy*, those should be separate operations — not one call with a bloated output contract. The reasoning pass returns a small validated struct. The rendering pass takes well-formed data and returns text.

**Pulse example (current, unified):** One Haiku call returns:
```
type, sms_text, picks[], neighborhood_used, filters_used,
suggested_neighborhood, clear_filters, pending_filters
```
That's 8 structured fields. The LLM is simultaneously doing intent classification, filter inference, event selection, neighborhood reasoning, and SMS copywriting. Each structured field is a potential source of drift.

**Pulse example (proposed split):**
- **Reasoning call** → `{ type, picks[], clear_filters }` (3 fields, validated immediately)
- **Rendering call** → `sms_text` (1 field, pure copy)
- Everything else (`filters_used`, `neighborhood_used`, `suggested_neighborhood`, `pending_filters`) derived deterministically by code

**Tradeoff:** The unified call exists because the previous two-call architecture (route + compose) had filter state disagreements between calls, and the A/B eval showed unified Haiku matched Sonnet compose at 73% lower cost. Splitting again needs to avoid those same problems. The key difference: the new split would have code own all state between calls, not pass LLM output from call 1 to call 2.

**Cost:** ~$0.001/msg → ~$0.002/msg. Budget is $0.10/day/user, so 50 messages instead of 100. Acceptable for a 5-10 message session but worth tracking.

---

### P3. Extract Structure at the Boundary, Then Never Touch LLM Output Again

If the LLM must produce structured data (intent, filters, etc.), validate and normalize it once at the ingestion boundary. After that, internal code trusts internal types. Don't normalize some LLM fields and trust others — that's worse than no normalization.

**Pulse example (good):** `normalizeFilters()` maps LLM subcategories to canonical values (jazz→live_music, techno→nightlife) at the boundary.

**Pulse example (violation):** We normalize `filters_used` and `pending_filters` but pass through `neighborhood_used`, `suggested_neighborhood`, and `clear_filters` without validation. There's no consistent rule for which LLM fields get validated.

**The better framing:** Don't think of this as "extract before the LLM vs. after." Think of it as: wherever the LLM produces structured data, there's exactly one boundary where it gets converted to internal types. After that boundary, code never reasons about LLM output shapes.

---

### P4. One Save Path, Not Parallel Paths That Must Agree

Every fork in the pipeline where session state is written differently is a bug waiting to happen. The ideal is one function that atomically writes all session fields, called from every code path.

**Pulse current state — 12 session write sites:**

| Method | Count | Paths |
|--------|-------|-------|
| `setSession()` (merge) | 8 | init, clear_filters, clear pending, inject filters, clear stale, LLM filter wipe, clean pending, ask_neighborhood |
| `saveResponseFrame()` (atomic) | 4 | conversational/empty, event_picks, more+remaining, more+perennials |

The 8 `setSession` calls each set different subsets of fields. When a new field is added to session, every `setSession` call must be audited. When a path forgets to clear `pendingFilters` or save `lastFilters`, stale state persists until the next `saveResponseFrame` call overwrites it.

**Proposed:** Reduce to 2 categories:
1. **Ephemeral writes** (pre-processing): `setSession` only for transient flags set *before* the LLM call (pending filter injection, stale clearing). These are staging, not final state.
2. **Terminal writes** (post-response): Every path that sends an SMS ends with one `saveResponseFrame` call that atomically sets all session fields. No exceptions.

---

### P5. The LLM's Output Contract Should Be Minimal

Every structured field in the LLM output schema is a surface for hallucination, format drift, and state disagreement. Fewer fields = fewer failure modes.

**Current unified output:** 8 structured fields + internal metadata
- `type` — intent classification (state)
- `sms_text` — response copy (rendering)
- `picks[]` — event selection (state + rendering)
- `neighborhood_used` — neighborhood echo (state)
- `filters_used` — filter introspection (state)
- `suggested_neighborhood` — nudge suggestion (state)
- `clear_filters` — filter clearing signal (state)
- `pending_filters` — deferred filters (state)

6 of 8 fields are state management. The LLM is doing more bookkeeping than copywriting.

**Target:** If reasoning and rendering are split (P2), the rendering call returns only `sms_text`. The reasoning call returns `type` + `picks[]` + `clear_filters` (3 fields). Everything else is derived:
- `neighborhood_used` → code already resolves this as `hood` before the LLM call
- `filters_used` → code already has `activeFilters` before the LLM call
- `suggested_neighborhood` → code already has `nearbyHoods` and can pick deterministically
- `pending_filters` → code can extract from the reasoning call's intent + pre-router detection

---

### P6. Deterministic Extraction Should Grow to Cover the Common Cases

Don't rely on the LLM for structure that pattern matching can handle. Extend the pre-router to cover compound filters before they reach the LLM. Reserve the LLM for genuinely ambiguous language.

**What the pre-router handles today:**
- Simple follow-ups: "how about comedy", "later tonight", "free"
- Clear filters: "forget the comedy", "show me everything"
- Mechanical: help, 1-5, more, greetings, event name match

**What falls through to the LLM (and shouldn't):**
- Compound filters: "free comedy", "late jazz", "free stuff tonight"
- Filter + neighborhood: "comedy in bushwick", "free stuff in LES"
- These are still pattern-matchable: `(?:free\s+)?(category)\s+(?:in\s+)?(neighborhood)?\s*(?:tonight|later)?`

**What genuinely needs the LLM:**
- Vibes: "something lowkey", "nothing too expensive"
- Implicit intent: "what would you recommend for a first date"
- Ambiguous: "what about that jazz thing from earlier"

**The risk:** Building a brittle regex extractor that covers 80% and silently misses the other 20%, creating two layers that can fail. Mitigation: the pre-router is additive (returns detected filters for the LLM to see in the tagged pool), not gate-keeping. If the pre-router misses a compound, the LLM still sees untagged events and can select freely.

---

### P7. Validate the Contract, Not the Content

Don't try to verify whether the LLM's picks are "good" or its copy is "on brand" in the hot path. Validate structural contracts (is `type` one of three values? are `picks[].event_id` values present in the pool?) and let evals catch quality issues offline.

**Pulse example (good):** handler.js checks `result.picks.length === 0` to avoid wiping session state on empty responses.

**Pulse example (could add):** Validate that `result.picks[].event_id` values exist in the event pool before saving. Currently trusting the LLM not to hallucinate event IDs.

---

## Current Architecture vs. Proposed

```
CURRENT (unified, 1 LLM call):
  message → pre-router → filter merge → tagged pool → LLM(understand + compose) → parse 8 fields → save (multiple paths) → SMS

PROPOSED (split, 2 LLM calls):
  message → pre-router (expanded) → filter merge → tagged pool
    → LLM-reason(type, picks, clear_filters) → validate boundary → code derives all state
    → LLM-render(events + context → sms_text) → send → atomic save → SMS
```

## Proposed Implementation Sequence

| Step | Change | Risk | Leverage |
|------|--------|------|----------|
| 1. Unify session saves | Every SMS-sending path ends with `saveResponseFrame`. Eliminate 6 of 8 `setSession` calls. | Low — pure refactor, no behavior change | High — eliminates the class of stale-state bugs |
| 2. Expand pre-router compound extraction | Handle "free comedy", "late jazz", "comedy in bushwick" deterministically. Additive, not gate-keeping. | Low — pre-router already returns filters for unified branch | Medium — reduces dependency on `filters_used` |
| 3. Derive state fields deterministically | Stop reading `neighborhood_used`, `suggested_neighborhood`, `pending_filters` from LLM. Code already has the data. | Low — removing fields from schema | Medium — shrinks LLM contract from 8 to 5 fields |
| 4. Reasoning/rendering split | Separate intent+selection call from copy call. Remove `filters_used` and `sms_text` from reasoning schema. | Medium — reintroduces two calls, needs A/B eval | High — clean separation, minimal contracts |
| 5. Remove `filters_used` from LLM contract | After steps 2+4, the LLM never needs to report what filters it used. Code owns that entirely. | Low — by this point it's unused | Completes P1 |

Steps 1-3 are safe incremental improvements. Step 4 is the structural bet that needs evaluation. Step 5 is cleanup.

---

## Review Consensus (Round 1)

### Agreed — proceed with steps 1-3

Steps 1-3 are unanimously supported. Unifying session saves is pure structure with no behavior change. Deriving `neighborhood_used`, `suggested_neighborhood`, `pending_filters` deterministically is a no-brainer — asking the LLM to echo back data code already has just creates drift surface.

### Agreed with caution — step 4 reasoning/rendering split

The principle is right but the regression risk is real (unified call exists because the previous two-call flow had quality issues). Key discipline: **nothing from the reasoning call's output gets passed as input to the rendering call except event data.** Code reconstructs everything else. If you find yourself passing `result.type` or `result.clear_filters` into the render prompt, you've recreated the original problem with extra steps. Needs A/B eval before committing.

### Resolved — no hybrid approach

The hybrid (unified for simple, split for compound) was considered and rejected. The routing decision is deterministic, but maintaining two modes indefinitely creates exactly the path divergence P4 warns against. Better to do the full split with a solid A/B than maintain two modes.

### Resolved — use tool_use for reasoning call

The 1% JSON parse failure rate matters more on the reasoning call because its output (`type`, `picks[]`, `clear_filters`) drives code execution directly. Use tool_use for structural correctness on the reasoning call. Keep the lightweight regex parser for the rendering call where the only output is text.

### Elevated — P7 event ID validation moves to step 1

Validating `result.picks[].event_id` against the event pool should happen alongside session save unification, not deferred to step 5. Hallucinated event IDs that pass through silently would produce broken SMS links — a bad UX that's hard to debug. This is a one-liner guard.

---

## Open Questions (Remaining)

1. **Is the reasoning/rendering split worth the cost doubling?** ~$0.001/msg → ~$0.002/msg. Budget is $0.10/day/user. Acceptable for 5-10 message sessions but needs monitoring.

2. **How do we handle the step 4 transition?** Steps 1-3 can ship to production first. Step 4 needs an A/B eval framework — what metrics define success? Tone pass rate, filter persistence rate, pick relevance, latency, cost?
