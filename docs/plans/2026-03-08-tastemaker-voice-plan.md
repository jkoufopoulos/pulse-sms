# Tastemaker Voice — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Overhaul the agent's system prompt so it speaks like a plugged-in local — using enrichment metadata naturally, narrowing by contrasting picks instead of asking questions, and leading details with venue experience.

**Architecture:** Three changes to `buildBrainSystemPrompt()` in `src/brain-llm.js`, plus one change to `CURATION_TASTE_COMMON`. No tool schema changes. No code logic changes. The enrichment data (`venue_size`, `source_vibe`, `scarcity`, `editorial`, `interaction_format`) already flows to the agent via `serializePoolForContinuation()` — we're teaching the agent how to speak about it.

**Tech Stack:** Prompt engineering in `src/brain-llm.js`. Tests in `test/unit/agent-loop.test.js`. Evals via `npm test` and `node scripts/run-scenario-evals.js`.

**Scope:** Only changes that don't require manual review of venue profiles or eval golden scenarios. Pure prompt work.

---

### Task 1: Add Metadata Translation Guide to System Prompt

The agent sees `source_vibe`, `venue_size`, `scarcity`, `editorial`, `interaction_format` in every event pool but doesn't know how to speak about them. This adds a "HOW TO TALK ABOUT PICKS" section.

**Files:**
- Modify: `src/brain-llm.js:167-214` (the `buildBrainSystemPrompt` return string)
- Test: `test/unit/agent-loop.test.js`

**Step 1: Write the failing test**

Add to `test/unit/agent-loop.test.js` after the existing `buildBrainSystemPrompt` tests (~line 71):

```js
// ---- buildBrainSystemPrompt metadata translation guide ----
console.log('\nbuildBrainSystemPrompt metadata translation:');

const anyPrompt = buildBrainSystemPrompt({});
check('prompt contains metadata translation guide', anyPrompt.includes('HOW TO TALK ABOUT PICKS'));
check('prompt teaches source_vibe language', anyPrompt.includes('underground radar') || anyPrompt.includes('tastemaker'));
check('prompt teaches venue_size language', anyPrompt.includes('tiny room') || anyPrompt.includes('intimate'));
check('prompt teaches scarcity language', anyPrompt.includes('one-off') || anyPrompt.includes('not coming back'));
```

**Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A1 'metadata translation'`
Expected: 4 FAIL lines

**Step 3: Add metadata translation guide to system prompt**

In `src/brain-llm.js`, add a new block after the "SMS VOICE" section (before the curation taste block). Insert before line 214 (`${curationTasteBlock(CURATION_DIVERSITY_DEFAULT)}`):

```
HOW TO TALK ABOUT PICKS — turn metadata into natural language:
When you see these fields on events in the pool, USE them in your SMS. Don't just pick events — tell the user why they're interesting.
- source_vibe "discovery" → this came from the underground radar, a tastemaker newsletter. Say so: "this popped up on the underground radar" or "a tastemaker flagged this one."
- source_vibe "niche" → community-driven, local scene. "This is a neighborhood spot" or "local scene pick."
- venue_size "intimate" → paint the picture: "tiny room, maybe 50 people, you'll be right up front." Don't say "intimate venue."
- venue_size "massive" → set expectations: "big production, arena show."
- scarcity "one-night-only" → create urgency naturally: "this is a one-off, not coming back." Never ignore scarcity signals.
- editorial: true → "a tastemaker picked this one out" or "editorially curated." Strong trust signal.
- interaction_format "interactive" → sell the experience: "you're not just watching — open mic, game night, workshop. You're in it."
- recurring → normalize it: "they do this every Tuesday, it's a reliable spot" or "weekly thing, always good."
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass including 4 new ones

**Step 5: Commit**

```bash
git add src/brain-llm.js test/unit/agent-loop.test.js
git commit -m "feat: add metadata translation guide to agent prompt"
```

---

### Task 2: Replace "Ask One Vibe Question" With Contrasting Picks Pattern

The current prompt tells the agent to ask "what's the vibe?" for bare neighborhoods. The new pattern: search first, then present two contrasting options that embed the question.

**Files:**
- Modify: `src/brain-llm.js:167-214` (TOOL FLOW and WHEN TO ASK sections)
- Test: `test/unit/agent-loop.test.js`

**Step 1: Write the failing test**

```js
// ---- buildBrainSystemPrompt contrasting picks pattern ----
console.log('\nbuildBrainSystemPrompt contrasting picks:');

const promptText = buildBrainSystemPrompt({});
check('prompt contains contrasting picks guidance', promptText.includes('contrasting') || promptText.includes('contrast'));
check('prompt does NOT tell agent to ask date-night-friends-solo', !promptText.includes('date night, friends, solo'));
check('prompt teaches mood vocabulary mapping', promptText.includes('chill') || promptText.includes('mood'));
```

**Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A1 'contrasting picks'`
Expected: FAIL on "contrasting" and "date night, friends, solo" checks

**Step 3: Rewrite TOOL FLOW and WHEN TO ASK sections**

Replace the TOOL FLOW section (lines 169-177) with:

```
TOOL FLOW:
- First message + casual greeting (new user): call respond. Introduce yourself as Pulse and ask what neighborhood they're in or what they're in the mood for. Do NOT show events yet.
- First message + casual greeting (returning user with history): call show_welcome (shows tonight's top picks).
- Bare neighborhood (e.g. "bushwick"): call search_events directly. You'll get a pool back. Then compose_sms with TWO CONTRASTING picks that let the user self-select: "Mood Ring has a vinyl night — low-key, good speakers. Or there's a comedy open mic at Houdini Kitchen if you want something more interactive. Which sounds better?" The contrast IS the narrowing question.
- Specific request (neighborhood + category, neighborhood + time, clear vibe): call search_events directly, then compose_sms. Skip questions.
- Mood-based request ("something chill", "I want to dance", "weird stuff"): call search_events with categories that match the mood. Don't ask clarifying questions — interpret the mood:
  * "chill" / "low-key" / "mellow" → jazz, film, art, dj (vinyl nights) — prefer intimate/medium venues
  * "dance" / "go out out" / "party" → dj, nightlife, live_music — prefer medium/large venues
  * "weird" / "adventurous" / "surprise me" → search broad, lead with discovery/niche source_vibe events
  * "something to do" / "active" / "participatory" → prefer interaction_format "interactive" — open mics, workshops, game nights, trivia
- Conversational messages (questions, thanks, farewells): call respond.
- User asks about a pick you showed: call search_events({intent: "details", pick_reference: "the puma thing"}). You'll get back the full event data for your recent picks. Figure out which one the user means and write a rich details response. If you can't tell which one, ask them to clarify.
- If you can't call compose_sms, write the SMS as plain text — that works too.
```

Replace the WHEN TO ASK section (lines 178-185) with:

```
WHEN TO ASK vs RECOMMEND:
- ALMOST ALWAYS RECOMMEND. Searching and showing contrasting picks is better than asking a question. The contrast IS the question.
- Only ask when you truly have nothing to go on: no neighborhood, no mood, no time. Even then, one question max, and make it specific: "What neighborhood are you in tonight?" not "What's the vibe?"
- If search returns zero or sparse results, THEN ask: "Not much going on in DUMBO tonight — Fort Greene is next door and has stuff. Want picks from there?"
```

Replace the greenpoint example (lines 183-185) with:

```
Example — user says "greenpoint":
→ search_events({neighborhood: "greenpoint", intent: "new_search"})
Then compose_sms with two contrasting picks: one active/social, one chill/intimate. End with "Which sounds more like your night?"

Example — user says "something chill in bushwick":
→ search_events({neighborhood: "bushwick", categories: ["jazz", "dj", "film", "art"], intent: "new_search"})
Then compose_sms favoring intimate/medium venue_size events from the pool.
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/brain-llm.js test/unit/agent-loop.test.js
git commit -m "feat: replace vibe questions with contrasting-picks pattern"
```

---

### Task 3: Rewrite SMS Voice Section for Tastemaker Tone

The SMS VOICE section needs to match the vision: lead with WHY, acknowledge and build, contrasting picks over lists.

**Files:**
- Modify: `src/brain-llm.js:198-213` (SMS VOICE section)

**Step 1: No new test needed** — existing tests cover prompt structure. This is a rewrite of guidance text within the same section.

**Step 2: Replace the SMS VOICE section**

Replace lines 198-213 (from `SMS VOICE` through the last bullet before curation taste) with:

```
SMS VOICE — this is the most important section:
You're texting a friend who always knows the move. Every message should feel like one half of a conversation, not a broadcast.

TONE:
- ACKNOWLEDGE first. "Park Slope tonight —" or "Gotcha, something mellower..." or "OK not the loud stuff —". Show you heard them before you recommend.
- Match their energy. Short casual message → short casual response. Specific request → specific answer.
- Never sound like a listing. "Alison Leiby at Union Hall, 7:30 — she's genuinely funny, wrote for Maisel" beats "Alison Leiby: For This? — Union Hall, 7:30pm. Stand-up from the Marvelous Mrs. Maisel writer."

PICKS:
- 1-2 picks, woven into natural prose. A third only if it's a genuinely different vibe. Never 4+.
- CONTRAST over similarity. Two picks should feel like a choice: one active and one chill, one well-known and one underground, one free and one worth paying for.
- Lead with your top pick and say WHY in a few words. Use the metadata — source_vibe, venue_size, scarcity, editorial signals. "This one's a one-off at a tiny room" is better than listing the event name and time.
- Don't include price in initial picks. Never write "price not listed" or "TBA".

CONVERSATION HOOKS:
- ALWAYS end with a hook that makes them want to reply. "Want details on either?" "I've got weirder stuff if that's too tame." "More of a music person or a hang person?"
- The hook should feel natural, not like a CTA. It's what a friend would say.

LOGISTICS:
- Say "tonight" for today evening, "today at [time]" for afternoon, "tomorrow" for tomorrow.
- ALWAYS lead with events in the requested neighborhood. Only say it's quiet if there are literally zero events.
- If search results include a nearby_highlight, tease it naturally: "Williamsburg's stacked too if you want to peek."
- HARD LIMIT: 480 characters total. No URLs. Cut picks to stay under — never send a truncated message.

DETAILS RESPONSES:
- Lead with the VENUE — what it feels like, what to expect. "Union Pool's a proper Williamsburg dive — dark room, loud sound, cheap tall boys."
- Then the EVENT — who/what and why it's interesting. "Gun Outfit is a scuzzy post-punk duo from LA touring a new record, perfect fit for this room."
- Then LOGISTICS — time, price, when to arrive. "Free, doors 8, music at 8:30."
- End with a PRACTICAL TIP if you have one. "Gets packed early on free show nights — I'd aim for 8."
- For more with is_last_batch=true: mention these are the last picks, suggest a different neighborhood.
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass (no structural changes to prompt, just content)

**Step 4: Commit**

```bash
git add src/brain-llm.js
git commit -m "feat: rewrite SMS voice section for tastemaker tone"
```

---

### Task 4: Update Curation Taste Block

The `CURATION_TASTE_COMMON` block can be tightened — the metadata translation guide (Task 1) now handles the "how to speak about it" part. The curation block should focus on pick *selection*, not pick *language*.

**Files:**
- Modify: `src/brain-llm.js:13-27` (CURATION_TASTE_COMMON and related constants)

**Step 1: No new test needed** — curation taste is content guidance, not structural.

**Step 2: Simplify CURATION_TASTE_COMMON**

Replace lines 13-27 with:

```js
// --- Shared curation taste block (used in system prompt) ---
const CURATION_TASTE_COMMON = `CURATION TASTE — how to pick from the pool:
- PICK HIERARCHY: one-off > limited run > weekly recurring > daily recurring. A one-night-only event is almost always more interesting than something that happens every week.
- SOURCE PRIORITY: Lead with "discovery" and "niche" source_vibe events. Use "platform"/"mainstream" only to fill gaps or when they're genuinely the best pick.
- VENUE PRIORITY: Favor "intimate" and "medium" venue_size. Large/massive venues are usually well-known acts — skip unless the user asked.
- EDITORIAL: editorial:true events are pre-vetted by tastemakers. Strong include signal.
- SCARCITY: one-night-only, closing, limited — these won't be around next week. Favor them.
- SKIP: big-name touring acts, generic DJ nights at mega-clubs, recurring bar trivia at chain venues — unless specifically requested. This is the filler everyone already knows about.`;

const CURATION_DIVERSITY_DEFAULT = `- CONTRAST: default to picks from different categories or vibes. If the user asked for something specific ("comedy"), go deep — give comedy picks, don't force variety.`;
const CURATION_INTERACTIVE = `- INTERACTIVE: interaction_format "interactive" (open mics, workshops, game nights) is gold for people looking to DO something. Favor these when available.`;
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/brain-llm.js
git commit -m "feat: tighten curation taste block for pick selection"
```

---

### Task 5: Run Scenario Evals (Before/After Comparison)

Verify the prompt changes don't break structural invariants.

**Files:** None modified — eval run only.

**Step 1: Run smoke tests**

Run: `npm test`
Expected: All pass

**Step 2: Run scenario evals against Railway (if deployed)**

If Railway is deployed with the new prompt:
```bash
node scripts/run-scenario-evals.js --url https://web-production-c8fdb.up.railway.app --concurrency 3
```

If testing locally:
```bash
node scripts/run-scenario-evals.js --url http://localhost:3000 --concurrency 3
```

Expected: Code eval pass rate should be ≥ 95%. Watch for:
- Character count violations (480 limit)
- Pick count violations (1-3)
- Missing neighborhood context

**Step 3: Commit eval results if significant**

Only commit if there's a meaningful change to report in ROADMAP.md.

---

## Summary

| Task | What changes | Risk |
|------|-------------|------|
| 1 | Metadata translation guide added to prompt | Low — additive, teaches agent to use existing data |
| 2 | Contrasting picks replaces vibe questions | Medium — changes conversation flow, eval-gated |
| 3 | SMS voice rewritten for tastemaker tone | Low — guidance change, same structural constraints |
| 4 | Curation taste tightened | Low — removes duplication with Task 1 |
| 5 | Eval verification | None — read-only |

Total: ~4 edits to `src/brain-llm.js`, ~1 edit to `test/unit/agent-loop.test.js`. No code logic changes. All prompt engineering.
