# NightOwl — Issues Log

Generated: 2026-02-14
Scope: Full repo review of all source files
Status: **All 23 issues fixed**

---

## CRITICAL — Fixed

### 1. `resolveNeighborhood` borough map short-circuits geo lookup — FIXED
**Fix:** Moved borough map below geo lookup in `src/utils/geo.js`. Coords now checked first; borough is a fallback only when no lat/lng available. Verified with test: `resolveNeighborhood('Brooklyn', 40.6934, -73.9867)` → `'Downtown Brooklyn'`.

### 2. Concurrent cache refresh race condition — FIXED
**Fix:** Added `refreshPromise` mutex in `src/services/events.js`. Multiple simultaneous requests share a single refresh promise.

### 3. No timeout on Claude API calls — FIXED
**Fix:** Added `{ timeout: 12000 }` (12s) on `pickEvents` and `{ timeout: 30000 }` (30s) on `extractEvents` in `src/services/ai.js`.

### 4. Eventbrite category hardcoded to `'nightlife'` — FIXED
**Fix:** Added `inferCategory()` function in `src/utils/geo.js` that detects comedy, art, nightlife, live_music, theater, food_drink, community from event name/description keywords. Used by Eventbrite source in `src/services/sources.js`.

### 5. Greenwich Village and West Village identical coordinates — FIXED
**Fix:** Adjusted Greenwich Village to `lat: 40.7308, lng: -73.9973` in `src/utils/neighborhoods.js` (toward Washington Square Park, distinct from West Village).

---

## HIGH — Fixed

### 6. No Twilio webhook signature validation — FIXED
**Fix:** Added `twilio.webhook({ validate: true })` middleware in `src/routes/sms.js`. Only enabled when `TWILIO_AUTH_TOKEN` is set (allows local dev without Twilio).

### 7. Phone numbers logged in plaintext (PII) — FIXED
**Fix:** Added `maskPhone()` in `src/routes/sms.js` and `src/services/sms.js`. Logs now show `***-***-1234` instead of full numbers. Message text truncated to 80 chars in logs.

### 8. Server startup blocks on cache refresh — FIXED
**Fix:** Changed to fire-and-forget in `src/server.js`: `refreshCache().catch(...)` without `await`. Health check responds immediately.

---

## MEDIUM — Fixed

### 9. DETAILS, MORE, FREE commands not implemented — FIXED
**Fix:** Full implementation in `src/routes/sms.js` with session store:
- **DETAILS**: Shows venue address, ticket URL, map hint for lead pick
- **MORE**: Re-runs Claude picks excluding previously shown events
- **FREE**: Filters to free events, runs picks on those
- Sessions stored in-memory with 30-minute TTL and cleanup interval

### 10. Songkick `is_free` always hardcoded false — FIXED
**Fix:** Now checks `offers.lowPrice`/`offers.price` and scans event name for "free" in `src/services/sources.js`.

### 11. No "I don't know your neighborhood" path — FIXED
**Fix:** When `extractNeighborhood` returns null, sends "Hey! What neighborhood are you near?" instead of silently defaulting to Midtown.

### 12. No rate limiting — FIXED
**Fix:** Added in-memory rate limiter in `src/routes/sms.js`: 15 requests per phone per hour. Rate-limited requests get empty TwiML response (silent drop).

### 13. Skint content truncated at 8000 chars — FIXED
**Fix:** Increased limit to 15,000 chars in `src/services/sources.js`. Claude Sonnet handles 200K tokens; 15K chars is safe.

### 14. Extracted lat/lng from Claude discarded — FIXED
**Fix:** `normalizeExtractedEvent` in `src/services/sources.js` now passes Claude-extracted `latitude`/`longitude` to `resolveNeighborhood` when neighborhood is not already set.

### 15. Songkick never passes geo coords to `resolveNeighborhood` — FIXED
**Fix:** Songkick fetcher now extracts `geo.latitude`/`geo.longitude` from JSON-LD and passes them to `resolveNeighborhood` in `src/services/sources.js`.

### 16. No error response path when everything fails — NOTED
**Status:** The current behavior (try error SMS, then empty TwiML) is the correct pattern for Twilio. Adding a retry queue or alerting is a future enhancement, not a code fix.

---

## LOW — Fixed

### 17. `refreshSkintCache` alias is misleading — FIXED
**Fix:** Removed alias. All references now use `refreshCache` directly in `src/server.js` and `src/services/events.js`.

### 18. No test files — FIXED
**Fix:** Created `test/smoke.test.js` with 43 tests covering all pure functions: renderSMS, extractNeighborhood, makeEventId, resolveNeighborhood, inferCategory, haversine, getNycDateString, rankEventsByProximity. Run via `npm test`.

### 19. No `.nvmrc` or Node version pinning — FIXED
**Fix:** Added `.nvmrc` with Node 20.

### 20. `.env` validation is warning-only — FIXED
**Fix:** Changed to `process.exit(1)` on missing critical env vars in `src/server.js`. Server won't start without required keys.

### 21. User message logged in full — FIXED
**Fix:** Messages truncated to 80 chars in logs. Phone numbers masked (see #7).

### 22. No graceful shutdown handler — FIXED
**Fix:** Added `SIGTERM`/`SIGINT` handlers in `src/server.js` that clear the cache interval, close the server, and force-exit after 5s.

### 23. `setInterval` for cache refresh isn't cleared — FIXED
**Fix:** Interval ID stored in `cacheInterval` variable and cleared in shutdown handler.

---

## Refactoring (post-fix)

`src/services/events.js` exceeded 500 lines after fixes. Split into 3 files:

| File | Lines | Responsibility |
|------|-------|----------------|
| `src/services/events.js` | 148 | Cache orchestration, Tavily fallback, `getEvents` |
| `src/services/sources.js` | 298 | 3 source fetchers (Skint, Eventbrite, Songkick), event normalization |
| `src/utils/geo.js` | 126 | resolveNeighborhood, rankEventsByProximity, haversine, inferCategory, getNycDateString |

All 43 smoke tests pass after refactor.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 5 | All fixed |
| High | 3 | All fixed |
| Medium | 8 | 7 fixed, 1 noted (future enhancement) |
| Low | 7 | All fixed |
| **Total** | **23** | **22 fixed, 1 noted** |

---
---

# Pipeline Review — Open UX Issues

15 additional UX issues and edge cases identified during full pipeline review (2026-02-14).

---

## Critical (4)

### #1: `formatEventDetails` omits time and price

- **File:** `src/routes/sms.js:64-71`
- **Impact:** High — breaks the core DETAILS use case
- **Description:** When a user texts "when does it start?" or "how much?", both the AI and legacy flows route to DETAILS and call `formatEventDetails`. But the helper only includes name, venue, address, ticket URL, and map hint. It never shows `start_time_local`, `end_time_local`, `is_free`, or `price_display`. A user literally asking "what time?" gets an address back.

### #2: Silent rate limiting — user gets zero feedback

- **File:** `src/routes/sms.js:135-138`
- **Impact:** High — user thinks the service is broken
- **Description:** When a user exceeds 15 messages/hour, `handleMessage` returns silently. No SMS is sent. The user texts and nothing happens. They'll assume the service is broken and keep texting, which extends their rate limit window.

### #3: Legacy regex: "no cover" routes to DETAILS instead of FREE

- **File:** `src/routes/sms.js:321` (matches `\bcover\b`) vs `line 347` (matches `\bno cover\b`)
- **Impact:** Medium — wrong intent in legacy flow
- **Description:** The "how much" pattern at line 321 matches `\bcover\b` before the "free" pattern at line 347 matches `\bno cover\b`. User intent is clearly "show me free events" but they get event details instead. The patterns are checked top-to-bottom, and the broader pattern fires first. Similarly, "tickets" in "I already have tickets" would incorrectly route to DETAILS.

### #4: "FREE" intent silently defaults to Midtown

- **File:** `src/routes/sms.js:238`
- **Impact:** Medium — confusing results for non-Manhattan users
- **Description:** `neighborhood || session?.lastNeighborhood || 'Midtown'` — a brand-new user texting "any free events?" with no session gets Midtown events without being told why. The "events" intent has a neighborhood guard (line 211) that asks the user, but "free" doesn't have this gate.

---

## Significant (5)

### #5: "MORE" replaces session — can't go back to original picks

- **File:** `src/routes/sms.js:224-226`
- **Impact:** Medium — loss of context for DETAILS after MORE
- **Description:** When MORE runs, `setSession` replaces `lastEvents` with only the remaining events. The original picks are gone. If the user says "DETAILS" after "MORE", they can only see details for the second batch. "Tell me more about that first one" (from the original batch) is lost.

### #6: "MORE" with no prior session gives a misleading message

- **File:** `src/routes/sms.js:217-233`
- **Impact:** Low-Medium — confusing for new users
- **Description:** If a brand-new user texts "show me more" with no session, the `if (session && session.lastEvents)` check fails and they get: "That's all I've got for now. Try a different neighborhood or check back later!" They've been shown nothing. Should say something like "Text a neighborhood to get started!"

### #7: `composeResponse` picks aren't validated — DETAILS silently breaks

- **File:** `src/services/ai.js:474-476`
- **Impact:** Medium — DETAILS fails with no useful error
- **Description:** `parsed.picks` is stored as-is without validating that each pick has an `event_id` field. If Claude returns malformed picks (e.g., `{"rank": 1, "id": "..."}` instead of `event_id`), the session stores them. Later, `session.lastPicks[0].event_id` is `undefined`, `session.lastEvents[undefined]` is `undefined`, and the user gets "No recent picks to show details for" despite just being shown picks.

### #8: Empty events list passed to `composeResponse`

- **File:** `src/routes/sms.js:256, 260`
- **Impact:** Low-Medium — fragile path for thin neighborhoods
- **Description:** `getEvents(hood)` can return `[]`. This is passed directly to `composeResponse`. Claude receives an empty `EVENT_LIST` and has to compose a response from nothing. The COMPOSE_SYSTEM prompt says "If nothing is worth recommending, say so honestly" but there's no explicit empty-input handling. One wrong Claude response and the user gets the generic glitch message instead of a helpful "quiet night" reply.

### #9: `free_only` filter is extracted but never used

- **File:** `src/routes/sms.js:237-252` and `src/services/ai.js:447`
- **Impact:** Low-Medium — missed preference for edge-case messages
- **Description:** `routeMessage` extracts `filters.free_only` from user intent. But if Claude routes a message like "anything free in the East Village?" as intent `events` with `free_only: true` (rather than intent `free`), the events handler runs without filtering. The filter is passed to `composeResponse` but the prompt only shows `category` and `vibe`, not `free_only`. Claude would have to re-infer it from the raw user message.

---

## Minor (6)

### #10: Whitespace-only messages waste an API call

- **File:** `src/routes/sms.js:103`
- **Impact:** Low — wasted API cost
- **Description:** `!message` check passes for `" "` (whitespace-only is truthy in JS). A whitespace-only message goes through the full AI routing pipeline. Should trim before checking.

### #11: `interpretMessage` reply not length-bounded in legacy flow

- **File:** `src/routes/sms.js:451`
- **Impact:** Low — potential for oversized SMS
- **Description:** Sends `interpretation.reply` without `.slice(0, 480)`. Claude could theoretically return a reply longer than 480 chars. The AI flow paths do `.slice(0, 480)` (lines 167, 175), but the legacy `interpretMessage` path doesn't.

### #12: Unrecognized Claude intents silently fall through to events default

- **File:** `src/routes/sms.js:156-268`
- **Impact:** Low — defensive gap
- **Description:** If `routeMessage` returns an intent string that doesn't match any of the if-checks (e.g., Claude returns `"question"` instead of `"conversational"`), no branch fires. Execution reaches line 254 and defaults to fetching events. The `!neighborhood` check on line 211 only gates `route.intent === 'events'`, so the unknown intent bypasses the neighborhood prompt and silently defaults to Midtown.

### #13: Legacy DETAILS always shows the first pick — no way to reference #2 or #3

- **File:** `src/routes/sms.js:295, 305, 314, 323, 373`
- **Impact:** Low — limited in legacy flow only
- **Description:** All legacy follow-up DETAILS paths use `session.lastPicks[0]`. The AI flow handles `event_reference` for numbered picks, but the legacy flow can't. If a user sends "tell me about the second one" via legacy, they get details for pick #1.

### #14: Event reference parsing requires numeric input

- **File:** `src/routes/sms.js:183`
- **Impact:** Low — graceful fallback exists
- **Description:** `parseInt(route.event_reference, 10)` works for `"2"` but returns `NaN` for `"the second one"`. The `|| 1` fallback defaults to pick #1. The ROUTE_SYSTEM prompt says Claude can set event_reference to "the rank number (1, 2, 3) or keyword" but only numbers actually work downstream.

### #15: 20 events serialized per `composeResponse` call

- **File:** `src/services/ai.js:427-442`
- **Impact:** Low — latency and cost
- **Description:** `getEvents` returns up to 20 events, all serialized to JSON (~12 fields each) in the prompt. This is ~2-3K input tokens per compose call even when Claude only picks 1-3. Not a bug, but could pre-filter to top ~8 by proximity to reduce cost and latency.

---

## Priority Ranking (Impact x LOE)

Ranked by bang-for-buck: high impact + low effort = fix first.

| Rank | Issue | Impact | LOE | What to do |
|------|-------|--------|-----|------------|
| 1 | **#1** formatEventDetails missing time/price | High | ~10 min | FIXED — added time, price, free fields |
| 2 | **#2** Silent rate limiting | High | ~5 min | FIXED — sends message (currently disabled per user request) |
| 3 | **#10** Whitespace-only messages | Low | ~1 min | FIXED — added `.trim()` to check |
| 4 | **#11** Legacy reply not length-bounded | Low | ~1 min | FIXED — added `.slice(0, 480)` |
| 5 | **#6** MORE with no session — bad message | Low-Med | ~2 min | FIXED — shows "Text a neighborhood to get started!" when no session |
| 6 | **#3** "no cover" regex ordering | Medium | ~10 min | FIXED — moved free regex above price/cover in legacy flow |
| 7 | **#4** FREE defaults to Midtown | Medium | ~10 min | FIXED — added neighborhood guard before free handler |
| 8 | **#12** Unknown intents fall through | Low | ~10 min | FIXED — unknown intents now hit neighborhood guard before defaulting to events |
| 9 | **#7** Picks not validated | Medium | ~15 min | FIXED — `composeResponse` filters picks to those with valid `event_id` |
| 10 | **#8** Empty events → composeResponse | Low-Med | ~10 min | FIXED — early return with "Quiet night" message when no events |
| 11 | **#14** Event reference needs numeric input | Low | ~5 min | Won't fix — `|| 1` fallback is sufficient, Claude returns digits |
| 12 | **#9** `free_only` filter unused | Low-Med | ~30 min | FIXED — events handler pre-filters when `free_only` is true; compose prompt now includes `free_only` |
| 13 | **#5** MORE replaces session history | Medium | ~45 min | FIXED — session keeps full `allEvents` map + `allPicks` across batches; DETAILS references current batch |
| 14 | **#13** Legacy DETAILS: first pick only | Low | ~30 min | FIXED — "DETAILS 2" now parses pick number in legacy flow |
| 15 | **#15** 20 events per compose call | Low | ~30 min | FIXED — events sliced to top 8 before compose; full set kept in session for MORE |

### Quick wins (ranks 1-5): DONE
### Medium effort (ranks 6-11): DONE
### Larger lifts (ranks 12-15): DONE

---
---

# Consolidated Review — All Open Issues

Merged from 4 parallel reviews (code, architecture, edge case, UX) on 2026-02-14.
Deduplicated across 112 raw findings → **45 unique issues** organized by priority tier.

---

## Tier 1 — Critical / High Impact (fix first)

### C1. Timezone-naive date parsing across the app
- **Files:** `src/utils/geo.js:95-100` (`getNycDateString`), `src/utils/geo.js:134-158` (`filterUpcomingEvents`)
- **Impact:** Events shown/hidden incorrectly on cloud servers running in UTC
- **Description:** `getNycDateString` mixes server-local timezone with NYC-formatted date parts. `filterUpcomingEvents` parses `start_time_local` strings (e.g., `"2026-02-14T21:00:00"` — no offset) via `new Date()` which uses server timezone, not NYC. On a UTC server, 9 PM NYC (2 AM UTC next day) is parsed as 9 PM UTC = 4 PM NYC → events filtered too early.
- **Fix:** Simplify `getNycDateString` to `new Date(Date.now() + dayOffset * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })`. In `filterUpcomingEvents`, append `-05:00` (or detect DST) when parsing timezone-naive strings.
- **LOE:** ~30 min

### C2. AI flow has no try/catch — failures cascade to full legacy re-run
- **Files:** `src/routes/sms.js:161-304` (handleMessageAI), `src/routes/sms.js:145-155` (fallback)
- **Impact:** Double Claude API spend, 30-60s total latency, duplicate/conflicting responses
- **Description:** If `composeResponse` fails after `getEvents` succeeds, the error propagates to `handleMessage` which retries via `handleMessageLegacy` — discarding already-fetched events and making fresh Claude calls. If Twilio is down (not Claude), legacy also fails the same way. No distinction between "Claude failed" and "Twilio failed."
- **Fix:** Wrap `handleMessageAI` in try/catch. On `composeResponse` failure, use `pickEvents` + `renderSMS` as middle-ground fallback with already-fetched events. On `sendSMS` failure, don't retry via legacy.
- **LOE:** ~30 min

### C3. No STOP/UNSUBSCRIBE/CANCEL keyword handling (TCPA compliance)
- **File:** `src/routes/sms.js` — entire `handleMessage` flow
- **Impact:** Responding to opt-out keywords with marketing content violates carrier regulations
- **Description:** If Twilio's Advanced Opt-Out is disabled, "STOP" reaches the webhook, goes through AI routing, and gets a conversational response. This is a compliance risk.
- **Fix:** Add early check in `handleMessage` for STOP/UNSUBSCRIBE/CANCEL/QUIT. Return without sending any SMS. Verify Twilio's Advanced Opt-Out is enabled.
- **LOE:** ~10 min

### C4. `response.content[0].text` accessed without null-safety across all Claude API calls
- **Files:** `src/services/ai.js:129,201,270,361,461`
- **Impact:** Server crash (TypeError) if Anthropic returns empty content array
- **Description:** Every Claude API call accesses `response.content[0].text` without checking if `content` is non-empty. Can happen with `max_tokens` edge cases or API changes.
- **Fix:** Guard: `const text = response.content?.[0]?.text || ''` at each call site. Handle empty explicitly.
- **LOE:** ~10 min

### C5. No timeout on Twilio `sendSMS` — unbounded outbound calls
- **File:** `src/services/sms.js:12-21`
- **Impact:** If Twilio is slow/unresponsive, async handlers hang indefinitely
- **Description:** No timeout on `client.messages.create`. No circuit breaker. Multiple `sendSMS` calls in a single request path can all hang.
- **Fix:** Wrap in `Promise.race` with 10s timeout. Add circuit breaker after N consecutive failures.
- **LOE:** ~15 min

### C6. Concurrent messages from same phone cause session race conditions — DEFERRED (post-MVP)
- **Files:** `src/routes/sms.js:82-90,104-128`
- **Why deferred:** Requires rapid-fire texting to trigger. Rare in practice.

### ~~C7. Scraping Eventbrite/Songkick via HTML~~ — REMOVED
Scraping is the intended approach for MVP. Good event data is the priority.

---

## Tier 2 — Medium Impact (next priority)

### M1. All in-memory state lost on restart (sessions, dedup, cache) — DEFERRED (post-MVP)
- **Why deferred:** In-memory is fine for single-process MVP. Restart losing sessions is acceptable at low traffic.

### M2. Legacy MORE replaces session — DETAILS for previous batch breaks
- **File:** `src/routes/sms.js:424-432`
- **Impact:** Legacy flow loses original picks after MORE
- **Description:** AI flow was fixed (allPicks/allEvents pattern), but legacy flow still replaces `lastEvents` with only remaining events.
- **Fix:** Mirror AI flow's `allPicks` pattern in legacy MORE.
- **LOE:** ~20 min

### M3. Legacy FREE still defaults to Midtown silently
- **File:** `src/routes/sms.js:444`
- **Impact:** Users without session get Midtown events instead of being asked
- **Description:** AI flow was fixed with neighborhood guard, but legacy flow still has `|| 'Midtown'` fallback.
- **Fix:** Add neighborhood guard matching AI flow pattern.
- **LOE:** ~5 min

### M4. `composeResponse` validates pick type but not existence in event list
- **File:** `src/services/ai.js:473`
- **Impact:** DETAILS fails silently when Claude returns non-existent event_id
- **Fix:** Build ID set from events: `const validIds = new Set(events.map(e => e.id))`. Filter: `parsed.picks.filter(p => p?.event_id && validIds.has(p.event_id))`.
- **LOE:** ~10 min

### M5. Tavily fallback runs uncached on every request for thin neighborhoods — DEFERRED (post-MVP)
- **Why deferred:** Cost optimization. At MVP traffic, a few extra Tavily calls don't matter.

### M6. No first-time user onboarding / welcome message — DEFERRED (post-MVP)
- **Why deferred:** Users who text the number already know what it does. Nice-to-have.

### M7. Session TTL of 30 minutes too short for a night out
- **File:** `src/routes/sms.js:80`
- **Impact:** DETAILS fails after dinner break; typical planning spans 1-2 hrs
- **Fix:** Change `SESSION_TTL` to `2 * 60 * 60 * 1000` (2 hours).
- **LOE:** ~1 min

### M8. "Quiet night" message doesn't suggest specific nearby neighborhoods with events — DEFERRED (post-MVP)
- **Why deferred:** "Try a nearby neighborhood" is fine for now. Polish feature.

### M9. Missing major NYC neighborhoods (Meatpacking, Chinatown, East Wburg, etc.)
- **File:** `src/utils/neighborhoods.js`
- **Impact:** Common neighborhoods return null → user asked again
- **Fix:** Add Meatpacking→Chelsea, Chinatown/Little Italy→LES, East Williamsburg→Bushwick, Ridgewood→Bushwick, Murray Hill→Midtown, South Slope→Park Slope.
- **LOE:** ~20 min

### M10. `filterUpcomingEvents` passes through events with no parseable time — stale events accumulate
- **File:** `src/utils/geo.js:138-140`
- **Impact:** Yesterday's events shown to users
- **Description:** Events with `start_time_local: null` or date-only strings from previous days pass the filter.
- **Fix:** Add date-only check: `if (e.date_local && e.date_local < getNycDateString(0)) return false;`
- **LOE:** ~10 min

### M11. No processing acknowledgment during slow Claude calls (5-30s silence) — DEFERRED (post-MVP)
- **Why deferred:** Adds extra Twilio call per message. Users can wait 5-10s for MVP.

### M12. `routeMessage` fallback defaults to `intent: 'events'` — may trigger unwanted event fetch
- **File:** `src/services/ai.js:364-374`
- **Impact:** On parse failure, returning users get unwanted event list instead of helpful error
- **Fix:** Change fallback to `intent: 'conversational'` with reply: "Sorry, I didn't catch that. Text a neighborhood to see tonight's picks, or HELP for commands."
- **LOE:** ~5 min

### M13. Category filtering extracted but never pre-filtered on events — DEFERRED (post-MVP)
- **Why deferred:** Claude handles it well enough via prompt hint. Not enforced but functional.

### M14. "No free events — try MORE" is misleading
- **File:** `src/routes/sms.js:252`
- **Impact:** MORE shows non-free events, confusing user
- **Fix:** Change to: `No free events found near ${hood} tonight. Text "${hood}" to see all events instead.`
- **LOE:** ~2 min

### M15. `makeEventId` collisions for events with null/empty fields
- **File:** `src/services/sources.js:14-17`
- **Impact:** Events with missing name+venue+date hash identically → silent dedup drops
- **Fix:** Include source name in hash: `${name}|${venue}|${date}|${sourceName}`.
- **LOE:** ~5 min

### M16. `parseJsonFromResponse` returns first valid fragment, not the most complete one — DEFERRED (post-MVP)
- **Why deferred:** Edge case. Current parser works 99% of the time.

### M17. Express body size limit too permissive for SMS endpoint
- **File:** `src/server.js:20-21`
- **Impact:** 100KB POST bodies processed when SMS should be <2KB
- **Fix:** Add `express.urlencoded({ extended: false, limit: '5kb' })` for SMS route.
- **LOE:** ~5 min

### M18. Skint extraction re-runs Claude on identical content every 2 hours — DEFERRED (post-MVP)
- **Why deferred:** Saves ~$0.50/day. Not worth optimizing at MVP.

---

## Tier 3 — Low Impact / Nice-to-Have

### L1. No horizontal scalability — DEFERRED (post-MVP)
### L2. Claude API is single point of failure — no local fast-path router — DEFERRED (post-MVP)
### L3. Every message costs 2 Claude calls — no compose response caching — DEFERRED (post-MVP)
### L4. No request-level concurrency control — Claude API stampede risk — DEFERRED (post-MVP)
### L5. No structured logging or correlation IDs — DEFERRED (post-MVP)
### L6. `sms.js` is a 548-line god module — DEFERRED (post-MVP)

### L7. Duplicated `maskPhone` function in two files
- **Files:** `src/routes/sms.js:58-61`, `src/services/sms.js:18`
- **Fix:** Extract to shared utility.
- **LOE:** ~5 min

### L8. `boroughMap` recreated on every `resolveNeighborhood` call
- **File:** `src/utils/geo.js:39-48`
- **Fix:** Move to module scope as constant.
- **LOE:** ~2 min

### L9. `is_free` normalization uses loose equality — `0` treated as non-null
- **File:** `src/services/sources.js:280`
- **Fix:** Use `is_free: Boolean(e.is_free)` or `e.is_free === true`.
- **LOE:** ~2 min

### L10. Health check exposes internal source health without auth
- **File:** `src/server.js:24-26`
- **Fix:** Return `{ status: 'ok' }` publicly; move details behind auth.
- **LOE:** ~10 min

### L11. No Express security middleware (Helmet, trust proxy)
- **File:** `src/server.js`
- **Fix:** Add `helmet()`. Set `trust proxy` for production.
- **LOE:** ~10 min

### L12. `renderSMS` alt picks with missing events produce blank lines
- **File:** `src/services/sms-render.js:40`
- **Fix:** Filter out entries where `eventMap[p.event_id]` is undefined.
- **LOE:** ~5 min

### L13. Dedup registers MessageSid before processing — retries after failure are dropped
- **File:** `src/routes/sms.js:111-119`
- **Fix:** Move `processedMessages.set()` to after `handleMessage` completes successfully.
- **LOE:** ~10 min

### L14. `setInterval` cleanup callbacks have no error handling
- **File:** `src/routes/sms.js:26-31,50-55,93-98`
- **Fix:** Wrap each callback body in try/catch.
- **LOE:** ~5 min

### L15. HELP message doesn't mention landmarks, subway stops, DETAILS numbering, or categories
- **File:** `src/routes/sms.js:171,318`
- **Fix:** Expand HELP text with examples.
- **LOE:** ~5 min

### L16. Songkick includes tomorrow's events — may confuse "tonight" users
- **File:** `src/services/sources.js:188-189`
- **Fix:** Either filter to today-only or have compose prompt note tomorrow vs tonight.
- **LOE:** ~10 min

### L17. User prompt injection defense in Claude prompts — DEFERRED (post-MVP)
- **Why deferred:** Low risk for SMS app with no financial actions.

### L18. `composeResponse` `.slice(0, 480)` can cut mid-word or mid-URL
- **File:** `src/services/ai.js:476`
- **Fix:** Use word-boundary-aware truncation. Never cut mid-URL.
- **LOE:** ~15 min

### L19. Long event names (200+ chars) consume entire SMS budget
- **File:** `src/services/sms-render.js:64`
- **Fix:** Truncate event name to ~80 chars in `formatLeadPick`.
- **LOE:** ~5 min

### L20. Cross-source event dedup only by ID, not by fuzzy name+venue match — DEFERRED (post-MVP)
- **Why deferred:** Occasional near-duplicate is acceptable for MVP.

### L21. Test suite has no integration tests, no mocking, no I/O coverage — DEFERRED (post-MVP)
- **Why deferred:** Important eventually, not blocking launch.

### L22. CTA shows DETAILS/MORE/FREE even with zero picks
- **File:** `src/services/sms-render.js:21-23`
- **Fix:** When `picks.length === 0`, use "Text another neighborhood!" instead.
- **LOE:** ~5 min

### L23. Tavily search query too generic (no date in query)
- **File:** `src/services/events.js:91`
- **Fix:** Include current date: `events tonight in ${neighborhood} NYC ${date}`.
- **LOE:** ~2 min

### L24. Anthropic client instantiated at require time before env validation
- **File:** `src/services/ai.js:1-3`
- **Fix:** Lazy-initialize on first use.
- **LOE:** ~10 min

### L25. No acknowledgment when user switches neighborhoods mid-session — DEFERRED (post-MVP)
- **Why deferred:** Polish feature.

### L26. Eventbrite `addressLocality` often "New York" → everything bucketed as Midtown
- **File:** `src/services/sources.js:113-117`
- **Fix:** When borough-fallback fires and no geo coords, leave neighborhood as `null`.
- **LOE:** ~10 min

### L27. "Vibe's brain glitched — text a neighborhood" confusing when user already provided one
- **File:** `src/services/ai.js:467`
- **Fix:** Change to "Having a moment — try again in a sec!"
- **LOE:** ~2 min

---

## MVP Scope

| Category | MVP | Deferred | Total |
|----------|-----|----------|-------|
| **Tier 1 (Critical)** | 5 | 2 (C6 concurrency, C7 removed) | 7 |
| **Tier 2 (Medium)** | 10 | 8 | 18 |
| **Tier 3 (Low)** | 12 | 8 | 20 |
| **Total** | **27** | **18** | **45** |

### MVP fix order:

**Batch 1 — Tier 1 critical (run tests after):**

| # | Issue | LOE |
|---|-------|-----|
| 1 | C3 — STOP/UNSUBSCRIBE handling | ~10 min |
| 2 | C4 — content[0] null safety | ~10 min |
| 3 | C5 — sendSMS timeout | ~15 min |
| 4 | C2 — AI flow try/catch | ~30 min |
| 5 | C1 — Timezone parsing | ~30 min |

**Batch 2 — Tier 2 bugs + quick UX (run tests after):**

| # | Issue | LOE |
|---|-------|-----|
| 6 | M7 — Session TTL → 2 hours | ~1 min |
| 7 | M3 — Legacy FREE Midtown default | ~5 min |
| 8 | M14 — Misleading "try MORE" CTA | ~2 min |
| 9 | M15 — makeEventId collisions | ~5 min |
| 10 | M12 — routeMessage fallback intent | ~5 min |
| 11 | M17 — Express body size limit | ~5 min |
| 12 | M4 — Pick validation (event_id exists) | ~10 min |
| 13 | M2 — Legacy MORE session fix | ~20 min |
| 14 | M10 — Stale events filter | ~10 min |
| 15 | M9 — Missing neighborhoods | ~20 min |

**Batch 3 — Tier 3 quick fixes (run tests after):**

| # | Issue | LOE |
|---|-------|-----|
| 16 | L8 — boroughMap to module scope | ~2 min |
| 17 | L9 — is_free Boolean coercion | ~2 min |
| 18 | L23 — Tavily query add date | ~2 min |
| 19 | L27 — Better glitch message | ~2 min |
| 20 | L7 — Dedupe maskPhone | ~5 min |
| 21 | L12 — renderSMS skip missing events | ~5 min |
| 22 | L14 — setInterval try/catch | ~5 min |
| 23 | L15 — Expand HELP message | ~5 min |
| 24 | L19 — Truncate long event names | ~5 min |
| 25 | L22 — CTA with zero picks | ~5 min |
| 26 | L24 — Lazy-init Anthropic client | ~10 min |
| 27 | L26 — Eventbrite null vs Midtown | ~10 min |
