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

**Agent loop (sole path, ~$0.001/call)** — True agent loop via `runAgentLoop` in `llm.js`. `checkMechanical` handles only "help"/"?" and TCPA opt-out at $0. Everything else goes through `handleAgentRequest` in `agent-loop.js`, which runs a multi-turn tool calling loop (max 3 iterations): model calls a tool → code executes it → result fed back → model decides next action or writes SMS. 2 tools: `search` (unified — events, bars, restaurants, details, more, welcome) and `respond` (conversation). The model writes the SMS as plain text when it's ready. Falls back to Anthropic Haiku on Gemini failure. 2-5s typical latency.

A typical multi-turn conversation:
```
User: "williamsburg"           → agent brain: search({neighborhood: "williamsburg", intent: "discover"}) ($0.0005)
User: "how about comedy"       → agent brain: search({neighborhood: "williamsburg", filters: {categories: ["comedy"]}, intent: "discover"}) ($0.0005)
User: "2"                      → agent brain: search({intent: "details", reference: "2"}) ($0.0005)
User: "try bushwick"           → agent brain: search({neighborhood: "bushwick", filters: {categories: ["comedy"]}, intent: "discover"}) ($0.0005)
User: "later tonight"          → agent brain: search({neighborhood: "bushwick", filters: {categories: ["comedy"], time_after: "22:00"}, intent: "discover"}) ($0.0005)
User: "forget the comedy"      → agent brain: search({neighborhood: "bushwick", intent: "discover"}) ($0.0005)
User: "more"                   → agent brain: search({intent: "more"}) ($0.0005)
```

**Filter state flow:** The handler reads filter state from the agent brain's `search` tool call params (filters.categories, filters.free_only, filters.time_after, filters.date_range). These are structured and validated — safe state sources. After the response, the handler saves `activeFilters` as `lastFilters` via `saveResponseFrame`. Conversation history includes `search_summary` entries for richer model context.

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
   events.js                    runAgentLoop
   (cache, dedup,              (llm.js, multi-turn
    source health)              tool calling loop)
        │                           │
        │                    ┌──────┴──────┐
        │                    ▼             ▼
        │                search         respond
        │              (events, bars,  (greetings,
        └─►             more, details)  thanks, bye)
                             │
                        agent loop (max 3 turns)   ~$0.001
                        model writes plain text SMS
                             │
                        saveSessionFromToolCalls    $0
                        (from tool call params)
                             │
                        formatters.js (480-char)
                             │
                        twilio.js (send SMS)    ~$0.008

```

**Key modules** (all under `src/`):

| Module | Role |
|--------|------|
| `handler.js` | Orchestrator: checkMechanical → agent loop → session save |
| `agent-loop.js` | True agent loop: `handleAgentRequest` (orchestrator), `executeTool` (callback for tool execution), `saveSessionFromToolCalls` (post-loop session save) |
| `request-guard.js` | TCPA opt-out, Twilio dedup, per-user AI budget ($0.10/day prod), IP rate limiting |
| `model-config.js` | Single source of truth for LLM model choices. 3 roles (brain, extract, fallback), env var overrides, provider auto-detection from model name prefix |
| `llm.js` | Provider-agnostic LLM interface: `generate()`, `callWithTools()`, `continueChat()`, `runAgentLoop()`. Routes to Gemini or Anthropic based on model name |
| `agent-brain.js` | Mechanical pre-check only: `checkMechanical` (help + TCPA). Re-exports `executeMore`/`executeDetails` for tests |
| `brain-llm.js` | Tool definitions (`BRAIN_TOOLS`), system prompt (`buildBrainSystemPrompt`), event serialization (`serializePoolForContinuation`) |
| `brain-execute.js` | Pure tool implementations: `buildSearchPool`, `executeMore`, `executeDetails`, `validatePicks` |
| `pipeline.js` | `buildTaggedPool`, `eventMatchesFilters`, `saveResponseFrame` (atomic session writes) |
| `ai.js` | `extractEvents` (scrape-time). Uses `llm.generate()` |
| `prompts.js` | System prompts: `EXTRACTION_PROMPT` |
| `session.js` | Per-phone session store, 2hr TTL, 12 fields |
| `events.js` | Daily event cache + disk persistence, cross-source dedup, quality gates, source vibe stamping |
| `source-registry.js` | Single source of truth for all 22 source entries across 19 scraper modules (weights, tiers, fetch functions) |
| `nudges.js` | Recurrence nudge system: attendance tracking via detail requests, consent flow (REMIND ME / NUDGE OFF), deterministic nudge messages, hourly scheduler. `trackRecurringDetail`, `captureConsent`, `buildNudgeMessage`, `checkAndSendNudges` |

Other modules: `intent-handlers.js` (help response), `geo.js` + `neighborhoods.js` (75 NYC hoods across 5 boroughs), `venues.js` (auto-learning coords), `formatters.js` (480-char cap), `twilio.js`, `traces.js`, `alerts.js`, `preference-profile.js`, `referral.js`, `curation.js`, `source-health.js`, `db.js` (SQLite).

Sources: 22 entries across 19 scraper modules in `sources/` — see `source-registry.js` for the full list. Evals: 6 modules in `src/evals/`. Scripts: 13 runners in `scripts/`. UIs: 8 dashboards served by `server.js`.

## Design Principles (do not violate)

- **P1: Structured tool calls own state, free-text owns language** — Session state is derived from the agent brain's tool call params (`search` args) and pool results, never parsed from free-text LLM output. Picks are saved from pool order (top events shown to model), not fuzzy-matched from SMS text.
- **P4: One save path** — Every SMS-sending path must end with `saveResponseFrame`. No `setSession` terminal writes.
- **P6: Mechanical shortcuts for $0 operations, LLM for everything else** — `checkMechanical` handles "help"/"?" and TCPA opt-out at $0. Everything else (including bare numbers, "more", greetings) goes to the agent brain's tool calling.
- **480-char SMS limit** — All responses capped at 480 chars.
- **TCPA compliance** — STOP/UNSUBSCRIBE/CANCEL/QUIT silently dropped (no reply).
- **Per-user daily AI budget** — $0.10/day prod, $10 test. `trackAICost` accumulates; `isOverBudget` blocks.
- **Daily cache** — Events scraped once at 10am ET, persisted to `data/events-cache.json`. `isCacheFresh()` skips startup scrape when <20hr old. No Tavily in hot path.
- **Cross-source dedup** — Event IDs hashed from name + venue + date. Higher-weight source wins merge. Weights in `source-registry.js`.
- **Quality gates** — Events below 0.4 confidence, flagged `needs_review`, or below 0.4 completeness are dropped in `getEvents()`.

## Env Vars

Required: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `GEMINI_API_KEY`.

Optional: `ANTHROPIC_API_KEY` (only needed if using Claude models), `PORT` (default 3000), `PULSE_TEST_MODE=true` (enables simulator), `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/`GMAIL_REFRESH_TOKEN` (newsletter scrapers), `RESEND_API_KEY`/`ALERT_EMAIL` (email alerts), `PULSE_NO_RATE_LIMIT=true`, `PULSE_NUDGES_ENABLED=true` (enables hourly recurrence nudge scheduler).

Model config (all optional, defaults in `src/model-config.js`): `PULSE_MODEL_BRAIN` (agent loop, default `gemini-2.5-flash`), `PULSE_MODEL_EXTRACT` (event extraction, default `gemini-2.5-flash`), `PULSE_MODEL_EVAL` (evals and quality scoring, default `gemini-2.5-flash`), `PULSE_MODEL_FALLBACK` (fallback for all roles, default `gemini-2.5-flash`). Provider auto-detected from model name prefix (`gemini-*` → Gemini, `claude-*` → Anthropic).

## Running

```bash
cp .env.example .env   # fill in your keys
npm install
npm start              # boots on PORT (default 3000)
npm run dev            # dev server with file-watch reload
npm test               # smoke tests (pure functions, no API calls)
npm run eval:quality   # quality evals on 15 golden conversations (~$0.02, ~30s)
```

**Railway:** Simulator at `https://web-production-c8fdb.up.railway.app/test`. Test endpoint: `POST /api/sms/test` with `Body` and optional `From`. Health dashboard: `GET /health`. Deploy: `railway up` (async build, ~2-3 min).

**GitHub Pages:** Public site at `https://jkoufopoulos.github.io/pulse-sms/` — landing page, architecture explorer, evals page. Source files live in `site/`. Deployed via `gh-pages` branch. To update: edit files in `site/` on `main`, then sync to `gh-pages` branch and push. Railway's `/architecture` redirects here.
