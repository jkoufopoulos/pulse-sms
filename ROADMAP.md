# Pulse — Roadmap

> Single source of truth for architecture principles, planned work, and completed phases.
> Last updated: 2026-03-16
> North star: **"Feel like a local."** See [Product Vision](docs/VISION.md) and [Architecture Review](docs/plans/2026-03-08-architecture-review-design.md).

---

## Architecture Principles

These principles govern how Pulse splits work between deterministic code and LLM tool calling. Developed from regression eval failures, reviewed across multiple models, updated when the agent brain became the sole architecture (2026-03-05).

### P1. Structured Tool Calls Own State, Free-Text Owns Language

Session state is derived from structured, validated sources — never parsed from free-text LLM output. The LLM's tool call parameters (`search` args) ARE the system of record for filters and intent. Picks are saved from pool order (top events shown to model), not fuzzy-matched from SMS text.

**In practice:** The agent brain calls `search({ neighborhood: "bushwick", filters: { categories: ["comedy"], free_only: true }, intent: "discover" })`. The handler reads these tool params to set `activeFilters` and `lastNeighborhood`.

**Anti-pattern:** Parsing the LLM's free-text SMS response to extract state. We tried reading `filters_used` from LLM output (2026-02-22) and reverted it.

### ~~P2. Separate Reasoning from Rendering~~ — Retired

Abandoned — the agent brain's tool calling handles structured output and natural language in one flow.

### P3. Extract at the Boundary, Then Trust Internal Types

Wherever the LLM produces structured data, validate and normalize it once at the ingestion boundary. After that, internal code trusts internal types.

### P4. One Save Path, Not Parallel Paths That Must Agree

Every code path that sends an SMS must end with `saveResponseFrame`. No exceptions.

### P5. Minimal LLM Output Contract

Fields the code already knows before calling the LLM should never be in the LLM's output schema. The model writes plain text SMS directly — no separate compose step.

### P6. Mechanical Shortcuts for $0 Operations, LLM for Everything Else

`checkMechanical` handles "help"/"?" and TCPA opt-out at $0. Everything else — including bare numbers, "more", greetings, compound filters — goes to the agent brain.

### P7. Validate the Contract, Not the Content

Validate structural contracts in the hot path (do pick IDs exist in the pool?). Let evals catch quality issues offline.

---

## Current Architecture

```
message -> checkMechanical (help + TCPA only, $0)
  -> handleAgentRequest (agent-loop.js)
  -> runAgentLoop (llm.js, multi-turn tool calling, max 3 iterations)
  -> model calls search or respond tools
  -> code executes tool, result fed back to model
  -> model writes plain text SMS when ready
  -> saveSessionFromToolCalls -> saveResponseFrame -> SMS
```

2 tools: `search` (unified — events, bars, restaurants, details, more, welcome) + `respond` (conversation). Pool items carry `recommended` and `why` fields so the model trusts pre-digested curation signals. Fallback chain: Gemini -> Anthropic Haiku.

Web app at `/app` — Gemini-style conversational interface using the same backend. SMS acquisition funnel.

---

## Planned Work

### Phase 8: Venue Knowledge (1 remaining item)

- [ ] Cache raw newsletter content in `.cache.json` alongside extracted events (enables re-extraction)

### Phase 9: Serendipity + Personalization (Code)

*The agent surprises you with something you didn't know you wanted, and gets smarter about you over time.*

**Story: The wild card pick**
> As a user asking for comedy in Bushwick, I want one of the picks to occasionally be something unexpected but great — a one-night-only interactive art show, a secret concert — that I never would have searched for.

- [ ] Implement `scoreSurprise(event, userProfile)` — category distance, neighborhood distance, source obscurity, format novelty
- [ ] Serendipity score = `quality * surprise` (quality from existing `scoreInterestingness`)
- [ ] Prompt the agent to include a serendipity pick when available, framed naturally: "Also tonight — this weird thing at..."
- [ ] Initially use global surprise signals (no user profile needed): discovery source + one-night-only + interactive = serendipitous for anyone

**Story: Pulse remembers me across sessions**
> As a returning user, I want Pulse to remember that I like jazz and Bushwick without me saying it every time.

- [x] Move preference data from `preference-profile.js` to SQLite `user_profiles` table (Mar 16)
- [x] Store: neighborhood frequency, category frequency, time/price preferences, session counts, proactive opt-in (Mar 16)
- [x] Inject `buildProfileSummary()` into `buildBrainSystemPrompt()` — agent sees lifetime patterns (Mar 16)
- [x] JSON→SQLite migration on first boot, `profiles.json` renamed to `.migrated` (Mar 16)
- [ ] Feed persistent profiles into `scoreSurprise()` for personalized serendipity

**Story: The agent adapts to how I decide**
> As a user who always picks fast, I want fewer options. As a user who asks lots of questions, I want more context.

- [ ] Track decision style signals: details-request rate, more-request rate, pivot rate, avg picks per session
- [ ] Inject decision style into system prompt: "this user picks fast — be decisive, lead with one strong pick" vs. "this user explores — give more context and contrasts"

### Phase 11: Data Layer Resilience (Infrastructure)

*The data has to be trustworthy for the tastemaker voice to be trustworthy.*

**Story: Non-events never reach users**

- [ ] Golden negative eval cases: add 15 worst junk examples as extraction eval negatives
- [ ] Yutori email filter audit: identify which newsletters produce the most junk, tighten `email-filter.js`

**Story: Events are fresh when users actually text**

- [ ] Add 4pm ET scrape refresh for HTML sources (catches same-day updates with minimal architecture change)
- [ ] Increase email polling frequency for newsletter sources to every 2 hours

**Story: SMS quality doesn't silently degrade**

- [ ] Runtime quality sampling: async LLM judge on 5% of production SMS
- [ ] 7-day rolling quality score with alert threshold (< 3.5/5.0)
- [ ] Track character count distribution, pick count distribution, venue-knowledge usage rate

**Story: Extraction pipeline hardens at the boundary**

- [ ] **Validate at source boundary, not post-merge**: move `computeCompleteness` + quality gate (0.4 threshold) into each source's fetch function return path. Currently validation happens in `refreshCache()` after all sources merge — a bad extraction can interact with dedup before getting filtered.
- [ ] **LLM junk filter for borderline events**: after `applyQualityGates` removes obvious junk, batch borderline events through a binary LLM classifier: "is this an actual attendable NYC event?"

### Phase 11b: Eval Hardening (Infrastructure)

*The eval system catches structural regressions well but is weakest at catching quality regressions and behavioral correctness for newer features. Current state: 6 layers, 447 golden cases, ~$1.20/full run, ~25 min. Scenario eval pass rate: 49.6%. Code eval pass rate: 100%.*

**P0 — Before next major feature**

**Story: Judges are validated against human labels**
> LLM judges run on every eval but have never been validated. Zero human-annotated traces exist. The 49.6% scenario pass rate could be misleading in either direction — judges may be too harsh or too lenient.

- [ ] Annotate 100 production traces using `/eval` UI (50 judge-pass, 50 judge-fail). 1-2 hours of trace review.
- [ ] Run `scripts/judge-alignment.js` to compute TPR/TNR against human annotations. Target: TPR > 80%, TNR > 90%.
- [ ] For 5 of 15 quality conversations, write reference "5/5" responses as few-shot calibration examples for the quality judge.
- [ ] Use fresh random traces (not fixture scenarios) as the test set — avoid train/test contamination.

**Story: Quality evals use binary pass/fail, not Likert**
> Quality eval scores 6 dimensions on 1-5 Likert (tone 4.0, curation 2.6, inference 2.3). These produce trends without decisions — is 2.6 acceptable? Is a drop to 2.4 a regression? No threshold exists.

- [x] Convert each quality dimension to binary pass/fail with explicit criteria (Mar 16)
- [x] Keep Likert scores as secondary signal; gate decisions on binary verdicts (Mar 16)
- [x] Define pass thresholds per dimension with clear PASS/FAIL rules in judge prompt (Mar 16)

**Story: Scenario judge is rewritten for current architecture**
> The scenario judge prompt (run-scenario-evals.js) references behaviors from the old 5-tool architecture. It patches this with "ignore old format" caveats rather than clean rules for the current 2-tool system. It's also holistic — one mega-prompt checks tone, filters, routing, and picks simultaneously.

- [x] Rewrite scenario judge prompt for current 2-tool architecture (search + respond). Removed all "ignore old format" caveats. (Mar 16)
- [x] Wire `judgeTone` and `judgePickRelevance` per-aspect judges into scenario eval runner (run with --judge). Filter persistence check is deterministic code eval. (Mar 16)
- [ ] Re-run error analysis on 100 recent traces (data/traces/2026-03-15 + 2026-03-16) to identify new failure modes post-architecture-change.

**Story: Profile personalization has eval coverage**
> As a developer shipping personalization features, I need evals that verify the agent actually uses profile data — not over-personalizing, not ignoring it.

- [x] Add 5 golden conversations with returning users (sessions 3+) to `quality-conversations.json` (Mar 16)
- [x] Add 5 scenario evals for profile injection: returning user greeting, neighborhood inference, avoid over-personalization, blank profile, category weighting (Mar 16)
- [x] Add `profile_context` code eval + trace enrichment: `profile_summary` captured in trace, validated by deterministic check (Mar 16)
- [x] Unit tests for profile_context: valid/null/short/missing field (Mar 16)

**Story: Filter persistence stops regressing**
> Filter drift is the #1 failure category at 49.6% scenario pass rate. Dedicated eval + fix loop needed.

- [x] Add 10 dedicated filter persistence scenarios: comedy/free/time/compound filter survival, explicit removal, category replacement (Mar 16)
- [x] Add code eval: `filter_state_preserved` — deterministic multi-turn check comparing brain_tool_calls filters across turns (Mar 16)
- [x] Add 5 regression scenarios with 16 assertions for filter persistence and explicit removal (Mar 16)
- [ ] Target: filter_drift category pass rate from 49% → 80%

**Story: Eval score regression is detected automatically**
> Reports exist as timestamped JSON but aren't compared. A 10% pass rate drop would go unnoticed.

- [x] Add `scripts/compare-eval-reports.js` — diffs latest report against previous, outputs delta table (Mar 16)
- [x] Add npm script: `npm run eval:diff` — runs compare, exits non-zero if pass rate drops >5% (Mar 16)
- [x] Track per-category pass rate and new failures/passes in comparison (Mar 16)

**P1 — This sprint**

**Story: Place search has eval coverage**
> Place/bar/restaurant searches are production features with zero behavioral evals.

- [x] Add 10 scenario evals: bar/restaurant queries, mixed events+bars, vibe filters, more/details for places, switch from bars to events (Mar 17)
- [ ] Add quality eval conversations for place recommendations (tone, usefulness)

**Story: Nudge flow has eval coverage**
> REMIND ME / NUDGE OFF is implemented but has zero scenario coverage.

- [x] Add 3 scenario evals: consent after detail, NUDGE OFF opt-out, REMIND ME consent (Mar 17)
- [x] Unit tests for `buildNudgeMessage` already exist (7 checks in nudges.test.js)
- [ ] Add 2 scenarios for nudge timing edge cases (event already started, no time data)

**Story: SMS rewrite loop is validated**
> `rewriteIfTooLong()` is the 480-char safety net but has no eval coverage.

- [ ] Add unit test: feed known 600-char SMS through rewriteIfTooLong, assert result <480 chars
- [ ] Add unit test: rewrite preserves event names and venue names from original
- [ ] Add code eval: track rewrite frequency in traces (how often does it fire?)

**Story: Cost regression is monitored**
> Per-trace AI cost is captured but not trended. A model switch could 10x costs silently.

- [x] Add avg cost/request to daily digest + email (Mar 17)
- [ ] Add alert if avg cost/request >2x 7-day rolling average
- [ ] Add `--cost-report` flag to eval runners that outputs cost breakdown by request type

**P2 — This month**

**Story: Fallback model quality is baselined**
> When Gemini fails, Haiku takes over — but we don't know if Haiku quality is acceptable.

- [ ] Run A/B eval: Gemini Flash vs Claude Haiku on 15 composition cases
- [ ] Establish minimum quality bar for fallback (tone ≥3.5, curation ≥2.5)
- [ ] Track fallback frequency in daily digest (currently logged but not aggregated)

**Story: Session expiry and edge cases have coverage**

- [ ] Add 5 scenarios: user returns after 2+ hours (expired session, profile persists)
- [ ] Add 3 scenarios: emoji-only messages, non-English input, extremely long messages
- [ ] Add 2 scenarios: rapid-fire messages (concurrent request handling)
- [ ] Add scenario: user asks about past events (should not hallucinate)

**Story: Source degradation evals**

- [ ] Add eval that simulates 50% source failure and measures response quality degradation
- [ ] Add eval for stale cache (>24hr old) — does the agent still produce useful responses?
- [ ] Track pool size per neighborhood in traces for sparse coverage detection

### Phase 10b: Prompt Architecture (Next)

*The agent brain's prompts were built iteratively as features shipped. They work, but they've drifted from how Anthropic and Google recommend structuring agent systems. This phase realigns with vendor best practices — not for theory, but because the current structure causes real bugs (e.g. "weird" query producing 2 results because vibe words become hard category filters via example pattern-matching).*

**Context:** Audited all prompts against Anthropic's agent guidance ("Building Effective Agents", "Writing Tools for Agents", "Effective Context Engineering") and Google's Gemini docs (function calling, system instructions, prompting strategies). Three structural issues identified; one already caused a production bug.

**Story: Remove few-shot examples from the agent brain**
> Anthropic: few-shot examples "often backfire in agentic systems" where the model needs to work autonomously in a loop. Google: examples cause overfitting in tool-calling; improve function descriptions instead.

The brain system prompt has 3 input→tool_call→SMS examples. The model anchors on these patterns instead of reasoning about novel inputs. "Surprise me with something weird" doesn't match any example, so the model force-fits it into the nearest pattern (maps "weird" to category filters, nuking the pool to 2 results).

- [ ] Remove all 3 few-shot examples from `buildBrainSystemPrompt()` in `brain-llm.js`
- [ ] Strengthen the RULES section to compensate — rules already cover tool selection logic, just need to be explicit enough to stand alone
- [ ] Enrich `BRAIN_TOOLS` descriptions (3-4 sentences each per Anthropic guidance) so tool definitions own routing without system prompt help
- [ ] Run quality evals before/after to measure impact. Expect: broader pools for vibe queries, no regression on direct queries
- [ ] *Already done:* Updated mood mapping rule to separate category-mapped moods from vibe queries (Mar 16)

**Story: Use native multi-turn history instead of text serialization**
> Anthropic: use native `tool_use`/`tool_result` message blocks. Google: Gemini is stateless and expects proper native message types. Both: text serialization means the model can't distinguish context from instructions.

The `historyBlock` in `buildBrainSystemPrompt()` serializes prior turns as `User: "...", Pulse: "...", > search(...)` text in the system prompt. This is lossy (truncated to 150 chars), burns system prompt tokens, and the model can't tell history from instructions.

- [ ] Pass conversation history as native message turns in the `messages` array (Anthropic) or `contents` array (Gemini) instead of text in the system prompt
- [ ] Remove `historyBlock` from `buildBrainSystemPrompt()`
- [ ] Update `runAgentLoop` in `llm.js` to accept and forward prior turns in the provider's native format
- [ ] Keep session context (current neighborhood, active filters, last picks) in the system prompt — that's state the model needs, not history
- [ ] Run scenario evals to verify multi-turn coherence (filter persistence, details references) improves or holds

**Story: Separate tool routing from SMS composition in the system prompt**
> Anthropic: use XML tags to organize by concern, progressive disclosure. Google: separation improves agentic performance ~5%. Both: don't mix "when to call tools" with "how to write the response."

The system prompt is a monolith mixing persona, tool routing rules, composition rules, and session context in one flat block. The model has to mentally parse which rules apply at which phase of the agent loop.

- [ ] Restructure `buildBrainSystemPrompt()` into clearly labeled sections (XML tags or markdown headers): `PERSONA`, `TOOL SELECTION`, `WRITING THE SMS`, `SESSION STATE`
- [ ] Move routing logic out of RULES and into `BRAIN_TOOLS` descriptions (tool defs own routing, system prompt owns persona + composition)
- [ ] Remove duplicated routing rules (e.g. `"2" or name = details` in RULES when the search tool's `intent: "details"` description already says this)
- [ ] Run quality evals before/after

**Sequencing:** Do these in order. Examples removal is the highest-impact fix (addresses a live bug, lowest effort). Native history is the biggest structural change (touches `llm.js` provider abstraction). Prompt restructure is cleanup that's easier after the other two land.

### Phase 12: Platform Expansion (Later)

*The intelligence layer serves more surfaces and more cities.*

- [x] Web companion: `/app` — Gemini-style conversational interface, SMS acquisition funnel (Mar 16)
- [ ] Multi-channel: WhatsApp, iMessage (same agent, different transport)
- [ ] Multi-city: only launch when 3+ editorial sources (weight >= 0.85) identified for the city. NYC → LA → Chicago.
- [ ] Paid tier: Stripe billing, $5-10/month for unlimited + proactive alerts
- [ ] Group planning: multi-user coordination via shareable pick list

**Not pursuing** (assessed, too costly for current scale):
- Formal DAG pipeline framework — `refreshCache()` already does fetch→merge→dedup→stamp sequentially in ~15s
- Embedding-based dedup — venue alias table solves name variance with 20 lines of code
- Unified extraction interface — deterministic and LLM extraction have different failure modes; hiding that loses clarity
- Strict TypeScript schema — `normalizeExtractedEvent` + `computeCompleteness` + 0.4 gate already function as runtime schema

---

## Source Coverage

### Current Sources (22 entries across 19 scraper modules)

| Source | Weight | Method | Strength |
|--------|--------|--------|----------|
| Skint | 0.9 | HTML -> Claude | Free/cheap curated picks |
| Skint Ongoing | 0.9 | HTML -> deterministic parser | Series events (exhibitions, festivals) |
| Nonsense NYC | 0.9 | Newsletter -> Claude | Underground/DIY/weird |
| Screen Slate | 0.9 | Newsletter -> Claude | Indie/repertory film |
| BK Mag | 0.9 | RSS + Cheerio HTML | Brooklyn weekend guide, curated |
| Luma | 0.9 | JSON API | Community, food, art, social (~330/week) |
| RA | 0.85 | GraphQL | Electronic/dance/nightlife |
| Dice | 0.8 | `__NEXT_DATA__` JSON (6 categories) | Ticketed shows, DJ sets, comedy, theater |
| BrooklynVegan | 0.8 | DoStuff JSON | Free shows, indie/rock |
| BAM | 0.8 | JSON API | Film, theater, music, dance |
| Yutori | 0.8 | Gmail + file briefings -> Claude | Curated newsletters |
| Sofar Sounds | 0.8 | Cheerio HTML (DoNYC venue page) | Secret concerts, 15+ neighborhoods |
| NYC Parks | 0.75 | Schema.org | Free parks/outdoor events |
| DoNYC | 0.75 | Cheerio HTML | Music, comedy, theater |
| Songkick | 0.75 | JSON-LD | Concerts/music |
| Tiny Cupboard | 0.75 | JSON-LD | Bushwick comedy, single-venue |
| Brooklyn Comedy Collective | 0.75 | Squarespace HTML | East Williamsburg comedy, 4 stages |
| NYC Trivia League | 0.75 | Cheerio HTML | Weekly trivia across 25+ venues, free |
| Eventbrite | 0.7 | JSON-LD / `__SERVER_DATA__` | Broad aggregator |
| NYPL | 0.7 | Eventbrite organizer | Free library events |
| EventbriteComedy | 0.7 | Eventbrite search pages | Comedy-specific |
| EventbriteArts | 0.7 | Eventbrite search pages | Art-specific |

**Inactive (scrapers preserved):** OhMyRockness, SmallsLIVE, Ticketmaster, Tavily.

### Source gaps to address

| Category | Current coverage | Gap |
|----------|-----------------|-----|
| Comedy | Good (10 sources, 330 events) | No dedicated scraper for Comedy Cellar, UCB, Caveat |
| Art/galleries | Moderate | No gallery opening calendar |
| Food/drink | Moderate (Luma only) | Single source for food events |
| Theater | Moderate (DoNYC, BAM, Dice) | No Broadway/off-Broadway (intentional — 70% tourist noise) |

---

## Open Issues

| Issue | Why deferred |
|-------|-------------|
| No processing ack during slow LLM calls | Adds extra Twilio cost |
| No structured logging or correlation IDs | Operational improvement for scale |
| Price data gap (21% unknown) | Structurally unavailable from some sources |

---

## Completed Work

| Phase | Date | Summary |
|-------|------|---------|
| Phase 1: Unified Agent Loop | Mar 5 | Deleted unified-flow, model-router, pre-router, skills (~1,300 lines). One code path. |
| Phase 2: Single-Turn Agent | Mar 5 | Merged routing + compose into single Gemini chat session. 99.2% code eval. |
| Phase 3: Conversation History | Mar 5 | Structured history: tool calls, params, picks. Agent sees own decisions. History cap 6→10. |
| Phase 4: Agent-Native Details/More | Mar 5 | Collapsed 3→2 tools. checkMechanical = help+TCPA only. Natural prose. ~310 lines removed. |
| Phase 5: True Agent Loop | Mar 7 | `runAgentLoop` + `handleAgentRequest`. Deleted ~1000 lines. Model writes plain text SMS. |
| Phase 6: Preference Learning (partial) | Mar 7 | User pick categories injected into agent context. Full profile injection planned (Phase 9). |
| Community Layer Phase 1 | Mar 2 | Recurrence detection: 485 active patterns, 790 events stamped. |
| Community Layer Phase 2 | Mar 3 | Venue size (200+ venues), interaction format, source vibe (4 tiers), editorial lean (51% discovery/niche). |
| Scrape Guard | Mar 5 | Baseline gates, post-scrape audit, yesterday's cache fallback. |
| Discovery Conversation | Mar 8 | Ask before recommending for vague requests. Vibe-first CTA. |
| Prompt Hygiene | Mar 7 | Dead prompts deleted, examples trimmed, curation taste shared constant. |
| Phase 7: Tastemaker Voice | Mar 8 | Metadata translation guide, contrasting picks, mood-to-category mapping, acknowledge-and-build, details structure. Prompt-only changes. |
| "Other" Category Reduction | Mar 9 | `remapOtherCategory` rules-based remap: 11 pattern groups. Reduced from 41% to 13.9%. |
| Editorial Note Preservation | Mar 9 | `editorial_note` field through normalization→serialization→details. All 4 LLM-extracted sources benefit. |
| Venue Learning Persistence | Mar 9 | `exportLearnedVenues`/`importLearnedVenues` wired to disk. 2500+ venues survive restarts. |
| Phase 8: Venue Knowledge | Mar 12 | 30 venue profiles (web-researched, human-reviewed). `venue_vibe` in pool, full profile in details. 99.9% code evals, 99.5% assertions (287 scenarios). |
| Phase 10: Proactive Outreach | Mar 13 | Post-scrape scoring, NOTIFY/STOP NOTIFY, opt-in CTA, 7-day cooldown, session seeding, engagement tracking. Default off. |
| Eval Golden Scenario Update | Mar 13 | Fixed `exists`/`contains_any` assertion types. Updated 14 stale text assertions for tastemaker voice. |
| Time-aware Filtering | Mar 13 | Grace window 2hr→30min for fixed-start shows. In-progress hints. `end_time_local` in pool serialization. |
| Recurrence Nudge | Mar 13 | Detail request = attended signal. Consent flow (REMIND ME / NUDGE OFF). Hourly scheduler, 7-day cooldown. `nudges.js`. |
| Scraper Failure Resilience | Mar 13 | Auto-disable after 7 failures, daily probe, graduated alerting (yellow/red emails). |
| Content-hash Extraction Cache | Mar 13 | `extraction-cache.js` hashes raw content via sha256. Saves ~$0.01/day on unchanged content. |
| Venue Alias Table | Mar 13 | 35 entries mapping variant names to canonical. Applied in normalization + dedup. |
| LLM Enrichment | Mar 13 | `enrichIncompleteEvents` + `classifyOtherEvents` in `enrichment.js`. Batched through Haiku at scrape time. |
| Classification Report | Mar 13 | `logClassification()` appends to `data/classification-log.json`. Human reads to promote patterns to regex. |
| Unified Agent Architecture | Mar 16 | 4-step refactor: (1) drop compose_sms, (2) unified `search` tool with parallel fan-out, (3) simplified session save with pool-order picks, (4) slim prompt with few-shot examples + `recommended`/`why` metadata. 2 tools instead of 5, ~250 lines reduced, ~47% cost reduction. |
| Web App Prototype | Mar 16 | `/app` — Gemini-style conversational interface. Same backend, SMS acquisition funnel. Sidebar, suggestion pills, inline event cards. |
| Profile Persistence + Brain Injection | Mar 16 | `user_profiles` SQLite table, `buildProfileSummary()`, profile injected into system prompt. JSON→SQLite migration (7698 profiles). |

---

## Not Building

- Yelp/Foursquare venue DB — Google Places covers venue metadata needs
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- Untargeted general web crawling — whitelist sources only
- Broadway/off-Broadway — 70% tourist noise, doesn't fit "feel like a local"
