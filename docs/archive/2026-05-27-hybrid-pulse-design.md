# Hybrid-Pulse: RAG craftsmanship + decision taxonomy — Design Spec

**Date:** 2026-05-27
**Status:** Draft
**Inputs:** Cap1 Agent Assist deck (`~/Projects/sticker-pipeline/internal/Cap1_agentassist_architecture.pdf`), Cap1 PM-prep notes, empirical embedding exploration of Pulse corpus (see `/tmp/explore-clusters.js` output), prior naive-strip experiment (deleted) and its findings.
**Status of this artifact:** experimental — not intended to ship into production Pulse. The artifact's value is interview-credible demonstration of two architectural patterns.

---

## 0. Why this exists

The Cap1 PM role (`Sr. Mgr — AI Orchestration & Experiences`) sits at the seam between *today's Agent Assist* (RAG + summarization, read-only) and *tomorrow's workflow execution* (stateful, action-taking, regulated). To talk credibly about that transition in an interview, the candidate needs concrete, hands-on understanding of:

1. **The retrieval craft itself** — what BM25 and dense embeddings actually do, why hybrid fusion exists, how cosine similarity behaves in real corpora (anisotropy, noise floor, category coherence).
2. **The orchestration craft** — what it means to encode an agent's allowed behavior as a typed taxonomy, gate it by confidence and authority, and make the people closest to the work co-authors of the taxonomy.

A prior naive-strip experiment (replacing Pulse's agent loop with a single linear retrieve→compose pipeline) was a strawman: it removed the agent loop without re-architecting around RAG. This spec is the principled rebuild.

## 1. The three-phase plan

**Phase 0 — Empirical anchor.** Before any new code, run the 25-query eval suite against agent-Pulse, compute what a hypothetical hybrid retrieval would return for each, and build a *failure-mode atlas*. The atlas — not the spec — is what determines the shape of Phase A and Phase B.

**Phase A — Retrieval craftsmanship.** Build the hybrid retrieval stack one layer at a time, evaluate each against the agent baseline, walk away with first-hand intuition for what each layer earns. *Phase 0 findings may show parts of this are unnecessary.*

**Phase B — Decision craftsmanship.** Codify one of Pulse's runtime decisions as a typed policy entry under an **LLM-proposes / taxonomy-authorizes** pattern (see §3). Build a feedback flywheel that turns user corrections into versioned taxonomy changes. *Phase 0 findings inform whether the LLM-proposes pattern is needed or whether deterministic routing would suffice — see "Known prior failure mode" callout in §3.*

**All phases live in a new clone `pulse-rag-hybrid` on port 3002** (except Phase 0, which uses scripts in `/tmp/` and existing cached embeddings — no new project). The original `pulse-sms` (port 3000) stays unchanged and serves as the agent-loop baseline for comparison.

```
PHASE 0 — EMPIRICAL ANCHOR  (~2-4 hours, mostly analysis, minimal new code)
  - Run 25-query suite against agent-Pulse (port 3000), capture responses + traces
  - For each query, compute what a HYPOTHETICAL hybrid retrieval would return
    (extend /tmp/explore-clusters.js to read the suite + score top-K via RRF)
  - Build a failure-mode atlas: where agent wins, where pure-RAG would, where both fail
  - Interrogate routing-style queries ("more", "2", "i meant brooklyn not bushwick")
    specifically: what does agent's tool-routing LLM do that a deterministic
    taxonomy would have to either replicate or escalate?

  ──── DECISION POINT — what does the failure-mode atlas tell us? ────
  (a) Phase A is justified → proceed with L1, L2
  (b) Phase A is partially redundant (e.g., L1 won't add insight beyond what
      Phase 0 already shows) → skip ahead
  (c) Phase B needs redesign → LLM-proposes / taxonomy-authorizes pattern needs
      validation separate from deterministic routing
  (d) Something else the spec didn't anticipate → adjust accordingly

PHASE A — RETRIEVAL CRAFT  (shape informed by Phase 0)
L1  BM25 only + single LLM compose
L2  + Gemini dense vectors + RRF hybrid fusion + light calibration

──── DECISION POINT — did L1→L2 land? If yes, stop the retrieval ladder. ────

PHASE B — DECISION CRAFT  (design refined by Phase 0 findings)
D1  Codify `interaction_routing` policy
    (LLM-proposes intent / taxonomy-authorizes evidence + audit + escalation)
D2  Feedback flywheel + decision review dashboard
```

**Explicitly NOT in scope:** L3 (cross-encoder reranker), L4 (confidence bands), L5 (query transformer). These are valid extensions; they're omitted because the marginal interview-value per hour of work tapers, and Phase B is the rarer story.

### Phase 0 — what we actually do

Phase 0 is mostly an analysis exercise on data we've already collected. Concrete steps:

1. **Extend `/tmp/explore-clusters.js`** to read `scripts/comparison-queries.txt` (write the 25-query suite as a file first) and for each query: embed it, retrieve top-10 by RRF over BM25 (rolled inline) + cached vectors, return ranked results.
2. **Run all 25 queries against agent-Pulse** at port 3000 via `compare-versions.js` (we have it from the deleted naive-strip experiment — regenerate as needed). Capture full responses + trace JSON.
3. **Build the failure-mode atlas** as a markdown table at `/tmp/phase-0-atlas.md`:

   | Query | Agent response | Hypothetical hybrid top-3 | Agent right? | Hybrid would be right? | Failure mode if either fails |
4. **Produce a 1-page summary** of what Phase A and Phase B should actually do based on the atlas.

If after Phase 0 we conclude the failure modes don't justify building L1–L2 (e.g., they all reduce to either "agent's tool routing handles X" or "needs reranker which is out of scope"), we pivot directly to Phase B with a refined D1 design.

---

## 2. Phase A — Retrieval craftsmanship

### L1: BM25-only retrieval

**Replaces** the agent's tool-deciding LLM call + deterministic SQL filter with a single deterministic retrieval step.

**Pipeline:** `user SMS → tokenize → BM25 score against in-memory inverted index over event cards → top-K → single LLM compose`.

**Event card** (the string we index per event):
```
"{name}. {venue_name}. {neighborhood}. {category}. {price}. {short_detail}"
```
Example: `"Trivia Night at Northern Bell. Northern Bell. Williamsburg. trivia. free. Weekly pub trivia with prizes."`

**Implementation:** roll our own BM25 (~80 LOC). Lowercase, tokenize on `/\w+/`, small stopword list, k1=1.2, b=0.75. No stemming. Library swap is a later option; the point at L1 is to understand the math.

**Filter philosophy at L1** — what stays, what drops:

| Filter | Type | Disposition |
|---|---|---|
| Date — past events | Hard constraint | Pre-filter; events from prior dates excluded before BM25 |
| `free_only` | Hard constraint | Pre-filter; *amended from initial design* — exploration showed semantic understanding of "free" is unreliable |
| Neighborhood | Soft preference | Drop; let BM25 surface "williamsburg" naturally |
| Category | Soft preference | Drop; let BM25 surface "comedy" naturally |

The neighborhood/category drop is intentional — it's the experiment of "can retrieval do what filters did before."

**Index lifecycle:** lazy rebuild. The retrieval module tracks `lastBuiltFromTimestamp`; on every `retrieve()` call it checks the events-cache timestamp and rebuilds if stale. No plumbing changes to `events.js`. ~10ms rebuild cost for 225 events.

**Top-K:** 8 (matches Pulse's current `DEFAULT_POOL_SIZE`).

**Dedup pass post-retrieval:** mandatory at every layer — explore-clusters surfaced that the corpus has exact-duplicate event rows (cosine sim 1.0 pairs). Without dedup, retrieved top-K can be the same event repeated.

**Post-retrieval dedup key:** `lower(name) + lower(venue_name)`.

### L2: Hybrid (BM25 + dense vectors)

**Adds** dense-vector retrieval alongside BM25, fuses the two via Reciprocal Rank Fusion (RRF).

**Embedding model:** Gemini `gemini-embedding-001` (3072 dims). Chosen because the API key is already provisioned for Pulse, and the cost is negligible (~$0.001 per full corpus rebuild).

**Vector store:** in-process JS arrays. 225 events × 3072 floats × 4 bytes = ~2.7MB. No external vector DB needed at this scale. Embedding pipeline persists to `data/embeddings-cache.json` alongside `events-cache.json`.

**Fusion:** RRF with k=60 (standard). Top 50 from each method, fused score = sum over methods of `1 / (60 + rank_in_method)`, return top-K from fused.

**Why RRF over weighted score fusion at L2:** RRF works on ranks, so it sidesteps the calibration problem (BM25 scores and cosine sims are on totally different scales). Weighted fusion (the deck's `0.6 lexical + 0.4 semantic` formula) is more powerful but requires per-method score normalization, which is a layer of work we punt.

**Calibration sub-eval at L2:** sweep RRF parameter k (try 10, 30, 60, 100) on Bucket B (vibe queries) — see which value surfaces best events per query. Document choice in `scripts/eval/L2-calibration.md`.

**Compose step is unchanged from L1.** Same prompt template, same LLM call. Only the retrieval input changes.

### Empirical findings (from exploration) that inform Phase A design

Running `/tmp/explore-clusters.js` against the corpus surfaced:

1. **Anisotropy / noise floor at 0.74.** Random pairs of Gemini embeddings of Pulse events average `cosine_sim = 0.7358` with `stddev = 0.0382`. The deck's confidence thresholds (0.25/0.4) are NOT portable to this model+corpus. The usable similarity range is roughly 0.70–0.90.
2. **Category coherence varies wildly.** `trivia` events cluster +0.117 over baseline (tight); `art` events cluster only +0.026 (loose). This implies semantic retrieval will be very strong for trivia-flavored queries and barely-above-noise for art-flavored ones.
3. **Exact duplicates in the corpus.** Top similarity pairs are all 1.0000 — same source listing the same event multiple times. `events.js` cross-source dedup doesn't catch within-source duplicates. **This is a real bug in the original pulse-sms** worth filing as a finding; for the hybrid clone we dedupe post-retrieval.
4. **"Free" as a semantic concept is unreliable.** Embedding-similarity to the word "free" surfaces events that mention "free wifi" or "free trial," not events with `is_free=true`. Hence the L1 amendment to keep `free_only` as a hard pre-filter.
5. **Lexical and semantic methods catch genuinely different things.** Set overlap of top-10 on "cozy date night in brooklyn": 2/10. BM25 surfaces literal-"Brooklyn" name matches; vectors surface actually-in-Brooklyn neighborhoods. The 2/10 overlap is the strongest motivator for hybrid fusion.

---

## 3. Phase B — Decision craftsmanship

### D1: Codify `interaction_routing` under the LLM-proposes / taxonomy-authorizes pattern

#### Known prior failure mode (load-bearing callout)

Past attempts at deterministic routing in conversational AI have produced poor results (specifics unrecalled by the architect; the failure is *known*, the precise cause is *not*). Common reasons deterministic routing fails:

- **Brittle pattern matching** — regex/keyword rules miss obvious-to-human edge cases
- **Ambiguity** — messages legitimately fit two routes; rules pick one arbitrarily, LLMs ask back
- **Hidden context dependencies** — the right route depends on subtle state the rules don't model
- **Long-tail edge cases** — happy path is 80%, the other 20% requires unmaintainable special-casing
- **Vocabulary drift** — paraphrase wrecks rules; LLMs handle it natively
- **Maintenance debt** — every product change requires routing-rule edits

**Therefore D1 is NOT "YAML regex routing replaces the LLM brain."** D1 is:

- **The LLM proposes** the intent classification (`new_search` | `more_picks` | `pick_details` | `clarify` | `out_of_scope`). This is the inherently fuzzy, context-dependent classification step — the work LLMs are good at.
- **The taxonomy authorizes** what happens next. For each proposed intent, the taxonomy specifies: what *evidence* must be present (e.g., `more_picks` requires `last_picks_present=true`), what *authority* is required (auto / clarify / refuse), what *audit signature* gets written, and what *failure modes* are routed where.

This is the same pattern Cap1's tiered-confidence applies to summaries: the LLM proposes a summary; the confidence layer authorizes display. We're applying that pattern to *actions*, with policy expressed as data, not as more LLM prompting.

If during build we find the YAML reducing to "ask the LLM what to do" with no policy enforcement on top, we've reproduced the prior failure mode and must stop.

#### The decision codified

**What gets classified:** intent of an incoming SMS — `new_search` | `more_picks` | `pick_details` | `clarify` | `out_of_scope`.

**Why this decision first:** it's the most workflow-shaped decision in Pulse, it covers every incoming message (high observation volume), and its failure modes are concrete and demonstrable.

**Two files split along the LLM/policy boundary:**

**(a) `src/taxonomy/interaction_routing_classifier.js`** — calls the LLM with a tight intent-classification prompt over `{ message, session_state }`. Returns a structured proposal:
```js
{
  intent: "more_picks" | "pick_details" | "new_search" | "clarify" | "out_of_scope",
  confidence: 0.0..1.0,
  evidence_referenced: ["last_picks_present", "neighborhood_mentioned", ...],
  reference_extracted: <if applicable, e.g., "2" or "the comedy one">,
}
```

**(b) `src/taxonomy/interaction_routing_policy.yaml`** — the authority/audit layer. Loaded at server startup, version-stamped:
```yaml
decision_type: interaction_routing
version: 0.1

# For each LLM-proposed intent, declare:
#   - what evidence must be true to authorize execution
#   - what to do if evidence is missing
#   - what audit signature to capture
#   - what known failure modes exist

intents:
  more_picks:
    required_evidence:
      - last_picks_present: true
      - last_neighborhood: not_null
    if_evidence_missing:
      action: route_to_clarify
      clarify_prompt: "Tell me what you're in the mood for — drop a neighborhood or a vibe."
    audit_signature: [llm_confidence, evidence_snapshot, taxonomy_version]
    known_failure_modes:
      - "user means 'more of something specific' not 'more of the same' (paraphrase drift)"

  pick_details:
    required_evidence:
      - last_picks_present: true
      - reference: numeric_or_descriptive
    if_evidence_missing:
      action: route_to_clarify
      clarify_prompt: "I don't have a pick list up right now — what are you looking for?"
    audit_signature: [llm_confidence, evidence_snapshot, taxonomy_version, reference]
    known_failure_modes:
      - "bare number with no prior picks"
      - "reference doesn't match any shown pick"

  new_search:
    required_evidence:
      - any_substantive_intent_signal: true
    if_evidence_missing:
      action: route_to_clarify
    audit_signature: [llm_confidence, evidence_snapshot, taxonomy_version]
    known_failure_modes:
      - "neighborhood contradicts prior turn (use clarify, not auto-pivot)"

  clarify:
    # this is itself an authorized intent — when the LLM proposes
    # clarify, the policy may accept it directly
    audit_signature: [llm_confidence, evidence_snapshot, taxonomy_version, clarify_question]

  out_of_scope:
    action: route_to_help_response
    audit_signature: [llm_confidence, evidence_snapshot, taxonomy_version]
```

**Implementation surface:**
- `src/taxonomy/loader.js` — loads + validates YAML, exposes version hash
- `src/taxonomy/interaction_routing_classifier.js` — the LLM-proposes step
- `src/taxonomy/interaction_routing_policy.yaml` — the authorize step
- `src/taxonomy/route.js` — orchestrates classifier → policy check → return final decision with audit record
- `src/handler.js` — calls `route()` before passing to retrieval / compose

#### Empirical question Phase 0 must answer

For each routing-style query in the suite (`more`, `2`, `i meant brooklyn not bushwick`, `actually skip the music, just bars`), Phase 0 must capture:

- What did agent-Pulse do? (it's already an LLM-classifies system)
- Where did agent-Pulse go wrong, if anywhere?
- Would a deterministic taxonomy plausibly handle this case differently?
- Would the LLM-proposes / taxonomy-authorizes pattern materially change the outcome vs the agent loop, or is it largely the same thing with better audit trail?

If the answer to the last question is "largely the same thing with better audit trail," D1's value is *policy and auditability infrastructure*, not improved routing accuracy. That's still valuable (it's the interview point), but the spec should be honest about what changes.

### D2: Feedback flywheel + decision review dashboard

Three mechanisms, ordered by leverage:

**Mechanism 1 — Downstream signal capture (automatic, cheapest).**
Detect user corrections in the conversation stream and log them as feedback against the *prior turn's* decision. Heuristic patterns include:
- "i meant ..." / "no, i meant ..."
- "actually, ..."
- contradictions ("brooklyn not bushwick")
- bounces (user sends new query unrelated to prior pool)

Each detected correction writes a `decision_feedback` record:
```
schema decision_feedback:
  invocation_id:           <trace ID of the offending turn>
  decision_type:           interaction_routing
  decision_version:        0.1
  feedback_source:         downstream_correction
  feedback_type:           route_was_wrong
  reason_structured:       <enum: ambiguous_ref | neighborhood_contradiction | ...>
  detected_at:             <timestamp>
```

**Mechanism 2 — Simulator-driven structured feedback (manual).**
The existing `/test` simulator UI gains a per-response widget: `Was this the right call? [Yes / Almost / No]`. The "No" path opens a structured form with the decision's known failure modes as enum options.

This is the human-in-the-loop labeling channel during dev. In a Cap1 deployment, this is associate-driven; here, it's curator-driven (you).

**Mechanism 3 — Decision review dashboard at `/decisions`.**
A simple Express-served page that surfaces, per `decision_type`:
- Route distribution (last 24h / 7d / 30d)
- Override rate per route (from feedback signal)
- Top structured failure reasons
- Pending taxonomy-change proposals (from human reviewers)
- Diff view across taxonomy versions

**The dashboard is the artifact that makes the flywheel real.** Without a visible review surface, "associate flywheel" is rhetoric. With one, the strategy has a literal screen to point at.

---

## 4. Eval methodology

### Phase A — Retrieval-quality eval

**Query suite:** 25 queries, 4 hypothesis-driven buckets, in `scripts/comparison-queries.txt`:

```
BUCKET A — State/reference (5 queries)
  Hypothesis: hybrid CAN'T do these by design; agent wins.
  - "more", "2", "i meant brooklyn not bushwick",
    "send me the link", "actually skip the music, just bars"

BUCKET B — Vibe/semantic (8 queries)
  Hypothesis: L1 BM25 misses these; L2 hybrid recovers them.
  - "something romantic and intimate in BK",
    "cozy date night spot",
    "weird underground vibes tonight",
    "low-key bar that isn't another wine bar",
    "where do creatives hang out in brooklyn",
    "something different tonight",
    "after-work drinks but not basic",
    "actually fun trivia somewhere"

BUCKET C — Classic retrieve (7 queries)
  Hypothesis: every layer handles these comparably to agent.
  - "williamsburg", "free events",
    "comedy in the lower east side",
    "jazz tonight", "events tomorrow night",
    "anything happening in bushwick", "dj set in brooklyn"

BUCKET D — Edges (5 queries)
  - "help", "dinner and a show",
    "how about comedy later tonight",
    "wburg" (abbreviation),
    "free or cheap things this weekend"
```

**Per-layer log format:** `scripts/eval/L<n>-<name>.md`. Per query: agent response, hybrid response, qualitative read. Bucket roll-up: count of wins/ties/losses. Decision: ship layer / iterate layer / abort.

**Calibration sub-eval at L2:** `scripts/eval/L2-calibration.md`. RRF k-parameter sweep across Bucket B, qualitative selection.

### Phase B — Decision-quality eval

Different in kind — measures *the mechanism*, not the model:

| Metric | Where measured | Target |
|---|---|---|
| Route correctness on 25-query suite | manual annotation post-run | ≥85% routes labeled correct |
| Override rate per route | feedback records / route invocations | trending down per taxonomy version |
| Failure modes detected outside taxonomy | structured feedback "missing route type" | should grow then plateau |
| Cycle time: override → taxonomy version bump | feedback timestamp → commit | <1 week in dev; tracked but not optimized |

**The Phase B "score" is the cycle time, not a static accuracy number.** This is intentional — workflow-agent maturity is measured by *how fast errors become versioned fixes*, not by point-in-time correctness.

---

## 5. Repo structure & tech stack

### Cloning

```bash
cp -r ~/Projects/pulse-sms ~/Projects/pulse-rag-hybrid
cd ~/Projects/pulse-rag-hybrid
# bump default PORT from 3000 → 3002 in src/server.js
npm rebuild better-sqlite3        # native binding for current Node version
npm test                          # baseline smoke check
```

### Directory layout (additions over pulse-sms)

```
src/
├── retrieval/                  # Phase A
│   ├── bm25.js                 # ~80 LOC, pure
│   ├── event-cards.js          # event → indexable string
│   ├── embeddings.js           # Gemini embedding client + cache
│   ├── cosine.js               # in-process cosine sim
│   ├── fusion-rrf.js           # rank-fusion
│   └── index.js                # public retrieve(query, k) surface
├── taxonomy/                   # Phase B
│   ├── loader.js                              # YAML loader + version hash
│   ├── interaction_routing_classifier.js      # LLM-proposes step
│   ├── interaction_routing_policy.yaml        # policy + audit + escalation
│   └── route.js                               # orchestrates classifier → policy → decision
├── feedback/                   # Phase B
│   ├── correction-detector.js  # downstream signal capture
│   ├── store.js                # SQLite persistence
│   └── api.js                  # /decisions dashboard backend
└── agent-loop.js               # replaced — linear retrieve→route→compose

data/
├── events-cache.json           # unchanged
├── embeddings-cache.json       # added — vector store on disk
└── pulse.db                    # decision_feedback table added

scripts/
├── comparison-queries.txt
├── compare-versions.js         # adapted from naive-strip experiment
└── eval/
    ├── L1-bm25.md
    ├── L2-hybrid.md
    ├── L2-calibration.md
    ├── D1-routing.md
    └── D2-flywheel.md

test/unit/retrieval/
├── bm25.test.js
├── event-cards.test.js
├── fusion-rrf.test.js
└── cosine.test.js

test/unit/taxonomy/
├── route.test.js
├── loader.test.js
└── interaction_routing_classifier.test.js
```

### Tech stack summary

- **Embeddings:** Gemini `gemini-embedding-001` (3072 dims). Hosted, single API call per event, cached to disk.
- **Vector store:** in-process JS arrays + cosine sim. No external DB.
- **BM25:** rolled in-house (~80 LOC). No library dependency.
- **Fusion:** RRF (k=60 default, calibrated at L2).
- **Taxonomy:** YAML on disk, version-hashed, loaded at startup.
- **Feedback persistence:** SQLite via the existing `better-sqlite3` dep, new `decision_feedback` table.
- **Dashboard:** plain Express + small HTML page (no SPA framework).

### Git discipline

One commit per layer (L1, L2, D1, D2) + one for the initial scaffold. Each commit is a working end-to-end system. Tagged `phase-a-L1`, `phase-a-L2`, `phase-b-D1`, `phase-b-D2`.

---

## 6. Risks & abort criteria

| Risk | Signal | Abort/pivot response |
|---|---|---|
| Phase 0 invalidates Phase A or Phase B premise | Failure-mode atlas shows agent already handles the targeted failures, or shows that hybrid retrieval doesn't change outcomes on the suite | Pivot — skip the layer that doesn't earn its place; potentially restructure both phases |
| D1 collapses into deterministic regex routing | LLM-proposes layer is absent or unused; YAML contains regex/keyword tests instead of evidence/authority specs | Stop and redesign per the "Known prior failure mode" callout in §3 — we'd be reproducing a known failure |
| L2 calibration doesn't yield clear above-noise cuts | Top-1 and 10th scores within stddev across eval set | Stop Phase A; investigate corpus quality (duplicate bug already a candidate root cause) |
| Hybrid fusion doesn't beat either method alone | All 25 queries: hybrid ≈ max(BM25, vector) | Drop fusion; ship single-method; proceed to Phase B anyway — the taxonomy story is the point |
| D2 feedback capture produces unactionable free-text | Reason field is open-ended in practice | Tighten schema to closed enum; drop claim if needed |
| Time budget exhausted | Phase A took longer than planned | Ship L1+L2+D1 without D2 dashboard; D2 becomes documented next step |

**Meta-risk explicitly acknowledged:** the 2,743-event Pulse corpus is not scale-transparent to a 50k-article Pinpoint KB. The artifact demonstrates *the pattern*; production scale requires infrastructure (versioned taxonomy storage, multi-region governance, sub-100ms decision lookup) we don't build here. Any interview discussion of the artifact should be explicit about this.

---

## 7. Strategic framing (interview-shaped)

The deck shows Agent Assist as: **Query Transformer → Retriever → Reranker → Prompt Construction → LLM Summarizer → Summary Transformer**, with confidence bands gating display.

The role asks: how do you transition from this to *workflow execution*?

The pattern this artifact demonstrates: **narrow the decision surface, let the LLM propose intent/action, let a typed policy taxonomy authorize execution and capture audit signal, design the flywheel that lets the people closest to the work be the editors of the policy.**

Phase 0 anchors the design empirically before code. Phase A grounds the retrieval-craftsmanship half. Phase B grounds the orchestration/policy half. Together they're a small but visibly principled implementation of the strategy the role is asking for.

The single sentence to lead with: **"Today Agent Assist gates *display*; tomorrow it gates *execution*; that one-word change reshapes the entire risk model and product surface, and the path through it is LLM-proposes / policy-authorizes — with the policy edited by the people closest to the work — not a smarter agent."**

---

## 8. Open questions (resolved or to defer)

| Question | Resolution |
|---|---|
| Should we keep the naive-strip RAG as L0 baseline? | No — it was a strawman; agent-Pulse (port 3000) is the only baseline |
| Should `free_only` be a hard or soft filter? | Hard (amended from initial design after empirical finding) |
| Should we keep neighborhood as a hard filter? | No — drop it; the experiment is whether retrieval can do what filters did before |
| RRF vs. weighted score fusion at L2? | RRF — avoids the score-scale calibration problem |
| Local vs. hosted embeddings? | Hosted (Gemini) — interview-relevant, negligible cost at this scale |
| Build reranker (L3)? Confidence bands (L4)? Query transformer (L5)? | Explicitly out of scope for this spec; documented next steps |
| Do we re-embed on every event-cache refresh? | Lazy rebuild — check cache timestamp on every retrieve call |
| Where does the spec doc live? | `pulse-sms/docs/superpowers/specs/` (with the source repo, not the experimental clone) |
| Should we excavate the prior deterministic-routing failure before designing D1? | Deferred to Phase 0 — empirical exercise will surface the failure mode, more durable than relying on partial recall |
| Where does Phase 0 actually run? | Scripts in `/tmp/` plus existing cached embeddings; no new project yet. The new `pulse-rag-hybrid` clone only gets created if Phase 0 confirms Phase A / Phase B should proceed |
