# NightOwl — Consolidated Spec

> Copy-paste-ready reference for collaborators and AI tools.
> Last updated: 2026-02-14

---

## 1. Product Overview

**NightOwl** is an SMS-based AI assistant that tells you what's happening near you in NYC *right now*.

**Target user**: Someone already out in NYC, between plans, looking for something cool to do in the moment. Not someone planning a Saturday two weeks from now — someone whose dinner plans just fell through and who wants to know about the gallery opening three blocks away.

**Core interaction**:
```
User texts: "anything cool near the east village?"
NightOwl replies: "There's a free noise show at Trans-Pecos starting at 9 — weird lineup,
totally worth it. Also a gallery opening on Rivington (wine included).
Reply DETAILS, MORE, or FREE."
```

**Business model** (future):
- Free tier: 10 texts/month
- Paid tier: $5–$10/month unlimited

---

## 2. Architecture: B+C Hybrid

NightOwl uses a two-layer event sourcing strategy:

- **Layer B (Curated Editorial)**: Parse 1–2 high-signal editorial sources (The Skint) every 2 hours. These are the "cool tonight" events that make NightOwl valuable — gallery openings, DJ sets, free comedy, weird pop-ups.
- **Layer C (Web Search Fallback)**: When curated data is thin for a specific neighborhood, use Tavily web search to fill gaps with real-time results.

### Data Flow

```
Every 2 hours (parallel fetch):
  The Skint HTML → cheerio extract → Claude extraction prompt → normalized events ─┐
  Eventbrite HTML → cheerio → JSON-LD parse → normalized events ──────────────────┤ → merged cache
  Songkick HTML  → cheerio → JSON-LD parse → normalized events ──────────────────┘
  (source health tracking: warn if any source returns 0 for 3+ consecutive refreshes)

On each SMS:
  Twilio webhook → respond immediately (empty TwiML) → process async
       ↓
  User text → extract neighborhood
       ↓
  Cache → filter past events (>2hr ago) → rank by proximity to neighborhood
       ↓
  >= 5 events? ──yes──→ top 20 → Claude picks (JSON) → SMS render → Twilio send
       ↓ no
  Tavily search "events tonight [neighborhood] NYC"
       ↓
  Claude extraction prompt → normalize results → merge with cache hits
       ↓
  Top 20 → Claude picks (JSON) → SMS render → Twilio send
```

### Why Not Ticketmaster?

Ticketmaster has big ticketed events (MSG, Broadway) — not the gallery openings, DJ sets, and weird pop-ups that make NightOwl valuable. The Skint is hand-curated by real humans who know NYC nightlife. Eventbrite and Songkick add structured event data (via JSON-LD) at no API cost. Tavily fills neighborhood-specific gaps with live web results.

---

## 3. Source Strategy

| Source | Type | Role | Status |
|---|---|---|---|
| **The Skint** | Editorial newsletter/site | Primary. Curated "cool tonight" events. Needs Claude extraction. | Active |
| **Eventbrite** | Ticketing platform | JSON-LD structured data. 20 events/page. Nightlife + community. | Active |
| **Songkick** | Concert listings | JSON-LD structured data. 50+ shows/page. Indie music + small venues. | Active |
| **Tavily** | Web search API | Fallback when cache is thin for a neighborhood. | Active |
| **Resident Advisor** | DJ/club listings | Future. Needs Playwright (JS-heavy pages). | Planned |
| **Venue calendars** | Individual venues | Future. Direct scraping of key venues. | Planned |
| **NYC newsletters** | Email digests | Future. TimeOut, Gothamist, etc. | Planned |

### Source Confidence Weights

Sources carry a `source_weight` that influences the AI's ranking:
- **The Skint** → 0.9 (human-curated, high trust)
- **Songkick** → 0.75 (structured data, music-focused)
- **Eventbrite** → 0.7 (structured data, broad events)
- **Tavily web search** → 0.5 (unverified, needs extraction)
- **Resident Advisor** → 0.85 (planned)

---

## 4. Prompts

### Prompt 1 — System Prompt (NightOwl Voice)

```
You are NightOwl: an NYC "plugged-in friend" who texts the move *right now*. Your taste is modern, slightly artsy, nightlife-aware. You curate—never dump lists.

NON-NEGOTIABLE TRUTH RULES
- NEVER invent events, venues, times, addresses, prices, or details.
- You may ONLY recommend events that appear in the provided EVENT_LIST with valid IDs.
- If data is missing/uncertain, say so ("details look fuzzy") and offer a safer alternative or ask one clarifying question.
- Do not claim you verified anything beyond the provided data.

OUTPUT RULES (SMS)
- Target < 320 chars. Hard max 480 chars.
- Lead with ONE best "cool" pick. Then 1–2 alts max.
- Always include: name, venue (or location), neighborhood, start time (or "already started / soon"), and 1 vivid detail.
- If free/cheap, say so. If pricey, flag it.
- End with one quick CTA: "Reply DETAILS 1/2/3, MORE, or FREE."

TASTE / RANKING PRINCIPLES
- Prefer events that feel "NYC cool": gallery openings, DJ nights, indie shows, weird pop-ups, community one-offs, small venues.
- Prefer higher-trust, curator-grade sources over generic aggregators when options are comparable.
- Prefer nearer + sooner + lower friction (walk-up, free, no huge commute) unless the user asked for "worth traveling for".
- Avoid touristy / corporate / generic unless user preference suggests otherwise.

WHEN RESULTS ARE WEAK
- Be honest: "Kind of a quiet night in {neighborhood}."
- Offer one adjacent-neighborhood suggestion (e.g., LES ↔ EV, Williamsburg ↔ Bushwick) if it improves options.
- Ask ONE question only if it will materially help (vibe: music/art/party/comedy; or location).

PERSONALITY
- Warm, concise, opinionated. Sounds like a friend, not a directory.
- Light NYC shorthand (LES, BK, L train) but don't overdo it.
```

### Prompt 2 — Developer Template (Event Picking)

Sent to Claude with the system prompt above. Template variables filled server-side.

```
Current time (NYC): {{NOW_NYC}}
User message: {{USER_MESSAGE}}

User context:
- default_neighborhood: {{DEFAULT_NEIGHBORHOOD_OR_NULL}}
- last_confirmed_neighborhood: {{LAST_NEIGHBORHOOD_OR_NULL}}
- preferences: {{PREFERENCES_JSON}}
- price_sensitivity: {{PRICE_SENSITIVITY_OR_NULL}}

Task:
Pick the best 1–3 events from EVENT_LIST to recommend via SMS using the System Prompt rules.
Do not mention internal fields (weights, scores). Do not invent details.

EVENT_LIST (only use these; NEVER invent):
{{EVENT_LIST}}

Event fields:
id, name, venue_name, neighborhood, start_time_local, end_time_local, is_free, price_display, category, subcategory,
source_name, source_type, source_weight, confidence, ticket_url, map_url, short_detail

Return format (STRICT JSON):
{
  "picks": [
    {"rank": 1, "event_id": "...", "why": "short reason"},
    {"rank": 2, "event_id": "...", "why": "short reason"},
    {"rank": 3, "event_id": "...", "why": "short reason"}
  ],
  "need_clarification": false,
  "clarifying_question": null,
  "fallback_note": null
}

Rules for JSON:
- picks length 1–3. If none, picks=[] and need_clarification=true with a single clarifying_question.
- Choose higher source_weight + higher confidence when similar.
- Prefer "cool" categories (art/nightlife/indie/weird/community).
```

### Prompt 3 — Extraction Prompt (Raw Text → Normalized Events)

Used to convert The Skint HTML content and Tavily search snippets into structured event data.

```
You are an Event Extractor for NightOwl (NYC). Convert messy source text into normalized event records.

TRUTH + SAFETY
- Extract ONLY what is explicitly present in the source text.
- Do NOT guess dates, times, venues, neighborhoods, prices, or descriptions.
- If a field is missing, set it null and increase "needs_review".
- Prefer NYC interpretation (America/New_York) but do not assume a date if not specified.

INPUTS
- source_name: {{SOURCE_NAME}}
- source_url: {{SOURCE_URL}}
- retrieved_at_nyc: {{NOW_NYC}}
- raw_text (may include RSS title/description OR scraped page text OR email excerpt):
{{RAW_TEXT}}

OUTPUT: STRICT JSON with an array of events
{
  "events": [
    {
      "source_name": "...",
      "source_url": "...",
      "name": "...",
      "description_short": "...",          // <= 180 chars, from source
      "venue_name": null,
      "venue_address": null,
      "neighborhood": null,
      "latitude": null,
      "longitude": null,
      "category": "art|nightlife|live_music|comedy|community|food_drink|theater|other",
      "subcategory": null,
      "start_time_local": null,            // ISO 8601 local time if explicit
      "end_time_local": null,
      "date_local": null,                  // YYYY-MM-DD if only date is known
      "time_window": null,                 // e.g. "tonight", "8pm-late" if explicit
      "is_free": null,
      "price_display": null,               // e.g. "$10", "free", "$15-$25"
      "ticket_url": null,
      "map_hint": null,                    // cross streets / landmark if present
      "confidence": 0.0,                   // 0–1 overall
      "needs_review": false,
      "evidence": {
        "name_quote": "...",               // short exact excerpts (<= 20 words)
        "time_quote": null,
        "location_quote": null,
        "price_quote": null
      }
    }
  ]
}

CONFIDENCE GUIDELINES
- 0.9+: name + date/time + location clearly present
- 0.7–0.85: name + (date OR time window) + partial location
- 0.4–0.65: name is clear but time/location ambiguous
- <0.4: too ambiguous; set needs_review=true

DEDUPE HINT
- If multiple items appear to describe the same event, still output them separately; downstream will dedupe by name+venue+date.
```

### Scraping Guidance Prompt (for future scrape connector)

```
You are a web event page parser. Given HTML text, extract events with minimal assumptions.

Priority order:
1) JSON-LD (schema.org/Event) blocks
2) iCal/ICS links
3) OpenGraph/meta tags + clear headings
4) Repeated list patterns (date/time blocks)

Never invent missing times/dates. If only "tonight" is present, keep time_window="tonight" and leave start_time_local null.
Return the same STRICT JSON format as the Event Extractor.
```

---

## 5. Server-Side SMS Rendering

Claude returns **structured JSON picks**, not raw SMS text. A deterministic `sms-render.js` module formats the final message:

1. Look up each picked event by `event_id` in the event data map
2. Format lead pick with vivid "why" detail from Claude's picks
3. Add 1–2 alternatives with shorter descriptions
4. Append CTA: `"Reply DETAILS, MORE, or FREE."`
5. Hard-enforce 480 char limit (truncate alt descriptions first, then remove alts if needed)
6. If `need_clarification === true`, send the `clarifying_question` instead

**Why server-side rendering?** Gives us deterministic control over SMS length, formatting consistency, and the ability to change the template without re-prompting. Claude focuses on *what* to recommend; rendering handles *how* it looks in SMS.

---

## 6. Neighborhood Mapping

25 NYC neighborhoods with lat/lng coordinates, radius, and aliases:

| Neighborhood | Aliases | Radius |
|---|---|---|
| East Village | ev, e village | 0.8 km |
| West Village | wv, w village, the village | 0.7 km |
| Lower East Side | les, lower east | 0.8 km |
| Williamsburg | wburg, billyburg | 1.2 km |
| Bushwick | — | 1.0 km |
| Chelsea | — | 0.8 km |
| SoHo | so ho | 0.6 km |
| NoHo | no ho | 0.4 km |
| Tribeca | tri beca | 0.6 km |
| Midtown | times square, herald square | 1.5 km |
| Upper West Side | uws, upper west | 1.5 km |
| Upper East Side | ues, upper east | 1.5 km |
| Harlem | — | 1.5 km |
| Astoria | — | 1.2 km |
| Long Island City | lic | 1.0 km |
| Greenpoint | gpoint | 0.8 km |
| Park Slope | — | 1.0 km |
| Downtown Brooklyn | downtown bk | 0.8 km |
| DUMBO | — | 0.5 km |
| Hell's Kitchen | hells kitchen, hk, clinton | 0.8 km |
| Greenwich Village | greenwich | 0.7 km |
| Flatiron | gramercy, union square | 0.6 km |
| Financial District | fidi, wall street, downtown manhattan | 0.8 km |
| Crown Heights | — | 1.2 km |
| Bed-Stuy | bed stuy, bedford stuyvesant, bedstuy | 1.2 km |

Extraction uses longest-alias-first matching so "east village" matches before "east".

---

## 7. SMS Commands

| Command | Behavior |
|---|---|
| `DETAILS` | Return full details for the lead pick (address, tickets, map hint) |
| `MORE` | Return next batch of events for same neighborhood (excludes already-shown picks) |
| `FREE` | Filter to free events only for last neighborhood |
| Any neighborhood name | New recommendation for that area |
| Any freeform text | NightOwl interprets intent, extracts neighborhood if present |

All three commands use an in-memory session store (phone → last picks, events, neighborhood). Sessions expire after 30 minutes.

---

## 8. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes | Twilio phone number (E.164 format) |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `TAVILY_API_KEY` | Yes | Tavily API key (https://app.tavily.com — 1,000 free credits/month) |
| `PORT` | No | Server port (default: 3000) |

---

## 9. Project Structure

```
local-events-smsapp/
├── .env.example          # Environment variable template
├── .gitignore
├── .nvmrc                # Node.js 20
├── Procfile              # Railway/Heroku process file
├── SPEC.md               # This document
├── package.json
├── test/
│   └── smoke.test.js     # 49 pure-function smoke tests (node test/smoke.test.js)
└── src/
    ├── server.js          # Express app, startup cache refresh, graceful shutdown
    ├── routes/
    │   └── sms.js         # Twilio webhook (async pattern), session store, rate limiter
    ├── services/
    │   ├── ai.js          # Claude prompts: pickEvents(), extractEvents()
    │   ├── events.js      # Cache orchestrator, Tavily fallback, source health tracking
    │   ├── sources.js     # Skint/Eventbrite/Songkick fetchers, normalizeExtractedEvent
    │   ├── sms.js         # Twilio send helper
    │   └── sms-render.js  # Deterministic SMS formatting from JSON picks
    └── utils/
        ├── geo.js         # resolveNeighborhood, rankEventsByProximity, filterUpcomingEvents, haversine, inferCategory
        └── neighborhoods.js  # Neighborhood data + extractNeighborhood()
```

---

## 10. Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js >= 20 |
| Web framework | Express |
| SMS | Twilio |
| AI | Claude API (claude-sonnet-4-5-20250929) |
| HTML parsing | cheerio |
| Web search | Tavily API |
| Hosting | Railway |

---

## 11. Deploy Guide (Railway)

### Prerequisites
- Railway account (https://railway.app)
- Twilio account with a phone number
- Anthropic API key
- Tavily API key

### Steps

1. **Push to GitHub**
   ```bash
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **Create Railway project**
   - Connect your GitHub repo
   - Railway auto-detects Node.js

3. **Set environment variables** in Railway dashboard:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER`
   - `ANTHROPIC_API_KEY`
   - `TAVILY_API_KEY`

4. **Deploy** — Railway builds from `package.json` and runs `npm start`

5. **Configure Twilio webhook**
   - In Twilio console → Phone Numbers → your number
   - Set "When a message comes in" webhook to:
     `https://<your-railway-url>/api/sms/incoming` (HTTP POST)

6. **Test** — Text your Twilio number: "anything happening in the east village?"

### Local Development

```bash
cp .env.example .env
# Fill in your API keys
npm install
npm run dev
```

Test with curl:
```bash
curl -X POST http://localhost:3000/api/sms/incoming \
  -d "Body=anything+cool+near+williamsburg" \
  -d "From=+15551234567"
```

---

## 12. Scraping Tools Reference

| Tool | What it does | When to use |
|---|---|---|
| **cheerio** | Fast HTML parser for Node.js (like Python's Beautiful Soup). DOM traversal without a browser. | MVP: extracting The Skint's content. Any static HTML source. |
| **browse.ai** | No-code scraping SaaS. Point-and-click extraction rules. | Future: if we add many venue calendar sources and don't want to maintain custom parsers. |
| **Playwright / Puppeteer** | Headless browser. Renders JavaScript, handles SPAs. | Future: Resident Advisor, any JS-heavy pages. Overkill for MVP. |

For The Skint (MVP), cheerio is sufficient — the page is server-rendered HTML with a clear content structure.

---

## 13. Future Roadmap

### Near-term
- **Resident Advisor integration** — Playwright scrape for DJ/club events. High-value source for nightlife.
- **Venue calendar scraping** — Direct parsing of key venues (Baby's All Right, Elsewhere, Le Poisson Rouge, etc.)
- **Newsletter ingestion** — Parse TimeOut NY, Gothamist, Nonsense NYC email digests.

### Medium-term
- **PostgreSQL** — User persistence, conversation history, event storage. Replace in-memory session store.
- **Preference learning** — Track what users click on / ask for more of. Adjust taste profile over time.

### Long-term
- **Stripe billing** — Paid tier ($5–$10/month unlimited).
- **Multi-city expansion** — LA, Chicago, etc. Same architecture, different sources.
- **Push notifications** — "Hey, there's a free rooftop thing near you starting in 30 min."
- **Group coordination** — "Find something for 4 people near Union Square."

---

## 14. Normalized Event Schema

Every event (from any source) is normalized to this shape before being passed to Claude:

```json
{
  "id": "hash-of-name-venue-date",
  "source_name": "theskint",
  "source_type": "curated",
  "source_weight": 0.9,
  "name": "Noise Night at Trans-Pecos",
  "description_short": "Experimental noise showcase with 4 acts",
  "venue_name": "Trans-Pecos",
  "venue_address": "915 Wyckoff Ave",
  "neighborhood": "Bushwick",
  "start_time_local": "2026-02-14T21:00:00",
  "end_time_local": null,
  "date_local": "2026-02-14",
  "time_window": "9pm-late",
  "is_free": true,
  "price_display": "free",
  "category": "live_music",
  "subcategory": "experimental",
  "confidence": 0.85,
  "ticket_url": null,
  "map_url": null,
  "map_hint": "near the Jefferson L stop",
  "short_detail": "Experimental noise showcase with 4 acts"
}
```

---

## 15. Key Design Decisions

1. **Claude returns JSON, not SMS text** — Deterministic rendering gives us control over formatting and length without re-prompting.
2. **2-hour cache TTL** — The Skint updates daily; 2 hours is fresh enough without hammering the site.
3. **Tavily as fallback, not primary** — Web search results are noisy. Curated sources come first; Tavily fills gaps when < 5 events near a neighborhood.
4. **No database for MVP** — In-memory cache + in-memory session store. PostgreSQL comes when we need user persistence across deploys.
5. **cheerio over Puppeteer** — The Skint is server-rendered. Eventbrite and Songkick use JSON-LD. No need for a headless browser yet.
6. **claude-sonnet-4-5-20250929** — Fast enough for SMS latency, cheap enough for per-message calls, smart enough for curation.
7. **Async webhook pattern** — Respond to Twilio immediately with empty TwiML, process the request asynchronously. Prevents Twilio's 15-second timeout and retries.
8. **MessageSid dedup** — Track recently processed Twilio MessageSids to prevent duplicate processing from retries.
9. **Time-awareness filtering** — Pre-filter events that started > 2 hours ago before sending to Claude. Keeps events with no parseable time, date-only strings, or events whose `end_time_local` is still in the future.
10. **Source health monitoring** — Track consecutive zero-result counts per source (Skint, Eventbrite, Songkick). Log warnings when a source returns 0 events for 3+ consecutive refreshes.
11. **In-memory rate limiter** — 15 messages per phone per hour. Prevents abuse before paid tier billing exists.
12. **In-memory session store** — Maps phone → {lastPicks, lastEvents, lastNeighborhood} with 30-minute TTL. Enables DETAILS/MORE/FREE follow-up commands without a database.
