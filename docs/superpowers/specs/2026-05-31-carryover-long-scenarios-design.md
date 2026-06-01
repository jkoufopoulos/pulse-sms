# Long-Horizon Carryover Scenarios — Design

**Date**: 2026-05-31
**Scope**: Add 8 multi-turn (6-10 turns) scenarios to the carryover eval suite to generate richer golden data for the `/eval` workbench.

## Why

The carryover replay suite (`src/eval/carryover/scenarios/v0-pre-clarify/`) is dominated by 2-3 turn scenarios. The workbench at `/eval` has a dearth of labeled long-horizon data, so the `context_carryover_quality` axis is hard to evaluate against realistic conversational depth. 6-10 turn scenarios surface failure modes that short ones can't:

- Filter persistence across many intermediate actions
- Frame restoration after pivot-and-return
- Numeric anchor resolution against the *original* pool (not the most-recent action)
- State stability under low-content / repair turns
- Stacked filter management (boolean toggles, time chains, conjunctions)

## Constraints

- **Fixture venues only.** The replay (`src/eval/carryover/replay.js`) calls `setEventCache(FIXTURE_EVENTS)` against a 15-event pool. New scenarios reference venues already in `fixtures/events.json` (Williamsburg, Bushwick, Greenpoint, LES + their venues) so behavior is deterministic.
- **No infra changes.** No new fixtures, no matcher operators, no scenario directories. Drop-in JSON files.
- **Matcher restraint.** `expect` blocks only on the 2-3 most diagnostic turns per scenario. Long convos with assertions on every turn become brittle — wandering and final turns are scored by human labeling in the workbench instead.

## Scenarios

Lives in `src/eval/carryover/scenarios/v1/` — v1 is the active authoring surface; `v0-pre-clarify/` is archived regression history per commit `c06dd0f`. The runner script `scripts/eval-carryover.js` has `SCENARIO_DIR` updated to point at `v1/`.

| File | Turns | Pattern under test |
|------|-------|---------------------|
| `q01-filter-persists-through-detail-and-more.json` | 7 | Category filter survives a detail request + a "more" + a stacked free_only |
| `q02-pivot-return-restores-filters.json` | 8 | Filter carries across a hood pivot AND a return to the original hood |
| `q03-multi-detail-drill.json` | 6 | Numeric anchors (1, 2, 3) resolve against original pool, not most-recent detail |
| `q04-free-paid-flip-flop.json` | 8 | `free_only` toggles cleanly without dropping a running category filter |
| `q05-time-chain-refinement.json` | 7 | `time_after` / `date_range` chain through "later" → "after midnight" → "saturday" |
| `q06-conjunction-follow-through.json` | 6 | "comedy or music" — agent tracks which side of OR the user drilled into |
| `q07-indecision-and-repair.json` | 9 | Low-content turns ("hmm", "wait", "nvm") don't drift session state |
| `q08-double-hood-swap-anchoring.json` | 8 | Two hood swaps + numeric anchor across them; most aggressive carryover test |

## Matcher Assertions

Each scenario gets `expect` blocks only on the turns where carryover is the load-bearing decision:

- **q01** — turn 1 (hood), turn 2 (filter set), turn 5 (`more` keeps filter), turn 6 (stack `free_only`)
- **q02** — turn 1 (hood), turn 2 (filter set), turn 5 (pivot keeps filter), turn 7 (return restores)
- **q03** — turn 1 (hood), turn 2 (anchor 1), turn 4 (anchor 3 from original pool)
- **q04** — turn 1 (`free_only=true`), turn 3 (`free_only=false`), turn 5 (`free_only=true`), turn 6 (free + comedy)
- **q05** — turn 3 (`time_after` set), turn 5 (date pivot replaces time), turn 7 (category stacks with date)
- **q06** — turn 1 (comedy side asserted), turn 3 (comedy follow-up), turn 4 (swap to music), turn 6 (music + free stacks)
- **q07** — turn 3 (LES set), turn 6 (music filter survives noise), turn 9 (comedy replaces music)
- **q08** — turn 1 (filter set), turn 3 (pivot keeps filter), turn 6 (return restores filter)

Operators used: `$contains` (for `filters.categories`), `$present` (for `time_after` / `date_range` — LLM-derived ISO strings would make exact-value assertions brittle), bare values for `neighborhood` / `free_only`. Keys not in `expected` are ignored by `matcher.js`.

Operators used: `$contains` (for `filters.categories`), bare values for `neighborhood` / `free_only`. Keys not asserted are ignored by `matcher.js`.

## Workflow

1. Write the 8 JSON files into `src/eval/carryover/scenarios/v0-pre-clarify/`.
2. Run `npm run eval:carryover` (hand off to user — Bash harness backgrounds node and swallows test output per memory: `feedback_lean_execution`).
3. Verify rows land in `eval_turn_captures` for the new scenarios.
4. User labels turns in `/eval` workbench on `context_carryover_quality` (1-5) into `response_labels`.

## Out of Scope

- Fixture pool expansion
- Matcher / replay code changes
- New `expect` operators
- Rubric definition changes
- Backporting `expect` blocks to existing `qXX-*` scenarios
