# Pulse — Roadmap

> Single source of truth for architecture principles, planned work, and completed phases.
> Last updated: 2026-03-13
> North star: **"Feel like a local."** See [Product Vision](docs/VISION.md) and [Architecture Review](docs/plans/2026-03-08-architecture-review-design.md).

---

## Architecture Principles

These principles govern how Pulse splits work between deterministic code and LLM tool calling. Developed from regression eval failures, reviewed across multiple models, updated when the agent brain became the sole architecture (2026-03-05).

### P1. Structured Tool Calls Own State, Free-Text Owns Language

Session state is derived from structured, validated sources — never parsed from free-text LLM output. The LLM's tool call parameters (`search_events` args) ARE the system of record for filters and intent.

**In practice:** The agent brain calls `search_events({ neighborhood: "bushwick", categories: ["comedy"], free_only: true })`. The handler reads these tool params to set `activeFilters` and `lastNeighborhood`.

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
  -> model calls search_events or respond tools
  -> code executes tool, result fed back to model
  -> model writes plain text SMS when ready
  -> saveSessionFromToolCalls -> saveResponseFrame -> SMS
```

2 core tools: `search_events` (all event intents) + `respond` (conversation). Plus `compose_sms` (structured pick validation) and `show_welcome` (returning users). Fallback chain: Gemini -> Anthropic Haiku.

---

## Planned Work

### Phase 7: Tastemaker Voice (Prompt)

*The agent speaks like a local, not a search engine. Highest ROI work — prompt changes only, no code.*

**Story: The agent explains WHY, not just WHAT**
> As a user, when I get a pick, I want to know why it's interesting tonight — not just the name, venue, and time.

- [x] Add metadata translation guide to system prompt: teach agent to speak about `source_vibe`, `venue_size`, `scarcity`, `editorial`, `interaction_format` in natural language
  - `source_vibe "discovery"` → "this popped up on the underground radar"
  - `venue_size "intimate"` → "tiny room, maybe 50 people, right up front"
  - `scarcity "one-night-only"` → "one-off, not coming back"
  - `editorial: true` → "a tastemaker picked this one out"
  - `interaction_format "interactive"` → "you're not just watching, you're in it"
- [x] Rewrite system prompt examples from list-style to contrasting-picks style
- [x] Run scenario evals before/after to measure voice quality change
- [x] Update eval golden scenarios to reflect new conversation style (fixed `exists`/`contains_any` assertion types in runner, updated 14 stale text assertions)

**Story: Narrow by showing, not asking**
> As a user, when I text a bare neighborhood, I want the agent to show me two contrasting options instead of asking me a generic vibe question.

- [x] Replace "ask one vibe question" prompt guidance with "narrow by contrasting picks"
- [x] Add mood-to-category mapping guidance: teach agent that "chill" means intimate venues + jazz/vinyl/film, "I want to dance" means dj/nightlife + medium-large venues
- [x] Add "acknowledge and build" pattern: every response references what the user just said

**Story: Details that build trust**
> As a user, when I ask for details about a pick, I want the response to lead with what the venue feels like, not just event metadata.

- [x] Add details structure to system prompt: venue experience → event → logistics → practical tip
- [x] ~~Evaluate whether `composeDetails` in `ai.js` can be consolidated into the agent loop~~ — Deleted. `composeDetails` was dead code (nothing called it). Agent loop handles details natively via `search_events({intent: "details"})`. Removed `composeDetails`, `DETAILS_SYSTEM`, and `MODELS.details`.

### Phase 8: Venue Knowledge Layer (Data + Code)

*Give the agent actual local knowledge about venues — the data that makes "feel like a local" possible.*

**Story: The agent knows what venues feel like**
> As a user, when I get a pick at Union Pool, I want to hear "sweaty dive bar, loud bands, cheap beer, gets packed by 9" — not just "Union Pool, Williamsburg."

- [x] Venue profiles in `data/venue-profiles.json`, lookup via `lookupVenueProfile()` in `venues.js` (30 venues, web-researched, human-reviewed)
- [x] `venue_vibe` one-liner wired into pool serialization (`serializePoolForContinuation`)
- [x] Full venue profile (known_for, crowd, tip) wired into details intent (`agent-loop.js`)
- [x] System prompt updated with `venue_vibe` and `venue_profile` guidance
- [x] Run scenario evals to verify agent uses venue knowledge naturally (99.9% code evals, 99.5% assertions across 287 scenarios)

**Story: Yutori's editorial voice comes through**
> As a user, when I get a pick that came from Yutori's newsletter, I want the agent to reference the editorial context — "Yutori called this the best kept secret in Bushwick" — not just a generic description.

- [x] Preserve source editorial blurbs through extraction as `editorial_note` field
- [x] Pass `editorial_note` to agent in pool serialization
- [ ] Cache raw newsletter content in `.cache.json` alongside extracted events (enables re-extraction)

**Story: Events in the "other" bucket become findable**
> As a user looking for "art" or "something weird," I want events currently categorized as "other" to be properly classified so they show up in category searches.

- [x] Audit "other" category events — identify common reclassifiable types (immersive theater, sound baths, zine fairs, popup markets)
- [x] Add rules-based category remapping at cache build time (`remapOtherCategory` in events.js)
- [x] Measure: reduce "other" bucket from 41% to <20% (achieved 13.9%)

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

### Phase 10: Proactive Outreach (Product) ✓

*Pulse texts you when something matches — the retention mechanism that makes SMS the right channel.*

**Story: "There's a thing tonight you'd love"**
> As an opted-in user, I want Pulse to text me once a week when there's a high-match event for my taste, without me having to initiate.

- [x] Proactive message scheduler: post-scrape hook scans opted-in users, scores events (neighborhood+category+interestingness+scarcity+editorial), threshold 5
- [x] Conservative cadence: 7-day cooldown per user, 30-day churn filter
- [x] Track per-user engagement via event_recommendations table (user_engaged flag)
- [x] Kill switch: PULSE_PROACTIVE_ENABLED env var (default false), /api/proactive/pause and /resume endpoints, in-memory pause flag
- [x] TCPA compliance: NOTIFY opt-in, STOP NOTIFY opt-out (mechanical, before TCPA STOP check), opt-in CTA on session 1 and 3 (max 2 prompts)
- [x] Session seeding: proactive SMS seeds session via saveResponseFrame for seamless reply handling

**Story: Recurrence nudge** ✓
> As a user who went to trivia at Black Rabbit twice, I want Pulse to text me on Tuesday afternoon: "Black Rabbit has trivia again tonight. Want the details?"

- [x] Cross-reference recurring patterns DB with user attendance history (detail request = attended signal)
- [x] Trigger: user attended same recurring event 2+ times → consent prompt ("REMIND ME")
- [x] Day/time: hourly scheduler sends nudge on matching day_of_week with 7-day cooldown
- [x] Consent flow: REMIND ME opt-in, NUDGE OFF global opt-out, TCPA STOP clears all subs
- [x] `nudges.js`: `trackRecurringDetail`, `captureConsent`, `buildNudgeMessage`, `checkAndSendNudges`
- [x] Gated behind `PULSE_NUDGES_ENABLED` env var (default off)

### Phase 11: Data Layer Resilience (Infrastructure)

*The data has to be trustworthy for the tastemaker voice to be trustworthy.*

**Story: Scraper failures degrade gracefully**
> As a system, when a source's markup changes, I want to detect partial degradation (not just total failure) and alert before coverage materially drops.

- [x] Source health scoring: rolling 7-day health per source (event count trend, extraction confidence avg, consecutive failures)
- [x] Auto-disable after 7 consecutive failures (with daily probe for auto-recovery)
- [x] Graduated alerting: yellow at 20% drop, red at 50% drop
- [x] Complete scrape resilience plan: volatile baseline (median not mean) for Yutori/NonsenseNYC, duplicate spike tolerance for multi-show venues

**Story: Events are fresh when users actually text**
> As a user texting at 8pm, I want today's data to include events posted after the 10am scrape — day-of announcements, cancellations, sold-out status.

- [ ] Add 4pm ET scrape refresh for HTML sources (catches same-day updates with minimal architecture change)
- [ ] Increase email polling frequency for newsletter sources to every 2 hours

**Story: SMS quality doesn't silently degrade**
> As a system, when a model update changes SMS composition behavior, I want to detect it before users notice.

- [ ] Runtime quality sampling: async LLM judge on 5% of production SMS
- [ ] 7-day rolling quality score with alert threshold (< 3.5/5.0)
- [ ] Track character count distribution, pick count distribution, venue-knowledge usage rate

**Story: Venue learning persists**
> As a system, when I geocode a new venue, I want to remember it permanently instead of losing it on restart.

- [x] Wire `exportLearnedVenues()` to write to disk at end of scrape (already implemented)
- [x] Wire `importLearnedVenues()` on startup to warm the cache (already implemented)

### Phase 12: Platform Expansion (Later)

*The intelligence layer serves more surfaces and more cities.*

- [ ] Web companion: browsable event page for longer sessions (SMS for discovery, web for depth)
- [ ] Multi-channel: WhatsApp, iMessage (same agent, different transport)
- [ ] Multi-city: only launch when 3+ editorial sources (weight >= 0.85) identified for the city. NYC → LA → Chicago.
- [ ] Paid tier: Stripe billing, $5-10/month for unlimited + proactive alerts
- [ ] Group planning: multi-user coordination via shareable pick list

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
| Prompt Hygiene | Mar 7 | Dead prompts deleted, examples trimmed, curation taste shared constant. 4 of 6 action items done. |
| Phase 7: Tastemaker Voice | Mar 8 | Metadata translation guide, contrasting picks, mood-to-category mapping, acknowledge-and-build, details structure. Prompt-only changes. |
| "Other" Category Reduction | Mar 9 | `remapOtherCategory` rules-based remap: 11 pattern groups (sound bath→community, film→film, vinyl night→nightlife, etc.). Runs post-stamp in cache build. |
| Editorial Note Preservation | Mar 9 | `editorial_note` field added to extraction prompt, carried through normalization→serialization→details. All 4 LLM-extracted sources benefit. |
| Venue Learning Persistence | Mar 9 | Already implemented: `exportLearnedVenues`/`importLearnedVenues` wired to disk. 2500+ venues survive restarts. |
| Phase 8: Venue Knowledge | Mar 12 | 30 venue profiles in `data/venue-profiles.json` (web-researched, human-reviewed). `venue_vibe` in pool serialization, full profile in details intent, prompt guidance added. Scenario evals: 99.9% code evals, 99.5% assertions (287 scenarios). |
| Phase 10: Proactive Outreach | Mar 13 | Post-scrape hook scores events against user profiles (neighborhood+category+interestingness+scarcity+editorial). NOTIFY/STOP NOTIFY keywords, opt-in CTA on sessions 1+3, 7-day cooldown, 30-day churn filter, session seeding for replies, engagement tracking, pause/resume endpoints. Default off (PULSE_PROACTIVE_ENABLED). |
| Phase 7+8: Eval golden scenario update | Mar 13 | Fixed `exists`/`contains_any` assertion types in eval runner (were silently failing). Updated 14 stale text assertions for new tastemaker voice. |
| Time-aware filtering | Mar 13 | Tightened `filterUpcomingEvents` grace window from 2hr to 30min for events without `end_time_local` (fixed-start shows). Events with end times still shown while ongoing. Added prompt hint for in-progress events ("started at 7 but goes til midnight") and wired `end_time_local` into pool serialization. |
| Phase 10: Recurrence Nudge | Mar 13 | Detail request = attended signal. 2nd detail → consent prompt ("REMIND ME"). Hourly scheduler sends nudge on matching day with 7-day cooldown. NUDGE OFF global opt-out, TCPA STOP clears all subs. `nudges.js` module, `nudge_subscriptions` SQLite table. Gated behind `PULSE_NUDGES_ENABLED`. |
| Phase 11 Story 1: Scraper Failure Resilience | Mar 13 | Auto-disable after 7 consecutive failures with daily probe for auto-recovery. Graduated alerting (yellow/red severity emails) replaces flat digest emails for non-green status. Disabled sources flagged in digest. Dead `alertOnFailingSources` removed. |

### Prompt Hygiene — Open Items

| # | Action | Risk | Effort |
|---|--------|------|--------|
| ~~5~~ | ~~Move filter_intent to deterministic code~~ — Won't do. Intent drives filter merge/replace logic (`new_search`/`pivot` = replace, `refine` = merge). This is a semantic decision that depends on conversational context, not derivable from params alone. Already a structured tool param (P1-safe). | — | — |
| ~~6~~ | ~~Add deterministic post-processing for price/day labels~~ — Already done. `dayLabel` computed deterministically in `serializePoolForContinuation`. Price passed as structured `is_free` + `price_display`. | — | — |

---

## Open Issues

| Issue | Why deferred |
|-------|-------------|
| No processing ack during slow LLM calls | Adds extra Twilio cost |
| No structured logging or correlation IDs | Operational improvement for scale |
| Price data gap (21% unknown) | Structurally unavailable from some sources |

---

## Not Building

- Yelp/Foursquare venue DB — Google Places covers venue metadata needs
- X/Twitter — expensive API, poor geo, ToS risk
- Time Out NY — aggressive anti-bot, DoNYC covers similar
- Untargeted general web crawling — whitelist sources only
- Broadway/off-Broadway — 70% tourist noise, doesn't fit "feel like a local"
