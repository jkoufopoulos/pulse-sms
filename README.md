# Pulse SMS

SMS-based AI assistant for NYC nightlife discovery. Text a neighborhood, get curated picks.

## What It Does

Pulse turns a text message into a curated night out. Send an NYC neighborhood name and get back 1-3 opinionated event picks formatted for SMS — no app, no account, no links unless you ask. Reply with a number for details, "more" for additional picks, "free" for free events, or refine with follow-ups like "how about comedy" or "later tonight."

## How It Works

Every incoming SMS runs through a lightweight agent loop powered by Gemini 2.5 Flash (with Anthropic Haiku fallback):

1. **Mechanical check** — handles "help" and TCPA opt-out at $0
2. **Agent loop** — multi-turn tool calling (max 3 iterations) with 2 tools:
   - `search` — unified tool for events, bars, restaurants, details, and more picks. Searches fan out in parallel when the user asks for both ("dinner and a show").
   - `respond` — handles greetings, thanks, off-topic
3. **Model writes the SMS** as plain text, capped at 480 characters. Pool items carry pre-computed `recommended` and `why` fields so the model trusts editorial signals without verbose prompt rules.

Events are scraped daily at 10am ET from 22 sources across 19 scraper modules, cached to disk, and deduplicated across sources. The model costs ~$0.001/msg.

See the [architecture explorer](https://web-production-c8fdb.up.railway.app/architecture) for the full pipeline.

## Example Conversation

```
You:   williamsburg
Pulse: Warm-up at Good Room tonight — techno night with DJ Seinfeld,
       $20, doors at 11. Littlefield has a free comedy showcase at 8.
       Or National Sawdust has an ambient showcase at 9, $15.

You:   2
Pulse: Littlefield Comedy Showcase — free stand-up and improv every
       Thursday at Littlefield (635 Sackett St). Doors 7:30, show 8pm.
       No cover, 2-drink min. BYOB-friendly patio before the show.

You:   how about music later tonight
Pulse: Late night music in Williamsburg — Good Room has that DJ Seinfeld
       techno set at 11 ($20), and Baby's All Right has an indie showcase
       with Wilder Maker at 10:30 ($12).

You:   try bushwick
Pulse: Late night music in Bushwick — Elsewhere has Mall Grab across two
       rooms at 11 ($25), and Sultan Room has a jazz fusion jam at 10 ($10).
```

## Sources

22 source entries across 19 scraper modules covering NYC events: Resident Advisor, Dice, Nonsense NYC, Skint, Brooklyn Vegan, Eventbrite, DoNYC, Songkick, BAM, NYPL, Luma, and more. Four sources use LLM extraction (Skint, Nonsense NYC, Yutori, Screen Slate). See `src/source-registry.js` for the full list.

75 neighborhoods across all 5 NYC boroughs are supported.

## Running Locally

```bash
cp .env.example .env   # fill in your keys
npm install
npm start              # boots on PORT (default 3000)
npm run dev            # dev server with file-watch reload
npm test               # smoke tests (905 tests, $0)
```

## Environment Variables

**Required:**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

**Optional:**
- `PORT` — default 3000
- `PULSE_TEST_MODE=true` — enables the web simulator
- `PULSE_MODEL_BRAIN` — agent loop model (default `claude-haiku-4-5-20251001`)
- `PULSE_MODEL_EXTRACT` — event extraction model (default `claude-haiku-4-5-20251001`)
- `PULSE_MODEL_FALLBACK` — fallback for all roles (default `claude-haiku-4-5-20251001`)
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` — newsletter scrapers
- `RESEND_API_KEY`, `ALERT_EMAIL` — email alerts

## Links

- [Simulator](https://web-production-c8fdb.up.railway.app/test) — try it in a browser
- [Architecture Explorer](https://jkoufopoulos.github.io/pulse-sms/architecture.html) — interactive pipeline diagram
- [Health Dashboard](https://web-production-c8fdb.up.railway.app/health) — scraper status and event counts
