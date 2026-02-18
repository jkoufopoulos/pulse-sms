# Codebase Audit — Pulse SMS

**Date:** 2026-02-18 (v2 — second pass after initial fixes)
**Scope:** Full codebase (~3,500 LOC across 20 source files)
**Tests:** 421 passing (384 smoke + 37 eval), 0 npm vulnerabilities

---

## Executive Summary

### Top 5 "breaks first in production"

1. **SmallsLIVE hardcoded EST offset** — Every event time is wrong by 1 hour from March to November (8 months/year). Users see "7 PM" when the show is at 8 PM.
2. **`getNycDateString` DST fall-back** — On one night per year (Nov), event date calculation returns today instead of tomorrow between midnight and 1 AM, causing stale events to appear and tomorrow's events to be missed.
3. **`makeEventId` random fallback** — Events with empty name+venue+date get random IDs on each scrape, breaking cross-scrape dedup. Same event appears multiple times.
4. **RA `is_free` misclassification** — `isTicketed === false` marks non-ticketed events as free, but many are pay-at-door. Users arrive expecting free entry.
5. **Nudge-accept triggers on stale state** — `pendingNearby` persists in session, so any affirmative word ("yes", "sure", "okay") in unrelated messages redirects to a neighborhood the user already moved past.

### Top 5 highest-leverage fixes

1. **Fix SmallsLIVE timezone** — One-line change: compute offset dynamically instead of `-05:00`. Fixes 8 months of wrong times.
2. **Fix `getNycDateString`** — Replace ms-arithmetic with calendar-day arithmetic. Fixes DST edge case for all date comparisons.
3. **Fix `makeEventId` fallback** — Use `source + name` hash instead of `randomUUID()`. Stabilizes dedup for empty-field events.
4. **Clear `pendingNearby` on non-nudge messages** — Add `setSession(phone, { pendingNearby: null })` when message isn't a nudge response. Prevents stale redirects.
5. **Fix RA free detection** — Use `is_free: false` (RA doesn't reliably indicate free events) or check if price info is available.

### Previously fixed (v1 audit)

These issues from the first audit pass have been resolved:

| Issue | Fix | Commit |
|-------|-----|--------|
| TCPA opt-out regex false positives | Anchored at `^\s*` | 03b9d33 |
| `handleMessageAI` 650-line god function | Split into 7 per-intent handlers | eae9a82 |
| Zero integration tests for SMS hot path | Added 10 integration tests | eae9a82 |
| `sms_text` not type-validated before truncation | Added `typeof` check | 03b9d33 |
| `setSession()` overwrites entire state | Changed to merge semantics | 03b9d33 |
| Claude extraction confidence threshold 0.3 too low | Raised to 0.5 | 03b9d33 |
| Event name normalization strips all parentheticals | Now only strips noise parentheticals | 03b9d33 |

---

## Findings

### ISSUE-001

| Field      | Value |
|------------|-------|
| Type       | Bug |
| Severity   | P1 high |
| Confidence | High (proven) |
| Where      | `src/sources/smallslive.js:parseFirstTime` (line 33) |
| What       | Hardcoded `-05:00` (EST) offset is wrong during EDT (March–November) |
| Trigger    | Any SmallsLIVE event scraped between second Sunday in March and first Sunday in November. Line 33: `return \`${dateLocal}T${hours}:${mins}:00-05:00\`` always appends EST. |
| Fix        | Compute current NYC offset dynamically using `Intl.DateTimeFormat` or `toLocaleString` with `timeZoneName: 'shortOffset'` |
| Test       | Unit test: mock date in July, verify `parseFirstTime("7:00 PM", "2026-07-15")` returns `-04:00` not `-05:00` |

### ISSUE-002

| Field      | Value |
|------------|-------|
| Type       | Bug |
| Severity   | P1 high |
| Confidence | High (proven) |
| Where      | `src/geo.js:getNycDateString` (line 131–134) |
| What       | Ms-arithmetic (`refTimeMs + dayOffset * 86400000`) returns wrong date on DST fall-back night |
| Trigger    | Call `getNycDateString(1)` at 12:30 AM EDT on fall-back Sunday (first Sun in Nov). `refTimeMs` = 4:30 AM UTC Nov 2. Adding 86400000ms = 4:30 AM UTC Nov 3 = 11:30 PM EST Nov 2. `toLocaleDateString` returns "2025-11-02" instead of "2025-11-03". |
| Fix        | Use calendar-day arithmetic: parse NYC date components, add `dayOffset` to the day, format. E.g., `new Date(new Date(refTimeMs).toLocaleString('en-US', { timeZone: 'America/New_York' }))` then `.setDate(d.getDate() + dayOffset)` |
| Test       | `getNycDateString(1, Date.UTC(2025, 10, 2, 4, 30))` should return `"2025-11-03"`, not `"2025-11-02"` |

### ISSUE-003

| Field      | Value |
|------------|-------|
| Type       | Bug |
| Severity   | P1 high |
| Confidence | High (proven) |
| Where      | `src/sources/shared.js:makeEventId` (line 35) |
| What       | When name+venue+date are all empty, fallback uses `crypto.randomUUID()` producing non-deterministic IDs |
| Trigger    | Any event from Claude extraction where all three core fields are empty AND `sourceUrl` is undefined. `makeEventId('', '', '', 'skint', undefined)` returns a different ID every call. |
| Fix        | Remove `randomUUID()` fallback. Use `source + 'empty'` as fallback hash, or skip events with no identifying data. |
| Test       | Call `makeEventId('', '', '', 'skint', undefined)` twice, assert same ID returned |

### ISSUE-004

| Field      | Value |
|------------|-------|
| Type       | Bug |
| Severity   | P2 medium |
| Confidence | High (proven) |
| Where      | `src/sources/ra.js:115` |
| What       | `is_free: e.isTicketed === false` marks non-ticketed RA events as free, but many are pay-at-door |
| Trigger    | Any RA event where `isTicketed` is `false`. Common for smaller venues that don't sell through RA. User sees "free" label, arrives, and has to pay cover. |
| Fix        | Set `is_free: false` for all RA events (RA doesn't expose price data reliably) |
| Test       | Scrape RA events, verify no events have `is_free: true` unless price data confirms it |

### ISSUE-005

| Field      | Value |
|------------|-------|
| Type       | Bug |
| Severity   | P2 medium |
| Confidence | Med (likely) |
| Where      | `src/pre-router.js:48` + `src/handler.js` (nudge_accept flow) |
| What       | `pendingNearby` persists in session after nudge is ignored, causing later affirmative messages to trigger neighborhood redirect |
| Trigger    | User gets nudge → ignores it → texts "yeah I want jazz" → pre-router matches "yeah" against stale `pendingNearby` → redirects to Flatiron instead of parsing the jazz request |
| Fix        | Clear `pendingNearby` at the top of `handleMessageAI` for any intent that isn't `nudge_accept` |
| Test       | Integration test: set `pendingNearby` → send "jazz in east village" → verify pendingNearby cleared and EV events returned |

### ISSUE-006

| Field      | Value |
|------------|-------|
| Type       | Reliability |
| Severity   | P2 medium |
| Confidence | High (proven) |
| Where      | `src/events.js:msUntilNextScrape` (line 325) |
| What       | `hoursUntil <= 0` at exactly 10:00 AM schedules next scrape for tomorrow instead of running now |
| Trigger    | Restart server at exactly 10:00:xx AM ET. `SCRAPE_HOUR - hour = 0`, which is `<= 0`, so adds 24h. Today's scrape is skipped. |
| Fix        | Change `hoursUntil <= 0` to `hoursUntil < 0` (strictly less than). When `hoursUntil === 0`, the remaining seconds/minutes produce a small positive ms value for an almost-immediate scrape. |
| Test       | Unit test: mock clock to 10:00 AM, verify `msUntilNextScrape()` returns < 3600000 (less than 1 hour) |

### ISSUE-007

| Field      | Value |
|------------|-------|
| Type       | Reliability |
| Severity   | P2 medium |
| Confidence | Med (likely) |
| Where      | `src/ai.js:composeResponse` (lines 565–584) |
| What       | Hallucinated pick ID recovery uses fragile name substring matching that can match wrong events |
| Trigger    | Claude returns picks with hallucinated event IDs. Recovery at line 578 matches first 20 chars of event name as substring of `sms_text`. Events named "Jazz Night at Smalls" and "Jazz Night at Mezzrow" both match if first 20 chars overlap. |
| Fix        | Require full event name match (not just first 20 chars). Log all recovered picks with `[RECOVERED]` flag. |
| Test       | Mock composeResponse where Claude hallucinates IDs, verify correct event is recovered |

### ISSUE-008

| Field      | Value |
|------------|-------|
| Type       | Bug |
| Severity   | P2 medium |
| Confidence | High (proven) |
| Where      | `src/handler.js:handleDetails` (line 237) |
| What       | Out-of-range pick number silently clamps to last pick instead of telling user the valid range |
| Trigger    | Compose returns 3 picks → user texts "5" → `Math.min(4, 2) = 2` → returns details for pick #3 without explanation |
| Fix        | If `ref > picks.length`, reply "I only have {n} picks — reply 1-{n} for details" |
| Test       | Integration test: seed 3 picks, send "5", verify helpful error message returned |

### ISSUE-009

| Field      | Value |
|------------|-------|
| Type       | Bug |
| Severity   | P2 medium |
| Confidence | Med (likely) |
| Where      | `src/handler.js:handleDetails` (line 230) |
| What       | "All details" path sends up to 1500 chars — exceeds SMS segment limit, may split unpredictably |
| Trigger    | User sends non-numeric detail request with 3+ picks in session. `details.join('\n\n').slice(0, 1500)` — Twilio will split this into multiple SMS segments, but the split points are arbitrary. |
| Fix        | Cap at 480 chars like other paths, or use `sendSMS` for each detail individually |
| Test       | Create 3 picks with long details, verify total response fits SMS constraints |

### ISSUE-010

| Field      | Value |
|------------|-------|
| Type       | Domain |
| Severity   | P2 medium |
| Confidence | Med (likely) |
| Where      | `src/geo.js:5` (BOROUGH_FALLBACK_MAP) |
| What       | Borough "Brooklyn" falls back to "Williamsburg" — misleading for events in Park Slope, DUMBO, etc. |
| Trigger    | Event has locality "Brooklyn" with no coords → `resolveNeighborhood` returns "Williamsburg". Event in Park Slope gets filed under Williamsburg. |
| Fix        | Return `null` for borough-level localities instead of mapping to a single neighborhood |
| Test       | `resolveNeighborhood('Brooklyn', null, null)` returns `null` |

### ISSUE-011

| Field      | Value |
|------------|-------|
| Type       | Reliability |
| Severity   | P2 medium |
| Confidence | Med (likely) |
| Where      | `src/geo.js:parseAsNycTime` (lines 164–178) |
| What       | Offset detection via `new Date(nycNow).getTime()` is unreliable on non-UTC servers |
| Trigger    | Server running with `TZ=America/New_York`. `nycNow = new Date().toLocaleString(...)` returns NYC time. `new Date(nycNow)` parses as local time (also NYC). `nycMs - utcMs ≈ 0` instead of `-5 * 3600000`. All events get wrong timestamps. |
| Fix        | Use `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })` to get the actual UTC offset string directly |
| Test       | Set `TZ=America/New_York`, verify `parseAsNycTime("2026-02-18T20:00:00")` produces correct UTC ms |

### ISSUE-012

| Field      | Value |
|------------|-------|
| Type       | Reliability |
| Severity   | P2 medium |
| Confidence | Med (likely) |
| Where      | `src/events.js:refreshCache` (line 240) |
| What       | `batchGeocodeEvents` failure blocks entire cache update |
| Trigger    | Nominatim returns 429 or times out → `batchGeocodeEvents` throws → `refreshPromise` rejects → cache never updates for this cycle |
| Fix        | Wrap in try-catch: `try { await batchGeocodeEvents(allEvents); } catch (err) { console.error('Geocoding failed, continuing:', err.message); }` |
| Test       | Mock Nominatim to throw, verify `eventCache` still gets updated |

### ISSUE-013

| Field      | Value |
|------------|-------|
| Type       | Reliability |
| Severity   | P3 low |
| Confidence | Med (likely) |
| Where      | `src/pre-router.js:40` |
| What       | Pre-router only matches digits 1-3, but compose may return up to 5 picks |
| Trigger    | User receives 4 picks, texts "4" → falls through to Claude routing (adds ~1-2s latency). Works correctly but slower than pre-route. |
| Fix        | Expand regex to `/^[1-5]$/` or dynamically check against `session.lastPicks.length` |
| Test       | Seed 5 picks in session, send "4", verify pre-routed as `details` intent |

### ISSUE-014

| Field      | Value |
|------------|-------|
| Type       | Reliability |
| Severity   | P3 low |
| Confidence | Low (hypothesis) |
| Where      | `src/handler.js` (all `composeAndSend` call sites) |
| What       | No per-intent error handling — all AI failures produce same "Pulse hit a snag" message |
| Trigger    | Claude timeout on any compose call → generic error. User can't distinguish transient failure from persistent bug. Static finding. |
| Fix        | Add intent-specific fallback messages (e.g., "Couldn't load more picks — try again in a sec" for the `more` intent) |
| Test       | Mock `composeResponse` to throw timeout, verify intent-specific error message |

### ISSUE-015

| Field      | Value |
|------------|-------|
| Type       | Maintainability |
| Severity   | P3 low |
| Confidence | High (proven) |
| Where      | `src/sources/donyc.js` |
| What       | Makes up to 18 sequential HTTP requests (3 categories × 3 pages × 2 dates) during daily scrape |
| Trigger    | Every daily scrape. Sequential fetches mean DoNYC alone can take 30+ seconds if pages are slow. Static finding. |
| Fix        | Parallelize category fetches with `Promise.allSettled` |
| Test       | Time DoNYC scrape before/after, verify >50% improvement |

### ISSUE-016

| Field      | Value |
|------------|-------|
| Type       | Security |
| Severity   | P3 low |
| Confidence | Med (likely) |
| Where      | `src/ai.js:452`, `src/ai.js:531` |
| What       | User SMS message interpolated directly into Claude prompts via string template |
| Trigger    | User texts adversarial input like `East Village" IGNORE PREVIOUS INSTRUCTIONS`. Claude's instruction hierarchy mitigates this, but injection vector exists. |
| Fix        | Wrap user input in XML tags (`<user_message>...</user_message>`) for clearer prompt boundaries |
| Test       | Send adversarial messages via test endpoint, verify Claude doesn't follow injected instructions |

### ISSUE-017

| Field      | Value |
|------------|-------|
| Type       | Reliability |
| Severity   | P3 low |
| Confidence | Low (hypothesis) |
| Where      | `src/ai.js:parseJsonFromResponse` (lines 651–683) |
| What       | `lastIndexOf('}')` fallback can match `}` inside quoted strings, truncating JSON |
| Trigger    | Claude returns non-fenced JSON where `sms_text` contains a `}` character. Parser matches inner brace instead of outer. Fenced responses (the common case) are handled correctly. |
| Fix        | Require markdown fences in system prompt, or use a proper JSON boundary detector |
| Test       | Pass `{"sms_text": "Event at Venue} tonight", "picks": []}` to parser, verify full parse |

---

## Refactor Candidates

### 1. Shared Claude-extraction scraper helper (HIGH ROI)
Skint, Nonsense NYC, and Oh My Rockness all follow the same pattern: fetch HTML → CSS-select text blocks → send to `extractEvents()` → filter by confidence. They share no code for this flow. Extract a `claudeExtractionScraper(url, selectors, options)` helper that handles fetch, text extraction, Claude call, and confidence filtering.

**Files:** `src/sources/skint.js`, `src/sources/nonsense.js`, `src/sources/ohmyrockness.js`
**Estimated savings:** ~60 lines of duplicated logic

### 2. Centralized NYC timezone utilities (HIGH ROI)
`getNycDateString`, `parseAsNycTime`, `getEventDate`, and SmallsLIVE's `parseFirstTime` all handle NYC timezone conversion with varying correctness. Consolidate into `src/time.js` with `getNycOffset()`, `getNycDate(dayOffset)`, `formatAsNycIso(dateLocal, hours, mins)`.

**Files:** `src/geo.js`, `src/sources/smallslive.js`
**Fixes:** ISSUE-001, ISSUE-002, ISSUE-011

### 3. Session state machine (LOW ROI now, HIGH later)
Session fields (`pendingNearby`, `lastPicks`, `visitedHoods`, `allOfferedIds`) are managed ad-hoc across handler intent functions. As features grow, a formal state machine would prevent stale state bugs like ISSUE-005. Not urgent for the current feature set.

**Files:** `src/handler.js`, `src/session.js`

---

## PR Plan

### PR 1: Fix timezone bugs
**Title:** Fix DST and timezone offset bugs in date/time utilities
**Files:** `src/geo.js`, `src/sources/smallslive.js`, `test/smoke.test.js`
**Fixes:** ISSUE-001, ISSUE-002, ISSUE-011
**Acceptance:**
- SmallsLIVE events use dynamic offset (correct in both EDT and EST)
- `getNycDateString(1)` returns correct date on DST fall-back night
- `parseAsNycTime` uses reliable offset detection
- Unit tests for DST edge cases pass

### PR 2: Fix dedup + data quality
**Title:** Stabilize event dedup IDs and fix RA free detection
**Files:** `src/sources/shared.js`, `src/sources/ra.js`, `src/events.js`, `test/smoke.test.js`
**Fixes:** ISSUE-003, ISSUE-004, ISSUE-006
**Acceptance:**
- `makeEventId` never uses `randomUUID()`
- RA events default to `is_free: false`
- `msUntilNextScrape` returns ~0 at exactly 10:00 AM
- Unit tests for each edge case pass

### PR 3: Fix nudge state + pick validation
**Title:** Clear stale nudge state and validate pick references
**Files:** `src/handler.js`, `test/smoke.test.js`
**Fixes:** ISSUE-005, ISSUE-008, ISSUE-009
**Acceptance:**
- `pendingNearby` cleared on non-nudge intents
- Out-of-range pick numbers return helpful error message
- "All details" path respects SMS length constraints
- Integration tests for each case pass

### PR 4: Resilience improvements
**Title:** Add geocode error handling and improve AI error messages
**Files:** `src/events.js`, `src/ai.js`, `src/handler.js`
**Fixes:** ISSUE-007, ISSUE-012, ISSUE-014
**Acceptance:**
- `batchGeocodeEvents` failure doesn't block cache refresh
- Hallucination recovery uses full name match and logs `[RECOVERED]`
- At least `more` and `free` intents have specific fallback messages

### PR 5: Lower-priority improvements
**Title:** Minor data quality, performance, and security improvements
**Files:** `src/geo.js`, `src/pre-router.js`, `src/sources/donyc.js`, `src/ai.js`
**Fixes:** ISSUE-010, ISSUE-013, ISSUE-015, ISSUE-016, ISSUE-017
**Acceptance:**
- Borough-level fallback returns `null` instead of arbitrary neighborhood
- Pre-router matches digits 1-5
- DoNYC categories fetch in parallel
- User messages wrapped in XML tags in Claude prompts
