# Pulse SMS

Pulse is an SMS-based AI assistant that recommends NYC nightlife and events. Text a neighborhood and get curated picks via Twilio, powered by Claude.

## Architecture

```
Daily scrape (10am ET)     Incoming SMS
        │                       │
        ▼                       ▼
   sources.js              handler.js
   (Skint, RA, Dice,       (webhook, dedup,
    Eventbrite, Songkick)   sessions)
        │                       │
        ▼                       │
   events.js ◄──────────────────┤
   (cache, filter,              │
    rank by proximity)          ▼
                            ai.js
                            ├─ routeMessage  (intent + neighborhood)
                            ├─ composeResponse (pick events + write SMS)
                            └─ extractEvents (parse Skint HTML → events)
                                    │
                                    ▼
                               twilio.js
                               (send SMS)
```

## File Map

| File | Purpose |
|------|---------|
| `server.js` | Express setup, routes, health check, daily schedule, graceful shutdown |
| `handler.js` | Twilio webhook, dedup, rate limiter, sessions, message dispatcher, AI flow |
| `ai.js` | 3 Claude calls: `routeMessage`, `composeResponse`, `extractEvents` |
| `events.js` | Daily event cache, source health tracking, `getEvents()` |
| `sources.js` | Scrapers: The Skint (HTML→Claude), RA (GraphQL), Dice (__NEXT_DATA__), Eventbrite (JSON-LD), Songkick (JSON-LD) |
| `twilio.js` | `sendSMS` with timeout, test capture mode for simulator |
| `geo.js` | `resolveNeighborhood`, proximity ranking, haversine, time filtering |
| `neighborhoods.js` | 25 NYC neighborhoods with coords, aliases, landmarks, subway stops |
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
- `PULSE_MODEL_ROUTE` — Claude model for routing (default: claude-sonnet-4-5-20250929)
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
- **No Tavily in hot path**: Tavily was removed from the live request path. All event data comes from the daily scrape (Skint, RA, Dice, Eventbrite, Songkick).
- **Source trust hierarchy**: Skint (0.9) > RA (0.85) > Dice (0.8) > Songkick (0.75) > Eventbrite (0.7). Claude is told to prefer higher-trust sources.
- **480-char SMS limit**: All responses are capped at 480 chars. Claude is prompted to write concisely.
