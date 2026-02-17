# Pulse SMS

Pulse is an SMS-based AI assistant that recommends NYC nightlife and events. Text a neighborhood and get curated picks via Twilio, powered by Claude.

## Architecture

```
Daily scrape (10am ET)     Incoming SMS
        │                       │
        ▼                       ▼
   sources/               handler.js
   (13 scrapers:           (webhook, dedup,
    Skint, RA, Dice,        rate limiter,
    Eventbrite, Songkick,   AI orchestrator)
    BrooklynVegan, NYC          │
    Parks, Nonsense NYC,   pre-router.js
    Oh My Rockness,        (deterministic
    DoNYC, Tavily)          intent matching)
        │                       │
        ├─► venues.js      session.js
        │   (auto-learn     (state store)
        │    coords,            │
        │    persist)      formatters.js
        ▼                  (SMS formatting)
   events.js ◄──────────────────┤
   (cache, filter,              │
    rank by proximity,          ▼
    cross-source dedup)     ai.js
                            ├─ routeMessage
                            ├─ composeResponse
                            └─ extractEvents
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
| `pre-router.js` | Deterministic intent matching — greetings, details, more, free, bare neighborhoods, boroughs |
| `session.js` | Per-phone session store with TTL cleanup — lastPicks, lastEvents, lastNeighborhood |
| `formatters.js` | SMS formatting — `formatTime`, `cleanUrl`, `formatEventDetails` (480-char cap) |
| `ai.js` | 3 Claude calls: `routeMessage`, `composeResponse`, `extractEvents` |
| `events.js` | Daily event cache, source health tracking, cross-source dedup, venue persistence, `getEvents()` |
| `sources/` | 13 scrapers split into individual modules with barrel `index.js` |
| `sources/shared.js` | `FETCH_HEADERS`, `makeEventId`, `normalizeExtractedEvent` |
| `sources/skint.js` | Skint (HTML→Claude extraction) |
| `sources/eventbrite.js` | Eventbrite (JSON-LD + __SERVER_DATA__), Comedy, Arts — 5 functions, 2 internal parsers |
| `sources/songkick.js` | Songkick (JSON-LD) |
| `sources/dice.js` | Dice (__NEXT_DATA__ JSON) |
| `sources/ra.js` | Resident Advisor (GraphQL) |
| `sources/nyc-parks.js` | NYC Parks (Schema.org) |
| `sources/brooklynvegan.js` | BrooklynVegan (DoStuff JSON) |
| `sources/nonsense.js` | Nonsense NYC (HTML→Claude extraction) |
| `sources/ohmyrockness.js` | Oh My Rockness (HTML→Claude extraction) |
| `sources/donyc.js` | DoNYC (Cheerio HTML scraping — music, comedy, theater) |
| `sources/tavily.js` | Tavily (web search fallback) |
| `perennial.js` | Perennial picks loader — `getPerennialPicks(hood, opts)`, caches JSON, filters by day, checks adjacent neighborhoods |
| `venues.js` | Shared venue coord map, auto-learning from sources, Nominatim geocoding fallback, persistence (export/import learned venues) |
| `twilio.js` | `sendSMS` with timeout, test capture mode for simulator |
| `geo.js` | `resolveNeighborhood`, proximity ranking, haversine, time filtering |
| `neighborhoods.js` | 36 NYC neighborhoods with coords, aliases, landmarks, subway stops |
| `test-ui.html` | Browser-based SMS simulator for testing (served at `/test`) |

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
- `PULSE_MODEL_ROUTE` — Claude model for routing (default: claude-haiku-4-5-20251001)
- `PULSE_MODEL_COMPOSE` — Claude model for composition (default: claude-sonnet-4-5-20250929)
- `PULSE_MODEL_EXTRACT` — Claude model for extraction (default: claude-sonnet-4-5-20250929)

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

## Key Design Decisions

- **Conversational UX**: Claude routes all messages (no regex commands). Users text naturally; Claude figures out intent, neighborhood, and filters.
- **Daily cache**: Events are scraped once at 10am ET and cached in memory. Incoming messages read from cache — no scraping in the hot path.
- **Two-call AI flow**: Call 1 routes intent + neighborhood. Call 2 picks events + writes the SMS. This keeps each call focused and fast.
- **No Tavily in hot path**: Tavily was removed from the live request path. All event data comes from the daily scrape.
- **Cross-source dedup**: Event IDs are hashed from name + venue + date (not source), so the same event from Dice and BrooklynVegan merges automatically. Sources are processed in weight order, so the higher-trust version wins.
- **Source trust hierarchy**: Skint (0.9) = Nonsense NYC (0.9) > RA (0.85) = Oh My Rockness (0.85) > Dice (0.8) = BrooklynVegan (0.8) > NYC Parks (0.75) = DoNYC (0.75) = Songkick (0.75) > Eventbrite (0.7) > Tavily (0.6). Claude is told to prefer higher-trust sources.
- **Venue auto-learning**: Sources with lat/lng (BrooklynVegan, Dice, Songkick, Eventbrite) teach venue coords to the shared venue map at scrape time. This helps sources without geo data (RA, Skint, Nonsense NYC) resolve neighborhoods.
- **Venue persistence**: Learned venues are saved to `data/venues-learned.json` after each scrape and loaded on boot, so knowledge compounds across restarts.
- **480-char SMS limit**: All responses are capped at 480 chars. Claude is prompted to write concisely.
