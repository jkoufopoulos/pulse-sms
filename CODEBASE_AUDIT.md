# Codebase Audit — Pulse SMS

> Comprehensive audit of stability, UX, security, and maintainability.
> Date: 2026-02-18

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Repo Map & How It Works](#repo-map--how-it-works)
3. [How To Run / Build / Test](#how-to-run--build--test)
4. [Findings (Prioritized Issue List)](#findings)
5. [PR Plan (Small, Reviewable Chunks)](#pr-plan)
6. [Implemented Fixes](#implemented-fixes)
7. [Appendix](#appendix)

---

## Executive Summary

### Top 10 Issues

| # | Issue | Type | Severity | Impact |
|---|-------|------|----------|--------|
| 1 | TCPA opt-out regex false positives | Bug | P0 | "can't stop dancing" silently dropped — user gets no response |
| 2 | handler.js is 840 lines with a 650-line god function | Maintainability | P1 | Untestable, hard to debug, high change risk |
| 3 | Zero integration tests for the SMS hot path | Maintainability | P1 | Regressions in handler/AI flow go undetected |
| 4 | `sms_text` not type-validated before truncation | Bug | P1 | Claude returning non-string crashes smartTruncate |
| 5 | SmallsLIVE date parsing only replaces first dot | Bug | P2 | "Feb. 17, 2026" works by accident; format change breaks it |
| 6 | Event name normalization strips parentheticals → ID collisions | Bug | P2 | "DJ Cool (8 PM set)" and "DJ Cool (10 PM set)" dedup to one |
| 7 | `parseAsNycTime` fragile on non-UTC servers | Maintainability | P2 | Works on Railway (UTC) but breaks on dev machines |
| 8 | Dead `source_weight` in 12 scraper files | Maintainability | P3 | Confusing; overridden by SOURCES registry |
| 9 | Session `setSession()` overwrites entire state | Bug | P2 | Partial updates lose prior fields if caller forgets to spread |
| 10 | Claude extraction confidence threshold 0.3 too low | UX | P2 | Low-quality events reach users from Skint/Nonsense/OMR |

### What Will Break First in Production

1. **TCPA false positive** — A real user texts "can't stop thinking about jazz" and gets silently ignored. They think the bot is dead and never come back.
2. **Claude returns unexpected JSON shape** — If `sms_text` is a number or missing, `smartTruncate` crashes and the user gets the generic error SMS.
3. **SmallsLIVE changes date format** — If they add a trailing period or change month format, all SmallsLIVE events disappear silently.
4. **Handler.js regression** — With 840 lines and zero integration tests, any edit risks breaking a flow path. The "MORE" and "DETAILS" paths are especially fragile.
5. **Session state corruption** — If a new intent handler is added and calls `setSession()` with partial data, all prior session fields (picks, events, neighborhood) are lost.

### Highest-Leverage Fixes (Top 5)

| Fix | Expected Impact | LOE |
|-----|-----------------|-----|
| **TCPA regex → start-anchored** | Prevents silent message loss for legitimate users | 5 min |
| **Type-validate sms_text** | Prevents crash on unexpected Claude response | 2 min |
| **SmallsLIVE `.replace` → global regex** | Prevents silent data loss on format change | 1 min |
| **Add integration test for SMS flow** | Catches regressions in the hot path | 2 hrs |
| **Split handleMessageAI into intent handlers** | Makes each flow testable, reduces change risk | 4 hrs |

---

## Repo Map & How It Works

### Architecture

```
Daily scrape (10am ET)     Incoming SMS (Twilio webhook)
        │                            │
        ▼                            ▼
   sources/                   handler.js:router.post('/incoming')
   (16 scrapers)                     │
        │                     twilio.webhook() signature check
        │                            │
        ▼                     pre-router.js (deterministic matching)
   events.js                         │
   (SOURCES registry,          ┌─────┴─────┐
    timedFetch, dedup,         │ matched    │ no match
    health tracking)           ▼            ▼
        │                 direct SMS    ai.js:routeMessage()
        │                 response         │
        ▼                            ┌─────┴────────┐
   venues.js                         ▼              ▼
   (auto-learn coords,     events/more/free    help/conversational
    persistence)                  │                  │
        │                         ▼              direct SMS
        ▼                 ai.js:composeResponse()
   geo.js                         │
   (proximity ranking,            ▼
    time filtering)        handler.js:sendComposeWithLinks()
                                  │
                                  ▼
                           twilio.js:sendSMS()
                           (retry + timeout)
```

### How The App Works (For a New Engineer)

1. **Daily at 10am ET**, `events.js:refreshCache()` fires. It calls all 16 scrapers in parallel via `Promise.allSettled`, deduplicates events by hash (name+venue+date), tracks source health, and caches everything in memory.

2. **When a user texts**, Twilio POSTs to `/api/sms/incoming`. The handler validates the Twilio signature, deduplicates retries by MessageSid, checks TCPA opt-out and rate limits, then processes the message.

3. **Pre-router** tries deterministic matching first (greetings, "more", "free", bare neighborhoods, boroughs, details by number). If matched, it returns immediately without calling Claude.

4. **If pre-router doesn't match**, `ai.js:routeMessage()` calls Claude Haiku to classify intent and extract neighborhood. Then based on intent:
   - `events` → fetch from cache, call `composeResponse()` to pick 1-3 events and write SMS
   - `details` → look up the event, call `composeDetails()` for a detailed SMS
   - `more` → exclude already-shown events, re-compose with remaining pool
   - `free` → filter to free events, re-compose

5. **Session state** (per phone number, 2hr TTL) tracks: last neighborhood, last picks, all offered event IDs, event details map. This enables "more", "details", and "free" follow-ups.

### Key Modules

| Module | LOC | Responsibility |
|--------|-----|----------------|
| handler.js | 840 | Webhook, routing dispatch, all intent handlers, session orchestration |
| ai.js | 827 | 3 Claude prompts + callers, JSON parsing, pick validation |
| events.js | 400 | SOURCES registry, scrape orchestration, cache, health tracking |
| venues.js | 312 | 200+ venue coords, auto-learning, geocoding, persistence |
| neighborhoods.js | 301 | 36 neighborhoods with coords, aliases, landmarks, subway stops |
| geo.js | 223 | Proximity ranking, time filtering, timezone helpers |
| sources/*.js | ~2400 | 16 individual scrapers |

### External Dependencies

| Dependency | Used In | Purpose |
|------------|---------|---------|
| `@anthropic-ai/sdk` | ai.js | Claude API (routing, composition, extraction) |
| `twilio` | twilio.js, handler.js | SMS send/receive, webhook validation |
| `express` | server.js | HTTP server |
| `helmet` | server.js | Security headers |
| `cheerio` | donyc.js, smallslive.js | HTML parsing |
| `dotenv` | server.js | Env var loading |

---

## How To Run / Build / Test

### Install

```bash
npm install
cp .env.example .env  # Fill in API keys
```

### Required Env Vars

| Var | Where Used | Purpose |
|-----|------------|---------|
| `TWILIO_ACCOUNT_SID` | twilio.js, handler.js | Twilio auth |
| `TWILIO_AUTH_TOKEN` | twilio.js, handler.js | Twilio auth + webhook validation |
| `TWILIO_PHONE_NUMBER` | twilio.js | SMS sender number |
| `ANTHROPIC_API_KEY` | ai.js (via SDK) | Claude API |
| `TAVILY_API_KEY` | sources/tavily.js | Web search fallback |

Optional: `PORT` (default 3000), `PULSE_TEST_MODE` (enables /test UI), `PULSE_MODEL_ROUTE/COMPOSE/EXTRACT` (Claude model overrides), `RESEND_API_KEY` + `ALERT_EMAIL` (health alerting), `HEALTH_AUTH_TOKEN` (dashboard auth).

### Run

```bash
npm start              # Production — boots server, scrapes at 10am ET
PULSE_TEST_MODE=true npm start  # Dev — enables /test simulator and /eval dashboard
```

### Test

```bash
npm test               # 280 tests — pure functions only, no API calls (~2s)
```

### Build

No build step. Plain Node.js (>=20), runs directly.

---

## Findings

### ISSUE-001
- **Type**: Bug
- **Severity**: P0
- **Confidence**: High
- **Where**: `src/handler.js:143` — `OPT_OUT_KEYWORDS` regex
- **Repro**: Text "can't stop dancing" to the bot → message silently dropped, no response
- **Root cause**: `\b(stop|...)\b` matches "stop" inside "can't stop" because `\b` is a word boundary, not start-of-message. Any message containing an opt-out word as a standalone word gets silently ignored.
- **Fix**: Change to `^\s*(stop|...)\b` — only match when keyword is at the start of the message. This catches "STOP", "stop please", "quit" but not "can't stop" or "don't quit".
- **Test**: Added 10 TCPA regex tests covering true positives and false positive avoidance.

### ISSUE-002
- **Type**: Maintainability
- **Severity**: P1
- **Confidence**: High
- **Where**: `src/handler.js:177-828` — `handleMessageAI()` function
- **Repro**: Static finding
- **Root cause**: Single 650-line function handles all 6 intents (events, details, more, free, help, conversational) with deeply nested if/else chains. Cyclomatic complexity ~35+.
- **Fix**: Extract each intent into its own function: `handleDetails()`, `handleMore()`, `handleFree()`, `handleEvents()`. Each becomes <100 lines and independently testable.
- **Test**: After extraction, unit test each handler with mocked dependencies.

### ISSUE-003
- **Type**: Maintainability
- **Severity**: P1
- **Confidence**: High
- **Where**: `test/smoke.test.js` — entire test suite
- **Repro**: Static finding — zero tests exercise the handler.js → ai.js → twilio.js hot path
- **Root cause**: All 280 tests are pure function tests (extractNeighborhood, makeEventId, etc.) or eval contract tests. No integration test sends a simulated SMS through the full pipeline.
- **Fix**: Add integration test that mocks Twilio + Anthropic and exercises handleMessage() end-to-end.
- **Test**: The test itself IS the fix.

### ISSUE-004
- **Type**: Bug
- **Severity**: P1
- **Confidence**: High
- **Where**: `src/ai.js:551` — `composeResponse()` validation
- **Repro**: Claude returns `{ sms_text: 123, picks: [] }` (non-string sms_text)
- **Root cause**: Validation only checked `!parsed.sms_text` (falsy check), which passes for numbers. `smartTruncate(123)` would call `.length` on a number → TypeError.
- **Fix**: Add `typeof parsed.sms_text !== 'string'` to the validation check.
- **Test**: Covered by existing composeResponse shape contract tests.

### ISSUE-005
- **Type**: Bug
- **Severity**: P2
- **Confidence**: High
- **Where**: `src/sources/smallslive.js:13` — `parseDate()`
- **Repro**: SmallsLIVE returns `"Feb. 17, 2026."` (trailing dot) → `new Date("Feb 17, 2026.")` → NaN → event dropped
- **Root cause**: `.replace('.', '')` only replaces the first occurrence. Works by accident for "Feb. 17, 2026" but breaks if format changes.
- **Fix**: `.replace(/\./g, '')` — global regex replaces all dots.
- **Test**: Manual verification; event should parse regardless of dot placement.

### ISSUE-006
- **Type**: Bug
- **Severity**: P2
- **Confidence**: Med
- **Where**: `src/sources/shared.js:13-22` — `normalizeEventName()`
- **Repro**: Two events "DJ Cool (8 PM set)" and "DJ Cool (10 PM set)" at the same venue on the same date → both normalize to "dj cool" → same event ID → second event silently dropped by dedup.
- **Root cause**: Regex `.replace(/\s*\(.*?\)\s*/g, ' ')` strips all parenthetical content. Useful for "(SOLD OUT)" but harmful for set times.
- **Fix**: Only strip known noise patterns like "(SOLD OUT)", "(21+)", "(Ages 18+)" instead of all parentheticals. Or include time info in the hash.
- **Test**: Add test case with two same-name events at different times.

### ISSUE-007
- **Type**: Maintainability
- **Severity**: P2
- **Confidence**: Med
- **Where**: `src/geo.js:164-179` — `parseAsNycTime()`
- **Repro**: Run on a developer machine with TZ=EST → offset calculation returns 0 instead of -5 → events get wrong timestamps
- **Root cause**: `new Date(localeString)` is parsed as local time. On UTC servers, local=UTC, so the math works. On EST machines, local=EST, so the offset cancels out.
- **Fix**: Use `Intl.DateTimeFormat` with `resolvedOptions().timeZone` or compute offset via two `Date` objects with explicit UTC interpretation.
- **Test**: Unit test with mocked `Date.now()` and `toLocaleString()`.

### ISSUE-008
- **Type**: Maintainability
- **Severity**: P3
- **Confidence**: High
- **Where**: 12 files in `src/sources/` — dead `source_weight` assignments
- **Repro**: Static finding — `timedFetch()` in events.js line 113 overwrites all weights from SOURCES registry
- **Root cause**: Weights were added per-scraper before the registry existed. Now redundant.
- **Fix**: Remove `source_weight: N.NN` from all 12 scraper files.
- **Test**: Existing tests pass; weights are validated via SOURCES registry tests.

### ISSUE-009
- **Type**: Bug
- **Severity**: P2
- **Confidence**: Med
- **Where**: `src/session.js:12-13` — `setSession()`
- **Repro**: Call `setSession(phone, { pendingFilters: ... })` → all prior session fields (lastPicks, lastEvents, lastNeighborhood) are lost because `setSession` replaces the entire Map entry.
- **Root cause**: `sessions.set(phone, { ...data, timestamp })` creates a fresh object from only the provided `data`. No merge with existing session.
- **Fix**: Change to `sessions.set(phone, { ...sessions.get(phone), ...data, timestamp })` to merge new data with existing session.
- **Test**: Add test that sets partial data and verifies prior fields are preserved.

### ISSUE-010
- **Type**: UX
- **Severity**: P2
- **Confidence**: Med
- **Where**: `src/sources/skint.js:52`, `nonsense.js:49`, `ohmyrockness.js:55` — confidence thresholds
- **Repro**: Claude-extracted events with confidence 0.3-0.5 (ambiguous name, missing venue, unclear date) pass through and reach users as recommendations.
- **Root cause**: Threshold set at 0.3 to maximize event count. But low-confidence events often have wrong dates or venues.
- **Fix**: Raise threshold from 0.3 to 0.5 for all Claude-extraction scrapers.
- **Test**: Verify event counts don't drop dramatically (check health dashboard after deploy).

### ISSUE-011
- **Type**: Bug
- **Severity**: P2
- **Confidence**: Med
- **Where**: `src/ai.js:651-657` — `parseJsonFromResponse()` code-fence path
- **Repro**: Claude returns markdown-fenced JSON with literal newlines in string values → regex extracts the block → `JSON.parse()` fails → returns null instead of trying `fixJsonNewlines()`
- **Root cause**: Code-fence path (line 655) parses directly and falls through to `null` on failure, skipping the `fixJsonNewlines` recovery that exists in the brace-counting path.
- **Fix**: Add `fixJsonNewlines()` fallback to the code-fence path.
- **Test**: Add test with JSON containing literal newlines inside code fences.

### ISSUE-012
- **Type**: Perf
- **Severity**: P3
- **Confidence**: Med
- **Where**: `src/ai.js:593` — `composeResponse()` re-requires neighborhoods
- **Repro**: Static finding — `Object.keys(require('./neighborhoods').NEIGHBORHOODS)` called on every compose call
- **Root cause**: Neighborhood list is static but re-imported each invocation due to lazy require to avoid circular dependency.
- **Fix**: Cache at module scope: `const VALID_NEIGHBORHOODS = Object.keys(require('./neighborhoods').NEIGHBORHOODS);` (safe because neighborhoods.js doesn't require ai.js).
- **Test**: Verify compose still validates neighborhoods correctly.

### ISSUE-013
- **Type**: Security
- **Severity**: P3
- **Confidence**: High
- **Where**: `src/handler.js:147` — message logging
- **Repro**: Static finding — `console.log(\`SMS from ${masked}: ${message.slice(0, 80)}\`)` logs the first 80 chars of every incoming message
- **Root cause**: Useful for debugging but logs user message content. Not PII per se (phone is masked), but message content could contain sensitive info.
- **Fix**: Consider logging only in test mode, or hashing message content. Low priority since this is a nightlife bot.
- **Test**: N/A — operational policy.

### ISSUE-014
- **Type**: Bug
- **Severity**: P2
- **Confidence**: Med
- **Where**: `src/ai.js:820` — `isSearchUrl()` operator precedence
- **Repro**: URL `https://yelp.com/biz?find_desc=jazz` → `u.searchParams.has('find_desc')` is true → correctly returns true. But the line reads ambiguously due to missing parens.
- **Root cause**: `||` and `&&` in same expression without explicit grouping. Current behavior is actually correct due to JS precedence (`&&` binds tighter), but confusing to read.
- **Fix**: Add explicit parentheses: `(u.searchParams.has('find_desc')) || (u.searchParams.has('q') && u.pathname.includes('search'))`.
- **Test**: Add test cases for isSearchUrl with edge case URLs.

### ISSUE-015
- **Type**: UX
- **Severity**: P3
- **Confidence**: Med
- **Where**: `src/handler.js:267-286` — details not found path
- **Repro**: User texts "2" but session has no pick #2 (only 1 pick was shown) → gets "no picks" generic message instead of specific error
- **Root cause**: When `pickIndex >= validPicks.length`, the code falls through to a generic "text a neighborhood" message rather than saying "I only showed you 1 pick."
- **Fix**: Return a specific message: "I only showed you {n} pick(s) — reply 1{n > 1 ? '-' + n : ''} for details."
- **Test**: Simulate details request with out-of-range number.

---

## PR Plan

### PR 1: Fix TCPA + sms_text validation + SmallsLIVE (✅ IMPLEMENTED)
- **Title**: `Fix TCPA false positives, validate sms_text type, fix SmallsLIVE date parsing`
- **Files**: `src/handler.js`, `src/ai.js`, `src/sources/smallslive.js`, `test/smoke.test.js`
- **Why**: Prevents silent message loss (P0), crash on unexpected Claude response (P1), and scraper fragility (P2)
- **Acceptance criteria**: All 280 tests pass; "can't stop" no longer triggers opt-out; non-string sms_text hits fallback gracefully
- **Test plan**: 16 new unit tests added (10 TCPA + 6 smartTruncate)

### PR 2: Fix session setSession merge semantics
- **Title**: `Merge session data instead of overwriting on setSession()`
- **Files**: `src/session.js`, `test/smoke.test.js`
- **Why**: Prevents silent loss of session state when partial updates are made
- **Acceptance criteria**: `setSession(phone, { pendingFilters })` preserves existing `lastPicks`, `lastEvents`, `lastNeighborhood`
- **Test plan**: Add test: set full session → set partial → verify all fields present

### PR 3: Raise Claude extraction confidence threshold
- **Title**: `Raise extraction confidence threshold from 0.3 to 0.5 for Claude-parsed sources`
- **Files**: `src/sources/skint.js`, `src/sources/nonsense.js`, `src/sources/ohmyrockness.js`
- **Why**: Prevents low-quality events (wrong date, missing venue) from reaching users
- **Acceptance criteria**: Only events with confidence >= 0.5 pass through
- **Test plan**: Compare event counts before/after via health dashboard

### PR 4: Add fixJsonNewlines fallback to code-fence parsing path
- **Title**: `Fix JSON parser: try fixJsonNewlines on code-fence extraction failure`
- **Files**: `src/ai.js`, `test/smoke.test.js`
- **Why**: Prevents silent parse failures when Claude returns JSON with literal newlines in code fences
- **Acceptance criteria**: `parseJsonFromResponse` handles code-fenced JSON with newlines
- **Test plan**: Add test case with malformed code-fenced JSON

### PR 5: Fix event ID collision for parenthetical time info
- **Title**: `Preserve time-distinguishing parentheticals in normalizeEventName()`
- **Files**: `src/sources/shared.js`, `test/smoke.test.js`
- **Why**: Prevents dedup collisions for multi-set events at the same venue
- **Acceptance criteria**: "DJ Cool (8 PM)" and "DJ Cool (10 PM)" get different IDs
- **Test plan**: Add collision test case

### PR 6: Remove dead source_weight from scrapers
- **Title**: `Remove dead source_weight assignments from 12 scraper files`
- **Files**: 12 files in `src/sources/`
- **Why**: Dead code causes confusion; weights are canonical in SOURCES registry
- **Acceptance criteria**: No `source_weight:` assignments in scraper files; all tests pass
- **Test plan**: Existing SOURCES registry tests validate weights

### PR 7: Extract intent handlers from handleMessageAI
- **Title**: `Split handleMessageAI into per-intent handler functions`
- **Files**: `src/handler.js`
- **Why**: Reduces cyclomatic complexity from 35+ to ~8 per function; enables unit testing
- **Acceptance criteria**: Identical behavior; each function <100 lines
- **Test plan**: Add unit tests for each extracted handler

---

## Implemented Fixes

### Fix 1: TCPA Opt-Out Regex (ISSUE-001)

**File**: `src/handler.js:143`

**Before**:
```javascript
const OPT_OUT_KEYWORDS = /\b(stop|unsubscribe|cancel|quit)\b/i;
```

**After**:
```javascript
const OPT_OUT_KEYWORDS = /^\s*(stop|unsubscribe|cancel|quit)\b/i;
```

**Why**: `\b` word boundary matched opt-out keywords inside normal messages ("can't stop dancing", "don't quit your day job"). Changed to `^\s*` so keywords only match at the start of the message. Still catches "STOP", "stop please", "  quit" (with leading whitespace).

**Tests added**: 10 test cases in `test/smoke.test.js` covering true positives ("STOP", "stop please", "  quit", "unsubscribe me") and false positive avoidance ("can't stop dancing", "don't quit", "I want to cancel", "east village", "what's happening").

### Fix 2: sms_text Type Validation (ISSUE-004)

**File**: `src/ai.js:551`

**Before**:
```javascript
if (!parsed || !parsed.sms_text) {
```

**After**:
```javascript
if (!parsed || !parsed.sms_text || typeof parsed.sms_text !== 'string') {
```

**Why**: If Claude returns `{ sms_text: 123 }` (number instead of string), `smartTruncate(123)` would crash because it calls `.length` on a non-string. The type check sends users to the graceful fallback message instead.

### Fix 3: SmallsLIVE Date Parsing (ISSUE-005)

**File**: `src/sources/smallslive.js:13`

**Before**:
```javascript
const d = new Date(dataDate.replace('.', ''));
```

**After**:
```javascript
const d = new Date(dataDate.replace(/\./g, ''));
```

**Why**: `String.replace('.', '')` only removes the first dot. "Feb. 17, 2026" works by accident (only one dot matters). But if SmallsLIVE changes to "Feb. 17, 2026." or "Sat. Feb. 17, 2026", the extra dots break parsing. Global regex handles all dots safely.

### Tests Added

6 additional `smartTruncate` tests in `test/smoke.test.js`:
- Short text unchanged
- Exact 480 chars unchanged
- 481 chars gets truncated
- Truncated text ends with ellipsis
- Doesn't cut mid-word
- Drops partial URL lines

**Run**: `npm test` — 280 tests, 0 failures.

---

## Appendix

### Refactor Candidates

| File | LOC | Problem | Extraction Target |
|------|-----|---------|-------------------|
| `handler.js` | 840 | God function `handleMessageAI()` is 650 lines with 6 intent branches | Extract: `handleDetails()`, `handleMore()`, `handleFree()`, `handleEvents()`, `handleConversational()` |
| `ai.js` | 827 | 3 large prompts (300+ lines total) + 3 API callers + JSON parser | Extract prompts to `prompts.js`; extract `parseJsonFromResponse` to `json-utils.js` |
| `venues.js` | 312 | 200-line static VENUE_MAP + 100 lines of auto-learning logic | Move VENUE_MAP to `data/venues-static.json`, load at boot |
| `neighborhoods.js` | 301 | 36 hardcoded neighborhoods with coords, aliases, landmarks | Move to `data/neighborhoods.json` |

### Suggested Follow-ups

**Telemetry**:
- Add structured logging with correlation IDs (per-request trace through handler → ai → twilio)
- Add response latency histogram per intent type
- Alert when average compose latency exceeds 5s

**Data Quality**:
- Add schema validation on scraper output (require name, date, source_name)
- Add integration tests that scrape each source and validate event shape
- Consider fuzzy dedup (Levenshtein on event names) for near-duplicates

**Cost Optimization**:
- Cache compose responses for identical event sets + neighborhood (same user, same minute)
- Strip redundant fields from compose input (both `date_local` and `day` label sent)
- Reduce extraction prompt examples (80 lines, sent with every scrape)

**Resilience**:
- Persist event cache to disk alongside venues-learned.json — prevents empty cache after crash + failed re-scrape
- Add 5pm ET secondary scrape for events posted mid-day
- Add cache staleness alerting (flag if cache > 24 hours old)

### Open Questions & Unknowns

1. **Twilio native STOP handling**: Does Twilio intercept "STOP" before it reaches the webhook? If so, the application-level TCPA handler only matters for "cancel", "quit", "unsubscribe". Verify via Twilio console → Messaging → opt-out settings.

2. **Railway TZ**: The `parseAsNycTime()` function assumes the server runs in UTC. Verify Railway's default timezone and whether it could change.

3. **Event volume thresholds**: With 16 sources, how many events hit the cache daily? If >500, the 3km proximity filter may return too many candidates per neighborhood. Consider tightening to 2km.

4. **Claude Haiku quality**: The A/B eval showed Haiku matches Sonnet on compose quality. But has this been re-evaluated since the model was updated to `claude-haiku-4-5-20251001`? Worth re-running the eval suite.

5. **Rate limiter calibration**: 15 messages per phone per hour — is this too aggressive for power users exploring multiple neighborhoods? Consider 20-25 if users complain.
