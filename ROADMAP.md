# Pulse -- Roadmap

> Single source of truth for architecture principles, evolution strategy, open issues, and planned work.
> Last updated: 2026-03-05 (Phase 1 complete: agent brain is the sole path)

---

## Architecture Principles

These principles govern how Pulse splits work between deterministic code and LLM tool calling. They were developed from regression eval failures, reviewed across multiple models, and updated when the agent brain became the sole architecture (2026-03-05).

### P1. Structured Tool Calls Own State, Free-Text Owns Language

Session state is derived from structured, validated sources -- never parsed from free-text LLM output. The LLM's tool call parameters (`search_events` args: neighborhood, categories, time_filter, date_range, free_only, intent) ARE the system of record for filters and intent. Tool params are machine-readable, schema-validated, and deterministic -- safe state sources. The LLM's free-text SMS output is for the user, not for the system.

**In practice:** The agent brain calls `search_events({ neighborhood: "bushwick", categories: ["comedy"], free_only: true })`. The handler reads these tool params to set `activeFilters` and `lastNeighborhood`.

**Anti-pattern:** Parsing the LLM's free-text SMS response (or any unstructured output field) to extract state like filters or neighborhood. We tried reading `filters_used` from LLM output (2026-02-22) and reverted it because it made the LLM a secondary source of truth for state.

### ~~P2. Separate Reasoning from Rendering~~ -- **Retired**

Originally proposed splitting LLM calls into a reasoning pass and a rendering pass. Abandoned -- the agent brain's tool calling architecture handles structured output and natural language in one flow. Dead code cleaned up.

### P3. Extract at the Boundary, Then Trust Internal Types

Wherever the LLM produces structured data, validate and normalize it once at the ingestion boundary. After that boundary, internal code trusts internal types. Don't normalize some LLM fields and trust others -- inconsistent validation is worse than none.

**In practice:** `normalizeFilters()` maps subcategories to canonical values (jazz->live_music) at the boundary. This applies uniformly to every structured field from tool call params.

### P4. One Save Path, Not Parallel Paths That Must Agree

Every code path that sends an SMS must end with the same atomic session save function. No hand-built `setSession` merges, no conditional field sets, no paths that "forget" to save filters.

**Current state:** All SMS-sending paths end with `saveResponseFrame`. No exceptions.

### P5. Minimal LLM Output Contract

Every structured field in the LLM output is a surface for hallucination and drift. Fields the code already knows before calling the LLM should never be in the LLM's output schema.

**Current:** The agent brain uses 3 tools (`search_events`, `get_details`, `respond`) with validated parameter schemas. Free-text SMS composition is separate via `brainCompose`.

### P6. Mechanical Shortcuts for $0 Operations, LLM for Everything Else

Use deterministic code only for operations that don't need language understanding and can be handled at $0. Everything else -- including compound filters, semantic intent, and ambiguous language -- goes to the agent brain's tool calling.

**$0 mechanical (checkMechanical):** Bare numbers 1-5 (details), "more" (next batch), "help" (canned response), greetings/thanks/bye. These are pattern-matched and never hit the LLM.

**Agent brain handles natively:** "free comedy in bushwick", "later in the week", "how about something lowkey", "trivia or art stuff in greenpoint". The LLM expresses intent through structured tool params.

### P7. Validate the Contract, Not the Content

Validate structural contracts in the hot path (do `picks[].event_id` values exist in the pool?). Let evals catch quality issues offline.

**Done (2026-02-22):** Event ID validation added -- `validPicks` filters against `eventMap` before session save.

---

## Current Architecture

```
message -> checkMechanical ($0 shortcuts: 1-5, more, help, greetings)
  -> callAgentBrain (Gemini 2.5 Flash Lite tool calling)
  -> tool execution (search_events / get_details / respond)
  -> brainCompose (lightweight SMS composition)
  -> atomic save (saveResponseFrame) -> SMS
```

Fallback: Anthropic Haiku activates within the same agent loop on Gemini failure.

**Key decision (2026-03-05):** Phase 1 complete. Deleted unified-flow.js, model-router.js, pre-router.js, and src/skills/ (~1,300 lines). The agent brain is the only code path. Tool call params are the system of record for state.

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

### Category Gaps

| Category | Coverage | Gap |
|----------|----------|-----|
| Electronic/dance | Strong (RA, Dice) | -- |
| Indie/rock/punk | Good (Songkick, BrooklynVegan, Dice, Sofar) | -- |
| Comedy | Good (TinyCupboard, BrooklynCC, EventbriteComedy, DoNYC, Dice) | 330 events from 10 sources |
| Trivia | Good (NYC Trivia League, Yutori) | ~165 events/week |
| Art/galleries | Moderate (EventbriteArts, Skint, Luma) | No gallery opening calendar |
| Theater | Moderate (DoNYC, BAM, Dice) | No Broadway/off-Broadway source |
| Community/social | Good (Luma, NYC Parks, Eventbrite, NYCTrivia) | -- |
| Food/drink | Moderate (Luma) | Single source for food events |
| Underground/DIY | Good (Nonsense NYC, Sofar Sounds, BKMag) | -- |
| Jazz | Moderate (Skint, DoNYC) | -- |
| Film | Good (Screen Slate, BAM, Skint Ongoing) | -- |

---

## Feature Roadmap

### Agent-Native Evolution (Priority -- 5 phases)

**North star:** Pulse is a single agent loop that works with any tool-calling model, owns the full conversation, and builds a relationship with each user over time.

**Phase 1: Unified Agent Loop** -- **Done (2026-03-05)**

Deleted unified-flow.js, model-router.js, pre-router.js, src/skills/. One code path: `callAgentBrain` with Gemini -> Claude fallback. `checkMechanical` extracted to agent-brain.js.

**Phase 2: Single-Turn Agent** -- Merge routing + compose into one generation

Merge `callAgentBrain` and `brainCompose` into a single agent turn. The agent calls `search_events`, sees results inline, and writes the SMS in the same generation.

- `search_events` tool returns event pool as tool result; agent continues generating -> writes SMS directly
- Delete `brainCompose` -- the agent IS the composer
- `respond` tool simplified or removed -- agent writes conversational SMS directly
- Pool serialization: ~50-100 tokens/event x 15 events = ~1500 tokens. Fits in context.
- Cost: ~$0.0008/call (up from ~$0.0005). Worth it for coherence.
- Eval: A/B eval -- single-turn vs two-call. Measure editorial quality, filter compliance, 480-char compliance.

**Phase 3: Conversation History as State** -- Reduce session to accumulators

Feed the agent its own tool call history so it can derive context without explicit session fields.

- Conversation history includes tool calls + tool results (not just user/assistant text)
- Remove from session: `lastNeighborhood`, `lastFilters`, `lastBorough`, `pendingNearby`, `pendingFilters`, `pendingMessage` -- all derivable from tool call history
- Keep in session: `lastPicks`, `lastEvents` (event map cache), `allPicks`/`allOfferedIds` (dedup accumulators), `visitedHoods`, `lastResponseHadPicks`
- Session: 12 fields -> 7 fields
- Risk: agent may "forget" context if history truncated (currently 6 turns). May need 8-10 turns.

**Phase 4: Agent-Native Details and More** -- Move mechanical handlers into the agent

- Remove `checkMechanical` for numbers and "more" -- agent handles them as tool calls
- `get_details` enhanced: agent can reference by number, name, or description ("that comedy one")
- Keep `checkMechanical` only for: "help" (canned, $0), STOP/opt-out (TCPA compliance)
- Cost: ~$0.0005 per detail/more request (currently $0). Negligible at current volume.

**Phase 5: Preference Learning in the Loop** -- The agent knows you

- `preference-profile.js` data injected into agent system prompt
- Agent adapts: discovery-heavy for explorers, community-focused for new-to-city users
- Cross-session memory: "you went to trivia at Black Rabbit twice -- they have one tonight"

### Community Layer

**Phase 1: Recurrence detection** -- **Done (2026-03-02).** 485 active patterns, 790 events stamped `is_recurring`. LLM says "every Tues!" naturally.

**Phase 2: Venue size + interaction format + source vibe + editorial voice** -- **Done (2026-03-03).** VENUE_SIZE map (200+ venues), `classifyInteractionFormat()` (keyword-specific), SOURCE_VIBE (4 tiers: discovery/niche/platform/mainstream), editorial lean in prompts + deterministic sort tiebreaker. 51% picks from discovery/niche sources (up from 28%).

**Phase 3: Proactive persona capture** -- Planned. Detect community-seeking intent ("new here", "solo tonight"), amplify editorial lean, frame picks for joinability.

### Source + Quality

- Comedy source -- Dedicated scraper for Comedy Cellar, UCB, Caveat
- Gallery/art source -- Gallery listing aggregator
- Happy hour detection -- Surface as filterable category
- Self-healing scraper pipeline -- Auto-detect failures, retry, alert on structural breakage
- Web discovery crawlers -- Targeted searches for niche events beyond whitelisted sources

### Infrastructure + Product

- PostgreSQL -- Persistent event storage, user sessions, conversation history
- Profile-based event ranking -- Re-rank tagged pool using user profile signals
- Proactive user alerts -- Unsolicited texts for high-match events (opt-in, frequency caps)
- SMS map sharing -- Shareable map of picked event locations
- Group planning / voting -- Multi-user coordination via shareable pick list
- Paid tier -- Stripe billing, $5-10/month
- Multi-city -- Same architecture, different sources

---

## Open Issues

### Deferred (post-MVP)

| Issue | Why deferred |
|-------|-------------|
| No processing ack during slow LLM calls | Adds extra Twilio cost |
| No horizontal scalability | Single-process fine at current traffic |
| No structured logging or correlation IDs | Operational improvement for scale |

---

## Tech Debt

| Item | Risk | Notes |
|------|------|-------|
| Price data gap (21% unknown) | Low | Structurally unavailable from some sources |
| No horizontal scalability | Low | Single-process, in-memory sessions |
| Preference learning not yet active | Low | Profiles captured but not injected into prompts -- Phase 5 |

---

## Completed Work (Summary)

| Period | Highlights |
|--------|-----------|
| Mar 5 | Phase 1: unified agent loop (deleted unified-flow, pre-router, model-router, skills). First-message welcome flow. Quality eval runner + browse page. |
| Mar 3 | Eval suite audit (34 new scenarios, 417 total). Community layer Phase 2 (editorial voice, source vibe, venue size, interaction format). Skint multi-day parsing. Description coverage for Luma/Songkick/DoNYC. |
| Mar 2 | Agent brain (`agent-brain.js`) with 99.9% code eval. Cross-source recurrence detection (485 patterns). Gemini Flash fallback chain. Broad query support (citywide + date range). New sources: Tiny Cupboard, Brooklyn Comedy Collective, NYC Trivia League, BK Mag, Sofar Sounds. EventbriteComedy fix (0 -> 55 events). |
| Mar 1 | Prompt audit (tool_use, tone reduction, shared sections). Structural filter drift fix (Step 2b). Degraded-mode fallback. Code eval accuracy overhaul (99.8%). Fragility audit (16 issues fixed). New sources: Luma, Screen Slate, Skint Ongoing. Dice multi-category. Scrape audit dashboards. Price coverage 27% -> 79%. Neighborhood resolution gap 171 -> 80. SQLite event store. 286 golden scenarios. |
| Feb 21-28 | Unified LLM + tagged pool. Atomic session frames. Compound pre-router. Three-tier soft match. Deterministic state derivation (8->4 LLM fields). Gemini Flash switch. Session persistence. Referral cards. User preference profiles. |

---

## Not Building

- Yelp/Foursquare venue DB -- Google Places covers venue metadata needs
- X/Twitter -- expensive API, poor geo, ToS risk
- Time Out NY -- aggressive anti-bot, DoNYC covers similar
- Untargeted general web crawling -- whitelist sources only
- Real-time scraping -- SMS users don't need sub-daily freshness
