# Eval Redesign: Quality-First, Launch-Oriented

> Design approved 2026-03-05. Replaces 417-scenario behavioral conformance system with 15 golden conversations scored on 6 quality dimensions.

## Problem

The current eval system has 7 layers, 417 scenarios, costs $1.55, takes 30 minutes, and mostly tests behavioral conformance ("did 'bushwick' return intent=events?"). It doesn't measure what matters: does the user get a good experience? The quality evals that do exist scored 2.1/5 and nobody acted on it. Every architecture change (like Phase 4) breaks dozens of expectations that were testing plumbing, not product.

## What Gets Killed

- `data/fixtures/synthetic-cases.json` (105 behavioral conformance tests) -- archive
- `data/fixtures/regression-scenarios.json` (124 P1-P7 tests) -- archive
- `data/fixtures/multi-turn-scenarios.json` (293 scenarios) -- archive
- `scripts/run-evals.js` -- archive
- `scripts/run-regression-evals.js` -- archive
- `scripts/run-scenario-evals.js` -- archive
- Most of `src/evals/code-evals.js` (24 checks -> keep 6)

## What Survives

- `npm test` -- unit tests, free, fast, tests code correctness
- `scripts/run-quality-evals.js` -- the runner, upgraded with new rubric
- `data/fixtures/quality-conversations.json` -- expanded to 15 golden conversations
- `src/evals/code-evals.js` -- trimmed to 6 invariant checks

## New Rubric: 6 Dimensions

| Dimension | Score | What it means |
|-----------|-------|---------------|
| **tone** | 1-5 | Friend texting, not a router. Personality, opinion, NYC shorthand. |
| **curation** | 1-5 | Picks feel fresh, interesting, local. Not obvious Google results. |
| **intent_match** | 1-5 | Response matches what the user actually wanted. |
| **probing** | 1-5 | When intent is unclear, agent asks smart follow-up questions. |
| **inference** | 1-5 | Agent goes beyond literal request -- connects dots, offers alternatives. |
| **coherence** | 1-5 | Context maintained across turns, no forgetting, no regressions. |

Not every dimension applies to every turn. `probing` only scores when user intent is ambiguous. `coherence` only scores on turn 2+. `curation` only when picks are shown.

## Golden Conversations (15)

| # | Conversation | Tests |
|---|-------------|-------|
| 1 | "bushwick" -> details on a pick -> "thanks" | tone, curation, coherence |
| 2 | "jazz in west village" | tone, curation, intent_match |
| 3 | "anything weird tonight" | tone, curation, inference |
| 4 | "vibes" | probing (too vague, should ask questions) |
| 5 | "free stuff in greenpoint" -> "how about comedy" -> "more" | intent_match, coherence, curation |
| 6 | "4 of us looking for something fun in williamsburg" | inference (group -> social events) |
| 7 | "those sound basic" (after picks) | probing, inference (challenge -> dig deeper) |
| 8 | "les" -> "actually bushwick" -> "techno stuff" | coherence (pivot handling) |
| 9 | "east village" -> "any comedy?" -> "tell me about the first one" | intent_match, coherence |
| 10 | "comedy tonight somewhere in brooklyn" | intent_match, inference (borough -> hoods) |
| 11 | "something chill near prospect park" | inference (vibe + location -> picks) |
| 12 | "hey" (new user, no session) | tone, probing (welcome + engage) |
| 13 | "what's good this weekend" -> "saturday night specifically" | coherence, intent_match |
| 14 | "trivia" -> "more" -> "more" | curation, coherence (dedup, exhaustion) |
| 15 | "anything happening tomorrow afternoon" | intent_match (time + day) |

## Surviving Code Evals (6 invariants)

1. `char_limit` -- SMS <= 480 chars
2. `response_not_empty` -- got a response
3. `picked_events_exist` -- pick IDs exist in the pool
4. `latency_under_10s` -- response time < 10s
5. `valid_urls` -- URLs are parseable
6. `price_transparency` -- price mentioned when available

## Usage

```bash
npm run eval:quality   # ~2 min, ~$0.20, outputs single quality score
```

Output:
```
Quality: 3.8/5.0 (15 conversations)
  Tone: 4.1  Curation: 3.5  Intent: 4.0  Probing: 3.2  Inference: 3.4  Coherence: 4.2
  Worst: "those sound basic" (2.3), "vibes" (2.8)
  Cost: $0.18  Time: 95s
```

## Success Criteria

- Quality score >= 3.5/5.0 to launch
- Any single conversation below 2.0 is a blocker
- Run before every deploy, takes < 2 minutes
