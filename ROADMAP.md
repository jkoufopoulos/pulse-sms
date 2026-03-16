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

- [ ] Move preference data from ephemeral `preference-profile.js` to SQLite (keyed by hashed phone)
- [ ] Store: neighborhood frequency, category frequency, time preferences, venue preferences, engagement rates
- [ ] Inject persistent profile into `buildBrainSystemPrompt()` — agent sees lifetime patterns, not just last 2 hours
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

---

## Not Building

- Yelp/Foursquare venue DB — Google Places covers venue metadata needs
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- Untargeted general web crawling — whitelist sources only
- Broadway/off-Broadway — 70% tourist noise, doesn't fit "feel like a local"
