# "Other" Category Reduction + Editorial Note Preservation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce events stuck in "other" category from ~41% to <20% via rules-based remapping, and preserve editorial blurbs from newsletter sources as `editorial_note` so the agent can speak about why a pick matters.

**Architecture:** Task 1 adds a `remapOtherCategory(event)` function in `events.js` that runs post-merge, pre-quality-gates. Regex patterns on name + description reclassify "other" events into specific categories. Task 2 adds `editorial_note` to the LLM extraction prompt, carries it through normalization and serialization to the agent. Both changes are additive — no existing behavior modified.

**Tech Stack:** Node.js, regex pattern matching, LLM prompt engineering. Tests via `npm test`. No new dependencies.

---

### Task 1: Add `remapOtherCategory()` Function

**Files:**
- Modify: `src/events.js` (add function + call site)
- Test: `test/unit/events.test.js`

**Step 1: Write the failing test**

Add to the end of `test/unit/events.test.js`:

```js
// ---- remapOtherCategory ----
console.log('\nremapOtherCategory:');

const { remapOtherCategory } = require('../../src/events');

// Should remap known patterns
check('sound bath → community', remapOtherCategory({ category: 'other', name: 'Sound Bath at the Studio' }).category === 'community');
check('meditation → community', remapOtherCategory({ category: 'other', name: 'Full Moon Meditation Circle' }).category === 'community');
check('zine fair → community', remapOtherCategory({ category: 'other', name: 'Brooklyn Zine Fair 2026' }).category === 'community');
check('popup market → community', remapOtherCategory({ category: 'other', name: 'Vintage Popup Market' }).category === 'community');
check('flea market → community', remapOtherCategory({ category: 'other', name: 'Fort Greene Flea' }).category === 'community');
check('immersive theater → theater', remapOtherCategory({ category: 'other', name: 'Immersive Theater Experience' }).category === 'theater');
check('performance art → theater', remapOtherCategory({ category: 'other', name: 'Performance Art Night' }).category === 'theater');
check('film screening → film', remapOtherCategory({ category: 'other', name: 'Short Film Screening' }).category === 'film');
check('movie night → film', remapOtherCategory({ category: 'other', name: 'Outdoor Movie Night' }).category === 'film');
check('documentary → film', remapOtherCategory({ category: 'other', name: 'Documentary Premiere' }).category === 'film');
check('vinyl night → nightlife', remapOtherCategory({ category: 'other', name: 'Vinyl Night at Mood Ring' }).category === 'nightlife');
check('dance party → nightlife', remapOtherCategory({ category: 'other', name: 'Disco Dance Party' }).category === 'nightlife');
check('dj set → nightlife', remapOtherCategory({ category: 'other', name: 'Late Night DJ Set' }).category === 'nightlife');
check('jazz → live_music', remapOtherCategory({ category: 'other', name: 'Jazz Jam Session' }).category === 'live_music');
check('acoustic → live_music', remapOtherCategory({ category: 'other', name: 'Acoustic Night' }).category === 'live_music');
check('live band → live_music', remapOtherCategory({ category: 'other', name: 'Live Band Showcase' }).category === 'live_music');
check('trivia → trivia', remapOtherCategory({ category: 'other', name: 'Tuesday Trivia Night' }).category === 'trivia');
check('quiz night → trivia', remapOtherCategory({ category: 'other', name: 'Pub Quiz Night' }).category === 'trivia');
check('game night → trivia', remapOtherCategory({ category: 'other', name: 'Board Game Night' }).category === 'trivia');
check('gallery opening → art', remapOtherCategory({ category: 'other', name: 'Gallery Opening Reception' }).category === 'art');
check('art exhibition → art', remapOtherCategory({ category: 'other', name: 'New Art Exhibition' }).category === 'art');
check('book reading → spoken_word', remapOtherCategory({ category: 'other', name: 'Book Reading & Signing' }).category === 'spoken_word');
check('poetry slam → spoken_word', remapOtherCategory({ category: 'other', name: 'Poetry Slam Night' }).category === 'spoken_word');
check('storytelling → spoken_word', remapOtherCategory({ category: 'other', name: 'Storytelling Open Mic' }).category === 'spoken_word');
check('wine tasting → food_drink', remapOtherCategory({ category: 'other', name: 'Natural Wine Tasting' }).category === 'food_drink');
check('supper club → food_drink', remapOtherCategory({ category: 'other', name: 'Underground Supper Club' }).category === 'food_drink');
check('food popup → food_drink', remapOtherCategory({ category: 'other', name: 'Thai Food Popup' }).category === 'food_drink');

// Should NOT remap non-other categories
check('comedy stays comedy', remapOtherCategory({ category: 'comedy', name: 'Stand-up Night' }).category === 'comedy');

// Should leave genuinely unknown "other" alone
check('unknown stays other', remapOtherCategory({ category: 'other', name: 'Annual Gala Fundraiser' }).category === 'other');

// Should also check description_short
check('description match works', remapOtherCategory({ category: 'other', name: 'Special Event', description_short: 'An evening of jazz and cocktails' }).category === 'live_music');

// Returns the same object (mutates in place)
const evt = { category: 'other', name: 'Trivia Tuesday' };
check('returns same object', remapOtherCategory(evt) === evt);
```

**Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A1 'remapOtherCategory'`
Expected: FAIL — `remapOtherCategory is not a function`

**Step 3: Implement `remapOtherCategory` in `events.js`**

Add this function before `applyQualityGates` (before line 841):

```js
/**
 * Remap events with category "other" to a specific category based on name/description patterns.
 * Mutates events in place. Only touches category === 'other'.
 */
const OTHER_REMAP_RULES = [
  // Community / wellness / markets
  { pattern: /\b(sound bath|meditation|breathwork|yoga|wellness|healing)\b/i, category: 'community' },
  { pattern: /\b(zine|popup market|pop-?up market|flea market|flea|vintage market|craft fair|bazaar|swap meet)\b/i, category: 'community' },
  { pattern: /\b(workshop|class(?:es)?|seminar|lecture|talk(?:s)?)\b/i, category: 'community' },
  // Theater / performance
  { pattern: /\b(immersive|performance art|cabaret|burlesque|variety show|drag show|drag)\b/i, category: 'theater' },
  // Film
  { pattern: /\b(film|movie|screening|cinema|documentary|short films)\b/i, category: 'film' },
  // Nightlife
  { pattern: /\b(vinyl night|dance party|disco|dj\b|dj set|club night|rave|techno night|house night)\b/i, category: 'nightlife' },
  // Live music
  { pattern: /\b(jazz|acoustic|live band|songwriter|bluegrass|folk music|orchestra|ensemble|quartet|trio)\b/i, category: 'live_music' },
  // Trivia / games
  { pattern: /\b(trivia|quiz|game night|board game|bingo|karaoke)\b/i, category: 'trivia' },
  // Art
  { pattern: /\b(gallery|exhibition|art show|art opening|mural|sculpture)\b/i, category: 'art' },
  // Spoken word / literary
  { pattern: /\b(book reading|poetry|spoken word|storytelling|literary|book launch|reading series|open mic.*poet)\b/i, category: 'spoken_word' },
  // Food & drink
  { pattern: /\b(wine tasting|supper club|food popup|food pop-?up|tasting|beer fest|cocktail|brunch)\b/i, category: 'food_drink' },
];

function remapOtherCategory(event) {
  if (event.category !== 'other') return event;
  const text = `${event.name || ''} ${event.description_short || event.short_detail || ''}`.toLowerCase();
  for (const rule of OTHER_REMAP_RULES) {
    if (rule.pattern.test(text)) {
      event.category = rule.category;
      return event;
    }
  }
  return event;
}
```

Add `remapOtherCategory` to the module exports at the bottom of `events.js`.

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass including the new `remapOtherCategory` tests.

**Step 5: Commit**

```bash
git add src/events.js test/unit/events.test.js
git commit -m "feat: add remapOtherCategory rules for other→specific category"
```

---

### Task 2: Wire `remapOtherCategory` Into the Cache Build

**Files:**
- Modify: `src/events.js` (call remapOtherCategory in refreshCache)

**Step 1: Find the call site in `refreshCache()`**

In `events.js`, after all sources merge and stamping functions run (after `stampSourceVibe`, `stampInteractionFormat`, etc.) but before `applyQualityGates`, add the remap call.

Look for the section around lines 470-490 where `stampSourceVibe(validEvents)`, `stampInteractionFormat(validEvents)`, etc. are called. Add after the last stamp call:

```js
// Remap "other" category events using rules-based pattern matching
let remapped = 0;
for (const e of validEvents) {
  const before = e.category;
  remapOtherCategory(e);
  if (e.category !== before) remapped++;
}
if (remapped > 0) {
  console.log(`Category remap: ${remapped} events moved from "other" to specific categories`);
}
```

**Step 2: Run tests**

Run: `npm test`
Expected: All pass (this is wiring only, no new test needed — the function is already tested).

**Step 3: Verify with a scrape audit (optional, manual)**

After deploying, check the "other" percentage:
```bash
node -e "const {getEvents}=require('./src/events'); const evts=getEvents(); const other=evts.filter(e=>e.category==='other').length; console.log('other:', other, '/', evts.length, '=', (100*other/evts.length).toFixed(1)+'%')"
```

Target: <20% (down from ~41%).

**Step 4: Commit**

```bash
git add src/events.js
git commit -m "feat: wire category remap into cache build pipeline"
```

---

### Task 3: Add `editorial_note` to Extraction Prompt

**Files:**
- Modify: `src/prompts.js:76-113` (add field to extraction output schema)
- Test: `test/unit/ai.test.js` (or manual — prompt changes are tested via extraction audit)

**Step 1: Add `editorial_note` to the extraction JSON schema**

In `src/prompts.js`, in the output format JSON (lines 76-112), add after the `"scarcity"` line (line 107) and before `"is_recurring"` (line 108):

```
      "editorial_note": "If the source text includes a recommendation, opinion, or editorial take on why this event is worth attending, capture it verbatim or closely paraphrased (1-2 sentences, max 150 chars). Otherwise null.",
```

**Step 2: Run tests**

Run: `npm test`
Expected: All pass (prompt text change only, no structural change).

**Step 3: Commit**

```bash
git add src/prompts.js
git commit -m "feat: add editorial_note field to extraction prompt"
```

---

### Task 4: Carry `editorial_note` Through Normalization

**Files:**
- Modify: `src/sources/shared.js:153-202` (add field to normalizeExtractedEvent output)

**Step 1: Add `editorial_note` to the return object**

In `src/sources/shared.js`, in the `normalizeExtractedEvent` function's return object (line 153-202), add after the `evidence` block (after line 193):

```js
    editorial_note: e.editorial_note || null,
```

**Step 2: Run tests**

Run: `npm test`
Expected: All pass.

**Step 3: Commit**

```bash
git add src/sources/shared.js
git commit -m "feat: carry editorial_note through event normalization"
```

---

### Task 5: Add `editorial_note` to Agent Serialization + Details

**Files:**
- Modify: `src/brain-llm.js:286-298` (add to serializePoolForContinuation)
- Modify: `src/agent-loop.js:278-289` (add to details response)

**Step 1: Add `editorial_note` to pool serialization**

In `src/brain-llm.js`, in the `serializePoolForContinuation` function's event map (line 286-298), add after the `scarcity` line (line 296):

```js
      editorial_note: e.editorial_note || undefined,
```

**Step 2: Add `editorial_note` to details response**

In `src/agent-loop.js`, in the details intent handler's event map (line 278-289), add after the `recurring` line (line 288):

```js
          editorial_note: e.editorial_note || undefined,
```

**Step 3: Run tests**

Run: `npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/brain-llm.js src/agent-loop.js
git commit -m "feat: pass editorial_note to agent in pool and details responses"
```

---

### Task 6: Update ROADMAP.md

**Files:**
- Modify: `ROADMAP.md`

**Step 1: Mark completed items**

In ROADMAP.md, check off:
- Phase 7 items (metadata translation, contrasting picks, mood mapping, details structure — all done in prior session)
- Phase 8 "other" category reduction
- Phase 8 Yutori editorial preservation (editorial_note field added)
- Phase 11 venue learning persistence (already working)

**Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark completed roadmap items (phase 7, category remap, editorial note, venue persistence)"
```

---

## Summary

| Task | What changes | Risk |
|------|-------------|------|
| 1 | `remapOtherCategory()` function + tests | Low — pure function, well-tested |
| 2 | Wire remap into cache build | Low — additive, runs after stamps |
| 3 | `editorial_note` in extraction prompt | Low — additive field, null default |
| 4 | Carry through normalization | Low — one line addition |
| 5 | Pass to agent in pool + details | Low — one line each |
| 6 | Update ROADMAP.md | None |

Total: ~4 files modified, ~1 test file extended. No behavior changes to existing code — all additive.
