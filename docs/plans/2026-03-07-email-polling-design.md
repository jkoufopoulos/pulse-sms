# Email-Only Polling Design

**Date:** 2026-03-07
**Status:** Approved

## Problem

The 3 highest-quality discovery sources (NonsenseNYC w:0.9, ScreenSlate w:0.9, Yutori w:0.8) are email-scraped from Gmail. They only get fetched during the full scrape at 10am/6pm ET, creating a 15-hour overnight gap (6pm→10am). If a newsletter arrives after 6pm, its events are invisible until the next morning — by which time tonight's events are stale.

On 2026-03-07, ScreenSlate and Skint produced **zero events** and NonsenseNYC only **4 events** in the cache. Newsletters arriving later in the day would be missed entirely.

## Solution

Add a lightweight email-only polling schedule that fetches just the email sources every 4 hours and merges new events into the live cache. Full scrapes continue at 10am/6pm.

## Design

### source-registry.js

Add `channel: 'email'` to email-based sources:
- NonsenseNYC (`channel: 'email'`)
- Yutori (`channel: 'email'`)
- ScreenSlate (`channel: 'email'`)

Derive and export `EMAIL_SOURCES`:
```js
const EMAIL_SOURCES = SOURCES.filter(s => s.channel === 'email');
```

### events.js

**New function: `refreshEmailSources()`**
1. Fetch only `EMAIL_SOURCES` via `Promise.allSettled` + `timedFetch`
2. Run each through `checkBaseline` (same quality gates as full scrape)
3. Merge into live `eventCache` — new IDs appended, existing IDs skipped (higher-weight source already won during full scrape)
4. Update `sourceHealth` for polled sources
5. Re-persist to `data/events-cache.json`

**New schedule:**
```js
const EMAIL_POLL_HOURS = [6, 10, 14, 18, 22]; // every 4h ET
```

At 10am/6pm, `refreshCache()` fires (includes email sources). At 6am/2pm/10pm, only `refreshEmailSources()` fires. Scheduler picks whichever is next.

**New function: `scheduleEmailPolls()`**
- Same pattern as `scheduleDailyScrape()` — `setTimeout` to next email poll hour, repeat
- Skips if a full scrape is running (`refreshPromise` is set)

### Merge logic

Append-only: if event ID exists in cache, skip. If new, add it. Same hash-based dedup (name + venue + date) as `refreshCache`. No re-sorting of the full cache — new events go through `applyQualityGates` before insertion.

### What doesn't change

- Full scrapes at 10am/6pm (unchanged)
- `isCacheFresh()` checks full scrape timestamp only (email polls don't reset it)
- Cache JSON format unchanged
- Serving path, `buildSearchPool`, agent loop, session handling — all untouched
- No user-facing latency impact

### Edge cases

- **Gmail auth failure:** Graceful degradation (returns empty array, logged in sourceHealth)
- **Overlap at 10/18:** Full scrape covers email sources; email poll is redundant but harmless (dedup prevents duplicates)
- **Server restart:** Both `scheduleDailyScrape()` and `scheduleEmailPolls()` called on startup
- **Concurrent access:** `refreshEmailSources` checks/sets its own promise guard (like `refreshPromise` for full scrapes)

## Principles

- **P1 (Structured tool calls own state):** No impact — this is scrape-time only
- **P4 (One save path):** Cache persistence still goes through the same JSON write
- **P6 (Mechanical shortcuts):** No LLM cost — email polling is $0 (Gmail API + cached LLM extraction results)
