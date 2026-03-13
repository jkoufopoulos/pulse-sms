# Scraper Failure Resilience — Design

> Phase 11, Story 1: "Scraper failures degrade gracefully"
> Date: 2026-03-13

## Problem

When a source's markup changes, Pulse detects total failure (consecutiveZeros counter) but has no auto-disable, no graduated alerting, and no auto-recovery. A broken source gets scraped every cycle, logs warnings, but never gets skipped. The digest email reports status but doesn't escalate severity.

## Current State

- `consecutiveZeros` tracked per source in `source-health.js`
- Quarantine via `scrape-guard.js` (count drift, field coverage, duplicates) — per-scrape, not persistent
- `alertOnFailingSources()` defined but never called (dead code since digest replaced it)
- Daily digest emails status (green/yellow/red) but no graduated alert escalation
- No auto-disable — broken sources are retried every scrape cycle

## Design

### 1. Auto-Disable (source-health.js)

**Constant:** `AUTO_DISABLE_THRESHOLD = 7`

**In `updateSourceHealth()`:**
- When `consecutiveZeros >= AUTO_DISABLE_THRESHOLD`, set `health.disabled = true` and `health.disabledAt = now`
- Log: `[HEALTH] ${label} auto-disabled after ${consecutiveZeros} consecutive failures`

**New export:** `isSourceDisabled(label)` — returns `true` if `health.disabled === true`

**In `makeHealthEntry()`:** Add `disabled: false`, `disabledAt: null`, `lastProbeAt: null` fields.

**On boot:** `disabled` state is persisted in `health-cache.json` (already persists full health objects).

### 2. Auto-Recovery (source-health.js)

**In `updateSourceHealth()`:**
- When `events.length > 0` and `health.disabled === true`, set `health.disabled = false`, `health.disabledAt = null`
- Log: `[HEALTH] ${label} auto-recovered — ${events.length} events returned`

**Daily probe for disabled sources:**
- New export: `shouldProbeDisabled(label)` — returns `true` if disabled AND (`lastProbeAt` is null OR >24h ago)
- `events.js` calls this before skipping a disabled source. If true, fetch it anyway (probe). Update `lastProbeAt` after probe regardless of outcome.
- This means disabled sources get 1 attempt per day instead of every cycle.

### 3. Skip Disabled Sources (events.js)

**In `refreshCache()` source loop:**
- Before fetching, check `isSourceDisabled(label)`
- If disabled and `!shouldProbeDisabled(label)`: skip with log, record status `'disabled'` in health
- If disabled and `shouldProbeDisabled(label)`: fetch anyway (probe attempt), update `lastProbeAt`

**In `refreshEmailSources()`:** Same check for email-channel sources.

### 4. Graduated Alerting (daily-digest.js + alerts.js)

**In digest generation** (which already computes status):
- After computing digest status, call new `sendGraduatedAlert(severity, digest)` in `alerts.js`
- `yellow`: 1-2 sources below threshold OR 20-40% cache drop → email subject: "Pulse: needs attention"
- `red`: 3+ sources below OR >50% cache drop OR any auto-disabled → email subject: "Pulse: action required"
- `green`: no alert email (digest email still sent separately)

**`sendGraduatedAlert()` in alerts.js:**
- Separate from `sendHealthAlert` (which is dead code)
- Uses digest cooldown (1/day) — no separate cooldown needed since it's called from digest generation
- Email body: severity, which sources need attention, cache delta, recommended action

### 5. Cleanup

- Remove `alertOnFailingSources()` from `source-health.js` (dead code, never called)
- Remove its export

## Files Changed

| File | Change |
|------|--------|
| `src/source-health.js` | Add auto-disable/recovery in `updateSourceHealth`, new exports `isSourceDisabled`/`shouldProbeDisabled`, new fields in `makeHealthEntry`, remove `alertOnFailingSources` |
| `src/events.js` | Skip disabled sources in `refreshCache` and `refreshEmailSources`, probe logic |
| `src/alerts.js` | Add `sendGraduatedAlert(severity, digest)` |
| `src/daily-digest.js` | Call `sendGraduatedAlert` after computing digest status |
| `test/unit/source-health.test.js` | Tests for auto-disable, auto-recovery, probe timing |

## Not Doing

- Changing quarantine logic in `scrape-guard.js` — that handles per-scrape data quality, orthogonal to this
- Runtime SMS quality sampling — separate Phase 11 story
- 4pm refresh scrape — separate Phase 11 story
