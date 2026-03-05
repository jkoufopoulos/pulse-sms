# Property Alignment Design

**Goal:** Update all Pulse properties so messaging, features, links, and claims are accurate and cohesive. Then design an agent skill to automate future updates.

## Audit Findings

### Numbers that changed
| Claim | Old (on pages) | Actual | Where wrong |
|-------|----------------|--------|-------------|
| Neighborhoods | 36 | 75 (5 boroughs) | index.html hero, basics section |
| AI cost/msg | ~$0.001 | ~$0.0005 | test-ui.html system message |

### Stale messaging
| Issue | Where | Fix |
|-------|-------|-----|
| Demo shows numbered lists | index.html playDemo() | Switch to natural prose (Phase 4) |
| Demo says "Reply # for details" | index.html | Remove — agent handles naturally |
| Welcome msg references numbered lists | test-ui.html | Update to match current first-message |
| `.bestie-nav` CSS classes | test-ui.html, events-ui.html | Rename to `.pulse-nav` |
| `PULSE_AI_ROUTING=true` + Claude model refs | .env.example | Update to Gemini-first reality |
| Missing homepage/repository | package.json | Add fields |
| Source list says "and 16 more" | index.html | Verify: 6 named + 16 = 22 total (correct) |

### Architecture page
- No "Coming soon" placeholders found — sections are filled in
- Need to verify model names and cost figures match current state

## Changes

### 1. index.html (landing page)
- Update "36 neighborhoods" → "75 neighborhoods" in hero proof badge
- Update "36 neighborhoods across the city" → "75 neighborhoods across five boroughs" in basics section
- Add "Bronx" and "Staten Island" mentions alongside Manhattan, Brooklyn, Queens
- Add more hood tags (Astoria, Flushing, Jackson Heights etc.)
- Update demo conversation to use natural prose instead of numbered lists
- Remove "Reply # for details" from demo response

### 2. test-ui.html (simulator)
- Rename `.bestie-nav` → `.pulse-nav` (all CSS + HTML)
- Update cost claim: "~$0.001/msg" → "~$0.0005/msg"
- Update welcome messages to match current first-message experience

### 3. events-ui.html
- Rename `.bestie-nav` → `.pulse-nav` (all CSS + HTML)

### 4. package.json
- Add `"repository"` field
- Add `"homepage"` field (Railway URL for now)

### 5. .env.example
- Remove `PULSE_AI_ROUTING=true`
- Remove `PULSE_MODEL_ROUTE`
- Update model override comments to reflect Gemini-first architecture
- Add `GEMINI_API_KEY` (missing!)

### 6. Agent skill (design only)
- `/update-properties` skill that audits all properties against CLAUDE.md
- Flags stale counts, links, features, branding
- Can execute fixes or report what needs changing
