# Recurrence Nudge Design

> **Goal:** Text users when a recurring event they've shown interest in twice is happening again. First proactive outreach feature — scoped to recurring events only.

## Overview

When a user asks for details on the same recurring event twice (e.g., trivia at Black Rabbit on two different Tuesdays), Pulse asks if they want a reminder next time. If they opt in, Pulse sends a nudge 4-6 hours before the next occurrence. No LLM calls, no preference profiles — just a deterministic template using data we already have.

## Data Model

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS nudge_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hash TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  detail_count INTEGER DEFAULT 1,
  consent_asked INTEGER DEFAULT 0,
  opted_in INTEGER DEFAULT 0,
  opted_out INTEGER DEFAULT 0,
  last_nudged TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(phone_hash, pattern_key)
);
```

Joins against existing `recurring_patterns` table (has `pattern_key`, `name`, `venue_name`, `neighborhood`, `day_of_week`, `time_local`).

No general pick history table — the subscription table tracks everything we need for this feature.

## Detection & Consent Flow

**Tracking:** In `agent-loop.js`, after the details intent returns events from the pool, check all returned events for `is_recurring === true`. For each recurring event, upsert into `nudge_subscriptions` (increment `detail_count`). This happens before the model composes its response — we track interest in all recurring events shown, regardless of which one the model ultimately writes about.

**Consent trigger:** When `detail_count` reaches 2 and `consent_asked === 0`:
- Set `consent_asked = 1`
- Send consent as a **separate follow-up SMS** (not appended to the details response, which would exceed 480 chars after `smartTruncate`): `"Btw — want me to text you next time [event] at [venue] is on? Reply REMIND ME for reminders, or ignore this."`
- Sent via `twilio.js` directly from `agent-loop.js`, immediately after the details SMS. Cost: ~$0.008 extra.

**Consent keyword: `REMIND ME`** (not "YES" — too common a word that would collide with conversational replies to agent questions).

**Consent capture:** In `checkMechanical` (`agent-brain.js`), before the agent brain:
- `REMIND ME` → query `nudge_subscriptions` for a pending consent (consent_asked=1, opted_in=0, opted_out=0). If found, set `opted_in = 1`. Return `{ intent: 'nudge_consent', reply: "You got it! I'll text you next time it's on. Reply NUDGE OFF anytime to stop." }`. Handler sends reply and returns (terminal path, same as help/TCPA).
- `NUDGE OFF` → set `opted_out = 1` on ALL subscriptions for that phone (global nudge opt-out). Return `{ intent: 'nudge_optout', reply: "Done — no more reminders. You can still text me anytime for picks." }`.
- If `REMIND ME` with no pending consent, return `null` — falls through to agent brain as normal message.

**`checkMechanical` return contract:** Currently returns `null` (no match) or `{ intent, reply }` for help/TCPA. Nudge consent uses the same shape: `{ intent: 'nudge_consent' | 'nudge_optout', reply: string }`. The existing `handleMessageAI` in `handler.js` already dispatches on non-null returns — sends the reply and finalizes. No changes needed to `handler.js`.

**TCPA STOP handling:** When `OPT_OUT_KEYWORDS` matches in `handler.js`, also call `setOptedOut` for all nudge subscriptions for that phone hash. This ensures a full TCPA opt-out implicitly disables nudges.

## Nudge Scheduling & Sending

**Scheduler:** `setInterval` running once per hour (same pattern as `scheduleDailyScrape`). Gated by `PULSE_NUDGES_ENABLED` env var (default `false`).

**Hourly check logic:**
1. Get current NYC day-of-week and hour (all time comparisons in `America/New_York`, accounting for DST)
2. Query `nudge_subscriptions` where `opted_in = 1` AND `opted_out = 0`
3. Join against `recurring_patterns` to get event day/time (`time_local` is stored as `HH:MM` string)
4. For each: if event is today, current time is 4-6 hours before `time_local`, and `last_nudged` is not within last 7 days → send nudge
5. Update `last_nudged` after sending

**P4 scoping:** P4 ("every SMS path ends with saveResponseFrame") applies to request-response paths where session state must be persisted. Proactive nudges are outbound-only with no session context — `last_nudged` update in the database serves as the audit trail. No `saveResponseFrame` call needed.

**Nudge message:** Deterministic template, no LLM call ($0):
```
[Event] at [Venue] is back tonight at [time] — you know the vibe.
Want me to look at what else is happening in [neighborhood]?
```

**Reply handling:** Responses flow through the normal SMS handler (`/api/sms`). If they reply with a neighborhood or affirmative, the agent brain handles it. No special routing needed.

**Restart tolerance:** If the Railway dyno restarts and misses a nudge window, the nudge is simply skipped. Accepted limitation for v1 — at <50 users, a missed weekly nudge is not material. A "last checked" timestamp can be added later if needed.

**Safety rails:**
- Max 1 nudge per subscription per 7 days (check `last_nudged`)
- `PULSE_NUDGES_ENABLED` env var, default `false`
- Global opt-out: `NUDGE OFF` disables all nudges for that phone
- Plain `STOP` (TCPA) also clears all nudge subscriptions for that phone

## New Module & Integration Points

**New file: `src/nudges.js`**
- `trackRecurringDetail(phone, event)` — upsert subscription, return consent prompt string if threshold hit (or null)
- `captureConsent(phone, message)` — handle REMIND ME / NUDGE OFF, return `{ handled: boolean, reply: string|null }`
- `checkAndSendNudges()` — hourly scan, build messages, send via `twilio.js`
- `buildNudgeMessage(pattern)` — deterministic template
- `scheduleNudges()` / `clearNudgeSchedule()` — interval management

**Modified files:**

| File | Change |
|---|---|
| `db.js` | Add `nudge_subscriptions` table creation + queries (`upsertNudgeSub`, `getPendingConsent`, `setOptedIn`, `setOptedOut`, `getDueNudges`, `markNudgeSent`) |
| `agent-loop.js` | After details intent returns recurring events, call `trackRecurringDetail`. If consent prompt returned, send as separate SMS. |
| `agent-brain.js` | In `checkMechanical`, add REMIND ME / NUDGE OFF handling via `captureConsent` ($0, terminal path) |
| `handler.js` | In TCPA STOP handler, also call `setOptedOut` for nudge subscriptions |
| `server.js` | Call `scheduleNudges()` on startup (gated by env var) |

**No changes needed:** `twilio.js`, `session.js`, `brain-llm.js`

## Testing

**Unit tests** (`test/unit/nudges.test.js`):
- `trackRecurringDetail`: first detail → no prompt, second → consent prompt, third → no prompt (already asked)
- `captureConsent`: REMIND ME with pending → opted in, REMIND ME without pending → not handled, NUDGE OFF → global opt-out
- `buildNudgeMessage`: output format, character count under 480
- `getDueNudges`: correct day/time window, respects 7-day cooldown, skips opted-out, handles DST

**Scenario evals**: Add REMIND ME and NUDGE OFF keyword scenarios to eval fixtures.

**Manual validation**: Use simulator with `PULSE_NUDGES_ENABLED=true`. Verify consent flow end-to-end.

## Cost

- Detection + consent: ~$0.008 per consent SMS (one-time per subscription)
- Nudge messages: ~$0.008 Twilio per nudge, no LLM cost
- At 20 active subscriptions sending 1/week: ~$0.16/week
