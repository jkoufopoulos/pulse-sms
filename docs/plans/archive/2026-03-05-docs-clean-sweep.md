# Docs Clean Sweep Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Archive stale docs, rewrite architecture docs/UIs to reflect agent brain as primary architecture, fix branding, and ensure CC has accurate context.

**Architecture:** Content-only changes. No application code changes. Archive stale migration-era docs, rewrite ROADMAP.md and CLAUDE.md to remove legacy unified-flow prominence, rebuild architecture.html around agent brain flow, update eval docs/UIs, fix Bestie->Pulse branding across all HTML dashboards.

**Tech Stack:** Markdown, HTML, git

---

## Key Facts (reference for all tasks)

- **22 SOURCES entries** across 19 scraper modules (source-registry.js) — Ticketmaster and SmallsLIVE removed
- **Agent brain is primary path** — Gemini 2.5 Flash Lite tool calling + brainCompose. Unified-flow (Claude Haiku) is legacy fallback only.
- **`PULSE_AGENT_BRAIN` env var removed** (2026-03-05) — agent brain is always-on
- **24 code evals** (not 22)
- **417 golden scenarios** (293 multi-turn + 124 regression)
- **7 architecture principles** P1-P7 (P2 retired)
- **Branding: "Pulse"** not "Bestie" — all HTML dashboards still say Bestie
- **8 HTML dashboards**: architecture, health-ui, eval-ui, events-ui, test-ui, evals-landing, eval-report, eval-quality

---

### Task 1: Archive Stale Docs

**Files:**
- Create: `docs/archive/` directory
- Move: `docs/architecture-principles.md` -> `docs/archive/`
- Move: `docs/eval-plan.md` -> `docs/archive/`
- Move: `docs/filter-drift-prompt.md` -> `docs/archive/`
- Move: `docs/tagged-pool-implementation.md` -> `docs/archive/`
- Move: `docs/step2-compound-extraction-prompt.md` -> `docs/archive/`
- Move: `docs/middleware-simplification-review.md` -> `docs/archive/`

**Step 1: Create archive directory and move files**

```bash
mkdir -p docs/archive
git mv docs/architecture-principles.md docs/archive/
git mv docs/eval-plan.md docs/archive/
git mv docs/filter-drift-prompt.md docs/archive/
git mv docs/tagged-pool-implementation.md docs/archive/
git mv docs/step2-compound-extraction-prompt.md docs/archive/
git mv docs/middleware-simplification-review.md docs/archive/
```

**Step 2: Commit**

```bash
git add docs/archive/
git commit -m "chore: archive stale migration-era docs"
```

---

### Task 2: Rewrite ROADMAP.md

**Files:**
- Modify: `ROADMAP.md`

The current ROADMAP.md is ~590 lines with massive resolved-issues sections (strikethrough everywhere), a completed migration table, and detailed fragility audit results that are all done. Rewrite to focus on:

1. **Architecture Principles (P1-P7)** — keep as-is, they're current
2. **Current Architecture** — short section describing agent brain as primary, unified-flow as legacy fallback
3. **Open Issues** — only genuinely open items (deferred items table)
4. **Feature Roadmap** — keep the forward-looking sections (Agent-Native Evolution phases, Source + Quality, Infrastructure + Product)
5. **Tech Debt** — only open items
6. **Completed Work** — collapse to a summary table (date ranges, not individual line items)
7. **Not Building** — keep as-is

**Remove entirely:**
- All ~~strikethrough~~ resolved issues (they're in git history)
- Migration Status table (all done or abandoned)
- Resilience Gaps section (all fixed/superseded/abandoned)
- Pre-Launch Fragility Audit (all fixed)
- Neighborhood Resolution Gap detailed breakdown (fixed)
- Eval Trajectory & Trends detailed timeline (historical)
- Eval Coverage Audit details (done)

**Step 1: Rewrite ROADMAP.md**

Target: ~200 lines. Keep principles verbatim. Collapse completed work into a 2-column summary table with date ranges. Keep forward roadmap sections. Remove all resolved issues.

Structure:
```markdown
# Pulse -- Roadmap
## Architecture Principles (P1-P7) [keep verbatim]
## Current Architecture [new, 20 lines]
## Source Coverage [keep table from current, it's accurate]
## Feature Roadmap [keep: Agent-Native Evolution, Source+Quality, Intelligence, Infrastructure+Product]
## Open Issues [only genuinely open items]
## Tech Debt [only open items]
## Completed Work [collapse to summary table]
## Not Building [keep as-is]
```

**Step 2: Verify no broken cross-references**

Search codebase for links to ROADMAP.md sections that may have changed.

```bash
grep -r "ROADMAP" --include="*.md" --include="*.js" --include="*.html" .
```

**Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: rewrite ROADMAP.md — trim resolved issues, focus on current architecture + forward roadmap"
```

---

### Task 3: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Changes needed:
1. **Source counts**: "22 entries across 20 scraper modules" -> count from source-registry.js (22 entries, count actual module files for accuracy)
2. **Module table**: Remove `model-router.js` row (or mark as legacy). Update `unified-flow.js` and `pre-router.js` descriptions to say "Legacy fallback path" clearly. Remove `source-registry.js` saying "23 source entries" — update to 22.
3. **Architecture diagram**: Already shows agent brain as primary — verify it's accurate. The "22 entries across 20 scraper modules" label needs updating.
4. **Env vars**: Remove `TAVILY_API_KEY` from required (it's not required if Tavily is removed). Check if `TICKETMASTER_API_KEY` is still needed (Ticketmaster removed from SOURCES). Remove stale model override env vars if they only apply to legacy path.
5. **"Other modules" line**: says "22 entries across 20 scraper modules" — update count
6. **Design Principles**: Already updated for agent brain. Verify P6 description matches current state.

**Step 1: Read and update CLAUDE.md**

Make targeted edits — don't rewrite the whole file. CLAUDE.md is already mostly current.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md — fix source counts, remove stale env vars, clarify legacy paths"
```

---

### Task 4: Fix Bestie -> Pulse Branding Across All HTML Dashboards

**Files:**
- Modify: `src/health-ui.html`
- Modify: `src/eval-ui.html`
- Modify: `src/events-ui.html`
- Modify: `src/test-ui.html`
- Modify: `src/evals-landing.html`
- Modify: `src/eval-report.html`
- Modify: `src/eval-quality.html`

119 total "Bestie" occurrences across 7 files. Replace all with "Pulse".

**Step 1: Find and replace Bestie -> Pulse in all HTML files**

For each file:
- `<title>Bestie ...` -> `<title>Pulse ...`
- `<h1><span>Bestie</span>` -> `<h1><span>Pulse</span>`
- Any `bestie-nav` CSS class names can stay (they're internal class names, not user-visible)
- Text content "Bestie has six evaluation layers" -> "Pulse has seven evaluation layers" (update count too)

Note: CSS class names like `.bestie-nav`, `.bestie-nav-link` are internal — changing them requires updating both CSS and HTML references in every file. Leave class names as-is unless they appear in user-visible text.

**Step 2: Verify no broken rendering**

```bash
grep -n "Bestie" src/*.html
```

Should return only CSS class names (`.bestie-nav` etc.), no user-visible text.

**Step 3: Commit**

```bash
git add src/*.html
git commit -m "chore: rename Bestie -> Pulse in all dashboard UIs"
```

---

### Task 5: Rewrite architecture.html

**Files:**
- Modify: `src/architecture.html`

The current page (~75KB) documents the old architecture with unified-flow as co-primary. Major sections to update:

**Overview section:**
- Metrics: update "3 LLM prompts" -> "2 LLM prompts (agent brain + extraction)", "23 Event sources" -> "22", "1 Unified call (or agent brain)" -> "1 Agent brain call", "30 Files in src/" -> verify count
- Two Pipelines table: SMS Pipeline row says "1 unified call (Haiku) or agent brain" -> "Agent brain (Gemini tool calling + compose). Haiku fallback on failure."

**SMS Pipeline section:**
- Flow diagram: Remove the "Step 1: Pre-Router" and "Step 2: Filter Resolution + Tagged Pool" boxes — these are legacy unified-flow steps. Agent brain flow is: Webhook -> Guard -> checkMechanical -> callAgentBrain -> tool execution -> brainCompose -> Send+Save
- Pre-Router Coverage table: Simplify — checkMechanical handles only: help, 1-5 details, more, greetings/bye. The extensive filter detection table (category follow-up, time follow-up, vibe follow-up) is legacy pre-router behavior.
- Intent Decision Flow: Rewrite around agent brain (checkMechanical -> callAgentBrain)
- Error Handling: Keep, already includes agent brain failure row

**Intents section:**
- The 7-intent system with separate handlers (events, more, free, details, help, conversational, nudge_accept) is the legacy unified-flow routing. Agent brain handles all of these through tool calling except help/mechanical. Rewrite to reflect: checkMechanical catches help/numbers/more/greetings, everything else goes to agent brain which decides intent via tool calls.

**LLM Calls section:**
- Move `callAgentBrain()` and `brainCompose()` to the top as primary
- Mark `unifiedRespond()` as "Legacy fallback"
- Remove `composeResponse()` if it only exists for legacy path

**Sources section:**
- Update source count (22 entries)
- Remove SmallsLIVE from Cheerio HTML row
- Remove Ticketmaster from JSON API row
- Verify all source technique assignments are current

**Files section:**
- Update module descriptions to match Task 3 CLAUDE.md updates

**Step 1: Read full architecture.html content**

Need to see all sections (the file is 75KB). Read in chunks if needed.

**Step 2: Rewrite SMS Pipeline section**

Replace the 5-step flow (Webhook -> Guard -> Pre-Router -> Filter Resolution -> Unified/AgentBrain -> Send+Save) with 5-step agent brain flow (Webhook -> Guard -> checkMechanical -> callAgentBrain+tools -> brainCompose+Save).

**Step 3: Rewrite Intents section**

Simplify from 7 separate intent cards to: mechanical shortcuts (help, details, more, greetings) + agent brain (everything else via tool calling).

**Step 4: Update LLM Calls table**

Agent brain calls at top, legacy marked clearly.

**Step 5: Update Sources section**

Remove Ticketmaster, SmallsLIVE. Update counts.

**Step 6: Update metrics and overview**

Fix numbers in the metrics grid.

**Step 7: Verify page renders**

```bash
# Start server and check /architecture
PULSE_TEST_MODE=true node src/server.js &
open http://localhost:3000/architecture
```

**Step 8: Commit**

```bash
git add src/architecture.html
git commit -m "docs: rewrite architecture.html for agent brain primary architecture"
```

---

### Task 6: Update evals-landing.html

**Files:**
- Modify: `src/evals-landing.html`

Changes:
1. Pipeline Evals card: "22 deterministic checks" -> "24 deterministic checks"
2. Scenario Evals card: "293 multi-turn SMS conversations with 22 deterministic code evals" -> "293 multi-turn SMS conversations with 24 deterministic code evals"
3. Add Quality Evals card (new eval type from recent work — `/eval-quality` page exists but no card on landing page)
4. Intro text: "six evaluation layers" -> "seven evaluation layers" (adding quality evals)
5. Nav bar: Add link to `/eval-quality` page (currently missing from nav)
6. Bestie branding already handled in Task 4

**Step 1: Update eval counts and add quality evals card**

Add a new card after Regression Evals:

```html
<!-- Quality Evals -->
<div class="eval-card">
  <div class="eval-card-header">
    <div class="eval-card-title">Quality Evals</div>
    <div class="eval-card-badges">
      <span class="cost-badge paid">~$0.50</span>
    </div>
  </div>
  <div class="eval-card-desc">
    Rubric-based quality assessment of multi-turn conversations. Judges editorial voice,
    pick relevance, personality, and SMS formatting against a detailed rubric.
  </div>
  <div class="eval-card-stat">
    <span class="stat-label">Latest</span>
    <span class="stat-value loading" id="quality-stat">loading...</span>
  </div>
  <div class="eval-card-actions">
    <a href="/eval-quality" class="card-link primary">Browse results</a>
  </div>
</div>
```

**Step 2: Add quality stat loader to the script section**

Fetch from `/api/eval-reports?type=quality` similar to existing stat loaders.

**Step 3: Add `/eval-quality` to nav bars across all HTML files**

Currently the nav includes: Health, Events, Traces, Reports, Eval Guide, Simulator. Add "Quality" link.

**Step 4: Commit**

```bash
git add src/evals-landing.html
git commit -m "docs: update evals landing — fix counts, add quality evals card"
```

---

### Task 7: Update eval-howto.md

**Files:**
- Modify: `docs/eval-howto.md`

Changes:
1. Quick Reference table: Add quality evals row
2. Source counts: Update any "18 sources" or similar stale counts
3. Code eval count: Update "9 deterministic checks" (Layer 0 section) to current count (24)
4. Scenario count: Verify 293 is current
5. Add section for Quality Evals (Layer 6 or similar)
6. Verify all CLI commands still work (spot check)
7. Add `--pipeline agent_brain` flag documentation

**Step 1: Read full eval-howto.md**

**Step 2: Update counts and add quality eval section**

**Step 3: Commit**

```bash
git add docs/eval-howto.md
git commit -m "docs: update eval-howto — fix counts, add quality evals section"
```

---

### Task 8: Update Auto-Memory (MEMORY.md)

**Files:**
- Modify: `/Users/justinkoufopoulos/.claude/projects/-Users-justinkoufopoulos-Projects-pulse-sms/memory/MEMORY.md`

After all other tasks are done, update MEMORY.md to reflect:
1. Source count changes (22 entries, Ticketmaster removed)
2. `PULSE_AGENT_BRAIN` env var removed — agent brain is always-on
3. Doc structure changes (stale docs archived, ROADMAP trimmed)
4. Branding is now Pulse (not Bestie) in all UIs
5. Eval system: 24 code evals, 417 scenarios, quality evals added

**Step 1: Update MEMORY.md**

**Step 2: No commit needed** (memory files are outside the repo)

---

### Task 9: Final Verification + Commit

**Step 1: Verify no stale references remain**

```bash
# Check for stale "Bestie" in user-visible text
grep -n "Bestie" src/*.html | grep -v "bestie-nav" | grep -v "bestie-nav-link" | grep -v "bestie-nav-sep"

# Check for stale source counts
grep -rn "23 source" --include="*.md" --include="*.html" .
grep -rn "20 scraper" --include="*.md" --include="*.html" .

# Check for stale "unified-flow" as primary references
grep -rn "primary.*unified\|unified.*primary" --include="*.md" --include="*.html" .
```

**Step 2: Run tests to verify no breakage**

```bash
npm test
```

**Step 3: Single squash commit if preferred, or verify individual commits are clean**

```bash
git log --oneline -10
```
