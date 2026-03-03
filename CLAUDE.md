# Pulse SMS

Pulse is an SMS-based AI assistant that recommends NYC nightlife and events. Text a neighborhood and get curated picks via Twilio, powered by Claude.

## Roadmap Maintenance

`ROADMAP.md` is the single source of truth for architecture decisions, open bugs, and planned work. **Update it as part of completing work, not as a separate step.**

When to update:
- **Bug fix or feature lands** — mark the relevant migration step or open issue as done; add to "Completed Work" with date
- **Architecture decision made** — log it in "Decisions Made" with rationale; if it changes a principle, update the principle
- **Bug discovered** — add to "Open Issues" with root cause, regression principle, and fix strategy
- **Approach attempted and reverted** — document what was tried, why it was reverted, and what the principled fix is

When NOT to update:
- Exploratory research that doesn't change the plan
- Minor code changes that don't affect architecture (typo fixes, log messages)
- Work in progress — only update when something is actually done or decided

The roadmap has 7 architecture principles (P1-P7). New code changes should be evaluated against these. If a fix violates a principle, flag it rather than shipping it silently.

## What It Does

Pulse turns a simple text message into a curated night out. A user texts a neighborhood name — "Bushwick", "LES", "prospect park" — and gets back 1-3 opinionated event picks formatted for SMS (under 480 characters). They can reply a number for details, "more" for additional picks, "free" for free events, or refine with follow-ups like "how about comedy" or "later tonight." The entire experience happens in a single SMS thread with no app install, no account, and no links until the user asks for them.

## How Conversations Work

Pulse routes every incoming message through a two-tier system: a fast deterministic pre-router and a unified LLM call. The handler owns all filter state deterministically — the LLM never manages filters, it only composes from a pre-tagged event pool.

**Pre-router (~15% of messages, zero AI cost)** — Pattern-matches mechanical shortcuts: help, numbers 1-5 for details, "more", greetings/thanks/bye, event name matches, and session-aware filter detection ("how about comedy", "free", "later tonight"). Filter detections are injected into the unified branch — the pre-router never composes responses for these.

**Unified LLM call (~85% of messages, ~$0.001/call)** — A single Claude Haiku call that understands intent AND composes the SMS response. Handles neighborhoods, compound requests, off-topic deflection, nudge accepts, boroughs, and all semantic understanding. Receives a tagged event pool where filter-matched events are marked `[MATCH]`.

A typical multi-turn conversation:
```
User: "williamsburg"           → unified: Haiku composes Williamsburg picks ($0.001)
User: "how about comedy"       → pre-router detects comedy filter → unified: tagged pool, comedy [MATCH] ($0.001)
User: "2"                      → pre-router: details on pick #2 ($0)
User: "try bushwick"           → unified: comedy filter persists via mergeFilters, Bushwick comedy tagged [MATCH] ($0.001)
User: "later tonight"          → pre-router detects time filter → unified: comedy+late compound, both filters applied ($0.001)
User: "forget the comedy"      → pre-router: clear_filters → unified: fresh Bushwick picks, no filters ($0.001)
User: "more"                   → pre-router: next batch of picks ($0)
```

**Filter state flow:** The handler resolves filters deterministically using `mergeFilters(lastFilters, preDetectedFilters)`. Filters persist across neighborhood switches, nudge accepts, and conversational responses. The LLM sees a tagged event pool (`[MATCH]` events first, padded with unmatched) and a `SPARSE` flag when matches are thin. After the LLM responds, the handler saves `activeFilters` as `lastFilters` — never the LLM's guess.

Session state (neighborhood, last picks, active filters) persists for 2 hours per phone number.

## Architecture

All application source lives under `src/`. Scripts and eval runners are at root level in `scripts/`.

```
Daily scrape (10am ET)              Incoming SMS
        │                                │
        ▼                                ▼
   sources/                         handler.js
   (23 source entries)               (request-guard.js:           $0
        │                            TCPA, dedup, budget)
        │                                │
        ├─► venues.js              pre-router.js ◄── session.js
        │   (auto-learn             (mechanical        (14 fields,
        │    coords,                 shortcuts)         2hr TTL)
        │    persist)                    │
        ▼                    ┌──────────┼──────────────┐
   events.js            mechanical   filter detect   no match
   (cache, dedup,       shortcuts    (comedy/time/   (85% of
    source health)     (help, 1-5,   free/vibe/      messages)
        │               more, bye)   clear)              │
        │                  │            │                │
        │                  ▼            │                │
        │            intent-handlers    │                │
        │            (help, details,    │                │
        │             more, convo)      │                │
        │                  │            └──► merge ◄────┘
        │                  │                  │
        │                $0 AI           pipeline.js
        │                                mergeFilters()         $0
        │                                buildTaggedPool()
        │                     ┌── [MATCH] + unmatched events
        │                     │   + ACTIVE_FILTER / SPARSE
        │                     ▼
        └──────────►   ai.js/unifiedRespond
                       (Claude Haiku, 1 call)          ~$0.001
                       skills/ + prompts.js
                       (15 conditional modules)
                              │
                              ▼
                       handler saves                    $0
                       activeFilters → lastFilters
                       (deterministic, not LLM-derived)
                              │
                       formatters.js (480-char)
                              │
                       twilio.js (send SMS)            ~$0.008
```

**Key modules** (all under `src/`):

| Module | Role |
|--------|------|
| `handler.js` | Orchestrator: pre-router → filter resolution → tagged pool → unified LLM → deterministic session save |
| `request-guard.js` | TCPA opt-out, Twilio dedup, per-user AI budget ($0.10/day prod), IP rate limiting |
| `unified-flow.js` | Unified LLM orchestration: context resolution, LLM call, response handling, zero-match |
| `pre-router.js` | Deterministic intent matching + session-aware filter detection. Returns `null` → unified LLM |
| `pipeline.js` | `mergeFilters`, `buildTaggedPool`, `eventMatchesFilters`, `saveResponseFrame` (atomic session writes) |
| `ai.js` | `unifiedRespond` (single Haiku call), `composeResponse` (handleMore), `extractEvents` (scrape-time) |
| `prompts.js` | System prompts: `UNIFIED_SYSTEM`, `COMPOSE_SYSTEM`, `ROUTE_SYSTEM`, `EXTRACTION_PROMPT` |
| `session.js` | Per-phone session store, 2hr TTL, 14 fields |
| `events.js` | Daily event cache + disk persistence, cross-source dedup, quality gates |
| `source-registry.js` | Single source of truth for all 23 source entries (weights, tiers, fetch functions) |
| `model-router.js` | Complexity scoring (0-100), routes Haiku vs Gemini Flash |

Other modules: `intent-handlers.js` (help/details/more/convo), `geo.js` + `neighborhoods.js` (36 NYC hoods), `venues.js` (auto-learning coords), `formatters.js` (480-char cap), `twilio.js`, `traces.js`, `alerts.js`, `preference-profile.js`, `referral.js`, `card.js`, `curation.js`, `source-health.js`, `db.js` (SQLite).

Sources: 23 entries across 19 scraper modules in `sources/` — see `source-registry.js` for the full list. Evals: 6 modules in `src/evals/`. Scripts: 13 runners in `scripts/`. UIs: 7 dashboards served by `server.js`.

## Design Principles (do not violate)

- **P1: Code owns state, LLM owns language** — Never read structured fields from LLM output to set session state. The handler saves `activeFilters` as `lastFilters` deterministically. The LLM composes from a tagged pool but never manages filter state.
- **P4: One save path** — Every SMS-sending path must end with `saveResponseFrame`. No `setSession` terminal writes.
- **P6: Deterministic extraction first** — Compound filters ("free comedy") should be pre-router regex, not LLM-reported.
- **480-char SMS limit** — All responses capped at 480 chars.
- **TCPA compliance** — STOP/UNSUBSCRIBE/CANCEL/QUIT silently dropped (no reply).
- **Per-user daily AI budget** — $0.10/day prod, $10 test. `trackAICost` accumulates; `isOverBudget` blocks.
- **Daily cache** — Events scraped once at 10am ET, persisted to `data/events-cache.json`. `isCacheFresh()` skips startup scrape when <20hr old. No Tavily in hot path.
- **Cross-source dedup** — Event IDs hashed from name + venue + date. Higher-weight source wins merge. Weights in `source-registry.js`.
- **Quality gates** — Events below 0.4 confidence, flagged `needs_review`, or below 0.4 completeness are dropped in `getEvents()`.

## Env Vars

Required: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY` (required at boot, not used in hot path).

Optional: `PORT` (default 3000), `PULSE_TEST_MODE=true` (enables simulator), `GEMINI_API_KEY` (fallback provider), `TICKETMASTER_API_KEY`, `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/`GMAIL_REFRESH_TOKEN` (newsletter scrapers), `RESEND_API_KEY`/`ALERT_EMAIL` (email alerts), `PULSE_NO_RATE_LIMIT=true`, `PULSE_CARD_DOMAIN`.

Model overrides: `PULSE_MODEL_COMPOSE`, `PULSE_MODEL_EXTRACT`, `PULSE_MODEL_ROUTE`, `PULSE_MODEL_ROUTE_GEMINI`, `PULSE_ROUTE_PROVIDER`.

## Running

```bash
cp .env.example .env   # fill in your keys
npm install
npm start              # boots on PORT (default 3000)
npm run dev            # dev server with file-watch reload
npm test               # smoke tests (pure functions, no API calls)
npm run eval           # code evals on stored traces (no API calls)
npm run eval:judges    # code evals + LLM judge evals (costs API tokens)
```

**Railway:** Simulator at `https://web-production-c8fdb.up.railway.app/test`. Test endpoint: `POST /api/sms/test` with `Body` and optional `From`. Health dashboard: `GET /health`.
