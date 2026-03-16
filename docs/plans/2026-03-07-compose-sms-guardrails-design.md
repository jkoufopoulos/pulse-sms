# Compose SMS Guardrails Design

**Date:** 2026-03-07
**Problem:** Agent sends 10 picks in 900+ chars, gets truncated. "Daily Happy Hour" filler gets through. "price not listed" feels mechanical. Event names are unclear without context.

## Root Cause

`compose_sms` tool lets the model write free-text SMS with no code-side validation. The model owns both editorial judgment AND mechanical formatting — it's bad at the latter (character counting, pick limits).

## Design Principle

**Model owns editorial judgment. Code owns structural constraints.**

- Model picks which events (1-3), writes the SMS text, frames it with personality
- Code validates length/pick count, provides structured signals, rebuilds only on failure

## Changes

### 1. Code-side validation after compose_sms

When the model returns `compose_sms`, code checks:
- `sms_text` > 480 chars → rebuild from `picks` using template fallback
- `picks.length` > 3 → rebuild from first 3 picks
- `picks.length` === 0 → use existing "no events" handling

Rebuild is a last resort — the prompt should get it right most of the time. Log when rebuild fires so we can track regression.

### 2. Nearby neighborhood highlight signal

After `search_events` builds the pool, code computes a quality comparison:
- Score top events per nearby neighborhood (interestingness, editorial signals, scarcity, one-night-only count)
- If a nearby hood's top picks score notably higher than the requested hood, add to search results:

```json
{
  "nearby_highlight": {
    "hood": "williamsburg",
    "reason": "3 one-night-only events tonight",
    "top_pick": "MAYHEM: Anniversary Ball at 3 Dollar Bill"
  }
}
```

Model uses this to write a tease line (or not — it's editorial judgment). Code never forces the tease.

### 3. Prompt changes

Already partially done in this session. Key rules:
- Pick 1-3 events, be opinionated
- Describe what the event IS when the name isn't clear
- No prices in initial picks (save for details)
- Never write "price not listed" or "TBA"
- When `nearby_highlight` is present, consider teasing it
- Hard limit 480 chars — if over, cut picks, never send truncated

### 4. compose_sms tool schema tightened

- `picks`: maxItems 3, minItems 1
- `sms_text` description: emphasize 480 char limit, 1-3 picks, describe events

## What doesn't change

- Model 100% owns which events to pick and what to say
- `compose_sms` tool stays (model writes sms_text + picks array)
- `search_events` pool construction unchanged
- Curation taste block unchanged (pick hierarchy, source vibe, editorial signal)
- Template fallback already exists for MALFORMED_FUNCTION_CALL — this extends it to validation failures

## Implementation

1. Add `nearby_highlight` computation in `brain-execute.js` after pool construction
2. Include `nearby_highlight` in serialized pool result passed to model
3. Add validation in `agent-loop.js` after `compose_sms` returns (char count, pick count)
4. Log validation rebuilds for monitoring
5. Prompt changes (partially done — finalize wording)
6. Add regression eval scenarios for: truncation, >3 picks, missing event descriptions
