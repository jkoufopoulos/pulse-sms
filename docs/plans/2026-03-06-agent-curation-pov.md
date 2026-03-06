# Agent-Owned Curation: Point of View

**Date:** 2026-03-06
**Status:** Design exploration

---

## The Problem

Pulse has ~1,000 events per day across 22 sources. The current pipeline narrows them to ~20 via deterministic code (proximity, date, quality gates, source weight), then hands that pool to the LLM to pick 3.

The deterministic code makes the taste decisions. The agent makes none. This causes four problems:

1. **Pool is already too narrow** — By the time the agent sees 20 events, the interesting ones may have been filtered out. The geo + date + quality gates are blunt instruments that don't understand editorial quality.
2. **Pool is too noisy** — Of the 20 survivors, half may be filler. The agent has to wade through mediocre options with no signal about which are special.
3. **No taste persistence** — The agent can't learn what good picks look like. Every message starts from zero, with no knowledge of what this user (or users in general) respond to.
4. **Wrong diversity tradeoffs** — The agent sometimes picks 3 events from the same category, or forces diversity when the user clearly wants one thing. It has no guidance on when to diversify vs. when to go deep.

## How It Works Today

```
~1,000 events/day
    |
    v
Quality gates (confidence > 0.4, completeness > 0.4)     -- drops ~15%
    |
    v
Geo filter (haversine < 3km from target neighborhood)     -- drops ~80%
    |
    v
Date filter (today through +7 days)                       -- drops ~20%
    |
    v
Sort: date tier -> distance -> source_vibe                -- orders ~20
    |
    v
buildTaggedPool: filter-matched first, pad to 15          -- sends ~15-20 to LLM
    |
    v
LLM picks 3, composes SMS                                 -- ~$0.0005
```

The agent sees 15-20 events with metadata (name, venue, category, time, price, source_vibe, venue_size) but no scoring, no editorial signals, and no user preference context.

## Three Approaches

### Approach A: Better Pool, Same Architecture

Keep the two-stage funnel but improve the deterministic stage.

**Changes:**
- Widen pool from 20 to 40-50 events
- Attach `interestingness` score, `source_vibe`, `venue_size` as visible metadata
- Add taste instructions to the compose prompt ("prefer one-off discovery events at intimate venues")
- Add diversity instructions ("vary categories unless user asked for something specific")

**Pros:** Cheap, low-risk, no architecture change.
**Cons:** You're still hand-coding taste into deterministic scoring. `scoreInterestingness` is a static formula (vibe + rarity + venue size) that will never understand "this comedian just blew up on TikTok" or "this is the closing night of a 3-week run." The agent remains a copywriter, not a curator.

**Cost:** ~$0.0005/msg (unchanged)

### Approach B: Agent-Owned Ranking (Recommended)

Give the agent a much larger pool and let it do the curation.

**Changes:**
- Send 100-150 events as compressed summaries (~30 tokens each = 3k-4.5k input tokens)
- Each summary: name, venue, category, vibe, time, scarcity/editorial signals
- Define Pulse's editorial voice explicitly in the system prompt: "you're the friend who always knows the weird, perfect thing happening tonight"
- Pass user's prior pick history (categories, vibes they've engaged with) from session
- Agent reasons about the full pool and selects picks with justification

**Pros:** The agent actually curates. It can weigh editorial signals, read descriptions, and make judgment calls that no scoring formula can. Matches how Anthropic builds agents — give the model information and let it reason, rather than pre-filtering with heuristics that encode your biases poorly.
**Cons:** ~2x token cost, slightly more latency. Pool construction is simpler but prompt engineering for taste is harder to get right.

**Cost:** ~$0.001/msg

### Approach C: Tiered Agent with Learned Taste

Everything from B, plus persistent taste learning.

**Changes:**
- Preference profile as agent context: "this user tends to like comedy and late-night events"
- Global taste feedback loop: track which picks get detail requests (engagement signal) vs. ignored
- Use engagement data to periodically update the system prompt's taste guidance
- Editorial calendar: flag must-see events during scraping so the agent knows what's special

**Pros:** Most capable. Picks get better over time, both per-user and globally.
**Cons:** Cold start problem (sparse signal from SMS replies). Preference tracking adds complexity. Risk of feedback loops (popular categories get reinforced, niche gets starved).

**Cost:** ~$0.001/msg + preference tracking infrastructure

## Recommendation: Approach B, with one piece of C

**Why B:** The core Anthropic insight is — don't build heuristics for decisions the model can make. `scoreInterestingness` is a hand-coded proxy for taste. It works okay for the obvious cases, but it will never capture:

- "This DJ just did a Boiler Room set that went viral"
- "This is the last weekend of a critically acclaimed run"
- "This free comedy show in a Bushwick basement is exactly the kind of thing Pulse users love"

The agent can read `description_short` and make those calls. But only if it sees enough events to have real choices.

**The one piece of C worth adding now:** Feed the user's prior pick categories from session history into the agent context. You already track `allPicks` in the session. That's cheap context (~50 tokens) that immediately improves repeat-user experience with zero new infrastructure.

## Current Metadata Audit

### What we have (good):

- `name`, `description_short`, `venue_name`, `neighborhood`, `category`/`subcategory`
- `date_local`, `start_time_local`, `time_window`, `is_free`, `price_display`
- `source_vibe` (discovery/niche/platform/mainstream)
- `venue_size` (intimate/medium/large/massive)
- `is_recurring`, `interaction_format` (interactive/participatory/passive)
- `extraction_confidence`, `source_weight`

### What's missing that an Anthropic team would capture:

**At scrape time** (add to extraction prompt):

1. **`editorial_signal`** — Did the source editor call this out as a pick/highlight/must-see? Sources like Skint, NonsenseNYC, BKMag are editorial — they already curate. If the source text says "our pick" or leads with it, that's a strong signal. Right now we flatten all events from a source equally.

2. **`scarcity`** — Is this a one-night-only thing, a closing weekend, a limited-capacity event? The extraction prompt doesn't ask for this. "Last chance to see X" or "one night only" is exactly the kind of thing that makes a pick feel urgent and valuable.

3. **`vibe_tags`** — Free-form tags like `["chill", "date-night", "rowdy", "weird"]`. Our categories are structural (comedy, live_music). But a user texting "williamsburg" at 10pm on a Friday wants to know the *vibe*, not just the category. The agent could use these to match energy.

4. **`description_why`** — A one-line "why this is interesting" extracted from the source text. Different from `description_short` (what it is). Example: "DJ set from the Boiler Room resident who just went viral" vs. "DJ set at Elsewhere." The why is what makes someone text back "2" for details.

**At runtime** (derived, not scraped):

5. **`time_relevance`** — "starts in 2 hours" vs. "starts in 3 days." We have `date_local` but the agent doesn't get told how urgent something is relative to *right now*. A Thursday-night text should heavily favor tonight's events, and the agent should know "this starts in 90 minutes, mention that."

6. **`user_affinity`** — From session history: "this user asked about comedy twice" or "this user always texts late at night." We have `preference-profile.js` but it doesn't feed into the pool the agent sees.

### What to skip:

- **Popularity/trending** — no ticket sales data, biases toward mainstream
- **Social proof** ("X people going") — same bias problem
- **Explicit ratings** — misaligned with Pulse's editorial voice

### Priority

The biggest bang for effort is **`editorial_signal`** and **`scarcity`**. Those are already in our source text — the extraction prompt just doesn't ask for them. They're exactly the signals that separate "the agent picks the obvious thing" from "the agent picks the *perfect* thing."

## Token Math

For 150 events at ~30 tokens each (name + venue + category + vibe + time + editorial_signal):

```
Input:  system prompt (~500) + 150 events (~4,500) + session context (~200) = ~5,200 tokens
Output: SMS + picks + reasoning = ~300 tokens
Total:  ~5,500 tokens per message
```

At Gemini 2.5 Flash Lite pricing (~$0.075/1M input, $0.30/1M output):
- Input: 5,200 * $0.075/1M = $0.00039
- Output: 300 * $0.30/1M = $0.00009
- **Total: ~$0.0005/msg** (basically the same as today)

The pool is bigger but the per-event representation is compressed. This is surprisingly cost-neutral.

## Next Steps

1. Design the compressed event format (what fields to include per event in the agent pool)
2. Define the taste prompt (Pulse's editorial voice for curation)
3. Add `editorial_signal`, `scarcity`, `vibe_tags`, `description_why` to extraction prompt
4. Widen the pool pipeline (skip `buildTaggedPool` cap, send 100-150 to agent)
5. Add user pick history to agent context
6. Eval: compare pick quality between current pipeline and agent-curated pipeline
