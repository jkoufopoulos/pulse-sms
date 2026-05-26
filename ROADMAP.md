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

### FIXED: Details response linked the wrong event + fired multiple URL SMS (discovered 2026-05-26)

**Root cause:** The details URL-send path (`agent-loop.js`) re-derived which events to link by substring-matching the free-text SMS prose (`extractPicksFromSms`) against `Object.values(session.lastEvents)` — the entire shown pool, not the resolved pick. The matcher falls back to bare *venue-name* matching, so a details response about one National Sawdust event linked every National Sawdust event in the pool (including a sibling event, Vagabon, never shown as a pick) and sent each as a separate SMS. The structured `reference` param that already names the pick was available but ignored.

**Fix:** Added `resolveDetailUrl(reference, session)` — resolves the single referenced event via `executeDetails` (structured `reference`, not prose) and returns its one URL. The details path now sends exactly one URL for that event; removed `extractPicksFromSms`/`sendPickUrls` from this path. Unit-tested against the multi-event-same-venue scenario.

**Regression principle:** P1 — structured tool calls own state, free-text owns language. Re-parsing the outgoing SMS prose to choose a URL is the free-text-owns-state anti-pattern; link from the structured `reference`, never from generated text.

---

### FIXED: Scraper crashes on every run — stale cache for 5 days (discovered 2026-03-24)

**Root cause:** `source-health.js` was stubbed out (no-op) during hypothesis focus, but `scrape-guard.js` still assumed real health data. The Proxy in the stub auto-creates empty objects `{}`, so `sourceHealth[label]` is truthy but has no `.history` array. `getBaselineStats` accessed `health.history.length` on `undefined` → crash on every scrape and email poll.

**Fix:** Stubbed `scrape-guard.js` to match `source-health.js` — both are now no-ops. Added 30-min heartbeat in `server.js` that triggers a scrape if cache goes stale, so this class of failure self-heals.

**Regression principle:** When stubbing a module, stub all modules that depend on its data (P1 applies to internal contracts too, not just LLM state).

---

### FIXED: Stale/wrong source links on LLM-extracted events (discovered 2026-03-24)

**Root cause:** LLM-extracted sources produce `source_url` via `[Source: URL]` markers that bleed across events, or blanket newsletter URLs. Instagram/social links are frequently wrong.

**Fix:** Added `isReliableEventUrl()` guard in `formatters.js`. Social media posts (Instagram, Twitter, Facebook) and newsletter homepages (nonsensenyc, theskint, screenslate) are filtered out at send time. `ticket_url` (from structured scrapers) always passes. Unreliable URLs fall back to Google Maps venue link.

### FIXED: Cross-source dedup misses near-duplicates (discovered 2026-03-24)

**Root cause:** `makeEventId` hashes normalized name — different names at same venue/time produce different IDs.

**Fix:** Added `deduplicateByVenueSlot()` in `events.js` — secondary dedup pass after ID-based dedup. Groups events by `venue_name + date_local + start_time_local + category`, keeps highest-weight source on collision. Events without venue or date are never touched.

---

## Active Plan — Agent conversational redesign (2026-04-15)

User tests surfaced four failure patterns that contradict the current prompt. Insight sources: Anthropic's `AskUserQuestion` tool pattern (multiple-choice, "Other" free-text), `EXPLORE_AGENT_MIN_QUERIES` (enforce breadth at the tool level), and the "collaborator not executor" transparency principle.

**Problem 1 — Agent skips discovery.** Current prompt says "if you have enough to search, search — don't ask to be safe." Model searches on the first substantive message and returns ranked picks, never learning what the user actually wants.

**Problem 2 — Picks are homogeneous.** `serializePoolForContinuation` marks `i < 5` as recommended. Top-5 by ranker are often clones (same category, same vibe). Model reads what's labeled `recommended: true` and echoes it.

**Problem 3 — Broadening is hidden.** Prompt explicitly says "silently include nearby neighborhoods. Don't explain the sparsity to the user." User asks for LES, gets a Williamsburg pick, has no idea why.

**Problem 4 — Prose blob, no structure.** Prompt explicitly says "No headers, no lists, no formatting. Short sentences." A 420-char comma-spliced paragraph with two picks is less scannable than numbered lines. Twilio renders `\n` fine.

### Fixes

1. **Flip `clarify` gate.** Keep tool name (already wired through `agent-loop.js`, `session.js`). Change the prompt from "only when ambiguous" to "default on first substantive request unless user gave neighborhood + (category OR vibe OR time)." Require 3-4 concrete options. Mark recommended option with `(Recommended)` prefix per Anthropic pattern. Examples in prompt flip: "comedy in bushwick" now clarifies (seated vs loud, early vs late); "comedy in bushwick around 9pm" searches.

2. **Diversify the recommended slice in the serializer.** Add `diversifyPool()` in `brain-llm.js` that picks top-N by rank, then swaps in lower-ranked candidates until categories span ≥3 distinct values and vibes span ≥2. Tag each with `diversity_role: 'primary' | 'contrast' | 'wildcard'`. Model reads the tag, doesn't compute diversity itself (P1 — structured state owns breadth).

3. **Flip transparency rules.** Remove "silently broaden" from prompt. Add `off_query: true` + `off_query_reason: string` fields on pool items that fell outside the user's stated filters (nearby neighborhood, adjacent category, different price). Prompt: "When including off-query picks, name it. 'Nothing great in LES for comedy, but 10 min away in Williamsburg…'"

4. **Allow numbered format.** Update prompt: when returning ≥2 picks, use `1) Name — why. Time, price.\n2) …`. Remove the "no headers, no lists, no formatting" blanket ban. Update few-shot examples. Keep 480-char cap.

### Files touched

- `src/brain-llm.js` — `BRAIN_TOOLS.clarify` description + required fields, `buildBrainSystemPrompt` sections (conversation, examples, clarification), `serializePoolForContinuation` + new `diversifyPool()`, new `buildRecommendationReason` handling for `off_query`.
- `src/agent-loop.js` — no functional change; clarify routing already present. Check `deriveIntent` still correct.
- `test/` — add regression tests for numbered format, diversity spread, off-query labeling, clarify-first on bare inputs.

### Not in scope (deferred)

- Prompt cache split (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) — tracked separately in `memory/plan-cost-reduction.md`.
- Renaming `clarify` → `askUser` — would churn session field `pendingClarification` and history entries.

---

## Next-up — Claude Code-inspired integrations (2026-04-15)

Patterns stolen from `codeaashu/claude-code` that fit Pulse's editorial-curation hypothesis. Each is independently shippable.

### 1. Pre-empt for long latencies — SHIPPED (2026-04-15)

Fires a request-specific "working on it" SMS the moment the model commits to its first tool call. Predictive signal (tool call → ≥2 round-trips → near-certain >3s), not a wall-clock timer. Env-gated via `PULSE_PREEMPT_ENABLED=true`. Copy derived from tool call params: `"Looking at comedy in bushwick tonight…"` / `"Checking Union Pool…"` / `"Pulling details on 2…"`. Non-blocking send. Fires in both prod and `PULSE_TEST_MODE` (simulator) — the original test-mode skip was dropped because no live eval indexes capture order from tool-using turns, and the simulator is the main iteration surface where the feature needs to be visible. Delivery tracked via `trace.preempt.{fired,delivered,sid,error}` (eventually consistent — `delivered` may be missing from on-disk JSONL if Twilio resolves after `finalizeTrace`; ring buffer + dashboard see it). Health dashboard tile: `/health` → Pre-empt.

**Known gaps (not blocking ship):**
- `[search, clarify]` batch causes pre-empt + clarify question = 2 SMS. Frequency negligible (prompt steers against it). Revisit if traces show >0.
- Brain fallback to Gemini (`agent-loop.js:991`) uses an inline executor that bypasses pre-empt. Worst-affected case (Claude degraded) gets no pre-empt. Fix is to extract `executeAndTrack` into a `buildExecutor` factory and reuse for both loops.
- Integration evals that index captured messages by position (`msgs[0]`, `msgs[1]`) will need to skip pre-empt captures (e.g. `msgs.filter(m => !m.preempt)` once we tag them). No active eval is affected today; flag for future evals that use tool-call paths.

### 2. `lookup_event_url` tool — structured enrichment from event pages

**Problem:** When `short_detail` is thin (title + time + venue only, no editorial context), the model has nothing to say beyond logistics. Right now we throw up our hands.

**Borrowed pattern:** Claude Code's `WebFetchTool` (`src/tools/WebFetchTool/`). Two design elements are load-bearing:
- **Preapproved domain list** (`preapproved.ts`) — only allowed hosts can be fetched without user approval. Pulse equivalent: the allow-list already implied by `isReliableEventUrl` in `formatters.js` — formalize it.
- **Secondary model post-processing** (`makeSecondaryModelPrompt`) — fetched HTML is piped through a cheap Haiku pass to extract a structured payload, never fed raw to the main brain. Same pattern Pulse already uses for `extractEvents` at scrape time.

**Shape:** New tool exposed to the brain:
```
lookup_event_url({ event_id: string }) →
  { confirmed_date, confirmed_price, confirmed_time, editorial_blurb, source_host }
```
Brain calls this on details requests when `short_detail` is <60 chars or missing. Internally: resolves `event_id` → `source_url`, checks against preapproved domain list, fetches with 15-min cache (steal the CC caching pattern), feeds HTML to Haiku with a fixed extraction prompt, returns structured payload.

**Guardrails:**
- Allow-list only — no free-roaming fetch.
- Never call on discover/more — only on details.
- Budget-aware — counts against per-user `$0.10/day`.
- Empty-result fallback — if extraction fails or yields nothing useful, return `{ _empty: true }` and let the brain write details from existing fields.

**Risk:** Tempting to expand into a general `web_fetch` tool. Don't — that invites fabrication from low-quality snippets and breaks the data contract.

### 3. `get_directions` helper — deterministic walking/transit URLs

**Problem:** Users asking "how do I get there" today get nothing. The simulator has Google Maps API keys and we already geocode venues via `venues.js`.

**Borrowed pattern:** Claude Code's `isReadOnly: true` + `isConcurrencySafe: true` tool flags (`src/tools/WebFetchTool/WebFetchTool.ts`). Pattern: purely deterministic helpers are exposed as tools but run without an LLM round-trip — the tool signature IS the output.

**Shape:** No LLM call. Pure function that builds a Google Maps deep link:
```
get_directions({ venue_name: string, from?: string }) →
  "https://www.google.com/maps/dir/?api=1&destination=..."
```
Called on the `details` path when the SMS includes "how do I get there" / "directions" / "where is". Rendered as a follow-up URL message — same pattern as `sendPickUrls`.

**Guardrails:**
- `from` defaults to "current location" (user's phone GPS, not known to us — Google's app prompts).
- Never include user's home address or prior locations — no PII leakage.
- Fails open: if venue isn't geocoded, fall back to `https://maps.google.com/?q=<venue_name>`.

### 4. Parallelize `search` + `lookup_venue` — concurrency optimization

**Problem:** On details requests with thin venue data, the loop runs sequentially: search returns the pick → model calls `lookup_venue` → waits for Google Places → writes SMS. That's 2 serial round-trips + 1 Google call, often 5-7s.

**Borrowed pattern:** Claude Code's parallel tool execution (`isConcurrencySafe`). The brain issues multiple tool calls in one turn and they run in parallel — the orchestrator awaits all before feeding results back.

**Shape:** In `executeAndTrack`, detect when the brain calls `search` + `lookup_venue` in the same turn and run them concurrently with `Promise.all`. Already supported by the underlying `runAgentLoop` — just needs the execute wrapper to not serialize them. Prompt update to tell the brain "on a details request with a known pick, call `search({intent: 'details', reference})` AND `lookup_venue({venue_name})` in the same turn."

**Guardrails:**
- Only parallelize read-only, concurrency-safe tools (both of these are).
- `clarify` + anything else must stay serialized (clarify is terminal).

**Order of operations:** #2 → #3 → #4. #2 is the biggest quality win (fixes thin-data details responses). #3 is low-risk UX polish. #4 is a latency optimization worth ~1-2s but requires #2 to land first so the prompt rewrite is one change.

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
