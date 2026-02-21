# Pulse Eval Plan

## Current State

The system has strong operational observability and SMS-level quality checks. What's missing is event-level evaluation — understanding whether we're collecting the right events and choosing well for users.

### What exists today

| Layer | What it measures | Coverage |
|-------|-----------------|----------|
| **Source health** | Per-source: event count, fetch time, consecutive failures, HTTP status, 7-run history | Every scrape, all 18 sources |
| **Code evals** | 9 deterministic checks per SMS: char limit, valid intent/neighborhood, picks exist, URLs valid, day labels, off-topic redirect, latency | Every request, zero cost |
| **Traces** | Full request lifecycle: routing → candidates → composition → picks → SMS text | Every request, JSONL on disk |
| **Judge evals** | LLM grades tone + pick relevance + A/B preference (Sonnet) | On-demand, ~$0.01/case |
| **Scenario evals** | Multi-turn conversation correctness against 25 curated scenarios | On-demand |
| **Synthetic evals** | 105 generated test cases across neighborhoods, intents, filters | On-demand |

### What's not measured

1. **Extraction fidelity** — Does the extracted JSON match what the source actually says?
2. **Event coverage** — Are we missing events a user would want?
3. **Event quality** — Of 300+ cached events, how many are actually worth recommending?
4. **Dedup accuracy** — Do name+venue+date hashes catch all true duplicates? Do they false-positive on different events?
5. **Pick outcomes** — After we send picks, did the user engage or bail?

---

## Proposed Eval Layers

### Layer 1: Extraction Audit — IMPLEMENTED

**Status:** Implemented in `src/evals/extraction-audit.js`. Runs automatically on every scrape (Tier 1) and on-demand via API (Tier 2).

**Goal:** Validate that extracted event fields match the raw source content.

**How it works:**

Raw source text is captured before each `extractEvents()` call (via `captureExtractionInput()` in each source file). After all sources complete, `runExtractionAudit()` runs deterministic checks on every Claude-extracted event.

**Tier 1 — Deterministic checks (runs every scrape, free):**

| Check | Logic | What it catches |
|-------|-------|-----------------|
| `evidence_name_in_source` | `rawText.includes(evidence.name_quote)` | Hallucinated event names |
| `evidence_time_in_source` | `rawText.includes(evidence.time_quote)` | Made-up times |
| `evidence_location_in_source` | `rawText.includes(evidence.location_quote)` | Invented venues |
| `evidence_price_in_source` | `rawText.includes(evidence.price_quote)` | Wrong prices |
| `has_evidence` | At least 2 of 4 evidence fields non-null | Extraction without grounding |
| `confidence_calibrated` | High confidence (>0.8) ↔ all evidence present | Overconfident extraction |
| `date_not_past` | `date_local` is today or future | Stale events leaking through |
| `required_fields_present` | name + (venue OR neighborhood) + (date OR time_window) | Skeleton events |

**Tier 2 — LLM judge (on-demand via `POST /api/eval/audit`, ~$0.001/event):**

Asks Claude Haiku to verify each field as CORRECT, WRONG, or UNVERIFIABLE against the raw source text. Prioritizes events that failed Tier 1 checks.

**Endpoints:**
- `GET /api/eval/audit` — returns latest audit report from disk
- `POST /api/eval/audit` — runs full audit (Tier 1 + Tier 2) on current cache

**Dashboard:** Health UI (`/health`) shows per-source pass rate and failure breakdown in the "Extraction Quality" section.

**Reports:** Saved to `data/reports/extraction-audit-*.json` after each scrape.

**What it catches:**
- Hallucinated dates, venues, prices
- Schema drift (source changes HTML structure, extraction breaks silently)
- Systematic extraction bias (e.g., always missing end times, always wrong on free/paid)

**Metrics:**
- Per-source pass rate (e.g., "theskint: 95%, yutori: 88%")
- Most common failure types per source
- Overall extraction fidelity across Claude-extracted sources

---

### Layer 2: Event Scoring

**Goal:** Score every cached event on dimensions that matter to Pulse users, so composition can pick from pre-ranked events instead of raw proximity.

**Scoring dimensions:**

| Dimension | What it measures | Signal |
|-----------|-----------------|--------|
| **Completeness** | Has venue, time, price, description, URL vs partial data | Events missing key fields are harder to recommend |
| **Timeliness** | Tonight/this week vs stale or undated | Undated events are low-confidence picks |
| **Audience fit** | Indie/underground/curated vs mainstream/corporate | Pulse users want Mercury Lounge, not MSG |
| **Uniqueness** | Niche event vs something on every platform | "Secret DJ set in a warehouse" > "Hamilton on Broadway" |
| **Source trust** | Already exists (source_weight 0.6–0.9) | Higher-trust sources = more reliable data |

**How it works:**
- **Completeness** is deterministic — count non-null fields, weight by importance
- **Timeliness** is deterministic — parse date, compare to today
- **Audience fit** and **uniqueness** need a lightweight classifier at scrape time (Haiku, batched)
- Composite score = weighted sum, stored on each event as `quality_score`

**What it enables:**
- Compose prompt can say "pick from the highest-quality events" instead of just proximity
- Health dashboard shows quality distribution per source ("RA averages 0.82, Tavily averages 0.51")
- Identify sources that contribute noise vs signal

**Metrics:**
- Quality score distribution per source
- Quality score of picked events vs unpicked (are we picking the best ones?)
- Percentage of cache that's "recommendable" (score > threshold)

**Cost:** Completeness and timeliness are free. Audience fit classifier: ~$0.005 per batch of 50 events = ~$0.03/scrape.

**Implementation:** New `src/evals/event-scoring.js`. Deterministic scores at scrape time, classifier scores as optional enrichment. Score stored on event object in cache.

---

### Layer 3: Dedup & Coverage Audit

**Goal:** Understand merge behavior and find coverage gaps.

#### Dedup audit

**How it works:**
1. Before dedup, snapshot all raw events with their IDs
2. After dedup, log which events were merged and which source "won"
3. Periodically sample merged pairs and ask: "Are these actually the same event?"

**What it catches:**
- False merges: "DJ Honey Dijon" from Dice merged with "Honey Dijon Brunch" from Eventbrite (same name hash, different events)
- Missed merges: "Blessing Offor w/ Mina Mei" from Yutori not merged with "Blessing Offor" from Ticketmaster (different name hash, same event)

**Metrics:**
- Merge rate per source pair (e.g., "Dice-BrooklynVegan: 12% overlap")
- False merge rate (sampled)
- Missed merge rate (sampled)

#### Coverage audit

**How it works:**
1. Weekly: take a curated list of "known good" events (from a human or from Yutori scouts)
2. Check which ones appear in the cache
3. For misses: which source should have had it? Did the scraper fail or does the source not list it?

**What it catches:**
- Blind spots by neighborhood (e.g., no Bed-Stuy coverage)
- Blind spots by category (e.g., no film events before Yutori)
- Source regression (RA used to return 50 events, now returns 20)

**Metrics:**
- Coverage rate against known-good set
- Coverage by neighborhood
- Coverage by category

**Cost:** Dedup audit is mostly free (logging). Coverage audit needs a human-curated reference set or can use Yutori emails as a partial proxy.

**Implementation:** Dedup logging added to `src/events.js`. Coverage check as new script `scripts/coverage-audit.js`.

---

### Layer 4: Outcome Tracking

**Goal:** Close the feedback loop — understand which picks actually serve users.

**Signals already in traces (just need aggregation):**

| User action after picks | Signal | Interpretation |
|------------------------|--------|----------------|
| Asks for **details** on pick #1 | Strong positive | Pick was interesting enough to explore |
| Asks for **more** | Mild negative | First picks didn't satisfy |
| Texts a **different neighborhood** | Negative | Wrong area or bad picks |
| Asks for **free** after paid picks | Negative | Price mismatch |
| Says **thanks** / positive | Positive | Satisfied |
| **No further texts** | Ambiguous | Satisfied or gave up |

**How it works:**
1. For each trace with intent=events, look at the next message from the same phone within 30 minutes
2. Classify the follow-up as positive/negative/neutral signal
3. Attribute signal back to the picked events and their sources

**What it enables:**
- "Pick success rate" per source (events from RA get details requests 40% of the time, Tavily only 10%)
- "Pick success rate" per neighborhood (East Village picks land well, Midtown picks don't)
- Identify which event attributes correlate with engagement (free? live music? tonight?)

**Metrics:**
- Details request rate (% of pick sessions where user asks for details)
- More request rate (% where user asks for more)
- Bounce rate (% where user doesn't text again within 30 min)
- Per-source pick success rate

**Cost:** Free — just trace aggregation.

**Implementation:** New `scripts/outcome-analysis.js` that reads trace files and computes metrics. Could also run as a nightly batch.

---

## Priority Order

| Layer | Effort | Signal value | Dependency |
|-------|--------|-------------|------------|
| **Layer 4: Outcome tracking** | Low (trace aggregation) | High (closes feedback loop) | Needs trace volume |
| **Layer 1: Extraction audit** | Low-medium | High (catches silent failures) | None |
| **Layer 2: Event scoring** | Medium | High (improves pick quality) | None |
| **Layer 3: Dedup & coverage** | Medium-high | Medium (diagnostic) | Layer 2 helps interpret |

Layer 4 is cheapest and most impactful — the data already exists in traces. Layer 1 is the most urgent for the new Yutori/Gmail pipeline since we're feeding Claude longer, messier HTML than the other sources.

---

## How-To Guide

See [docs/eval-howto.md](eval-howto.md) for a complete walkthrough of running every eval layer, reading reports, and troubleshooting.

---

## Success Criteria

The eval system is working when we can answer these questions from dashboards or reports:

1. **"Are our scrapers healthy?"** — Already answered (source health dashboard).
2. **"Is Claude extracting events correctly?"** — Layer 1 answers this.
3. **"Are we caching good events?"** — Layer 2 answers this.
4. **"Are we missing events users would want?"** — Layer 3 answers this.
5. **"Are we picking the right events for users?"** — Layer 4 answers this.
6. **"Is the SMS response well-written?"** — Already answered (judge evals).
