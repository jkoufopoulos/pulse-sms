# Scrape Guard: Self-Healing Scraper Pipeline

> Detect silent data rot and structural scraper breakage at scrape time, before bad data reaches users.

## Problem

When a source's DOM or API changes, the scraper may return plausible-looking but wrong data (wrong dates, missing venues, truncated descriptions). Current quality gates (completeness < 0.4, confidence < 0.4) catch gross failures but not subtle rot. The daily cache's rolling-week overlap means quarantining a broken source costs almost nothing -- yesterday's good events are still in the cache.

## Design

Two layers: **baseline gates** (block bad data from entering the cache) and **post-scrape audit** (detect subtle drift after merge).

### Layer 1: Scrape-Time Baseline Gates

New module `src/scrape-guard.js` (~100 lines). After `timedFetch` returns events for a source but before merge into cache, run four checks comparing against the source's 7-day rolling history.

| Check | Logic | Quarantine threshold |
|-------|-------|---------------------|
| Count drift | Event count vs 7-day average | <40% of average (or <3 when avg is 10+) |
| Field coverage | % events with venue_name, date_local, name | >25pp drop from historical average |
| Date sanity | % events with date_local within next 7 days | <20% when historical avg is >60% |
| Duplicate spike | % events sharing identical name | >50% identical names |

**Baseline source:** `sourceHealth[label].history` (already stores 7 days of count/status). Extended to also store `fieldCoverage: { venue_name: 0.95, date_local: 0.88 }` per entry.

**Quarantine behavior:**
- Source marked `status: 'quarantined'`, events not merged into cache
- Alert sent via `sendHealthAlert` with quarantine reason
- Yesterday's events for that source survive in the cache naturally
- Health dashboard shows quarantine status + reason

### Layer 2: Post-Scrape Eval Audit

After `refreshCache` completes the merge, automatically run two existing eval checks:

1. **`checkSourceCompleteness(fetchMap)`** -- per-source field validation against `SOURCE_EXPECTATIONS`. Alert when any source's pass rate drops below 80%.
2. **`runExtractionAudit(events, extractionInputs)`** -- Tier 1 deterministic checks on Claude-extracted sources. Alert when any source's pass rate drops below 70%.

These run after merge as a second line of defense. Alert-only (no quarantine) -- they catch subtle quality drift, not structural breakage.

## Integration

### Changed flow in `refreshCache` (events.js)

```
Before: timedFetch -> merge in priority order -> geocode -> stamp -> persist
After:  timedFetch -> baseline gate per source -> merge survivors -> post-scrape audit -> geocode -> stamp -> persist
```

### File changes

1. **`src/scrape-guard.js`** (new, ~100 lines) -- exports `checkBaseline(label, events)` and `postScrapeAudit(fetchMap, events, extractionInputs)`.

2. **`src/source-health.js`** -- extend `updateSourceHealth` to compute and store `fieldCoverage` stats in history entries. Add `getBaselineStats(label)` helper that returns rolling averages.

3. **`src/events.js`** -- in `refreshCache`, after `timedFetch` loop and before merge loop: call `checkBaseline` per source, quarantine failures. After merge, before geocode: call `postScrapeAudit`.

4. **`src/alerts.js`** -- no changes needed. Existing `sendHealthAlert` handles quarantine alerts. Existing `sendRuntimeAlert` handles audit alerts.

### What doesn't change

`timedFetch`, `saveResponseFrame`, `buildTaggedPool`, the agent brain, the SMS hot path. All changes are scrape-time only.

## Edge cases

- **First deploy / no history:** Skip baseline gates for sources with <3 history entries. Let them build up naturally.
- **Source legitimately changes count:** e.g., Dice adds a new category and doubles events. Quarantine fires, alert sent, you see it's fine and the baseline adjusts within 2-3 scrapes as history accumulates.
- **All sources quarantined:** Won't happen -- quarantine only blocks merge of new events, cache retains yesterday's data. Even if every source were quarantined, users get yesterday's events.

## Success criteria

- A source returning garbage (wrong dates, missing venues) is quarantined before merge
- A source returning 0 events is already caught by existing consecutive-zero detection
- Post-scrape audit catches subtle quality drift in Claude-extracted sources
- Health dashboard shows quarantine status with reason
- No changes to SMS hot path latency or cost
