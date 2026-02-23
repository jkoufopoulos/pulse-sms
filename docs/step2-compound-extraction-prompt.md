# Step 2: Compound Pre-Router Extraction

## Context

Read `ROADMAP.md` for architecture principles (especially P1, P6) and the full migration path. Read `CLAUDE.md` for system overview.

The pre-router (`src/pre-router.js`) currently detects single-dimension filter follow-ups: "how about comedy", "free", "later tonight", "something chill". But compound messages like "free comedy", "late jazz", "free stuff tonight", "comedy in bushwick" fall through to the unified LLM, which picks correct events but whose filter understanding is never persisted back to `lastFilters`. This is the root cause of P1 (Filter Persistence) regression at 50%.

The filter schema now supports `subcategory` (from Option D). Clean categories (comedy, theater, art, nightlife, community) use `[MATCH]` tagging in `buildTaggedPool`. Live music sub-genres (jazz, rock, indie, folk) are passed as `subcategory` — intent context for the LLM, not used for `[MATCH]` tagging.

## What to build

Extend the pre-router's session-aware filter detection (lines ~99-136 in `pre-router.js`) to handle compound messages — messages containing multiple filter dimensions in one phrase. Currently each filter type (free, category, time, vibe) has its own regex block that matches the full message. Compounds fall through because "free comedy" doesn't match the free regex (`/^(free|free stuff|...)$/`) or the category regex (`/^(?:how about|any|...) comedy...$/`).

**Compound patterns to handle:**
- Category + free: "free comedy", "free jazz", "any free music"
- Category + time: "late jazz", "comedy tonight", "late night comedy"
- Category + neighborhood: "comedy in bushwick", "jazz in the village" (extract neighborhood too)
- Free + time: "free stuff tonight", "anything free and late"
- Triple: "free comedy tonight", "free late jazz"

**Design constraints:**
- The pre-router is **additive, not gate-keeping**. If it detects compound filters, it returns `intent: 'events'` with the detected filters and the handler injects them into the unified LLM branch. If it misses a compound, the LLM still works — it just won't persist the filters. Silent failure = unfiltered picks, not wrong picks.
- Use the existing `catMap` for category/subcategory resolution. Don't duplicate the mapping.
- Use `extractNeighborhood()` from `neighborhoods.js` for neighborhood extraction (already imported in pre-router.js).
- Return the same shape as existing filter detections: `{ intent: 'events', neighborhood, filters: { category, subcategory, free_only, time_after, vibe }, confidence }`.
- The compound detection should run AFTER the existing single-dimension checks (lines 100-135) so simple messages still take the fast path. Add it as a new block before the `return null` at line 138.
- Don't require session — compound messages like "free comedy in bushwick" can be a first message with no prior context. But if session exists, use `session.lastNeighborhood` as fallback.

**`normalizeFilters()` in `pipeline.js`:** Review and revise — it currently maps jazz→live_music which conflicts with Option D's subcategory preservation. Remove live_music sub-genre mappings. Keep clean category mappings (standup→comedy, theatre→theater, improv→comedy). This function should be used to normalize the compound extraction output.

**Tests to add** (`test/unit/pre-router.test.js` or equivalent):
- "free comedy" → `{ free_only: true, category: 'comedy' }`
- "free jazz" → `{ free_only: true, category: 'live_music', subcategory: 'jazz' }`
- "late jazz" → `{ time_after: '22:00', category: 'live_music', subcategory: 'jazz' }`
- "comedy in bushwick" → `{ category: 'comedy' }` with `neighborhood: 'Bushwick'`
- "free comedy tonight" → `{ free_only: true, category: 'comedy', time_after: '22:00' }` (or similar)
- "free stuff tonight" → `{ free_only: true, time_after: '22:00' }`
- Existing single-dimension tests still pass unchanged

**Verification:**
1. `npm test` — all 520+ tests pass
2. Update `ROADMAP.md` — mark step 2 as done, note what changed
3. If possible: `node scripts/run-regression-evals.js --url http://localhost:3001 --principle P1` to measure improvement
