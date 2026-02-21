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

```
Daily scrape (10am ET)     Incoming SMS
        │                       │
        ▼                       ▼
   sources/               handler.js
   (18 scrapers:           (webhook, dedup,
    Skint, RA, Dice,        rate limiter,
    Eventbrite, Songkick,   AI orchestrator)
    BrooklynVegan, NYC          │
    Parks, Nonsense NYC,   pre-router.js ◄─── session.js
    Oh My Rockness,        (deterministic       (lastPicks,
    DoNYC, BAM, NYPL,      intent matching:     lastFilters,
    SmallsLIVE, Ticketmaster, greetings, hoods,  lastNeighborhood)
    Yutori, Tavily)          follow-up filters,
        │                    more, free, details)
        │                       │
        │              match? ──┤── no match
        │              │        │
        ├─► venues.js  │    ai.js/routeMessage
        │   (auto-learn │   (Gemini Flash or
        │    coords,    │    Claude Haiku —
        │    persist)   │    semantic routing)
        ▼              │        │
   events.js ◄─────────┴────────┘
   (cache, filter,              │
    rank by proximity,          ▼
    cross-source dedup)     ai.js/composeResponse
                            (pick events +
                             write SMS)
                                │
                            formatters.js
                            (480-char cap)
                                │
                                ▼
                           twilio.js
                           (send SMS)
```

## File Map

| File | Purpose |
|------|---------|
| `server.js` | Express setup, routes, health check, daily schedule, graceful shutdown |
| `handler.js` | Twilio webhook, dedup, rate limiter, message dispatcher, AI orchestrator |
| `pre-router.js` | Deterministic intent matching — greetings, details, more, free, bare neighborhoods, boroughs, and session-aware follow-up filters (category/time/vibe) |
| `session.js` | Per-phone session store with TTL cleanup — lastPicks, lastEvents, lastNeighborhood, lastFilters, conversationHistory |
| `formatters.js` | SMS formatting — `formatTime`, `cleanUrl`, `formatEventDetails` (480-char cap) |
| `ai.js` | 3 Claude calls: `routeMessage`, `composeResponse`, `extractEvents` |
| `events.js` | Daily event cache, source health tracking, cross-source dedup, venue persistence, `getEvents()` |
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
| `gmail.js` | Gmail OAuth client — `getGmailService`, `fetchYutoriEmails`, `fetchEmails` (generic sender query) |
| `sources/tavily.js` | Tavily (web search fallback) |
| `perennial.js` | Perennial picks loader — `getPerennialPicks(hood, opts)`, caches JSON, filters by day, checks adjacent neighborhoods |
| `venues.js` | Shared venue coord map, auto-learning from sources, Nominatim geocoding fallback, persistence (export/import learned venues) |
| `twilio.js` | `sendSMS` with timeout, test capture mode for simulator |
| `geo.js` | `resolveNeighborhood`, proximity ranking, haversine, time filtering |
| `neighborhoods.js` | 36 NYC neighborhoods with coords, aliases, landmarks, subway stops |
| `test-ui.html` | Browser-based SMS simulator for testing (served at `/test`) |
| `extraction-capture.js` | Lightweight extraction input capture — stores raw text before `extractEvents()` for audit verification |
| `evals/extraction-audit.js` | Extraction fidelity audit — Tier 1 deterministic checks (evidence quotes in source) + Tier 2 LLM judge |
| `health-ui.html` | Source health dashboard — per-source timing, status, history sparklines, extraction quality (served at `/health`) |

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

## Running Locally

```bash
cp .env.example .env   # fill in your keys
npm install
npm start              # boots on PORT (default 3000)
npm test               # runs smoke tests (pure functions only, no API calls)
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
- **Source trust hierarchy**: Skint (0.9) = Nonsense NYC (0.9) > RA (0.85) = Oh My Rockness (0.85) > Dice (0.8) = BrooklynVegan (0.8) = BAM (0.8) = SmallsLIVE (0.8) = Yutori (0.8) > NYC Parks (0.75) = DoNYC (0.75) = Songkick (0.75) = Ticketmaster (0.75) > Eventbrite (0.7) = NYPL (0.7) > Tavily (0.6). Claude is told to prefer higher-trust sources.
- **Venue auto-learning**: Sources with lat/lng (BrooklynVegan, Dice, Songkick, Eventbrite, Ticketmaster) teach venue coords to the shared venue map at scrape time. This helps sources without geo data (RA, Skint, Nonsense NYC) resolve neighborhoods.
- **Venue persistence**: Learned venues are saved to `data/venues-learned.json` after each scrape and loaded on boot, so knowledge compounds across restarts.
- **Session-aware follow-ups**: The session stores `lastFilters` alongside picks and neighborhood, so the router sees what the user already asked for. This lets follow-ups like "how about theater" or "later tonight" modify the active session rather than being misclassified as conversational. The pre-router catches simple filter changes deterministically; the AI router handles compound requests ("any more free comedy stuff") with few-shot examples.
- **480-char SMS limit**: All responses are capped at 480 chars. Claude is prompted to write concisely.
