# Architecture Page Redesign

**Goal:** Rebuild `site/architecture.html` as a portfolio piece that gives full visibility into the Pulse SMS system. The current page is from a pre-Phase 4 era (pre-router, single Haiku call, "Bestie" branding) and no longer reflects the architecture.

**Audience:** Portfolio — investors, potential collaborators, people evaluating the project.

**Style:** Evolve the existing dark aesthetic (Syne/DM Sans, coral accent, `#08070d` background) with new visual patterns: interactive flow diagrams, collapsible prompt blocks, animated cost annotations.

---

## Section 1: Hero + Live Conversation

Animated phone mockup showing a real SMS exchange. Messages animate in with typing delay. Sidebar annotates each message with what fired under the hood:

```
User: "bushwick"
  -> checkMechanical: miss
  -> callAgentBrain: search_events({neighborhood: "Bushwick", intent: "new_search"})
  -> 47 events -> 3 picks composed
  -> cost: $0.0005 | latency: 2.1s
```

Shows: it's an SMS product, there's a sophisticated brain behind it, and every message's cost is known.

## Section 2: Request Flow (Interactive Timeline)

Vertical timeline tracing a single message through the system. Each step is a card with module name, cost, and latency on the left rail. Expandable on click to show what the module does.

Steps:
1. `request-guard.js` — $0 / <1ms — TCPA, dedup, budget gate
2. `handler.js` — $0 / <1ms — orchestrator
3. `checkMechanical` — $0 / <1ms — help + TCPA only, ~95% pass-through
4. `agent-brain.js` (orchestrator) — $0 / <1ms — routes to brain-llm
5. `brain-llm.js` — $0.0005 / ~2s — Gemini 2.5 Flash Lite tool call [expandable: system prompt]
6. `brain-execute.js` — $0 / <50ms — executes search_events, builds pool
7. `brain-llm.js` (continuation) — included — same Gemini session writes SMS [expandable: compose prompt]
8. `saveResponseFrame` — $0 / <1ms — atomic session write (P4)
9. `twilio.js` — $0.008 — SMS out

Coral accent highlights the two steps that cost money (Gemini + Twilio).

## Section 3: Agent Brain (Deep Dive)

Three panels side by side (stack on mobile):

**Panel 1: The 3-File Split**
Dependency graph visual:
```
agent-brain.js (orchestrator, ~450 lines)
  +-- brain-llm.js (LLM calls + compose, ~550 lines)
  +-- brain-execute.js (tool execution + pools, ~530 lines)
```

**Panel 2: The 2 Tools**
Actual tool schemas as styled JSON — `search_events` and `respond`. Annotations highlighting P1: tool call params ARE the state. Intent enum with one-line examples.

**Panel 3: Fallback Chain**
Small flow: Gemini -> (fail) -> Haiku fallback. Composition: continuation -> (fail) -> brainCompose -> (fail) -> Haiku.

**Below panels: 5 Expandable Prompt Blocks**
Dark code cards, first ~3 lines as preview, expand to full text:
- `BRAIN_SYSTEM` — routing brain (built dynamically from session)
- `BRAIN_COMPOSE_SYSTEM` — lightweight SMS compose
- `WELCOME_COMPOSE_SYSTEM` — first-message welcome format
- `DETAILS_SYSTEM` — event detail composition
- `EXTRACTION_PROMPT` — scrape-time event extraction

## Section 4: Data Pipeline

CSS/SVG flow diagram showing the daily scrape cycle:

10am cron -> source-registry.js -> 19 scrapers (parallel) -> scrape-guard.js (4 checks: count, coverage, date, dupes) -> pass/quarantine fork -> merge -> post-scrape audit -> geocode + stamp -> events-cache.json

Key visual: **source pills** — 22 sources as compact pills, color-coded by vibe tier:
- Discovery (coral): Skint, NonsenseNYC, BKMag, Yutori, ScreenSlate, BrooklynVegan
- Niche (purple): TinyCupboard, BrooklynCC, BAM, NYPL, NYCTrivia, NYCParks, Luma
- Platform (blue): RA, Dice, DoNYC, Songkick
- Mainstream (grey): Eventbrite (Comedy, Arts, Music)

Callout card: "4 sources use LLM extraction" — links to EXTRACTION_PROMPT in Section 3.

## Section 5: Session Isolation

Two phone number bubbles with separate session state (neighborhood, picks, filters, history, mutex). Wall between them labeled "no shared state."

Four callouts:
- **Keyed by phone #** — Map lookup, no cross-access possible
- **Per-phone mutex** — acquireLock(phone) serializes concurrent requests
- **SHA-256 on disk** — raw numbers never persisted
- **2hr TTL + cleanup** — auto-expiry, garbage collected every 10 minutes

## Section 6: Cost Anatomy (Footer)

Horizontal bar showing per-message cost breakdown:

```
$0.0005  agent brain (Gemini 2.5 Flash Lite)
$0.008   SMS delivery (Twilio)
---------
$0.0085  total per message

$0.10    daily per-user AI budget cap
```

---

## Technical Notes

- Single HTML file at `site/architecture.html` (same pattern as existing site pages)
- No build step, no framework — vanilla HTML/CSS/JS
- CSS animations for the phone mockup typing effect
- Collapsible sections via `<details>`/`<summary>` or JS toggle
- Prompt text pulled from actual source (hardcoded in HTML, updated manually)
- Source list and counts should match source-registry.js (22 entries, 19 modules)
- All architecture claims must match current Phase 4 + brain split state
