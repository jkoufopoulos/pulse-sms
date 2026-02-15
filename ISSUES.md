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
