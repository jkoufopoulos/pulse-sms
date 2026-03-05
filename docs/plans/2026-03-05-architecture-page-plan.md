# Architecture Page Rebuild — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the stale `site/architecture.html` with a 6-section portfolio piece reflecting Phase 4 + brain split architecture.

**Architecture:** Single HTML file, no build step. Vanilla HTML/CSS/JS. Same dark aesthetic as existing site (Syne/DM Sans, coral accent, `#08070d` bg). CSS animations for phone mockup, JS toggles for collapsible prompts. ~1200-1500 lines.

**Tech Stack:** HTML, CSS (custom properties, grid, flexbox, keyframes), vanilla JS (toggle, typing animation).

---

### Task 1: Scaffold — nav, CSS variables, section shells

**Files:**
- Modify: `site/architecture.html` (full rewrite)

**Step 1: Write the scaffold**

Replace the entire file with:
- Same `<head>` (fonts, viewport, title)
- Same CSS variables from existing `:root` block
- Same nav markup (Pulse logo + "Architecture" breadcrumb)
- 6 empty `<section>` elements with IDs: `#hero`, `#flow`, `#brain`, `#pipeline`, `#sessions`, `#cost`
- Sticky section nav (jump links to each section)
- Base CSS for: nav, container, section spacing, section-label/section-title patterns, responsive breakpoints
- Add new CSS variables: `--bg-code: rgba(255,255,255,0.04)`, `--border: rgba(255,255,255,0.06)`

Keep the existing `:root` colors (`--coral`, `--blue`, `--green`, `--purple`, `--yellow`) and fonts (`--font-display`, `--font-body`, `--font-mono`). Add `--font-mono: 'DM Mono', monospace` if not present.

**Step 2: Verify in browser**

Open `site/architecture.html` in browser. Confirm: dark background, nav renders, 6 section headings visible, section jump links work.

**Step 3: Commit**

```bash
git add site/architecture.html
git commit -m "refactor: scaffold architecture page with 6-section layout"
```

---

### Task 2: Section 1 — Hero + Live Conversation

**Files:**
- Modify: `site/architecture.html`

**Step 1: Build the phone mockup**

Inside `#hero`, create a two-column layout (stack on mobile):

Left column — CSS phone frame:
```html
<div class="phone">
  <div class="phone-notch"></div>
  <div class="phone-screen" id="convo">
    <!-- Messages injected by JS -->
  </div>
</div>
```

Phone CSS: `320px` wide, rounded corners (`40px`), dark border, inner screen area with `overflow-y: auto`. Messages are `<div class="msg msg-user">` and `<div class="msg msg-pulse">` with appropriate bubble styling (user = right-aligned blue, Pulse = left-aligned dark card).

Right column — annotation sidebar:
```html
<div class="annotations" id="annotations">
  <!-- Populated by JS alongside each message -->
</div>
```

**Step 2: Write the conversation data + animation JS**

At the bottom of the file in a `<script>` block, define the conversation:

```js
const CONVO = [
  { role: 'user', text: 'bushwick', annotation: 'checkMechanical: miss\ncallAgentBrain → search_events({neighborhood: "Bushwick", intent: "new_search"})\n47 events → 3 picks composed\ncost: $0.0005 · latency: 2.1s' },
  { role: 'pulse', text: "Tiny Cupboard's got a free open mic tonight at 8, and there's a killer DJ set at Elsewhere at 10 ($15). Or if you want something chill, Bushwick Comedy has stand-up at 9 — free. Any of these sound good?", annotation: 'Gemini continuation → natural prose SMS\nsaveResponseFrame → session updated\ntwilio.js → SMS out ($0.008)' },
  { role: 'user', text: '2', annotation: 'search_events({intent: "details", pick_reference: "2"})\nFuzzy match → Elsewhere DJ set\ncost: $0.0005' },
  { role: 'pulse', text: "Elsewhere is that massive warehouse venue — tonight's a deep house night with DJ Honeypot. Doors at 10, gets going around 11. $15 at the door. https://elsewhere.zone/tonight", annotation: 'continueWithResults → detail SMS\n480 chars · includes URL' },
  { role: 'user', text: 'how about comedy', annotation: 'search_events({neighborhood: "Bushwick", category: "comedy", intent: "refine"})\nFilters persist from session (P1)' },
  { role: 'pulse', text: "Bushwick Comedy's got free stand-up at 9 tonight — always a good crowd. And Tiny Cupboard has an improv jam at 10 ($5). Reply 1 or 2 for details.", annotation: 'Refined search: comedy + Bushwick\n2 picks composed\ncost: $0.0005' },
];
```

Animation: `playConvo()` function that appends messages one at a time with 1.5s delay, each message fading in with CSS `@keyframes fadeSlideIn`. Annotation appears alongside each message.

Auto-plays when `#hero` enters viewport (IntersectionObserver). Replays on click.

**Step 3: Add CSS for phone + annotations**

Phone: dark border frame, screen bg slightly lighter than page. Message bubbles: user (coral bg, right), pulse (card bg, left). Annotation blocks: monospace, dim text, left-bordered with coral.

Responsive: on mobile (<768px), stack phone above annotations.

**Step 4: Verify in browser**

Open page. Confirm: phone mockup renders, messages animate in with delay, annotations appear alongside, responsive layout works on narrow viewport.

**Step 5: Commit**

```bash
git add site/architecture.html
git commit -m "feat: architecture hero — animated phone mockup with annotated conversation"
```

---

### Task 3: Section 2 — Request Flow Timeline

**Files:**
- Modify: `site/architecture.html`

**Step 1: Build the timeline**

Inside `#flow`, create a vertical timeline. Each step is a card:

```html
<div class="flow-step" data-cost="$0" data-latency="<1ms">
  <div class="flow-dot"></div>
  <div class="flow-card">
    <div class="flow-header">
      <span class="flow-module">request-guard.js</span>
      <span class="flow-cost">$0</span>
      <span class="flow-latency">&lt;1ms</span>
    </div>
    <div class="flow-desc">TCPA opt-out check, Twilio dedup, per-user AI budget ($0.10/day)</div>
  </div>
</div>
```

9 steps total (from design doc). The two paid steps (`brain-llm.js` at $0.0005 and `twilio.js` at $0.008) get `class="flow-step paid"` with coral left border and coral cost text.

Timeline CSS: vertical line on the left (2px, `var(--border)`), dots at each step, cards offset right. Paid steps have coral dot + coral left border.

Steps 5 and 7 (`brain-llm.js`) get expandable content — a `<details>` element inside the card that shows "View system prompt" / "View compose prompt" as summary. The actual prompt text goes in Task 5 (after Section 3 is built).

**Step 2: Verify**

Confirm timeline renders vertically, paid steps highlighted in coral, expandable stubs work.

**Step 3: Commit**

```bash
git add site/architecture.html
git commit -m "feat: architecture request flow — vertical timeline with cost annotations"
```

---

### Task 4: Section 3 — Agent Brain Deep Dive

**Files:**
- Modify: `site/architecture.html`

**Step 1: Build the three panels**

Inside `#brain`, create a 3-column grid (stack on mobile):

**Panel 1: 3-File Split**
```html
<div class="brain-panel">
  <h3>3-File Split</h3>
  <div class="file-tree">
    <div class="file-node root">agent-brain.js <span class="file-meta">orchestrator · ~450 lines</span></div>
    <div class="file-node child">brain-llm.js <span class="file-meta">LLM calls + compose · ~550 lines</span></div>
    <div class="file-node child">brain-execute.js <span class="file-meta">tool execution + pools · ~530 lines</span></div>
  </div>
  <p class="panel-note">No circular dependencies. agent-brain.js re-exports everything — existing imports work unchanged.</p>
</div>
```

**Panel 2: 2 Tools**
Show `search_events` and `respond` tool schemas as styled pseudo-JSON. Highlight the key params:
- `search_events`: neighborhood, category/categories, free_only, time_after, date_range, intent (enum with all 5 values), pick_reference
- `respond`: message, intent (enum)

Add a callout: "Tool call params ARE the state (P1) — filters, intent, and neighborhood are never parsed from free text."

**Panel 3: Fallback Chain**
Small vertical flow with arrows:
```
Gemini 2.5 Flash Lite
  ↓ fail
Claude Haiku (fallback)

Composition:
Same Gemini session (continuation)
  ↓ fail
brainCompose (standalone)
  ↓ fail
Claude Haiku
```

**Step 2: Verify**

Three panels render side-by-side on desktop, stack on mobile. Tool schemas readable. Fallback chain clear.

**Step 3: Commit**

```bash
git add site/architecture.html
git commit -m "feat: architecture agent brain — 3-file split, tool schemas, fallback chain"
```

---

### Task 5: Expandable Prompt Blocks

**Files:**
- Modify: `site/architecture.html`

**Step 1: Add prompt CSS**

```css
.prompt-block { margin: 16px 0; }
.prompt-block summary {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--coral);
  cursor: pointer;
  padding: 12px 16px;
  background: var(--bg-code);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.prompt-block pre {
  margin-top: 8px;
  padding: 16px;
  background: var(--bg-code);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--text-dim);
  overflow-x: auto;
  white-space: pre-wrap;
  max-height: 400px;
  overflow-y: auto;
}
```

**Step 2: Add 5 prompt blocks below the panels**

Each is a `<details class="prompt-block">` with:
1. `BRAIN_SYSTEM` — Copy from `buildBrainSystemPrompt()` in `brain-llm.js` lines 97-218. Note: this is dynamic (session-dependent), so show the template with `${sessionContext}` placeholders visible.
2. `BRAIN_COMPOSE_SYSTEM` — Copy from `brain-llm.js` lines 480-496.
3. `WELCOME_COMPOSE_SYSTEM` — Copy from `brain-llm.js` lines 515-543.
4. `DETAILS_SYSTEM` — Copy from `prompts.js` lines 233-261.
5. `EXTRACTION_PROMPT` — Copy from `prompts.js` lines 1-182.

Each summary shows the prompt name + first line as preview. Full text in the `<pre>` block.

Also wire up the expandable stubs in Section 2's timeline (Steps 5 and 7) to point to these prompt blocks via anchor links.

**Step 3: Verify**

All 5 prompts collapse/expand. Text is readable in monospace. Scrollable when long. Timeline links jump to correct prompt.

**Step 4: Commit**

```bash
git add site/architecture.html
git commit -m "feat: architecture prompts — 5 expandable blocks with actual system prompts"
```

---

### Task 6: Section 4 — Data Pipeline

**Files:**
- Modify: `site/architecture.html`

**Step 1: Build the pipeline flow**

Inside `#pipeline`, create a vertical CSS flow diagram:

```html
<div class="pipe-flow">
  <div class="pipe-node trigger">10am ET cron</div>
  <div class="pipe-arrow"></div>
  <div class="pipe-node">source-registry.js</div>
  <div class="pipe-arrow"></div>
  <div class="pipe-node">19 scrapers (parallel fetch)</div>
  <div class="pipe-arrow"></div>
  <div class="pipe-node guard">scrape-guard.js — count · coverage · date · dupes</div>
  <div class="pipe-fork">
    <div class="pipe-branch pass">
      <div class="pipe-arrow"></div>
      <div class="pipe-node">merge into cache</div>
    </div>
    <div class="pipe-branch fail">
      <div class="pipe-arrow"></div>
      <div class="pipe-node alert">quarantine + alert</div>
    </div>
  </div>
  <div class="pipe-arrow"></div>
  <div class="pipe-node">post-scrape audit</div>
  <div class="pipe-arrow"></div>
  <div class="pipe-node">geocode + stamp</div>
  <div class="pipe-arrow"></div>
  <div class="pipe-node storage">events-cache.json (atomic write)</div>
</div>
```

**Step 2: Build the source pills grid**

Below the flow, a grid of 22 source pills color-coded by vibe tier:

```html
<div class="source-grid">
  <div class="source-pill discovery">Skint <span>0.9</span></div>
  <div class="source-pill discovery">SkintOngoing <span>0.9</span></div>
  <div class="source-pill discovery">NonsenseNYC <span>0.9</span></div>
  <!-- ... all 22 -->
</div>
```

Colors:
- `.discovery` (unstructured tier): coral bg — Skint, SkintOngoing, NonsenseNYC, Yutori, ScreenSlate, BKMag
- `.niche` (curated/primary): purple bg — RA, Dice, BrooklynVegan, BAM, Luma, SofarSounds
- `.platform` (secondary): blue bg — DoNYC, Songkick, NYCParks, TinyCupboard, BrooklynCC, NYCTrivia
- `.mainstream` (secondary/low-weight): muted bg — Eventbrite, EventbriteComedy, EventbriteArts, NYPL

Tier legend below the grid. Callout card: "4 sources use LLM extraction: Skint, NonsenseNYC, Yutori, ScreenSlate" with link to `#brain` (extraction prompt).

**Step 3: Verify**

Pipeline flow renders vertically with arrows. Fork shows pass/fail paths. Source pills render in a wrapping grid with correct colors. Responsive on mobile.

**Step 4: Commit**

```bash
git add site/architecture.html
git commit -m "feat: architecture data pipeline — scrape flow + 22 source pills by vibe tier"
```

---

### Task 7: Section 5 — Session Isolation

**Files:**
- Modify: `site/architecture.html`

**Step 1: Build the isolation visual**

Inside `#sessions`, create two phone-number session bubbles side by side with a divider:

```html
<div class="session-visual">
  <div class="session-bubble">
    <div class="session-phone">+1 (917) ***-**42</div>
    <div class="session-fields">
      <span>neighborhood: Bushwick</span>
      <span>picks: 3 shown</span>
      <span>filters: comedy</span>
      <span>history: 4 turns</span>
    </div>
  </div>
  <div class="session-wall">
    <span>no shared state</span>
  </div>
  <div class="session-bubble">
    <div class="session-phone">+1 (347) ***-**87</div>
    <div class="session-fields">
      <span>neighborhood: LES</span>
      <span>picks: 2 shown</span>
      <span>filters: free + jazz</span>
      <span>history: 6 turns</span>
    </div>
  </div>
</div>
```

**Step 2: Add the 4 callout cards**

```html
<div class="isolation-grid">
  <div class="iso-card">
    <h4>Keyed by phone #</h4>
    <p>In-memory Map uses the From phone number as key. Every read/write is scoped to one user. No shared state, no cross-access.</p>
  </div>
  <div class="iso-card">
    <h4>Per-phone mutex</h4>
    <p>acquireLock(phone) serializes concurrent SMS from the same number. Prevents race conditions within a session.</p>
  </div>
  <div class="iso-card">
    <h4>SHA-256 on disk</h4>
    <p>Phone numbers are hashed before writing to sessions.json. Raw numbers never touch disk.</p>
  </div>
  <div class="iso-card">
    <h4>2hr TTL + cleanup</h4>
    <p>Sessions auto-expire after 2 hours. Garbage collected every 10 minutes. Flushed on graceful shutdown.</p>
  </div>
</div>
```

**Step 3: Verify**

Two session bubbles with wall between them. Four callout cards in a 2x2 grid. Responsive.

**Step 4: Commit**

```bash
git add site/architecture.html
git commit -m "feat: architecture session isolation — dual-phone visual + 4 callout cards"
```

---

### Task 8: Section 6 — Cost Anatomy + Footer

**Files:**
- Modify: `site/architecture.html`

**Step 1: Build the cost breakdown**

Inside `#cost`, a clean cost table:

```html
<div class="cost-table">
  <div class="cost-row">
    <span class="cost-amount">$0.0005</span>
    <span class="cost-label">Agent brain — Gemini 2.5 Flash Lite</span>
    <span class="cost-bar" style="width: 6%"></span>
  </div>
  <div class="cost-row highlight">
    <span class="cost-amount">$0.008</span>
    <span class="cost-label">SMS delivery — Twilio</span>
    <span class="cost-bar" style="width: 94%"></span>
  </div>
  <div class="cost-total">
    <span class="cost-amount">$0.0085</span>
    <span class="cost-label">Total per message</span>
  </div>
</div>
<div class="cost-note">
  Daily per-user AI budget: <strong>$0.10</strong> — enforced by request-guard.js
</div>
```

The visual insight: Twilio (the dumb pipe) costs 16x more than the AI brain. Show this as proportional bars.

**Step 2: Add page footer**

Simple footer with: "Built by Justin Koufopoulos" + link to GitHub repo + "Last updated: March 2026".

**Step 3: Verify**

Cost bars proportional, total visible, footer renders.

**Step 4: Commit**

```bash
git add site/architecture.html
git commit -m "feat: architecture cost anatomy + footer"
```

---

### Task 9: Polish — animations, responsive, final QA

**Files:**
- Modify: `site/architecture.html`

**Step 1: Add scroll-triggered fade-ins**

IntersectionObserver that adds `.visible` class to sections as they enter viewport. CSS transition: `opacity 0 -> 1, translateY(20px -> 0)` over 0.4s.

**Step 2: Responsive QA**

Test at 3 widths: 375px (mobile), 768px (tablet), 1200px (desktop). Fix any overflow, stacking, or readability issues. Key breakpoints:
- `<768px`: hero columns stack, brain panels stack, session bubbles stack vertically
- `<480px`: phone mockup scales down, flow timeline goes full width

**Step 3: Final content QA**

Verify all numbers match reality:
- 22 sources, 19 scraper modules
- 2 tools, 3 files in brain split
- 12 session fields, 2hr TTL
- $0.0005 per brain call, $0.008 per SMS, $0.10 daily budget
- All 5 prompts match current source code

**Step 4: Commit**

```bash
git add site/architecture.html
git commit -m "polish: architecture page animations, responsive fixes, content QA"
```
