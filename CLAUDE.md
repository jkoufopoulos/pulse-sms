# Pulse SMS

Pulse is an SMS-based AI assistant that recommends NYC nightlife and events. Text a neighborhood and get curated picks via Twilio, powered by Claude.

## What It Does

Pulse turns a simple text message into a curated night out. A user texts a neighborhood name — "Bushwick", "LES", "prospect park" — and gets back 1-3 opinionated event picks formatted for SMS (under 480 characters). They can reply a number for details, "more" for additional picks, "free" for free events, or refine with follow-ups like "how about comedy" or "later tonight." The entire experience happens in a single SMS thread with no app install, no account, and no links until the user asks for them.

## How Conversations Work

Pulse uses a two-tier routing system to understand messages:

1. **Pre-router (deterministic)** — Pattern-matches common intents instantly with zero latency or AI cost: greetings, bare neighborhood names, "more", "free", number replies for details, and follow-up filter modifications (category/time/vibe changes when the user has an active session).

2. **AI router (semantic)** — Handles ambiguous messages that need real understanding: "any good jazz shows near prospect park tonight", compound filters like "any more free comedy stuff", off-topic deflection. Uses Gemini Flash by default (~10x cheaper than Haiku), falls back to Claude Haiku.

A typical multi-turn conversation:
```
User: "williamsburg"           → pre-router: events in Williamsburg
User: "how about comedy"       → pre-router: events + comedy filter, same hood
User: "2"                      → pre-router: details on pick #2
User: "later tonight"          → pre-router: events + time_after 22:00
User: "any more free stuff"    → AI router: events + free + same hood (compound)
User: "more"                   → pre-router: next batch of picks
```

Session state (neighborhood, last picks, last filters) persists for 2 hours per phone number, enabling these follow-up flows without the user repeating context.

## Architecture

All application source lives under `src/`. Scripts and eval runners are at root level in `scripts/`.

```
Daily scrape (10am ET)         Incoming SMS
        │                           │
        ▼                           ▼
   sources/                    handler.js
   (18 scrapers)               (TCPA opt-out,
        │                       dedup, cost budget)
        │                           │
        ├─► venues.js          pre-router.js ◄─── session.js
        │   (auto-learn         (deterministic      (12 fields,
        │    coords,             intent match)       2hr TTL)
        │    persist)                │
        ▼                   match? ──┤── no match
   events.js                    │        │
   (cache, dedup,               │    ai.js/routeMessage
    source health)              │    (Gemini / Haiku)
        │                       │        │
        │         ┌─────────────┴────────┘
        │         ▼
        │   intent-handlers.js
        │   (dispatch: help, details, more,
        │    free, nudge_accept, events)
        │              │
        └──────►  curation.js
                  (filter kids, incomplete,
                   validate perennials)
                       │
                  skills/ + prompts.js
                  (compose prompt assembly,
                   12 conditional modules)
                       │
                  ai.js/composeResponse
                  (Claude Haiku)
                       │
                  formatters.js (480-char)
                       │
                  twilio.js (send SMS)

──── observability ────
traces.js — per-request JSONL + 200-trace ring buffer
alerts.js — email alerts via Resend (health + runtime)

──── offline eval ────
evals/     — code checks, LLM judges, extraction audit
scripts/   — pipeline, scenario, regression, A/B evals
```

## File Map

All paths are relative to `src/` unless prefixed with a directory.

**Core request handling:**

| File | Purpose |
|------|---------|
| `server.js` | Express setup, routes, health check, daily schedule, graceful shutdown |
| `handler.js` | Twilio webhook, TCPA opt-out (STOP/UNSUBSCRIBE/CANCEL/QUIT), dedup, per-user daily cost budget ($0.10/day), intent dispatch to `intent-handlers.js` |
| `pre-router.js` | Deterministic intent matching — greetings, details, more, free, bare neighborhoods, boroughs, and session-aware follow-up filters (category/time/vibe) |
| `intent-handlers.js` | Intent dispatch — `handleHelp`, `handleConversational`, `handleDetails`, `handleMore`, `handleFree`, `handleNudgeAccept`, `handleEventsDefault`; each receives context and orchestrates event fetching, filtering, compose, session writes, and trace finalization |
| `session.js` | Per-phone session store with 2hr TTL — 12 fields: `lastPicks`, `lastEvents`, `lastNeighborhood`, `lastFilters`, `conversationHistory`, `allPicks`, `allOfferedIds`, `visitedHoods`, `pendingNearby`, `pendingNearbyEvents`, `pendingFilters`, `pendingMessage` |

**AI & prompts:**

| File | Purpose |
|------|---------|
| `ai.js` | 3 AI calls: `routeMessage` (Gemini Flash or Claude Haiku), `composeResponse` (Claude Haiku), `extractEvents` (Claude Haiku) |
| `prompts.js` | System prompts for routing, composition, extraction, and details — centralized prompt strings used by `ai.js` |
| `skills/build-compose-prompt.js` | Dynamic compose prompt assembly — `buildComposePrompt(events, options)` conditionally appends skill modules based on context |
| `skills/compose-skills.js` | 12 composable prompt fragments: `core`, `tonightPriority`, `sourceTiers`, `neighborhoodMismatch`, `perennialFraming`, `venueFraming`, `lastBatch`, `freeEmphasis`, `activityAdherence`, `conversationAwareness`, `pendingIntent` |

**Event data:**

| File | Purpose |
|------|---------|
| `events.js` | Daily event cache, source health tracking, cross-source dedup, venue persistence, `getEvents()` |
| `curation.js` | Pre-compose deterministic filters — `filterKidsEvents` (drops NYC Parks children's events), `filterIncomplete` (below completeness threshold), `validatePerennialActivity` (removes bare-venue perennials) |
| `perennial.js` | Perennial picks loader — `getPerennialPicks(hood, opts)`, caches JSON, filters by day, checks adjacent neighborhoods |
| `venues.js` | Shared venue coord map, auto-learning from sources, Nominatim geocoding fallback, persistence (export/import learned venues) |
| `geo.js` | `resolveNeighborhood`, proximity ranking, haversine, time filtering |
| `neighborhoods.js` | 36 NYC neighborhoods with coords, aliases, landmarks, subway stops |

**Output:**

| File | Purpose |
|------|---------|
| `formatters.js` | SMS formatting — `formatTime`, `cleanUrl`, `formatEventDetails` (480-char cap) |
| `twilio.js` | `sendSMS` with timeout, test capture mode for simulator |

**Observability:**

| File | Purpose |
|------|---------|
| `traces.js` | Request trace capture — `startTrace`/`saveTrace` write per-request JSONL to `data/traces/` (daily rotation, 4-file max) + 200-entry in-memory ring buffer for eval UI |
| `alerts.js` | Email health/runtime alerts via Resend — `sendHealthAlert` (scrape failures, 6hr cooldown), `sendRuntimeAlert` (slow responses/errors, 30min per-type cooldown); no-ops if `RESEND_API_KEY` unset |
| `eval.js` | LLM-as-judge event quality scorer — `scoreEvents` batches events to Claude Sonnet, returns score 1-10 with flags (`stale`, `missing_venue`, `no_time`, `touristy`, `vague`, `duplicate`) |
| `extraction-capture.js` | Lightweight extraction input capture — stores raw text before `extractEvents()` for audit verification |

**Sources:**

| File | Purpose |
|------|---------|
| `sources/` | 18 scrapers split into individual modules with barrel `index.js` |
| `sources/shared.js` | `FETCH_HEADERS`, `makeEventId`, `normalizeExtractedEvent` |
| `sources/skint.js` | Skint (HTML→Claude extraction) |
| `sources/eventbrite.js` | Eventbrite (JSON-LD + __SERVER_DATA__), Comedy, Arts — 5 functions, 2 internal parsers |
| `sources/songkick.js` | Songkick (JSON-LD) |
| `sources/dice.js` | Dice (__NEXT_DATA__ JSON) |
| `sources/ra.js` | Resident Advisor (GraphQL) |
| `sources/nyc-parks.js` | NYC Parks (Schema.org) |
| `sources/brooklynvegan.js` | BrooklynVegan (DoStuff JSON) |
| `sources/nonsense.js` | Nonsense NYC (Gmail newsletter→Claude extraction, split by day) |
| `sources/ohmyrockness.js` | Oh My Rockness (HTML→Claude extraction) |
| `sources/donyc.js` | DoNYC (Cheerio HTML scraping — music, comedy, theater) |
| `sources/bam.js` | BAM (JSON API — film, theater, music, dance) |
| `sources/smallslive.js` | SmallsLIVE (AJAX HTML — jazz at Smalls + Mezzrow) |
| `sources/nypl.js` | NYPL (Eventbrite organizer pages — free library events) |
| `sources/ticketmaster.js` | Ticketmaster Discovery API (indie filter: large-venue blocklist + $100 price cap) |
| `sources/yutori.js` | Yutori (Gmail API + file-based agent briefings → Claude extraction) |
| `sources/tavily.js` | Tavily (web search fallback) |
| `gmail.js` | Gmail OAuth client — `getGmailService`, `fetchYutoriEmails`, `fetchEmails` (generic sender query) |

**Evals & scripts** (paths from project root):

| File | Purpose |
|------|---------|
| `src/evals/code-evals.js` | 9 deterministic trace checks — char limit, valid intent/neighborhood, picked events exist, valid URLs; free and instant |
| `src/evals/extraction-audit.js` | Extraction fidelity — Tier 1 deterministic checks (evidence quotes in source) + Tier 2 LLM judge (optional) |
| `src/evals/judge-evals.js` | LLM-as-judge trace quality — `judgeTone` (sounds like a friend, not a bot) + `judgePickRelevance` (events match request); binary PASS/FAIL |
| `src/evals/expectation-evals.js` | Test-case assertion runner — compares trace fields against expected intent, neighborhood, has_events, must_not banned phrases |
| `scripts/run-evals.js` | Pipeline eval runner (code evals on stored traces, `--judges` flag for LLM judges) |
| `scripts/run-scenario-evals.js` | Multi-turn scenario evals |
| `scripts/run-regression-evals.js` | Behavioral regression tests |
| `scripts/run-ab-eval.js` | A/B model comparison |
| `scripts/gen-synthetic.js` | Generate synthetic test scenarios for eval |
| `scripts/judge-alignment.js` | Judge alignment checks — validates LLM judge consistency |
| `scripts/gmail-auth.js` | Gmail OAuth token acquisition |

**UI:**

| File | Purpose |
|------|---------|
| `test-ui.html` | Browser-based SMS simulator for testing (served at `/test`) |
| `health-ui.html` | Source health dashboard — per-source timing, status, history sparklines, extraction quality (served at `/health`) |
| `eval-ui.html` | Eval results dashboard — trace viewer with eval scores (served at `/evals`) |

## Env Vars

Required:
- `TWILIO_ACCOUNT_SID` — Twilio account SID
- `TWILIO_AUTH_TOKEN` — Twilio auth token
- `TWILIO_PHONE_NUMBER` — Twilio phone number (sender)
- `ANTHROPIC_API_KEY` — Claude API key
- `TAVILY_API_KEY` — Tavily API key (required at boot but not used in hot path)

Optional:
- `PORT` — Server port (default: 3000)
- `PULSE_TEST_MODE=true` — Enables `/test` simulator UI and `/api/sms/test` endpoint
- `PULSE_AI_ROUTING=false` — Disable AI routing (unused now that legacy is removed)
- `GEMINI_API_KEY` — Google Gemini API key (optional; enables Gemini Flash for routing — ~10x cheaper than Haiku)
- `PULSE_ROUTE_PROVIDER` — Routing provider: "gemini" or "anthropic" (default: "gemini" if GEMINI_API_KEY set, else "anthropic")
- `PULSE_MODEL_ROUTE` — Claude model for routing (default: claude-haiku-4-5-20251001, used when provider=anthropic)
- `PULSE_MODEL_ROUTE_GEMINI` — Gemini model for routing (default: gemini-2.5-flash)
- `PULSE_MODEL_COMPOSE` — Claude model for composition (default: claude-haiku-4-5-20251001)
- `PULSE_MODEL_EXTRACT` — Claude model for extraction (default: claude-haiku-4-5-20251001)
- `TICKETMASTER_API_KEY` — Ticketmaster Discovery API key (optional; scraper returns [] if missing)
- `GMAIL_CLIENT_ID` — Google OAuth client ID (optional; Yutori falls back to file-based if missing)
- `GMAIL_CLIENT_SECRET` — Google OAuth client secret
- `GMAIL_REFRESH_TOKEN` — Gmail refresh token (run `scripts/gmail-auth.js` to obtain)
- `RESEND_API_KEY` — Resend API key for email alerts (optional; alerts no-op if unset)
- `ALERT_EMAIL` — Alert recipient email address

## Running Locally

```bash
cp .env.example .env   # fill in your keys
npm install
npm start              # boots on PORT (default 3000)
npm run dev            # dev server with file-watch reload
npm test               # runs smoke tests (pure functions only, no API calls)
npm run eval           # code evals on stored traces (no API calls)
npm run eval:judges    # code evals + LLM judge evals (costs API tokens)
npm run eval:gen       # generate synthetic test scenarios
```

## Testing on Railway

- Simulator: `https://web-production-c8fdb.up.railway.app/test`
- Test endpoint: `POST /api/sms/test` with `Body` and optional `From` params
- Health check: `GET /` returns cache status and source health
- Health dashboard: `GET /health` returns HTML dashboard (or JSON with `?json=1` / `Accept: application/json`)
- Eval how-to: `docs/eval-howto.md` — end-to-end guide for running all eval layers

## Key Design Decisions

- **Two-tier routing**: Common patterns (greetings, neighborhoods, "more", follow-up filters) are handled deterministically by the pre-router at zero latency and zero AI cost. Only ambiguous or compound messages reach the AI router. This keeps ~60% of messages off the AI path while still supporting natural conversation.
- **Conversational UX**: Users text naturally — no slash commands or rigid syntax. The router (pre-router + AI) figures out intent, neighborhood, and filters. Follow-up messages like "how about comedy" or "later tonight" modify filters on the active session rather than starting over.
- **Daily cache**: Events are scraped once at 10am ET and cached in memory. Incoming messages read from cache — no scraping in the hot path.
- **Two-call AI flow**: Call 1 routes intent + neighborhood. Call 2 picks events + writes the SMS. This keeps each call focused and fast. Both calls use Haiku — A/B eval showed Haiku matches or beats Sonnet on compose quality (71% preference, 89% tone pass) at 73% lower cost.
- **No Tavily in hot path**: Tavily was removed from the live request path. All event data comes from the daily scrape.
- **Cross-source dedup**: Event IDs are hashed from name + venue + date (not source), so the same event from Dice and BrooklynVegan merges automatically. Sources are processed in weight order, so the higher-trust version wins.
- **Source trust** (weight 0.6-0.9): Controls dedup merge order — higher-weight source wins when the same event appears in multiple sources. Skint (0.9) = Nonsense NYC (0.9) > RA (0.85) = Oh My Rockness (0.85) > Dice (0.8) = BrooklynVegan (0.8) = BAM (0.8) = SmallsLIVE (0.8) = Yutori (0.8) > NYC Parks (0.75) = DoNYC (0.75) = Songkick (0.75) = Ticketmaster (0.75) > Eventbrite (0.7) = NYPL (0.7) > Tavily (0.6). Not visible to compose Claude.
- **Event quality gates** (`extraction_confidence` + `completeness` + `needs_review`): Hard filter in `getEvents()` — events below 0.4 confidence, flagged needs_review, or below 0.4 completeness are dropped before reaching compose Claude. Structured sources (Dice, Eventbrite, etc.) have null confidence and pass through. Extracted sources (Skint, Nonsense NYC, etc.) get 0-1 confidence from the extraction prompt.
- **Source tiers** (unstructured/primary/secondary): Soft signal passed to compose Claude via `source_tier` field. Claude prefers unstructured and primary over secondary when choosing between similar events. `extraction_confidence` is also passed as a soft signal for tie-breaking.
- **Venue auto-learning**: Sources with lat/lng (BrooklynVegan, Dice, Songkick, Eventbrite, Ticketmaster) teach venue coords to the shared venue map at scrape time. This helps sources without geo data (RA, Skint, Nonsense NYC) resolve neighborhoods.
- **Venue persistence**: Learned venues are saved to `data/venues-learned.json` after each scrape and loaded on boot, so knowledge compounds across restarts.
- **Session-aware follow-ups**: The session stores `lastFilters` alongside picks and neighborhood, so the router sees what the user already asked for. This lets follow-ups like "how about theater" or "later tonight" modify the active session rather than being misclassified as conversational. The pre-router catches simple filter changes deterministically; the AI router handles compound requests ("any more free comedy stuff") with few-shot examples.
- **480-char SMS limit**: All responses are capped at 480 chars. Claude is prompted to write concisely.
- **TCPA opt-out compliance**: Messages starting with STOP, UNSUBSCRIBE, CANCEL, or QUIT are silently dropped (no reply sent). Twilio manages the actual opt-out list; Pulse ensures no response leaks through.
- **Per-user daily AI budget**: Each phone number gets $0.10/day of AI spend. `trackAICost` accumulates per-user cost with provider-aware pricing (Haiku vs Gemini). `isOverBudget` blocks further AI calls with a friendly message. Resets daily (NYC timezone).
- **Composable prompt skills**: The compose prompt is assembled dynamically from 12 conditional skill modules (`skills/compose-skills.js`). `build-compose-prompt.js` selects which skills to include based on context — tonight priority, neighborhood mismatch, perennial framing, free emphasis, conversation awareness, etc.
- **Request tracing**: Every request writes a JSONL trace to `data/traces/` (daily rotation, 4-file max). A 200-entry in-memory ring buffer powers the eval UI. Traces capture intent, neighborhood, picked events, AI costs, timing, and the full SMS response.
- **Intent dispatch separation**: `handler.js` handles TCPA, dedup, budget, and routing. `intent-handlers.js` handles the actual intent logic (7 handlers). This keeps handler.js focused on request lifecycle and intent-handlers.js focused on business logic.
