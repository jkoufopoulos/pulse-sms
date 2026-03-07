# Pulse Eval System — How-To Guide

This document walks through every eval layer in Pulse: what it checks, how to run it, how to read the results, and when to use each one.

## Prerequisites

```bash
# 1. Install dependencies
npm install

# 2. Copy env vars (need ANTHROPIC_API_KEY at minimum for LLM evals)
cp .env.example .env

# 3. Start the server in test mode (required for all evals except unit tests)
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js
```

The server must be running for pipeline evals, scenario evals, and A/B evals. Unit tests run standalone.

---

## Quick Reference

| What you want to check | Command | Cost | Time |
|------------------------|---------|------|------|
| Code didn't break | `npm test` | Free | ~2s |
| Extraction fidelity (auto) | Runs every scrape automatically | Free | <1s |
| Extraction fidelity (with LLM) | `POST /api/eval/audit` | ~$0.01 | ~10s |
| Full pipeline regression | `node scripts/run-evals.js` | Free | ~3min |
| Pipeline + LLM judges | `node scripts/run-evals.js --judges` | ~$0.50 | ~8min |
| Multi-turn conversations | `node scripts/run-scenario-evals.js` | ~$0.20 | ~5min |
| Model A/B comparison | `node scripts/run-ab-eval.js` | ~$0.30 | ~5min |
| Browse traces interactively | Open `/eval` in browser | Free | -- |
| Quality eval conversations | `npm run eval:quality` | ~$0.50 | ~5min |
| Check source health | Open `/health` in browser | Free | -- |
| View last audit report | `GET /api/eval/audit` | Free | -- |

---

## Layer 0: Unit Tests

**What it checks:** Pure-function correctness — neighborhood extraction, event ID hashing, dedup logic, eval functions themselves, venue resolution, geo math, prompt construction.

**Run:**
```bash
npm test
```

**Read the output:** Every line says `PASS` or `FAIL` with the test name. Exit code 0 = all pass. Currently 905+ tests.

**When to run:** After any code change, before committing. This is the fastest feedback loop.

---

## Layer 1: Extraction Audit

**What it checks:** Whether Claude's extracted events match the actual source text. Catches hallucinated venues, made-up times, invented prices, and overconfident extractions.

**Sources covered:** The 4 Claude-extracted sources — Skint, Nonsense NYC, Yutori, Screen Slate.

### Tier 1 — Deterministic (runs automatically every scrape)

Eight checks run on every Claude-extracted event:

| Check | What it catches |
|-------|-----------------|
| `evidence_name_in_source` | Event name not found in raw source text |
| `evidence_time_in_source` | Time quote not in source |
| `evidence_location_in_source` | Location quote not in source |
| `evidence_price_in_source` | Price quote not in source |
| `has_evidence` | Fewer than 2 of 4 evidence fields present |
| `confidence_calibrated` | Confidence > 0.8 but evidence is incomplete |
| `date_not_past` | Event date is before today |
| `required_fields_present` | Missing name, venue/neighborhood, or date/time |

**How it runs:** Automatically during `refreshCache()`. No action needed.

**View results:**
```bash
# In server logs after scrape:
# "Extraction audit: 45/48 events pass (93.8%), 3 issues"

# Via API:
curl http://localhost:3000/api/eval/audit | jq .

# On disk:
cat data/reports/extraction-audit-2026-02-19.json | jq .summary
```

**On the health dashboard:** Open `/health` — the "Extraction Quality" section shows per-source pass rates and failure breakdowns.

### Tier 2 — LLM Judge (on-demand)

Asks Claude Haiku to verify each field as CORRECT, WRONG, or UNVERIFIABLE. Prioritizes events that failed Tier 1.

**Run:**
```bash
# From another terminal while server is running:
curl -X POST http://localhost:3000/api/eval/audit | jq .

# With custom sample size (default 10):
curl -X POST "http://localhost:3000/api/eval/audit?sample=20" | jq .
```

**Read the output:** The response includes a `llmAudit` section with per-field verdicts for each sampled event.

### Reading an audit report

```bash
cat data/reports/extraction-audit-2026-02-19.json | jq '
{
  summary: .summary,
  worst_source: (
    .sourceStats | to_entries | sort_by(.value.passed / .value.total) | first
  ),
  sample_failure: (
    .events | map(select(.passed == false)) | first
  )
}'
```

Key things to look for:
- **Pass rate below 80%** for any source — the extraction prompt or source HTML may have changed
- **`evidence_*_in_source` failures** — Claude is hallucinating or paraphrasing instead of quoting
- **`date_not_past` failures** — stale events leaking into cache (source is publishing old dates)
- **`confidence_calibrated` failures** — extraction confidence scores are inflated

---

## Layer 2: Pipeline Evals (Synthetic Cases)

**What it checks:** End-to-end SMS pipeline correctness — does the right intent get routed, the right neighborhood resolved, the right events picked, and the right SMS format produced?

**Test cases:** 105 synthetic cases in `data/fixtures/synthetic-cases.json` plus 293 multi-turn scenarios and 124 regression scenarios (417 total golden dataset), covering:
- 8 neighborhoods x 3 phrasings (direct, slang, question)
- Landmark and subway-based neighborhood references
- Free intent, more intent, details intent, help intent
- Conversational messages (greetings, thanks, goodbye)
- Off-topic messages (weather, sports, food orders)
- Edge cases (emoji-only, single char, gibberish, very long messages)
- Session context (same hood, different hood)
- Filters (comedy, music, jazz, art, theater, vibes)
- Multi-turn conversation flows across 6 categories (happy path, edge case, filter drift, poor experience, abuse/off-topic, editorial)

### Code evals only (free, fast)

```bash
node scripts/run-evals.js
# or with explicit URL:
node scripts/run-evals.js --url=http://localhost:3000
```

Runs 6 invariant checks per trace (trimmed from 24 in Phase 5, 2026-03-07):

1. `char_limit` — SMS under 480 chars
2. `valid_intent` — intent is one of the valid types
3. `valid_neighborhood` — neighborhood is in the known set
4. `response_not_empty` — SMS is not blank
5. `valid_urls` — all URLs in SMS are parseable
6. `latency_under_10s` — total response time under 10 seconds

The following 18 checks were removed during Phase 5 code eval trimming: `picked_events_exist`, `day_label_accuracy`, `pick_count_accuracy`, `neighborhood_accuracy`, `category_adherence`, `free_claim_accuracy`, `compound_filter_accuracy`, `filter_match_alignment`, `time_filter_accuracy`, `neighborhood_expansion_transparency`, `price_transparency`, `schema_compliance`, `model_routing_captured`, `ai_cost_tracked`, `off_topic_redirect`, `filter_intent_gating`, `split_validation_effective`, `discovery_lean`.

Plus expectation checks per case (expected intent, expected neighborhood, banned words).

### With LLM judges (~$0.50)

```bash
node scripts/run-evals.js --judges
```

Adds two Claude Sonnet judges per trace:
- **`judge_tone`** — Does the SMS sound like a friend texting, not a bot?
- **`judge_pick_relevance`** — Are picked events relevant to the neighborhood and request?

### Reading an eval report

Reports are saved to `data/reports/eval-{timestamp}.json`.

```bash
# Latest report:
ls -t data/reports/eval-*.json | head -1 | xargs cat | jq '
{
  pass_rate: "\(.passed)/\(.total) (\(.passed/.total*100 | floor)%)",
  failures: .failure_breakdown,
  worst_cases: [.results[] | select(.pass == false) | {id, message: .case.message, failures: [.evals[] | select(.pass == false) | .name]}] | .[0:5]
}'
```

Key things to look for:
- **Pass rate below 90%** — something regressed
- **`valid_intent` failures** — routing model is misclassifying messages
- **`picked_events_exist` failures** — compose model is hallucinating event IDs
- **`off_topic_redirect` failures** — bot is answering off-topic questions instead of redirecting
- **`judge_tone` failures** — SMS sounds robotic or corporate

### Tagging runs

```bash
node scripts/run-evals.js --tag=after-prompt-change
```

Tags appear in the report JSON for comparison across runs.

---

## Layer 3: Scenario Evals (Multi-Turn Conversations)

**What it checks:** Behavioral correctness across multi-turn conversations — does the bot handle conversation flows naturally? Does session context carry forward? Does it handle edge cases gracefully?

**Test cases:** `data/fixtures/multi-turn-scenarios.json` (293 scenarios across 6 categories: happy path, edge case, filter drift, poor experience, abuse/off-topic, editorial) — scripted conversations with expected behavior descriptions and known failure modes.

**Run:**
```bash
# All scenarios:
node scripts/run-scenario-evals.js

# Filter by category:
node scripts/run-scenario-evals.js --category=filter_drift

# Filter by difficulty:
node scripts/run-scenario-evals.js --difficulty=hard

# Filter by name:
node scripts/run-scenario-evals.js --name="events then details"

# Against deployed server:
node scripts/run-scenario-evals.js --url=https://web-production-c8fdb.up.railway.app

# Only agent-brain-specific scenarios:
node scripts/run-scenario-evals.js --pipeline agent_brain

# With LLM judge (costs API tokens):
node scripts/run-scenario-evals.js --judge
```

Each scenario:
1. Plays a scripted conversation through the live pipeline
2. Collects actual bot responses
3. Sends the expected vs actual conversation to Claude Sonnet for grading
4. Returns per-turn pass/fail verdicts and any failure modes triggered

### Reading a scenario report

```bash
ls -t data/reports/scenario-eval-*.json | head -1 | xargs cat | jq '
{
  pass_rate: "\(.passed)/\(.total)",
  failures: [.results[] | select(.pass == false) | {
    name: .scenario.name,
    failure_modes: .judge.failure_modes_triggered
  }]
}'
```

Key things to look for:
- **Session leakage** — bot forgets or confuses context between turns
- **Details flow** — user asks about pick #1, bot responds about wrong event
- **More flow** — bot re-sends same events instead of new ones
- **Hood switch** — user changes neighborhood, bot still shows old neighborhood events

---

## Layer 3b: Regression Evals

**What it checks:** Principle-specific behavioral assertions tied to P1-P7 architecture principles. Each scenario has deterministic assertions (not LLM-judged) that verify specific invariants.

**Test cases:** `data/fixtures/regression-scenarios.json` — 124 scenarios with assertions tied to specific principles.

**Run:**
```bash
# All regression scenarios:
node scripts/run-regression-evals.js

# Against deployed server:
node scripts/run-regression-evals.js --url=https://web-production-c8fdb.up.railway.app
```

**When to run:** After any change that touches handler.js, agent-loop.js, brain-llm.js, pipeline.js, or session state logic. These catch principle violations that scenario evals might miss.

---

## CC Agent Analysis (Alternative to LLM Judge)

Instead of running scenario evals with `--judge` (which costs API tokens), you can run evals without the judge flag, then analyze the resulting JSON reports using Claude Code agents. This is cheaper, faster, and more nuanced.

**Workflow:**
```bash
# 1. Run evals (no --judge flag):
node scripts/run-scenario-evals.js
node scripts/run-regression-evals.js

# 2. Analyze reports with CC agents (fan out 3 in parallel):
# - Agent 1: Analyze scenario eval report for failures
# - Agent 2: Analyze regression eval report for principle violations
# - Agent 3: Cross-reference failures with filter drift patterns
```

Reports are saved to `data/reports/` as JSON. The CC agent reads the JSON and provides nuanced analysis of failures, filter drift, and behavioral regressions.

---

## Layer 4: A/B Model Comparison

**What it checks:** Whether a new model produces better SMS responses than the current one, using head-to-head comparison with LLM judges.

**Run:**
```bash
# Default: Haiku vs Sonnet
node scripts/run-ab-eval.js

# Custom models:
node scripts/run-ab-eval.js --model-a=claude-haiku-4-5-20251001 --model-b=claude-sonnet-4-5-20250929

# Multiple runs per case (reduces noise):
node scripts/run-ab-eval.js --runs=3

# Specific case:
node scripts/run-ab-eval.js --id=ab-001
```

For each test case, both models compose a response from the same event list, then three judges evaluate:
1. **Tone** — friend or bot?
2. **Pick relevance** — right events?
3. **Preference** — head-to-head, which SMS is better? (Position-randomized to control for bias)

Plus deterministic code checks (char limit, format, valid picks).

### Reading an A/B report

```bash
ls -t data/reports/ab-eval-*.json | head -1 | xargs cat | jq '
{
  model_a: .config.model_a,
  model_b: .config.model_b,
  preference: .summary.preference,
  tone_pass: .summary.tone,
  cost: .summary.cost
}'
```

Key things to look for:
- **Preference win rate** — if the cheaper model wins >60%, switch to it
- **Tone pass rate** — if one model consistently sounds more natural
- **Cost difference** — Haiku is ~73% cheaper than Sonnet; use A/B to verify quality holds

---

## Layer 5: Interactive Trace Viewer

**What it checks:** Nothing automatically — this is a manual inspection tool for browsing live request traces.

**Open:** Navigate to `/eval` in the browser (requires `PULSE_TEST_MODE=true`).

**What you can do:**
- Browse all recent traces (200 in-memory buffer)
- Filter by intent, neighborhood, source
- Inspect the full request lifecycle: routing decision, candidate events, composition, final SMS
- Annotate traces as pass/fail with failure mode tags
- View event scores from the scoring endpoint

**When to use:** After running evals, dig into specific failures. Or spot-check live production behavior.

---

## Layer 6: Quality Evals

**What it checks:** Rubric-based quality assessment of multi-turn conversations. An LLM judge scores editorial voice, pick relevance, personality, and SMS formatting against a detailed rubric.

**Run:**
```bash
npm run eval:quality
```

**Read the output:** Results saved to `data/reports/` as JSON. Browse interactively at `/eval-quality`.

**When to run:** After prompt changes, model swaps, or editorial voice adjustments. Complements code evals (which check correctness) with quality assessment (which checks tone and editorial taste).

---

## Full End-to-End Eval Run

Here's the complete sequence for a thorough quality check — for example, after a prompt change or model swap:

```bash
# Terminal 1: Start server
PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js

# Wait for initial scrape to complete (watch logs for "Cache refreshed: ...")
# Also watch for "Extraction audit: X/Y events pass" in the logs

# Terminal 2: Run evals in order

# 1. Unit tests (always first — catches code bugs before burning API credits)
npm test

# 2. Check extraction audit from the scrape that just ran
curl http://localhost:3000/api/eval/audit | jq .summary

# 3. Pipeline evals — code checks only (free, ~3 min)
node scripts/run-evals.js

# 4. Pipeline evals — with LLM judges (~$0.50, ~8 min)
node scripts/run-evals.js --judges

# 5. Scenario evals — multi-turn behavioral checks (~$0.20, ~5 min)
node scripts/run-scenario-evals.js

# 6. Quality evals — editorial voice and tone (~$0.50, ~5 min)
npm run eval:quality

# 7. (Optional) A/B eval — only if comparing models (~$0.30, ~5 min)
node scripts/run-ab-eval.js

# 8. (Optional) Full extraction audit with LLM tier (~$0.01, ~10s)
curl -X POST http://localhost:3000/api/eval/audit | jq .summary

# 9. Check reports
ls -t data/reports/*.json | head -5
```

Total cost for a full run (steps 1-6): ~$1.20. Time: ~25 minutes.

### Quick smoke test (free, 5 min)

For smaller changes where you just need a sanity check:

```bash
npm test
node scripts/run-evals.js
curl http://localhost:3000/api/eval/audit | jq .summary
```

---

## Generating / Updating Test Cases

### Synthetic cases

```bash
# Regenerate from templates (won't overwrite if hand-curated set < 100 cases):
node scripts/gen-synthetic.js

# Output: data/fixtures/synthetic-cases.json
```

### A/B compose cases

Edit `data/fixtures/ab-compose-cases.json` directly. Each case needs:
- `id` — unique identifier
- `message` — simulated user message
- `neighborhood` — target neighborhood
- `events` — array of event objects to compose from

### Multi-turn scenarios

Edit `data/fixtures/multi-turn-scenarios.json` directly. Each scenario needs:
- `name` — descriptive name
- `category` — grouping (e.g., "details", "more", "edge-case")
- `turns` — array of `{ user, expected_behavior }` pairs
- `failure_modes` — known failure patterns to watch for

---

## Report File Reference

All reports are saved to `data/reports/`:

| Pattern | Source | Contains |
|---------|--------|----------|
| `eval-{timestamp}.json` | `node scripts/run-evals.js` | Per-case pass/fail, failure breakdown, eval details |
| `scenario-eval-{timestamp}.json` | `run-scenario-evals.js` | Per-scenario judge verdicts, actual conversations |
| `ab-eval-{models}-{timestamp}.json` | `run-ab-eval.js` | Side-by-side responses, preference stats, cost |
| `extraction-audit-{date}.json` | Every scrape + `POST /api/eval/audit` | Per-event check results, source stats |

---

## API Endpoints

All eval endpoints require `PULSE_TEST_MODE=true`.

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/api/eval/events` | GET | Returns all cached events |
| `/api/eval/score` | POST | Runs AI scoring on cached events |
| `/api/eval/refresh` | POST | Forces a cache refresh (re-scrapes all sources) |
| `/api/eval/audit` | GET | Returns the latest extraction audit report |
| `/api/eval/audit` | POST | Runs full extraction audit (Tier 1 + Tier 2 LLM) |
| `/api/eval/traces` | GET | Returns recent traces (use `?limit=N`) |
| `/api/eval/traces/:id` | GET | Returns a specific trace by ID |
| `/api/eval/traces/:id/annotate` | POST | Annotate a trace (pass/fail + notes) |
| `/api/eval/session` | POST | Inject/clear session state for eval |
| `/api/eval/simulate` | POST | Simulate a neighborhood request (full funnel) |

---

## Troubleshooting

**"No events in cache"** — The scrape hasn't completed yet. Wait for the "Cache refreshed" log, or force one with `curl -X POST http://localhost:3000/api/eval/refresh`.

**Pipeline evals timing out** — Some sources are slow. The server needs to finish its initial scrape before evals can run. Watch the logs.

**"0 traces found" in eval runner** — The eval runner looks for traces at `GET /api/eval/traces?limit=1`. Make sure `PULSE_TEST_MODE=true` is set (traces are only exposed in test mode).

**Judge evals failing with auth error** — `ANTHROPIC_API_KEY` is missing or expired. Check `.env`.

**Extraction audit shows "No audit data yet"** — No scrape has completed since the server started. Hit `/api/eval/refresh` or wait for the scheduled scrape.

**A/B eval "no events for compose"** — The A/B runner calls `composeResponse()` directly with fixture events. Make sure `data/fixtures/ab-compose-cases.json` has valid event arrays.
