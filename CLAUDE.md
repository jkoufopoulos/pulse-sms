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

Pulse routes every incoming message through `checkMechanical` (help + TCPA only, $0) then the agent brain (Gemini tool calling). Session state is derived from the agent's structured tool call parameters — never parsed from free-text output.

**Agent brain (sole path, ~$0.0005/call)** — Gemini 2.5 Flash Lite with tool calling. `checkMechanical` handles only "help"/"?" and TCPA opt-out at $0. Everything else goes to `callAgentBrain` which uses 2 tools: `search_events` (all event intents: search, refine, more, details) and `respond` (conversation). SMS composition happens in the same Gemini chat session via multi-turn tool calling. 2-3s typical latency. Tool call params (`search_events` args) are the system of record for filters and intent. Falls back to Anthropic Haiku on Gemini failure.

A typical multi-turn conversation:
```
User: "williamsburg"           → agent brain: search_events({neighborhood: "williamsburg"}) ($0.0005)
User: "how about comedy"       → agent brain: search_events({neighborhood: "williamsburg", categories: ["comedy"]}) ($0.0005)
User: "2"                      → agent brain: search_events({intent: "details", pick_reference: "2"}) ($0.0005)
User: "try bushwick"           → agent brain: search_events({neighborhood: "bushwick", categories: ["comedy"]}) ($0.0005)
User: "later tonight"          → agent brain: search_events({neighborhood: "bushwick", categories: ["comedy"], time_filter: "late_night"}) ($0.0005)
User: "forget the comedy"      → agent brain: search_events({neighborhood: "bushwick"}) ($0.0005)
User: "more"                   → agent brain: search_events({intent: "more"}) ($0.0005)
```

**Filter state flow:** The handler reads filter state from the agent brain's `search_events` tool call params (categories, time_filter, free_only, date_range). These are structured and validated — safe state sources. After the response, the handler saves `activeFilters` as `lastFilters` via `saveResponseFrame`.

Session state (neighborhood, last picks, active filters) persists for 2 hours per phone number.

## Architecture

All application source lives under `src/`. Scripts and eval runners are at root level in `scripts/`.

```
Daily scrape (10am ET)              Incoming SMS
        │                                │
        ▼                                ▼
   sources/                         handler.js
   (22 entries across               (request-guard.js:           $0
    19 scraper modules)              TCPA, dedup, budget)
        │                                │
        ├─► venues.js              checkMechanical ◄── session.js
        │   (auto-learn             (help + TCPA          (12 fields,
        │    coords,                 only, $0)             2hr TTL)
        │    persist)                    │
        ▼                               ▼
   events.js                    callAgentBrain
   (cache, dedup,              (Gemini 2.5 Flash Lite
    source health)              tool calling)
        │                           │
        │                    ┌──────┴──────┐
        │                    ▼             ▼
        │              search_events    respond
        │              (search, refine, (greetings,
        └─►             more, details)   thanks, bye)
                             │
                        same Gemini session     ~$0.0005
                        writes natural prose SMS
                             │
                        handler saves              $0
                        activeFilters → lastFilters
                        (from tool call params)
                             │
                        formatters.js (480-char)
                             │
                        twilio.js (send SMS)    ~$0.008

```

**Key modules** (all under `src/`):

| Module | Role |
|--------|------|
| `handler.js` | Orchestrator: checkMechanical → agent brain → deterministic session save |
| `request-guard.js` | TCPA opt-out, Twilio dedup, per-user AI budget ($0.10/day prod), IP rate limiting |
| `model-config.js` | Single source of truth for all LLM model choices. 5 roles (brain, compose, extract, details, fallback), env var overrides, provider auto-detection from model name prefix |
| `llm.js` | Provider-agnostic LLM interface: `generate()`, `callWithTools()`, `continueChat()`. Routes to Gemini or Anthropic based on model name. Neutral tool format with automatic conversion |
| `agent-brain.js` | Sole LLM path: `checkMechanical` (help + TCPA only), `callAgentBrain` (tool calling via llm.js, 2 tools: `search_events` + `respond`). Falls back to `MODELS.fallback` on primary failure |
| `pipeline.js` | `buildTaggedPool`, `eventMatchesFilters`, `saveResponseFrame` (atomic session writes) |
| `ai.js` | `extractEvents` (scrape-time), `composeDetails` (event detail composition). Uses `llm.generate()` |
| `prompts.js` | System prompts: `BRAIN_SYSTEM`, `BRAIN_COMPOSE_SYSTEM`, `DETAILS_SYSTEM`, `EXTRACTION_PROMPT` |
| `session.js` | Per-phone session store, 2hr TTL, 12 fields |
| `events.js` | Daily event cache + disk persistence, cross-source dedup, quality gates, source vibe stamping |
| `source-registry.js` | Single source of truth for all 22 source entries across 19 scraper modules (weights, tiers, fetch functions) |

Other modules: `intent-handlers.js` (help response), `geo.js` + `neighborhoods.js` (75 NYC hoods across 5 boroughs), `venues.js` (auto-learning coords), `formatters.js` (480-char cap), `twilio.js`, `traces.js`, `alerts.js`, `preference-profile.js`, `referral.js`, `card.js`, `curation.js`, `source-health.js`, `db.js` (SQLite).

Sources: 22 entries across 19 scraper modules in `sources/` — see `source-registry.js` for the full list. Evals: 6 modules in `src/evals/`. Scripts: 13 runners in `scripts/`. UIs: 8 dashboards served by `server.js`.

## Design Principles (do not violate)

- **P1: Structured tool calls own state, free-text owns language** — Session state is derived from the agent brain's tool call params (`search_events` args), never parsed from free-text LLM output. Tool params are structured and validated — the sole source of truth for filters and intent.
- **P4: One save path** — Every SMS-sending path must end with `saveResponseFrame`. No `setSession` terminal writes.
- **P6: Mechanical shortcuts for $0 operations, LLM for everything else** — `checkMechanical` handles "help"/"?" and TCPA opt-out at $0. Everything else (including bare numbers, "more", greetings) goes to the agent brain's tool calling.
- **480-char SMS limit** — All responses capped at 480 chars.
- **TCPA compliance** — STOP/UNSUBSCRIBE/CANCEL/QUIT silently dropped (no reply).
- **Per-user daily AI budget** — $0.10/day prod, $10 test. `trackAICost` accumulates; `isOverBudget` blocks.
- **Daily cache** — Events scraped once at 10am ET, persisted to `data/events-cache.json`. `isCacheFresh()` skips startup scrape when <20hr old. No Tavily in hot path.
- **Cross-source dedup** — Event IDs hashed from name + venue + date. Higher-weight source wins merge. Weights in `source-registry.js`.
- **Quality gates** — Events below 0.4 confidence, flagged `needs_review`, or below 0.4 completeness are dropped in `getEvents()`.

## Env Vars

Required: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.

Optional: `PORT` (default 3000), `PULSE_TEST_MODE=true` (enables simulator), `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/`GMAIL_REFRESH_TOKEN` (newsletter scrapers), `RESEND_API_KEY`/`ALERT_EMAIL` (email alerts), `PULSE_NO_RATE_LIMIT=true`, `PULSE_CARD_ENABLED=true` (enables branded card pages; default off, uses direct source URLs), `PULSE_CARD_DOMAIN`, `PULSE_LINK_PREVIEWS=true` (sends each pick's URL as a separate SMS for iMessage link previews).

Model config (all optional, defaults in `src/model-config.js`): `PULSE_MODEL_BRAIN` (agent brain, default `gemini-2.5-flash-lite`), `PULSE_MODEL_COMPOSE` (SMS composition, default `gemini-2.5-flash-lite`), `PULSE_MODEL_EXTRACT` (event extraction, default `gemini-2.5-flash`), `PULSE_MODEL_DETAILS` (detail composition, default `gemini-2.5-flash`), `PULSE_MODEL_FALLBACK` (fallback for all roles, default `claude-haiku-4-5-20251001`). Provider auto-detected from model name prefix (`gemini-*` → Gemini, `claude-*` → Anthropic).

## Running

```bash
cp .env.example .env   # fill in your keys
npm install
npm start              # boots on PORT (default 3000)
npm run dev            # dev server with file-watch reload
npm test               # smoke tests (pure functions, no API calls)
npm run eval:quality   # quality evals on 15 golden conversations (~$0.02, ~30s)
```

**Railway:** Simulator at `https://web-production-c8fdb.up.railway.app/test`. Test endpoint: `POST /api/sms/test` with `Body` and optional `From`. Health dashboard: `GET /health`.
