# Venue Knowledge Layer — Design

> Date: 2026-03-12
> Status: Approved
> Phase: 8 (Venue Knowledge Layer)

## Problem

The agent can say "tiny room, maybe 50 people" (from `venue_size: intimate`) but can't say "dark cocktail bar with a killer sound system, go on a weeknight." Venue personality is the data that makes "feel like a local" credible, and we don't have it.

## Design Decisions

1. **Venue profiles live in `data/venue-profiles.json`** — a flat JSON file loaded on boot, same pattern as `venues-learned.json`. Not in `venues.js` (already 970 lines) and not in SQLite (overkill, can't git diff).

2. **One-liner in pool, full profile on details** — each event in the serialized pool gets a `venue_vibe` string (~15 tokens). Full profile (known_for, crowd, tip) only surfaces when the user asks for details. Keeps token budget manageable across 20-40 event pools.

3. **Seed set is curated by local relevance, not event frequency** — priority is "would a plugged-in local recommend this place, and does the name alone not tell you what to expect?" Not ranked by event count or source metadata.

4. **Web research for profile content** — profiles are drafted by agents that search the web for reviews, blog posts, Reddit threads, and local coverage. Not generated from model knowledge alone.

5. **Seed set only, no expansion pipeline yet** — 30-40 venues covers the vast majority of what the agent actually recommends. Build the draft/promote expansion workflow later if we hit unprofile'd venues in practice.

## Schema

`data/venue-profiles.json`:

```json
{
  "Mood Ring": {
    "vibe": "dark, moody cocktail bar with a sound system that punches above its size",
    "known_for": "vinyl nights, experimental DJ sets, natural wine",
    "crowd": "bushwick regulars, music nerds, people who came for one drink and stayed till close",
    "tip": "go on a weeknight — weekends get packed and loud"
  }
}
```

- `vibe` — one-liner in pool serialization (agent sees this for every event at the venue)
- `known_for` — what the venue is famous for in the local scene
- `crowd` — who goes there
- `tip` — the thing a local would tell a friend

## Integration Points

### Pool serialization (`brain-llm.js:282-299`)

Add one field to the event serialization in `serializePoolForContinuation`:

```js
venue_vibe: lookupVenueProfile(e.venue_name)?.vibe || undefined,
```

### Details intent (`brain-execute.js`)

`executeDetails` returns `{ found, event, pick, pickIndex }`. Add `venue_profile` to the return object:

```js
const profile = lookupVenueProfile(event.venue_name);
return { found: true, event, pick, pickIndex, venue_profile: profile || undefined };
```

This flows through `executeTool` in `agent-loop.js`, which serializes the tool result back to the agent. The agent sees `venue_profile: { known_for, crowd, tip }` alongside the event data and weaves it into the details SMS.

### System prompt (`brain-llm.js`)

Add one line to the metadata translation guide:

```
- venue_vibe → use it directly. "dark cocktail bar with a killer sound system" is better than anything generic. Trust the profile.
```

Add one line to the details structure guidance:

```
- If the venue has a profile (known_for, crowd, tip), lead with what the venue feels like before event logistics.
```

### Venue lookup (`venues.js`)

Add `lookupVenueProfile()` function that reads from the loaded JSON map. Uses the existing `normalizeName()` function (lowercase, strip punctuation, collapse whitespace) — same pattern as `lookupVenue` and `lookupVenueSize`. Handles variants like "The Bell House" / "Bell House" / "bell house" automatically.

On boot, load `data/venue-profiles.json` into a normalized map. If the file doesn't exist, default to an empty map with a log warning (same as `venues-learned.json` boot pattern).

## Seed Set (~30-40 venues)

Selected by local relevance, not event count. Approximate breakdown:

- **Bushwick/Ridgewood** (~8): Mood Ring, House of Yes, Bossa Nova Civic Club, Jupiter Disco, H0L0, Market Hotel, Elsewhere, TV Eye
- **Williamsburg/Greenpoint** (~6): Baby's All Right, Good Room, Purgatory, ALPHAVILLE, Sleepwalk, National Sawdust
- **Bed-Stuy/Crown Heights** (~4): C'mon Everybody, Ode to Babel, Public Records, Friends and Lovers
- **LES/East Village** (~4): Nublu, Pianos, Metrograph, Club Cumming
- **Gowanus/Park Slope** (~3): Bell House, Union Hall, Littlefield
- **Other** (~5): Pioneer Works, Spectacle Theater, Jalopy Theatre, Rockwood Music Hall, Caveat

Final list confirmed during web research phase — agents may surface additional worth-profiling venues or flag ones with insufficient web coverage.

## Seeding Workflow

1. For each seed venue, spawn a web search agent that:
   - Searches for reviews, blog posts, Reddit threads, local coverage
   - Reads 3-5 sources
   - Synthesizes into the 4-field profile schema
2. Collect all drafted profiles
3. Human reviews and edits profiles
4. Write approved profiles to `data/venue-profiles.json`

## What We're NOT Building

- **No `good_for` tags** — the system prompt already maps moods to categories and venue sizes. Redundant.
- **No expansion pipeline** — no draft file, no promote script, no trigger criteria. Ship seed set first, build expansion if needed.
- **No auto-learning from event data** — profiles come from web research + human review, not inferred from categories.
- **No dashboard UI** — review happens in the JSON file.
- **No changes to venue coords or size** — profiles are additive alongside existing data.
- **No venue profiles in `respond` tool** — profiles only affect `search_events` pool and details intent.

## Success Criteria

- Agent SMS responses reference venue-specific details ("dark cocktail bar with a killer sound system") instead of generic size descriptions ("intimate venue")
- Details responses lead with venue feel before event logistics
- No increase in pool serialization latency (profile lookup is O(1) map access)
- Human-reviewed profiles for 30-40 venues shipping in `data/venue-profiles.json`

## Roadmap Reconciliation

ROADMAP.md Phase 8 tasks need updating when this ships:
- "Create `src/venue-knowledge.js`" → profiles live in `data/venue-profiles.json`, lookup in `venues.js`
- "Seed top 50 venues by frequency" → 30-40 venues curated by local relevance
- "attach `venue_vibe` and `venue_tip`" → only `venue_vibe` in pool; full profile on details only
- `good_for` field mentioned in roadmap → explicitly cut from design
