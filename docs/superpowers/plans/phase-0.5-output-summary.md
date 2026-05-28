# Phase 0.5 — Decision Summary (clean re-run)

**Date:** 2026-05-28
**Atlas:** `phase-0.5-output-atlas.md`
**Compares against:** `phase-0-output-summary.md`
**Methodology change:** Each of the 25 queries used a unique phone (`+15550002000`–`+15550002024`), so the agent loop could not accumulate session state across the suite.

## What we tested for

Phase 0's central finding was that the agent loop's Bucket C losses were *probably* state-contamination artifacts from sharing one phone across all 25 queries — the agent was carrying filter state (`category=trivia`, `time_after=17:00`, `date_range=tomorrow`) forward into queries that shouldn't have inherited it. Phase 0.5 isolates each query with its own session.

## Bucket-level results

| Bucket | n | Agent right | Hybrid right | Δ vs Phase 0 (agent) | Δ vs Phase 0 (hybrid) |
|---|---|---|---|---|---|
| A — State / reference | 5 | 5 | 0 | unchanged | unchanged |
| B — Vibe / semantic | 8 | 8 | 5 | +1 | -1 |
| C — Classic retrieve | 7 | **7** | 6 | **+5** | +1 |
| D — Edges | 5 | 5 | 3 | +2 | -1 |
| **Total** | **25** | **25 (100%)** | **14 (56%)** | **+8** | **-1** |

**Hypothesis CONFIRMED.** Bucket C agent score jumped from 2/7 → 7/7 with fresh sessions. The hidden methodology bug in Phase 0 was masquerading as a retrieval failure.

Two other shifts:
- **D-24 and D-25** now have real agent responses (no budget cap, because each query has its own per-user budget allocation). The agent correctly resolved `"wburg"` → Williamsburg on its own.
- **Hybrid is identical to Phase 0** (same events, same ranks, same duplicates) — because hybrid retrieval is stateless. The only thing that changed was the agent side.

## What the clean re-run actually reveals

### Finding 1: The agent's default behavior with no context is to *clarify*, not to answer

Reading the 25 Phase 0.5 agent responses end-to-end, the pattern is striking: ~22 of 25 are *clarifying questions with 4 numbered options*. The agent only commits to a direct answer when:
- It's a mechanical pre-check (`"help"` → standard intro response)
- The query is a non-search reference (`"more"`, `"2"`, `"send me the link"` → "I don't have prior context, what do you want?")
- The query resolves to a clean intent with enough specificity (`"wburg"` → "what's the vibe in Williamsburg?")

Every Bucket B and Bucket C query produced a clarify response. This isn't necessarily wrong — Pulse's product stance per CLAUDE.md does encourage `clarify` to fire liberally on first substantive requests. But it means **with no session state, the agent loop is heavily clarify-biased.** That's a product choice, not a retrieval-quality finding.

### Finding 2: "Agent right" with clarify ≠ "agent useful" in the same way hybrid is useful

The bucket scoring counts "agent clarifies appropriately" as `yes`, but clarifying is a *deferred* answer. Hybrid retrieval gives a *direct* answer. A user evaluating these side-by-side would probably feel:

- Agent: "asks me what I want again, then I'd answer, then it'd search"
- Hybrid: "shows me three picks right now, even if one is weak"

For an SMS product where users want minimum friction, the hybrid behavior is *sometimes* preferable even when the agent's clarify is *technically more correct*. The real product question is: **which queries should auto-retrieve vs. which should clarify first?** This is exactly the kind of decision a typed-taxonomy policy layer (Phase B's D1) would govern explicitly.

### Finding 3: Hybrid's failure modes are unchanged and tractable

Both Phase 0 and Phase 0.5 surface the same hybrid weaknesses, in the same proportions:

- **Duplicate pollution** (A-3, B-6, B-9, D-23): mandatory dedup pass at retrieval time.
- **Negation failure** (B-9 "isnt another wine bar"): unsolvable by retrieval alone; needs a re-ranker or LLM-aware filter at L3.
- **False positives at noise floor** (D-21 "help"): exactly what L4 confidence bands would catch.
- **Vocabulary mismatch on temporal terms** (C-18 "events tomorrow night"): L5 query-transformer is where this gets fixed.

All four are layered fixes in the planned ladder (Phase A → L3 → L4 → L5). The artifacts call out which layer addresses which.

### Finding 4: The "agent budget cap" failure (Phase 0 D-24, D-25) was also a methodology artifact

With fresh phones, D-24 ("wburg") and D-25 ("free or cheap this weekend") both got clean agent responses. The agent correctly resolved "wburg" → Williamsburg in its clarify. So the daily budget exhaustion in Phase 0 was a side effect of *all 25 queries* counting against one user's $0.10 daily cap. Real users wouldn't hit this; the test methodology did.

## Implications for Phase A design

**Mostly unchanged from Phase 0 summary, with one important sharpening:**

### Already locked from Phase 0
- Phase A justified, proceed with L1 + L2.
- `dedup by (name+venue)` is P0, not P2.
- Hybrid handles vibe queries (B-7, B-8, B-10) well. Bucket B is where L2's lift is.

### New / sharpened from Phase 0.5
- **The agent's clarify rate is the real product variable.** When the agent has no context, it clarifies ~88% of the time (22/25). Whether L1+L2 retrieval should *replace* clarify or *complement* it depends on product stance. The artifact should make this explicit.
- **Hybrid's role as a *clarification-bypass*:** for queries where agent would clarify but where retrieval clearly has a strong answer (e.g., B-7 "cozy date night spot" with date night vinyl at 0.757 cos sim), hybrid retrieval could short-circuit the clarify. This is a specific policy decision worth codifying in D1.

## Implications for Phase B design

**Materially sharper than Phase 0 thought it would be:**

The Phase 0 summary suggested D1 should pivot from "intent classification" to "session-state policy." Phase 0.5 confirms that direction AND adds a second policy dimension:

1. **Session-state policy** (when to carry filter state forward — Phase 0 motivation)
2. **Clarify-vs-retrieve policy** (when to short-circuit clarify with a strong retrieval result — Phase 0.5 motivation)

Both are *decisions the agent makes turn-by-turn that affect product feel*. Both are exactly what a typed-taxonomy authorization layer would gate. D1's prototype taxonomy entry should include both:

```yaml
intents:
  new_search:
    required_evidence: [any_substantive_intent_signal: true]
    # NEW: clarify-bypass rule
    short_circuit_clarify_if:
      hybrid_top_1_lift_over_baseline: > 0.08   # strong retrieval match
      AND query_word_count: < 4                  # short query → less ambiguity
    if_short_circuited: return_hybrid_top_3_directly
    else: ask_clarify
```

That's a single rule that would have flipped B-7, B-8, C-14, C-19, C-20 from clarify to direct-answer in Phase 0.5. It's also auditable, versionable, and exactly the shape the Cap1-interview framing asks for.

## Decision

Same as Phase 0 with the same options, but with stronger evidence:

- [x] **Proceed to write Phase A implementation plan** (L1 BM25, L2 hybrid + dedup, on `pulse-rag-hybrid` clone at port 3002).
- [x] **D1's design should include both session-state policy AND clarify-vs-retrieve policy.** (Phase B's plan, when written, picks this up.)

## Next plan

**Phase A implementation plan** — write next. Should be a direct write of the implementation tasks from the spec's §2 (L1 + L2), with the two amendments locked in:
1. `dedup by (name+venue)` as a mandatory L1 step (not deferred).
2. Comparison harness keeps using rotated phones (PULSE_ROTATE_PHONE=true is now the default for the suite).

Phase B's plan still gets written after Phase A lands.
