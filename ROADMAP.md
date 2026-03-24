# Pulse — Roadmap

> Single source of truth for what we're testing and why.
> Last updated: 2026-03-18

---

## The Hypothesis

**A curated AI agent that surfaces 2-3 picks with genuine editorial context — why *this* event, why *tonight*, among everything you could be doing — is a fundamentally better way to find things to do than researching across fragmented apps and newsletters.**

The value isn't "here's what's happening." It's "out of everything, *this* is the one worth leaving your apartment for — and here's why."

### Assumptions

1. **The model won't hallucinate.** One invented DJ set or fake pop-up destroys trust permanently.
2. **The source material has the "why."** The agent can only surface editorial context that exists in the data — a rare guest, a one-night opening, a chef who never cooks in Brooklyn. Generic listings (title + time + venue) can't clear this bar.
3. **The target user's problem is discovery friction, not information scarcity.** 30-somethings in NYC subscribe to the right newsletters but don't do the work of reading them and synthesizing across sources. The barrier is effort, not access.

### What needs to be true to test it

1. **Pick quality is high** — Recommendations feel like they came from a friend who actually read the newsletters. The "why this, why now" context is the differentiator.
2. **Zero hallucination** — Every fact in every recommendation traces back to source material.
3. **Source material is rich** — We need 3-5 great editorial sources, not 22 scrapers. Quality of input > quantity.
4. **The voice is human and opinionated** — Not a listing service. "This is a rare one" / "Skip unless you're into deep house." Editorial confidence is the product.
5. **The experience is clean** — No weird edge cases, broken flows, or confusing responses. Small polished surface > big buggy one.

---

## Ship plan — 2 weeks (target: April 1)

### Week 1: Make the data and voice good enough

#### 1. Fix the editorial context pipeline (Day 1) — THE CRITICAL PATH

Audit done (Mar 18). The editorial context exists in our source data but the model never sees it.

**Source health:**
| Source | Events | Status | Problem |
|--------|--------|--------|---------|
| Yutori | 512 | Working | `editorial_note` always empty, `editorial_signal` not in extraction schema |
| Luma | 408 | Working | No editorial metadata at all (API scraper) |
| Skint | 56 | Working | `editorial_note` always empty despite prompt asking for it |
| BKMag | 5 | Working | Only publishes Fri/Sat weekend guides |
| NonsenseNYC | **0** | **Broken** | Gmail timeout → fallback cache → past-date confidence=0.1 → filtered out |
| ScreenSlate | **1** | **Broken** | LLM doesn't extract neighborhoods for film venues → quality gate kills 8/9 events |

**The core problem:** `description_short` has the editorial context ("World premiere... Rare opportunity to see an undisclosed documentary with expert discussion") but `serializePoolForContinuation` truncates `short_detail` to 60 chars. The model sees: "World premiere of one of True/False Film Festival's 2026 sel". 50% of description text is thrown away.

**Fixes (in priority order):**
- [x] Expand `short_detail` from 60 → 200 chars in serializer (brain-llm.js:270) — model now sees full editorial context (Mar 18)
- [ ] Fix NonsenseNYC: Gmail timeout on Railway. Newsletter is email-only (no web archive). Need to debug Gmail creds/timeout on Railway, or find alternative fetch path.
- [x] Fix ScreenSlate: added 16 museum/gallery venues to VENUE_MAP (Whitney, MoMA, RYAN LEE, Storefront for Art, etc.) — backfill now resolves neighborhoods (Mar 18)
- [x] Add `editorial_signal` + `editorial_note` to `YUTORI_EXTRACTION_PROMPT` schema (Mar 18)
- [ ] Decide on Luma: keep for volume (408 events) or cut as non-editorial? Social proof ("91 going") has value but no editorial "why"

#### 2. ~~Harden the hallucination guardrail (Day 2)~~ DONE (Mar 19)

Data contract in system prompt: explicit list of trusted fields (`short_detail`, `why`, `venue_profile`), anti-fabrication rule, `lookup_venue` tool as escape hatch. Tested with bare-data events — model leads with facts, doesn't embellish.

#### 3. ~~Rewrite the system prompt for voice (Day 3-4)~~ DONE (Mar 19)

Ground-up prompt rewrite: 5 sections (identity, data contract, composition, examples, name guidance). "Nightlife editor who texts" replaces "bot that texts like a friend." 3 example outputs at different data richness levels. Removed dead references (serendipity, proactive CTA, places mixing). Added `lookup_venue` tool (Google Places API) for venue research on details requests.

### Week 2: Polish the experience and ship

#### 5. End-to-end experience audit (Day 5-6)

Text every flow through the simulator and document every weird moment:
- [ ] First text (no session) — is the greeting good?
- [ ] Neighborhood search ("bushwick", "les", "prospect park")
- [ ] Vibe search ("something weird", "chill", "dance")
- [ ] Category search ("comedy", "jazz tonight")
- [ ] Details (reply "1", reply by name)
- [ ] More picks ("more", "what else")
- [ ] Filter follow-up ("how about comedy", "free stuff", "later tonight")
- [ ] Filter removal ("forget the comedy", "any price")
- [ ] Neighborhood switch ("try williamsburg")
- [ ] Greeting mid-session ("thanks", "cool", "bye")
- [ ] Edge: empty neighborhood (no events match)
- [ ] Edge: very broad request ("what's happening tonight")
- [ ] Edge: nonsense input ("asdfghjkl")

For each: is the response good? Does it sound like a friend? Is the "why" present? Any bugs?

#### 6. Fix what the audit finds (Day 6-8)

Unknown scope — depends on what breaks. Budget 3 days.

#### 7. Test with 5-10 real users (Day 8-12)

Give the number to 5-10 friends who fit the target profile (30-something, lives in NYC, goes out but doesn't do the research). Watch what they text, what they respond to, where they drop off. No surveys — observe behavior.

**What we're looking for:**
- Do they text back after the first response? (engagement)
- Do they ask for details? (pick quality was high enough to be curious)
- Do they actually go? (the ultimate signal — hard to measure in 2 weeks)
- Where do they get confused or frustrated? (experience gaps)

#### 8. Ship decision (Day 12-14)

Based on user behavior, decide:
- **Hypothesis confirmed:** Users engage, ask for details, express delight. Invest more.
- **Hypothesis unclear:** Users engage but don't come back. Need more data / longer test.
- **Hypothesis dead:** Users don't engage past first text, or responses feel generic despite editorial sources. Pivot or kill.

---

## Done (this sprint)

| What | Date | Summary |
|------|------|---------|
| Cut to editorial sources | Mar 18 | 22 → 7 sources (Skint x2, NonsenseNYC, Yutori, ScreenSlate, BKMag, Luma). All listing scrapers disabled. |
| Delete non-core features | Mar 18 | Removed: nudges, referral, proactive outreach, preference learning, enrichment, web app, alerts, daily digest. No-op stubs for source-health and alerts. |
| Anthropic-only | Mar 18 | All model roles default to claude-haiku-4-5-20251001. No Gemini in any path. |
| Dashboard cleanup | Mar 18 | Removed: digests, eval-quality, evals-landing dashboards. Kept: simulator, health, eval browser, events, eval reports. |
| Prompt rewrite + lookup_venue | Mar 19 | Editorial voice, data contract, anti-fabrication rule, 3 example outputs. `lookup_venue` tool for Google Places research on details requests. Removed dead serendipity/proactive code. |

---

## Architecture Principles

### P1. Structured Tool Calls Own State, Free-Text Owns Language
Session state from tool call params, never parsed from LLM free-text.

### P3. Extract at the Boundary, Then Trust Internal Types
Validate once at ingestion. Internal code trusts internal types.

### P4. One Save Path
Every SMS path ends with `saveResponseFrame`.

### P5. Minimal LLM Output Contract
Model writes plain text SMS. No separate compose step.

### P6. Mechanical Shortcuts for $0 Operations
`checkMechanical` handles help + TCPA only. Everything else → agent brain.

### P7. Validate the Contract, Not the Content
Structural validation in hot path. Quality via evals.

---

## Current Architecture

```
message -> checkMechanical (help + TCPA only, $0)
  -> handleAgentRequest (agent-loop.js)
  -> runAgentLoop (llm.js, multi-turn tool calling, max 3 iterations)
  -> model calls search, respond, or lookup_venue tools
  -> code executes tool, result fed back to model
  -> model writes plain text SMS when ready
  -> saveSessionFromToolCalls -> saveResponseFrame -> SMS
```

3 tools: `search` + `respond` + `lookup_venue`. All Anthropic (Claude Haiku). 7 editorial sources scraped daily at 10am ET.

---

## Open Issues

### FIXED: Scraper crashes on every run — stale cache for 5 days (discovered 2026-03-24)

**Root cause:** `source-health.js` was stubbed out (no-op) during hypothesis focus, but `scrape-guard.js` still assumed real health data. The Proxy in the stub auto-creates empty objects `{}`, so `sourceHealth[label]` is truthy but has no `.history` array. `getBaselineStats` accessed `health.history.length` on `undefined` → crash on every scrape and email poll.

**Fix:** Stubbed `scrape-guard.js` to match `source-health.js` — both are now no-ops. Added 30-min heartbeat in `server.js` that triggers a scrape if cache goes stale, so this class of failure self-heals.

**Regression principle:** When stubbing a module, stub all modules that depend on its data (P1 applies to internal contracts too, not just LLM state).

---

### Bug: Stale/wrong source links on LLM-extracted events (discovered 2026-03-24)

**Symptom:** User texts "bushwick", gets Tributary film screening at Millennium Film Workshop (8 PM, not free). Detail view sends an Instagram link (`instagram.com/p/DVYxEdrDX4J/`) that points to a *different* screening of the same film — at The Brick House on March 21 (3 days prior), 6-8 PM, free admission. The SMS text was correct (based on cache data), but the link is wrong.

**Root cause:** The `[Source: URL]` markers in Yutori's newsletter text are per-section, not per-event. When the LLM extracts events from a chunk, it assigns the nearest `[Source: URL]` — but if multiple events appear near the same Instagram link, the wrong URL can bleed across. The extraction prompt (line 13 of `prompts.js`) says "use the URL from the nearest preceding [Source: ...] marker" but this is fragile for densely packed newsletters where one Instagram post promotes a different instance of a recurring/traveling event.

**Impact:** User trust — clicking a link that contradicts what Pulse just told them. Violates hypothesis assumption #2 (zero hallucination extends to links).

**Fix strategy:** Validate source links post-extraction: if a `source_url` contains a date or venue that contradicts the event's `date_local` or `venue_name`, null it out. Alternatively, stop sending source links for LLM-extracted events unless the URL was explicitly part of the event listing (ticket_url).

### Bug: Cross-source dedup misses near-duplicates (discovered 2026-03-24)

**Symptom:** Bushwick today has two duplicate pairs that should merge:
1. "Trivia Night at Danger Danger (Bushwick)" (yutori) + "NYC Trivia League at Danger Danger" (nyctrivia) — same venue, same time (7:30 PM), same date, both trivia
2. "downstairs video game craft club" (dice) + "downstairs level up video game club" (dice) — same venue (Purgatory), same time (7 PM), both from Dice

**Root cause:** `makeEventId` in `shared.js:38` hashes `normalizeEventName(name) | venue | date | startTime`. The names normalize differently:
- "trivia night at danger danger bushwick" vs "nyc trivia league at danger danger" → different hashes
- "downstairs video game craft club" vs "downstairs level up video game club" → different hashes

The dedup is exact-match on ID. There's no fuzzy/similarity matching for events at the same venue + time + date.

**Impact:** Pool inflation — 13 events shown as available but really 11 unique ones. Model may waste a pick slot on a duplicate. Also inflates trivia category counts (25% of all events).

**Fix strategy:** Add a post-dedup pass: for events with same `venue_name + date_local + start_time_local + category`, keep the one from the higher-weight source. This is a mechanical check (P6) that doesn't need LLM involvement.

---

## Not Building (until hypothesis validated)

- Serendipity scoring / surprise picks
- Preference learning / decision style adaptation
- Proactive outreach / nudges
- Multi-channel (WhatsApp, iMessage)
- Multi-city expansion
- Paid tier
- Group planning
- Additional sources
- Eval hardening
- Runtime quality sampling
