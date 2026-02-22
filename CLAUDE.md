# Pulse SMS

Pulse is an SMS-based AI assistant that recommends NYC nightlife and events. Text a neighborhood and get curated picks via Twilio, powered by Claude.

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
   (18 scrapers)                    (TCPA opt-out, dedup,        $0
        │                            cost budget check)
        │                                │
        ├─► venues.js              pre-router.js ◄── session.js
        │   (auto-learn             (mechanical        (12 fields,
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
                       (12 conditional modules)
                              │
                              ▼
                       handler saves                    $0
                       activeFilters → lastFilters
                       (deterministic, not LLM-derived)
                              │
                       formatters.js (480-char)
                              │
                       twilio.js (send SMS)            ~$0.008

──── observability ────
traces.js — per-request JSONL + 200-trace ring buffer
alerts.js — email alerts via Resend (health + runtime)

──── offline eval ────
evals/     — code checks, LLM judges, extraction audit
scripts/   — pipeline, scenario, regression, A/B evals
```

**Cost per message:**

| Path | AI calls | AI cost | Twilio | Total |
|------|----------|---------|--------|-------|
| Mechanical shortcut (help, 1-5, more, greetings) | 0 | $0 | ~$0.008 | ~$0.008 |
| Details (with AI-composed detail card) | 1 Haiku | ~$0.001 | ~$0.008 | ~$0.009 |
| Filter follow-up ("how about comedy") | 1 Haiku | ~$0.001 | ~$0.008 | ~$0.009 |
| Neighborhood / compound / semantic | 1 Haiku | ~$0.001 | ~$0.008 | ~$0.009 |

Typical 5-message session: ~$0.004 AI + ~$0.040 Twilio = ~$0.044 total. Well under $0.10/day budget.

## File Map

All paths are relative to `src/` unless prefixed with a directory.

**Core request handling:**

| File | Purpose |
|------|---------|
| `server.js` | Express setup, routes, health check, daily schedule, graceful shutdown |
| `handler.js` | Twilio webhook, TCPA opt-out (STOP/UNSUBSCRIBE/CANCEL/QUIT), dedup, per-user daily cost budget ($0.10/day). Orchestrates the full pipeline: pre-router → filter resolution (`mergeFilters`) → tagged pool (`buildTaggedPool`) → unified LLM call → deterministic session save (`activeFilters` as `lastFilters`). Handles `clear_filters` intent by wiping filter state before unified branch. |
| `pre-router.js` | Deterministic intent matching (~15% of messages) — help, numbers 1-5, more, event name match, greetings/thanks/bye. Session-aware filter detection (category/time/vibe/free) returns `intent: 'events'` with detected filters for handler injection. `clear_filters` intent when user explicitly drops filters ("forget the comedy", "show me everything"). Everything else returns `null` → unified LLM. |
| `intent-handlers.js` | Mechanical intent handlers — `handleHelp`, `handleConversational`, `handleDetails`, `handleMore`. Each receives context and handles response + session writes. Only used for pre-router mechanical shortcuts; all semantic messages go through `unifiedRespond`. |
| `session.js` | Per-phone session store with 2hr TTL — 12 fields: `lastPicks`, `lastEvents`, `lastNeighborhood`, `lastFilters`, `conversationHistory`, `allPicks`, `allOfferedIds`, `visitedHoods`, `pendingNearby`, `pendingNearbyEvents`, `pendingFilters`, `pendingMessage` |

**AI & prompts:**

| File | Purpose |
|------|---------|
| `ai.js` | AI calls: `unifiedRespond` (Claude Haiku — single call for routing + composition, receives tagged event pool with `[MATCH]` tags, `ACTIVE_FILTER`/`SPARSE` context, returns `clear_filters` boolean), `composeResponse` (Claude Haiku — used by handleMore), `extractEvents` (Claude Haiku — scrape-time extraction), `routeMessage` (legacy, still used by handleMore) |
| `prompts.js` | System prompts: `UNIFIED_SYSTEM` (primary — understanding + composition + filter-aware selection rules + `clear_filters` schema), `COMPOSE_SYSTEM` (used by handleMore), `ROUTE_SYSTEM`, `EXTRACTION_PROMPT`, `DETAILS_SYSTEM` |
| `skills/build-compose-prompt.js` | Dynamic prompt assembly — `buildUnifiedPrompt(events, options)` assembles `UNIFIED_SYSTEM` + conditional skill modules, `buildComposePrompt(events, options)` does the same for the compose-only flow |
| `skills/compose-skills.js` | 12 composable prompt fragments: `core`, `tonightPriority`, `sourceTiers`, `neighborhoodMismatch`, `perennialFraming`, `venueFraming`, `lastBatch`, `freeEmphasis`, `activityAdherence`, `conversationAwareness`, `nearbySuggestion`, `pendingIntent` |

**Event data:**

| File | Purpose |
|------|---------|
| `events.js` | Daily event cache with disk persistence (`data/events-cache.json`), source health tracking, cross-source dedup, venue persistence, scrape-time date filtering (today through 7 days out) + kids filtering, `getEvents()`, `isCacheFresh()` (skips startup scrape when <20hr old) |
| `curation.js` | Pre-compose deterministic filters — `filterKidsEvents` (drops children's events from all sources), `filterIncomplete` (below completeness threshold), `validatePerennialActivity` (removes bare-venue perennials) |
| `pipeline.js` | Event pipeline — `mergeFilters` (compounds filters: incoming truthy values override, falsy fall back to existing), `buildTaggedPool` (returns `{pool, matchCount, isSparse}` with `[MATCH]`-tagged events first, padded to 15), `eventMatchesFilters` (checks category/free/time with after-midnight wrapping), `applyFilters` (legacy soft-mode filtering), `resolveActiveFilters`, `saveResponseFrame` (atomic session writes), `buildExhaustionMessage` |
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
| `sources/skint.js` | Skint (HTML→Claude extraction, skips past-day sections, resolves day headers to explicit dates) |
| `sources/eventbrite.js` | Eventbrite (JSON-LD + __SERVER_DATA__), Comedy, Arts — 5 functions, 2 internal parsers |
| `sources/songkick.js` | Songkick (JSON-LD) |
| `sources/dice.js` | Dice (__NEXT_DATA__ JSON) |
| `sources/ra.js` | Resident Advisor (GraphQL) |
| `sources/nyc-parks.js` | NYC Parks (Schema.org) |
| `sources/brooklynvegan.js` | BrooklynVegan (DoStuff JSON) |
| `sources/nonsense.js` | Nonsense NYC (Gmail newsletter→Claude extraction, split by day, caches events alongside newsletter ID for inter-scrape reuse) |
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
| `public/test-ui.js` | Client-side JS for the SMS simulator |
| `health-ui.html` | Source health dashboard — per-source timing, status, history sparklines, extraction quality (served at `/health`) |
| `eval-ui.html` | Eval results dashboard — trace viewer with eval scores (served at `/evals`) |
| `events-ui.html` | Event browser/explorer UI (served at `/events`) |

**Site** (GitHub Pages, `site/` directory — deployed to `gh-pages` branch):

| File | Purpose |
|------|---------|
| `site/index.html` | Landing page with live demo (connects to Railway test endpoint) |
| `site/architecture.html` | Public architecture overview (not linked from nav, direct URL only) |
| `site/privacy.html` | Privacy policy |
| `site/terms.html` | Terms of service |
| `site/evals.html` | Eval system overview |

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
- `GEMINI_API_KEY` — Google Gemini API key (optional; used as fallback provider for routing in legacy `routeMessage` path)
- `PULSE_ROUTE_PROVIDER` — Routing provider for legacy path: "gemini" or "anthropic" (default: "gemini" if GEMINI_API_KEY set)
- `PULSE_MODEL_ROUTE` — Claude model for legacy routing (default: claude-haiku-4-5-20251001)
- `PULSE_MODEL_ROUTE_GEMINI` — Gemini model for legacy routing (default: gemini-2.5-flash)
- `PULSE_MODEL_COMPOSE` — Claude model for composition (default: claude-haiku-4-5-20251001)
- `PULSE_MODEL_EXTRACT` — Claude model for extraction (default: claude-haiku-4-5-20251001)
- `TICKETMASTER_API_KEY` — Ticketmaster Discovery API key (optional; scraper returns [] if missing)
- `GMAIL_CLIENT_ID` — Google OAuth client ID (optional; Yutori falls back to file-based if missing)
- `GMAIL_CLIENT_SECRET` — Google OAuth client secret
- `GMAIL_REFRESH_TOKEN` — Gmail refresh token (run `scripts/gmail-auth.js` to obtain)
- `RESEND_API_KEY` — Resend API key for email alerts (optional; alerts no-op if unset)
- `ALERT_EMAIL` — Alert recipient email address
- `PULSE_NO_RATE_LIMIT=true` — Disable test endpoint rate limiting (30 req/hr/IP default)

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

- **Pre-router + unified LLM**: The pre-router handles ~15% of messages (mechanical shortcuts) at zero AI cost. Everything semantic — neighborhoods, compound requests, off-topic, nudge accepts — goes through a single `unifiedRespond` Claude Haiku call (~$0.001) that both understands intent AND composes the SMS response. Simple filter follow-ups ("how about comedy") are detected by the pre-router and injected into the unified branch as `preDetectedFilters`, so the LLM sees them in the tagged event pool.
- **Tagged event pool + deterministic filter state**: The handler owns all filter state. `mergeFilters(lastFilters, preDetectedFilters)` compounds filters across turns. `buildTaggedPool(events, activeFilters)` tags matching events with `[MATCH]` (up to 10 matched first, padded to 15 with unmatched) and provides `matchCount` + `isSparse` flag. The LLM receives the tagged pool and FILTER-AWARE SELECTION rules — it composes from what it sees but never manages filter state. After the LLM responds, the handler saves `activeFilters` as `lastFilters` (not the LLM's guess). This fixes filter drift across neighborhood switches without over-narrowing event pools.
- **Conversational UX**: Users text naturally — no slash commands or rigid syntax. Follow-up messages like "how about comedy" or "later tonight" compound with existing filters rather than replacing them. Filters persist across neighborhood switches ("try bushwick" keeps the comedy filter). Users can clear filters explicitly ("forget the comedy") via pre-router regex, or semantically ("just show me what's good") via the LLM's `clear_filters: true` response field.
- **Daily cache with disk persistence**: Events are scraped once at 10am ET and cached in memory + persisted to `data/events-cache.json`. On boot, the persisted cache loads instantly. If the cache is <20 hours old (`isCacheFresh()`), the startup scrape is skipped entirely. This avoids the ~8-minute cold start on Railway redeploys. A Railway volume at `/app/data` ensures the cache survives across deploys.
- **Single-call AI flow**: `unifiedRespond` handles both routing and composition in one Claude Haiku call. This replaced the old two-call flow (route + compose) which had filter state disagreements between calls. A/B eval showed Haiku matches or beats Sonnet on compose quality (71% preference, 89% tone pass) at 73% lower cost. The `handleMore` path still uses the legacy `composeResponse` two-call flow.
- **No Tavily in hot path**: Tavily was removed from the live request path. All event data comes from the daily scrape.
- **Cross-source dedup**: Event IDs are hashed from name + venue + date (not source), so the same event from Dice and BrooklynVegan merges automatically. Sources are processed in weight order, so the higher-trust version wins.
- **Source trust** (weight 0.6-0.9): Controls dedup merge order — higher-weight source wins when the same event appears in multiple sources. Skint (0.9) = Nonsense NYC (0.9) > RA (0.85) = Oh My Rockness (0.85) > Dice (0.8) = BrooklynVegan (0.8) = BAM (0.8) = SmallsLIVE (0.8) = Yutori (0.8) > NYC Parks (0.75) = DoNYC (0.75) = Songkick (0.75) = Ticketmaster (0.75) > Eventbrite (0.7) = NYPL (0.7) > Tavily (0.6). Not visible to compose Claude.
- **Event quality gates** (`extraction_confidence` + `completeness` + `needs_review`): Hard filter in `getEvents()` — events below 0.4 confidence, flagged needs_review, or below 0.4 completeness are dropped before reaching compose Claude. Structured sources (Dice, Eventbrite, etc.) have null confidence and pass through. Extracted sources (Skint, Nonsense NYC, etc.) get 0-1 confidence from the extraction prompt.
- **Source tiers** (unstructured/primary/secondary): Soft signal passed to compose Claude via `source_tier` field. Claude prefers unstructured and primary over secondary when choosing between similar events. `extraction_confidence` is also passed as a soft signal for tie-breaking.
- **Venue auto-learning**: Sources with lat/lng (BrooklynVegan, Dice, Songkick, Eventbrite, Ticketmaster) teach venue coords to the shared venue map at scrape time. This helps sources without geo data (RA, Skint, Nonsense NYC) resolve neighborhoods.
- **Venue persistence**: Learned venues are saved to `data/venues-learned.json` after each scrape and loaded on boot, so knowledge compounds across restarts.
- **Session-aware follow-ups**: The session stores `lastFilters` alongside picks and neighborhood. The pre-router detects simple filter follow-ups ("how about comedy", "free", "later tonight") and injects them as `preDetectedFilters`. The handler compounds them with existing filters via `mergeFilters`. Compound requests ("any more free comedy stuff") fall through to the unified LLM. Filter clearing uses a hybrid approach: common phrases ("forget the comedy") are caught by pre-router regex, semantic clearing ("just show me what's good") by the LLM's `clear_filters` response field.
- **Scrape-time quality gates**: Events are filtered at scrape time before entering the cache: (1) date window filter keeps only today through 7 days out, (2) kids event filter drops children's/family events from all sources. This keeps the cache focused and reduces noise for compose Claude.
- **480-char SMS limit**: All responses are capped at 480 chars. Claude is prompted to write concisely.
- **TCPA opt-out compliance**: Messages starting with STOP, UNSUBSCRIBE, CANCEL, or QUIT are silently dropped (no reply sent). Twilio manages the actual opt-out list; Pulse ensures no response leaks through.
- **Per-user daily AI budget**: Each phone number gets $0.10/day of AI spend. `trackAICost` accumulates per-user cost with provider-aware pricing (Haiku vs Gemini). `isOverBudget` blocks further AI calls with a friendly message. Resets daily (NYC timezone).
- **Composable prompt skills**: The unified system prompt is assembled dynamically from `UNIFIED_SYSTEM` base + 12 conditional skill modules (`skills/compose-skills.js`). `buildUnifiedPrompt(events, options)` selects which skills to include based on context — tonight priority, neighborhood mismatch, perennial framing, free emphasis, conversation awareness, nearby suggestion, etc. A first-message-to-Williamsburg prompt activates ~5 skills; a follow-up with history activates ~7. This keeps prompts focused (~800 tokens vs ~1,400 with everything on).
- **Request tracing**: Every request writes a JSONL trace to `data/traces/` (daily rotation, 4-file max). A 200-entry in-memory ring buffer powers the eval UI. Traces capture intent, neighborhood, picked events, AI costs, timing, and the full SMS response.
- **Intent dispatch separation**: `handler.js` handles TCPA, dedup, budget, routing, filter resolution, tagged pool building, and the unified LLM call. `intent-handlers.js` handles 4 mechanical intent handlers (help, conversational, details, more). The unified branch in handler.js handles all semantic messages directly.
