# Context Carryover Eval — v1 Design

**Status:** Design approved, ready for implementation plan.
**Date:** 2026-05-31

## The problem

Pulse's recurring production failure mode is **context loss across turns** — the brain forgets the neighborhood, drops a category filter, or restarts the frame on a "more" / numeric pick. Today there's no automated way to detect this. The `/test` simulator only catches it if you happen to type the right sequence and notice. Trace logs surface it after the fact. The deleted eval system (commit `1f9066b`) targeted output quality, not turn-to-turn frame survival.

## The loop

A **manual scoring loop** for context carryover quality. Human labels first; LLM judge later, once labels stabilize the rubric.

The loop has three automatic phases and one human phase. v1 implements all four.

1. **Author scenarios** (one-time, versioned) — JSON files, ordered user messages, optional mechanical `expect` block per turn.
2. **Replay** (`npm run eval:carryover`, ~60s, free) — runs each scenario through `handleAgentRequestGraph` against a fixed fixture pool, captures per-turn artifacts, runs the optional matcher, writes to DB.
3. **Workspace** (`/eval` in browser) — three nested views: runs list → run detail → scenario detail. The scenario detail view is where you label.
4. **Iterate** — change the brain prompt or model, re-run, re-label only the turns whose captures changed. After ~30-50 labels accumulate, design the LLM judge by imitating your own grading patterns. (v2.)

What's deferred to v2: judge, calibration kappa, diff-against-baseline view, "promote production trace → scenario" authoring loop.

## Data model

Two new tables. The existing `response_labels` table (committed in `b12d5df`) handles the labels themselves.

```sql
CREATE TABLE eval_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  git_sha    TEXT,
  model      TEXT NOT NULL,
  env_flags  TEXT,                       -- JSON: { PULSE_BRAIN_PROJECT: "true", ... }
  notes      TEXT
);

CREATE TABLE eval_turn_captures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES eval_runs(id),
  scenario_id     TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,
  trace_id        TEXT NOT NULL,         -- ties to response_labels via trace_id
  user_msg        TEXT NOT NULL,
  brain_prompt    TEXT,                  -- system prompt actually sent
  brain_messages  TEXT,                  -- JSON: messages array actually sent
  tool_call       TEXT,                  -- JSON: { name, params }
  agent_sms       TEXT,
  session_before  TEXT,                  -- JSON: relevant frame fields
  session_after   TEXT,                  -- JSON: relevant frame fields
  matcher_result  TEXT,                  -- JSON: { passed, mismatches } or null
  captured_at     TEXT NOT NULL,
  UNIQUE(run_id, scenario_id, turn_index)
);
CREATE INDEX idx_captures_scenario_turn ON eval_turn_captures(scenario_id, turn_index);
```

**Why two tables instead of one:** runs are slow-changing metadata; captures are bulk turn-level rows. Cleaner queries, and `eval_runs` can be selected by env_flags / git_sha without scanning capture blobs.

**Why labels link via `trace_id`, not (scenario_id, turn_index):** `response_labels` is shared with production traces (a future v2). Keying it to trace_id keeps it generic. The workspace joins through `eval_turn_captures` to find prior labels for the same logical turn across runs.

## Rubric (v1)

**One axis.**

| Axis | Scale | Definition |
|------|-------|------------|
| `context_carryover_quality` | 1–5 | Holistic grade of how well this turn carried context from prior turns. 1 = frame fully dropped; 5 = perfect carryover. Notes field captures the reasoning. |

Reason for one axis: the rubric structure should *emerge from the labeling experience*, not be designed upfront. Notes are the raw input; after 30-50 labels, patterns in the notes become candidate axes.

## Components

```
src/eval/carryover/
  matcher.js                    # deep partial-match w/ $present, $absent, $regex, $in, $contains, $absent_or_empty
  scenario-loader.js            # read + validate scenarios from disk
  replay.js                     # run one scenario through agent-graph, capture per-turn
  fixtures/events.json          # ~15 stable events spanning scenario neighborhoods + categories
  scenarios/
    01-filter-add-time.json
    02-filter-carries-across-hood-swap.json
    03-filter-drop-explicit.json
    04-more-keeps-frame.json
    05-numeric-pick-is-details.json
    06-intent-survives-hood-swap.json
    07-disjunction-honored.json
    08-date-swap.json
    09-greeting-then-hood.json
    10-comedy-keyword-refinement.json

scripts/
  eval-carryover.js             # CLI entry: kick off replay, create eval_runs row

src/eval-ui.html                # workspace UI — restored from git as skeleton, trim/rewrite if shape doesn't fit

Modified:
src/db.js                       # add eval_runs + eval_turn_captures migrations
src/events.js                   # add setEventCache export (fixture injection)
src/server.js                   # add /api/eval/* routes + /eval HTML route
package.json                    # add "eval:carryover" script
```

## API surface

All new routes under `/api/eval/*`. Existing `/api/eval/session` route (currently in `server.js`) is unaffected.

| Route | Behavior |
|-------|----------|
| `GET /api/eval/runs` | List recent eval_runs with summary counts (turns, labeled, matcher-passed) |
| `GET /api/eval/runs/:id` | Run detail: scenarios + per-scenario turn counts + label progress |
| `GET /api/eval/turns/:capture_id` | Full turn detail: all capture fields + prior labels for same (scenario_id, turn_index) across runs |
| `POST /api/eval/labels` | Save label `{ trace_id, axis, label, notes }` → response_labels |
| `GET /eval` | Serve eval-ui.html |

## UI shape

Single page, three nested views, vanilla JS, no SPA router.

**View 1 — Runs list.** Table of recent runs: timestamp, git_sha (short), model, env_flags badge, scenario/turn/label/matcher counts. Click row → run detail.

**View 2 — Run detail.** Scenarios as rows with their turn count, label progress, matcher pass rate. Click → scenario detail.

**View 3 — Scenario detail.** Stacked turn cards. Each card shows: user msg, tool call JSON, agent SMS, matcher badge (green/red, informational only — does NOT pre-fill score), collapsible sections for brain prompt + frame diff, label widget (5-button score + notes textarea + Save), and a "Previous labels" line showing your past grades on the same (scenario_id, turn_index) from other runs.

**What's deliberately NOT in v1:** filters, search, baseline pinning, diff view, run tagging, judge column, calibration metrics, scenario-from-trace authoring.

## Testing

**Unit tests** (no API cost):
- `test/unit/eval-matcher.test.js` — all 6 tagged matchers + nested object/array recursion
- `test/unit/eval-scenario-loader.test.js` — valid/invalid scenario shapes, directory loading
- `test/unit/eval-runs-schema.test.js` — schema migrations create both new tables; UNIQUE constraint on (run_id, scenario_id, turn_index)

**Manual verification** (one-time, after build):
1. `npm run eval:carryover` — runs 10 scenarios, prints PASS/FAIL summary, writes a run row.
2. `npm start`, open `/eval` — runs list shows the new run.
3. Click into a scenario, label one turn, save, refresh — label persists.
4. Re-run eval — open same scenario in the new run, see prior label surface under "Previous labels."

## Restoration from git

`src/eval-ui.html` (1,684 lines) was deleted in `1f9066b`. The implementation plan should:
1. Run `git show 1f9066b^:src/eval-ui.html > /tmp/old-eval-ui.html`
2. Open it, evaluate whether its shape matches the 3-view workspace above.
3. If it does, copy + trim to fit the v1 scope. If not, write fresh from the UI spec.

This decision is deferred to implementation; the spec doesn't commit either way.

## Cost & timing

- **Replay:** 10 scenarios × ~3 turns avg × ~$0.001/brain call ≈ **$0.03 per run**, ~60s.
- **Labeling:** human time, ~30 seconds per turn × ~30 turns to seed = ~15 minutes.
- **Build effort:** ~3-5 hours for the v1 loop.

## Out of scope (v2 candidates, in priority order)

1. LLM judge prompt + scoring on every replay (writes to `response_scores`).
2. Calibration job (Cohen's kappa between human labels and judge scores, writes to `calibration_runs`).
3. Diff-against-baseline view in the workspace ("freeze this run as baseline" button).
4. "Promote production trace → scenario" authoring tool.
5. Mechanical matcher matrix view (scenarios × turns × pass/fail) — separate from labeling view.
6. Reproducibility hardening: lock model version pin, lock fixture pool snapshot, deterministic time-of-day.

## Open decisions deferred to implementation

- The exact set of fields included in `session_before` / `session_after` JSON. Default: `lastNeighborhood`, `lastBorough`, `lastFilters`, `lastPicks` (ids only), `lastResultType`, `pendingNearby`, `visitedHoods`. Plan should confirm against the v1 scenarios.
- Whether replay surfaces a single combined "brain context" capture (system prompt + messages) or two separate fields. Default: two fields, since the projected vs. legacy paths differ in both.
- Whether the labeler_id defaults to a fixed `'jk'` constant or reads from an env var. Default: env var with `'jk'` fallback.
