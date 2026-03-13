# Proactive Outreach Design

> **Goal:** Pulse texts opted-in users when a high-confidence event match appears — turning Pulse from a search tool into a retention engine.

## Overview

Proactive outreach is the feature that justifies SMS as a channel. Without it, Pulse is a search engine you text instead of Google. With it, Pulse becomes a friend who texts you when something great comes up.

The system runs as a post-scrape hook (alongside digest and audit), scanning opted-in users against fresh events, composing a tastemaker-voice message via LLM, and sending a single SMS when a match clears a confidence threshold.

## Opt-in Flow

**Trigger:** Pulse prompts users to opt in during their first session and (if ignored) again on their third session. After two prompts, Pulse stops asking.

**Mechanism:** The agent system prompt includes a conditional instruction: if `proactiveOptIn === false` and `proactivePromptCount < 2` and `sessionCount` is 1 or 3, append to the picks response:

- Session 1: `PS — Want me to text you when something great comes up? Reply NOTIFY to opt in.`
- Session 3: `PS — Reminder: reply NOTIFY if you want me to text you when something great comes up.`

**Tracking:** `proactivePromptCount` (integer) on the preference profile, replaces the existing `proactiveOptInPromptedAt` timestamp field. Incremented each time the prompt is appended. `proactiveOptIn` (boolean) and `proactiveOptInDate` (ISO string) already exist in the profile schema.

**Opt-in keyword:** `NOTIFY` handled mechanically in `checkMechanical`:
- Sets `proactiveOptIn: true` and `proactiveOptInDate` on the profile
- Replies: "You're in! I'll text you when something great comes up. Reply STOP NOTIFY anytime to turn it off."

**Opt-out keyword:** `STOP NOTIFY` (or `UNSUBSCRIBE NOTIFY`) handled mechanically:
- Sets `proactiveOptIn: false`
- Replies: "Got it — no more proactive texts. You can still text me anytime for picks."
- Plain `STOP` still does full TCPA opt-out (which implicitly disables proactive)

**Keyword ordering:** `STOP NOTIFY` must be matched *before* the generic `STOP` TCPA check in `checkMechanical`. The existing `OPT_OUT_KEYWORDS` regex uses `^\s*(stop|...)\s*$` (exact match), so `STOP NOTIFY` won't match it — but this ordering must be verified and tested.

## Event Matching

**When:** After the daily scrape completes (10am ET, plus the existing 6pm refresh), as a post-scrape hook alongside digest/audit. Both scrape windows already exist in `events.js`.

**Who:** All users where `proactiveOptIn === true`, loaded via `getOptInEligibleUsers()`.

**Scoring:** For each opted-in user, score today's events against their profile:

| Signal | Weight | Source |
|--------|--------|--------|
| Neighborhood match (top 2) | +3 | `getTopNeighborhood(profile)` |
| Category match (top categories) | +2 | `getTopCategories(profile)` |
| Interestingness | +1 to +3 | `scoreInterestingness()` (already range -3 to 6, normalize to 1-3) |
| Scarcity (one-night-only, editorial) | +1 each | Event metadata (`scarcity`, `editorial_signal`) |

`match_score = neighborhood_weight + category_weight + interestingness + scarcity_bonus`

**Threshold:** Minimum score of 5 to send. This means at minimum a neighborhood match + category match, or a neighborhood match + high interestingness. Tune based on early engagement data. Better to send nothing than a mediocre pick.

**Guardrails:**
- 1 message per user per 7 days (check `event_recommendations` table for last send date)
- Never recommend an event the user already saw in a regular session (check `event_recommendations`)
- Skip users who haven't had an inbound session in 30 days (likely churned)

## Message Composition

**Model:** Same as brain (gemini-2.5-flash-lite by default).

**Prompt:** Focused single-purpose prompt:
- Input: matched event (full event object + `venue_vibe` if available), user's top neighborhood and categories
- Instruction: "You're Pulse, texting a user proactively about an event you think they'd love. Write a single short SMS (under 320 chars) that sounds like a friend giving a tip. Lead with why this is worth their night. End with 'Reply for details.'"

**Character budget:** 320 chars for LLM content + `\nReply STOP NOTIFY to turn off` footer = well under 480 cap.

**Cost:** ~$0.001 LLM + ~$0.008 Twilio per message. At 100 opted-in users sending 1/week, ~$0.90/week.

**Error handling:** If LLM or Twilio fails for a user, log it, skip, continue to next. No retries on proactive messages.

## Reply Handling

When a user replies to a proactive message, it hits the normal `/api/sms` webhook.

**Session seeding:** After sending the proactive SMS, use `saveResponseFrame()` (not `setSession()`) to persist the seeded session state — consistent with P4 (one save path). The frame includes:
- `lastNeighborhood` → event's neighborhood
- `lastPicks` → the proactive event
- `proactiveSeeded: true` flag for engagement tracking

Standard 2-hour TTL applies. Replies within 2 hours have proactive context; after that, fresh session.

**Special replies:**
- `STOP NOTIFY` / `UNSUBSCRIBE NOTIFY` → turn off proactive (mechanical)
- `STOP` → full TCPA opt-out (existing behavior)
- Anything else → normal agent loop with seeded session context

**Engagement tracking:** When a reply arrives on a `proactiveSeeded` session, call `markRecommendationEngaged()`. This measures whether proactive messages drive engagement.

## File Structure

**New file:**
- `src/proactive.js` — `processProactiveMessages()` (post-scrape hook), `scoreMatch()` (event-user scoring), `composeProactiveMessage()` (LLM composition), `shouldPromptOptIn()` (prompt schedule check)

**Modified files:**
- `src/events.js` — add `processProactiveMessages()` to post-scrape hook chain
- `src/agent-brain.js` — add `NOTIFY` and `STOP NOTIFY` to `checkMechanical`
- `src/brain-llm.js` — add conditional opt-in prompt instruction to `buildBrainSystemPrompt()`
- `src/preference-profile.js` — add `proactivePromptCount` field, increment when prompted
- `src/handler.js` — detect `proactiveSeeded` sessions for engagement tracking

**No changes needed:**
- `src/db.js` — `event_recommendations` table already exists with `insertRecommendations`/`markRecommendationEngaged`
- `src/twilio.js` — `sendSMS()` works as-is
- `src/session.js` — used via `saveResponseFrame` for session seeding, no changes needed

## Testing

**Unit tests** (`test/unit/proactive.test.js`):
- `scoreMatch()`: neighborhood match, category match, interestingness normalization, scarcity bonus, threshold filtering
- `shouldPromptOptIn()`: session 1 prompts, session 2 skips, session 3 prompts, session 4+ skips, already opted-in skips

**Scenario evals**: Add `NOTIFY` and `STOP NOTIFY` keyword scenarios to `data/fixtures/multi-turn-scenarios.json` — verify mechanical handling, profile updates, and that proactive opt-out doesn't trigger full TCPA opt-out.

**Manual validation**: Use the simulator (`/test`) to verify the opt-in CTA appears on first session, NOTIFY response works, and proactive messages compose correctly. `PULSE_PROACTIVE_ENABLED=true` required.

## Kill Switches

- `PULSE_PROACTIVE_ENABLED` env var (default `false` until validated) — master toggle
- If proactive opt-out rate exceeds 3% for any weekly cohort, auto-pause and alert
- Manual pause via `/api/proactive/pause` endpoint (for ops emergencies)

## Success Metrics

- **Opt-in rate:** % of first-session users who reply NOTIFY (target: 10-20%)
- **Engagement rate:** % of proactive messages that get a reply (target: 15-25%)
- **Retention lift:** % of proactive users who return for an inbound session within 14 days vs. non-proactive users
- **Opt-out rate:** % of opted-in users who STOP NOTIFY per week (alarm threshold: 3%)
