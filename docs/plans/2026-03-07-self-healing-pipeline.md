# Self-Healing Scraper Pipeline

> Plan for closing the gap between detection (good) and recovery (missing).

## Problem

The pipeline has strong detection: scrape guard (baseline gates, duplicate spike, field coverage drift), source health tracking (7-day history, consecutive zeros), daily digests, and post-scrape audits. But recovery is almost entirely manual:

- Quarantined sources auto-clear if baseline passes, but there's no retry with different parameters
- NonsenseNYC has 9 consecutive timeouts with no escalation beyond a single email
- No graduated alerting — failure #3 and failure #9 look the same
- No per-source timeout tuning — 60s uniform timeout, but Skint regularly takes 11 minutes

## Current State (2026-03-07)

| Source | Status | Root Cause |
|--------|--------|------------|
| NonsenseNYC | 9 consecutive timeouts | Gmail API or newsletter format changed |
| Yutori | Quarantined (count drift) | LLM extraction volatility |
| TinyCupboard | Quarantined (duplicate spike) | HTML scraper returning archive listings |
| Skint | Intermittent empty | 11-minute scrapes, possible rate limiting |
| RA | Data quality (is_free) | Fixed: now uses isTicketed fallback |

## What Already Works

- `checkBaseline` quarantines on count drift, field coverage drift, duplicate spike
- Quarantined sources still get scraped and auto-clear if baseline passes next cycle
- `postScrapeAudit` logs completeness and extraction quality issues
- Health history (7 entries) tracks trends per source
- Daily digest summarizes overall pipeline health

## Plan

### Step 1: Graduated Alerting

**Problem:** Alert fatigue. 6-hour cooldown means chronic failures generate ~1 email/day with no escalation.

**Change:** Track `consecutiveFailures` (zeros + timeouts + quarantines) per source. Alert severity scales with consecutive failures:

| Consecutive | Severity | Action |
|-------------|----------|--------|
| 3 | info | Log warning (existing) |
| 5 | warning | Email with "investigate" framing |
| 7+ | critical | Email with "source likely broken" framing, include last error + duration |

**Files:** `source-health.js` (tracking), `alerts.js` (severity-aware email template)

**Effort:** Small. ~30 lines.

### Step 2: Source-Specific Timeout

**Problem:** Skint regularly takes 11 minutes but has a 60s timeout. NonsenseNYC times out at 60s when it might succeed at 90s.

**Change:** Add optional `timeout` field to SOURCES registry entries. Default stays 60s. Override for known-slow sources:

```js
{ label: 'Skint', ..., timeout: 900_000 }  // 15 min — LLM extraction + rate limits
{ label: 'NonsenseNYC', ..., timeout: 120_000 }  // 2 min — Gmail API can be slow
```

**Files:** `source-registry.js` (config), `events.js` (pass to `timedFetch`)

**Effort:** Small. ~10 lines.

### Step 3: Single Retry on Timeout

**Problem:** Transient network issues cause a full-day outage for the source.

**Change:** In `timedFetch`, if a source times out, retry once with 1.5x timeout before marking failed. Log the retry.

**Files:** `events.js` (`timedFetch`)

**Effort:** Small. ~15 lines.

### Step 4: Quarantine Diagnostic Log

**Problem:** When a source gets quarantined, the reason is logged but no diagnostic context is captured. Hard to debug without re-running.

**Change:** When quarantined, save the first 3 failing events to a diagnostic file (`data/quarantine-debug/{label}-{date}.json`) with the baseline stats and quarantine reason. This gives enough context to fix the scraper without re-running.

**Files:** `events.js` (capture), new utility in `scrape-guard.js`

**Effort:** Small. ~20 lines.

### Step 5: Auto-Disable After N Consecutive Failures

**Problem:** NonsenseNYC has failed 9 times. Each failure burns Gmail API quota and scrape time for zero return.

**Change:** After 7 consecutive failures (timeout + empty + error), skip the fetch entirely and log "auto-disabled". Source re-enables automatically when health file is cleared (deploy) or after 7 days (configurable). Different from quarantine — this skips the fetch, not just the merge.

**Files:** `events.js` (check before fetch), `source-health.js` (auto-disable logic)

**Effort:** Medium. ~40 lines. Need to be careful not to permanently lose sources.

## Execution Order

1 and 2 are independent, can be done in parallel. 3 depends on 2 (uses the custom timeout). 4 is independent. 5 depends on 1 (uses the consecutive failure count).

## What This Does NOT Cover

- **Scraper auto-repair** — If HTML structure changes, a human still needs to update the CSS selectors. This plan handles detection and graceful degradation, not auto-fix.
- **Source replacement** — If a source goes permanently offline, manual intervention is needed to find an alternative.
- **LLM extraction quality** — Extraction confidence and completeness are tracked but not auto-tuned. Prompt changes require human judgment.
