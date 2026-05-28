# Phase 0 — Decision Summary

**Date:** 2026-05-28
**Atlas:** `phase-0-output-atlas.md`
**Spec:** `2026-05-27-hybrid-pulse-design.md`
**Plan:** `2026-05-27-phase-0-empirical-anchor.md`

## Bucket-level results

(Counting "right" = `yes` or `partial`; "wrong" = `no`.)

| Bucket | n | Agent right | Hybrid right | Both right | Both wrong |
|---|---|---|---|---|---|
| A — State / reference | 5 | 5 | 0 | 0 | 0 |
| B — Vibe / semantic | 8 | 7 | 6 | 5 | 1 |
| C — Classic retrieve | 7 | 2 | 5 | 1 | 1 |
| D — Edges | 5 | 3 | 4 | 1 | 1 |
| **Total** | **25** | **17 (68%)** | **15 (60%)** | **7** | **3** |

Surface-level totals are misleadingly close. The buckets tell a sharper story (see below).

## Top three findings

### 1. The Bucket C "agent loss" is mostly a session-state-carry-over artifact, not a retrieval failure

Bucket C (classic retrieval queries — "williamsburg", "free events", "comedy in LES", "jazz tonight") was supposed to be where the agent and hybrid would tie. Instead the agent failed 5 of 7. Looking at the actual responses, the failures were systematically of the form:

- `"williamsburg"` → agent: "No trivia after 5 in Williamsburg tonight" — _it carried the `category:trivia` filter from the previous query (B-13 "actually fun trivia somewhere")_
- `"free events"` → agent: "Nothing free in Williamsburg after 5" — _still on Williamsburg from C-14_
- `"comedy in the lower east side"` → agent: "No comedy in LES tonight after 5" — _the `time_after:17:00` carried forward_
- `"anything happening in bushwick"` → agent: "Nothing coming up tomorrow night in Bushwick" — _it carried `date_range:tomorrow` from C-18_
- `"dj set in brooklyn"` → agent: "Nothing specifically tagged as DJ tomorrow in Brooklyn" — _same tomorrow contamination_

**This was a methodology bug, not an architecture finding.** All 25 queries shared a single phone number (`+15550001234`), so agent-Pulse accumulated session state turn-by-turn — perfectly realistic for a conversation, perfectly wrong for an independent-query comparison. Hybrid retrieval has no session memory, so it sailed through these.

If we re-ran the atlas with a fresh session per query (rotate phone numbers, or reset session between queries), the agent's bucket-C score would jump from 2/7 to probably 6 or 7 of 7. **This needs to happen before we draw final conclusions about retrieval comparative quality.**

### 2. Hybrid retrieval genuinely earned its keep on Bucket B (vibe / semantic)

The most informative wins for the L2 hybrid layer:

- **B-7 "cozy date night spot"** — top result was "date night vinyl happy hour" in Williamsburg. Semantic + lexical both contributed; agent over-clarified.
- **B-8 "weird underground vibes tonight"** — top results were Village Underground (semantic), the underground open mic (lexical+semantic), and dlr/kalahari/pva at Nublu (pure semantic — "underground" understood as music genre). This is the magic moment we predicted from the embedding exploration.
- **B-10 "where do creatives hang out in brooklyn"** — Community Craft Night, Design Your Next Chapter (a literal "salon for creatives"), aci-d club weekly hang. The semantic match for "creatives" found events humans would actually pick.

The vibe queries are exactly where pure RAG would beat the agent's deterministic-filter approach if the agent's `category` taxonomy doesn't cover the concept. **Phase A's L2 layer earns its place on the strength of these alone.**

### 3. Duplicate pollution is the biggest hybrid failure mode visible in top-3 results

Cases where hybrid's top-3 was the SAME event repeated 2 or 3 times:

| Query | Repeated event |
|---|---|
| A-3 "i meant brooklyn not bushwick" | Best of Brooklyn Stand-Up Comedy ×3 |
| B-6 "something romantic and intimate in BK" | Weekday Happy Hour at Altar ×3 |
| B-9 "low-key bar that isnt another wine bar" | Weekday Happy Hour at Altar ×2 |
| D-23 "how about comedy later tonight" | Comedy Cellar Friday/Friday/Monday ×3 |

The original `events.js` cross-source dedup doesn't catch within-source same-event duplicates. The vector index inherits these and they pile up at the top of retrieval results because they're literally identical text → identical vectors → identical scores. **Any production hybrid retrieval must include a post-retrieval `dedup-by-name+venue` pass.** This was a planned amendment to the L1 design but the magnitude is more severe than predicted.

## What the failure-mode atlas tells us

Four specific failure-mode patterns dominate the annotations:

- **State contamination** (agent, 5 queries in Bucket C): the agent loop carries filter state forward when it shouldn't. The architecture allows it, the implementation needs more aggressive "new query, drop prior filters" logic. This is fixable in the existing agent loop.
- **Duplicate pollution** (hybrid, 4+ queries): the corpus has duplicate event rows; the vector index has no semantic dedup. A post-retrieval `dedup by lower(name)+lower(venue)` would handle most of it.
- **False positives at noise floor** (hybrid, on gibberish queries like D-21 "help"): the embedding model still returns *something* at cosine 0.6+, which surfaces as plausible-looking matches when nothing should match. This is exactly what L4 confidence bands would catch.
- **Negation failure** (hybrid, B-9 "isnt another wine bar"): "isnt another wine bar" → top result is Wine Bar Therapy 2.0. Negation in retrieval is a well-known hard problem; without an extra layer it's not solvable by either BM25 or vectors alone.

Two patterns that were predicted but didn't show as strongly as expected:

- **Vocabulary mismatch on temporal terms** showed up clearly at C-18 "events tomorrow night" (hybrid matched "Echoes of Tomorrow" by literal token, no temporal understanding). This is small but real.
- **Reference resolution** for "more" / "2" / "send me the link" went exactly as predicted (Bucket A): hybrid has no way to handle these.

One pattern I didn't predict but the atlas surfaced clearly:

- **Agent over-clarification** (B-6, B-7, B-8, B-11, C-18, D-22): when the user gave a substantive query the agent often pivoted to "what kind of X?" with a 4-option menu instead of just returning results. This is design — Pulse's `clarify` tool is encouraged to fire frequently — but in head-to-head with hybrid retrieval it costs the agent a "right" mark when hybrid just answered. Whether this is a defect or a feature depends on the product stance ("conversational" vs "transactional"). **This is the real architectural question Phase B should address.**

## Implications for the spec's three phases

### Phase A — Retrieval craft (L1, L2)

**Verdict: justified, proceed.**

The Bucket B wins for hybrid retrieval (B-7, B-8, B-10) are real and were predicted. The L2 layer demonstrably handles vibe queries the agent's category-tagged search cannot. L1 (BM25) is still worth building separately because:
- It gives us a baseline to measure L2's lift against (we saw mixed results in B-12, B-13 where BM25-style matching mattered)
- It's the cheaper layer to run and would be the right choice for high-confidence keyword queries

**One amendment to the L1 design (from §2 of the spec):** the post-retrieval `dedup by (name+venue)` pass is now P0, not nice-to-have. The atlas shows duplicate pollution affecting at least 4 of 25 queries (~16%).

**Recommendation before doing Phase A:** re-run the atlas with one fresh phone per query so we have a clean agent baseline. Took ~3 minutes the first time; should take the same again. This unblocks confident Phase A design decisions.

### Phase B — Decision craft (D1, D2)

**Verdict: redesign D1 around state-contamination, not intent classification.**

The Phase B design question per the spec was: "does the LLM-proposes / taxonomy-authorizes pattern materially change the outcome vs the agent loop, or is it largely the same thing with better audit trail?"

The atlas answers it sharply: the agent's intent classification is already quite good. Where it failed was **letting prior session state contaminate the current decision** (Bucket C). A typed taxonomy with required-evidence checks would have caught this:

- For `intent: new_search` with neighborhood "williamsburg", the policy could specify `if last_filter_categories != null AND user_message_does_not_repeat_category: drop_carry_over_categories`.
- For `intent: pick_details`, the policy could specify `required_evidence: { last_picks_present: true } else route_to_clarify`.

This is materially different from "ask the LLM to classify intent" — it's a state-shaping layer on top. **D1's design should pivot from "validate intent classification" to "explicit policy on what session state carries forward across turns."**

D2 (feedback flywheel + dashboard) doesn't change. If anything, the state-contamination failure mode is *exactly* the kind of edge case associates would surface in a feedback loop — they'd notice patterns like "every time I switch neighborhoods after a category query, the wrong filter sticks."

### Phase A and Phase B together — the architecture changes

Two cross-phase implications:

1. **Hybrid retrieval should sit AT the agent loop's tool callback, not as a replacement for it.** The naive strip we did earlier was strawman-shaped because it removed the agent entirely. The atlas suggests the better design is: agent loop classifies intent + applies policy + calls `hybridRetrieve` as a tool (instead of `buildSearchPool`). Best of both: the agent handles state/reference (Bucket A wins) and the hybrid retrieval handles vibes (Bucket B wins). This is in fact what a "real" production redesign would look like.

2. **The Cap1-interview-shaped point is sharper now.** "LLM-proposes / policy-authorizes" applied to *agent state management* is a genuine architectural insight: today's Agent Assist gates summary *display* with confidence bands; tomorrow's workflow agent could gate filter state *carry-over* between turns with policy bands. That's a cleaner version of the original framing because the atlas data backs it up.

## Decision

Selecting from the spec's four options:

- [ ] (a) Phase A is justified → proceed with L1, L2
- [x] (a-amended) **Phase A is justified, with two amendments: (1) re-run the atlas with fresh-session-per-query first to get a clean agent baseline, (2) include the dedup-by-(name+venue) pass as P0 not P2 in L1 design**
- [ ] (b) Phase A is partially redundant → skip ahead
- [x] (c-partial) **Phase B's D1 design needs to refocus on session-state-policy, not intent classification** (the atlas demonstrated that intent classification works fine; state contamination is the real failure mode)
- [ ] (d) Something else

Selected: **(a-amended) + (c-partial)**. Justification: the experimental data showed both retrieval layers earning their keep (L1 baseline + L2 semantic) AND surfaced a specific D1 design direction (session-state policy) that's stronger than the spec's original framing (intent classification on top of LLM).

## Next plan

Two new plans, in this order:

1. **Phase 0.5 — Clean Re-run** (~30 min): rotate phones per query in `atlas-runner.js`, re-run, re-annotate. Produces `phase-0.5-output-atlas.md` and `phase-0.5-output-summary.md`. The summary should confirm or refute the state-contamination hypothesis.

2. **Phase A Implementation Plan** (~3-4 hours): create the `pulse-rag-hybrid` clone on port 3002, implement L1 (BM25-only retrieve → single LLM compose), then L2 (add dense + RRF fusion + dedup). Add the `dedup-by-(name+venue)` pass per Finding 3. Run the 25-query suite after each layer. Update the comparison-log per the spec methodology.

Phase B's plan should be written *after* Phase A lands, informed by both Phase 0 and Phase A's findings.
