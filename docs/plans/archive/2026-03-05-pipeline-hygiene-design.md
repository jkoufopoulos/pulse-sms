# Pipeline Hygiene & Monitoring Redesign

> Design doc for registry-enforced data hygiene, daily digest reporting, and alert consolidation.

## Problem

Three issues eroding trust in the event pipeline:

1. **Stale data from removed sources.** Commenting a source out of `source-registry.js` stops scraping but doesn't purge SQLite. Ticketmaster (removed) was 23.7% of the cache. SmallsLIVE (removed) was 3.0%. Dashboard numbers can't be trusted.

2. **Noisy, unactionable alerts.** 39 alerts in history: 22 slow_response, 14 health ("1 source failing"), 1 scrape-audit-regression. Health alerts fire every 6 hours for expected situations (BKMag returns 0 on weekdays, Skint has occasional sponsored posts). No way to tell routine from urgent.

3. **No historical view.** Health dashboard shows current state only. No way to answer "was this source broken yesterday?" or "when did the cache drop?"

## Design

### 1. Registry-enforced data hygiene

**Source registry becomes the single source of truth for serving, not just scraping.**

After each scrape completes (in `refreshCache`):
- Get active `SOURCE_LABELS` from registry
- Delete SQLite events where `source_name NOT IN (active labels)`
- Log count deleted (if any)

Also at boot (in the SQLite load path):
- Same check — prune before building the serving cache

Category normalization in `normalizeExtractedEvent` (`shared.js`):
- Add `music -> live_music` mapping so any source that says `music` gets corrected at the boundary (P3)

**No new modules.** ~15 lines across `events.js` and `shared.js`.

### 2. Daily digest report (replaces per-event health alerts)

**One report generated after each morning scrape. Persisted to SQLite. Emailed. Browsable on dashboard.**

#### Report structure

```json
{
  "id": "2026-03-05",
  "generated_at": "2026-03-05T15:03:00Z",
  "status": "green|yellow|red",
  "summary": "2,541 events from 22 sources. 799 free. 5 sources need attention.",
  "cache": {
    "total": 2541,
    "yesterday": 2680,
    "change_pct": -5.2,
    "free": 799,
    "paid": 1742
  },
  "needs_attention": [
    { "source": "Skint", "issue": "0 events (avg 18)", "severity": "warn" },
    { "source": "BKMag", "issue": "0 events (weekend guide, expected Mon-Thu)", "severity": "info" }
  ],
  "sources": [
    { "name": "DoNYC", "count": 558, "avg_7d": 542, "status": "ok" },
    { "name": "Skint", "count": 0, "avg_7d": 18, "status": "warn" }
  ],
  "categories": { "comedy": 427, "nightlife": 471, "live_music": 404 },
  "latency_p95_ms": 3200,
  "user_facing_errors": 0
}
```

#### Status logic

- **Green**: all sources within 40% of 7-day average, cache size within 20% of yesterday, 0 user-facing errors
- **Yellow**: 1-3 sources below threshold OR cache dropped 20-40% OR latency p95 > 5s
- **Red**: >3 sources below threshold OR cache dropped >40% OR any user-facing errors in last 24h

#### "Needs attention" filtering

Not every source returning 0 is a problem. The digest distinguishes:
- **Expected zeros**: BKMag (weekend guide, 0 Mon-Thu is normal), newsletter sources without a new issue
- **Unexpected zeros**: sources with a 7-day average >5 that returned 0

This requires a small `SOURCE_EXPECTATIONS` config in the registry — just a `minExpected` per source and optional `schedule` (e.g., `{ days: ['fri', 'sat'] }` for BKMag).

#### Persistence

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS daily_digests (
  id TEXT PRIMARY KEY,         -- "2026-03-05"
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  report TEXT NOT NULL,        -- full JSON
  email_sent INTEGER DEFAULT 0
);
```

#### Email

Replaces `sendHealthAlert`. One email per day, sent only if status is yellow or red. Green days are logged but not emailed (you can check the dashboard if curious).

Format: plain text, structured like the JSON above but human-readable. Subject line: `Pulse daily: [green|yellow|red] - 2,541 events, 5 need attention`.

### 3. Instant alerts: user-facing failures only

Keep `sendRuntimeAlert` but restrict to two alert types:
- `agent_brain_error` — user got a fallback or error
- `double_failure` — user got nothing

Remove:
- `slow_response` — not an incident. Latency goes in the daily digest as p95.
- `scrape-audit-regression` — folded into the daily digest "needs attention" section.

Cooldown stays at 30 min per alert type.

### 4. Dashboard: digest history tab

Add a "Digests" link to the nav bar. Page shows:
- List of daily digests, most recent first
- Each row: date, status pill (green/yellow/red), summary line, event count
- Click to expand full report (sources, categories, needs-attention items)
- No new API framework — one `GET /api/digests` endpoint returning last 30 days, one static HTML page

The health dashboard stays as-is for real-time debugging. The digest page is where you go to answer "how has the pipeline been doing this week?"

## What changes

| Component | Change |
|-----------|--------|
| `events.js` | Boot + post-scrape: prune events from non-registry sources |
| `shared.js` | `normalizeExtractedEvent`: add `music -> live_music` |
| `source-registry.js` | Add `minExpected` and optional `schedule` per source |
| `db.js` | New `daily_digests` table, `saveDigest`, `getDigests` |
| `alerts.js` | New `generateDailyDigest()`, replace `sendHealthAlert` |
| `source-health.js` | `alertOnFailingSources` replaced by digest generation |
| `server.js` | New `/api/digests` endpoint, `/digests` page |
| New file | `src/digest-ui.html` — digest history dashboard |

## What doesn't change

- `scrape-guard.js` — baseline gates and quarantine logic stays (it prevents bad data from entering the cache)
- Health dashboard — stays for real-time debugging
- Events browser — stays, but now shows accurate data after stale source pruning
- `sendRuntimeAlert` — stays for agent_brain_error and double_failure

## Out of scope

- Automated remediation (auto-retry failed sources) — manual for now
- Source-level SLOs — overkill at current scale
- Slack/PagerDuty integration — email is fine for one operator
