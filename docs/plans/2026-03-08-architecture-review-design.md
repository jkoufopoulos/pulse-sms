# Architecture Review: From Current State to "Feel Like a Local"

*2026-03-08 — Strategic design review of Pulse SMS*

See also: [Product Vision](../VISION.md)

## The Core Gap

Pulse has a rich enrichment pipeline — venue size, source vibe, scarcity, editorial signals, interaction format, interestingness scoring. The data is flowing to the agent via `serializePoolForContinuation()`. But the agent doesn't know how to **speak** about this data the way a local would. It has metadata without knowledge, and the conversation flow is still query-response rather than true curation dialogue.

Two problems to solve:
1. **The agent has metadata but no knowledge.** It knows `venue_size: "intimate"` but not that Mood Ring is a sweaty Bushwick basement with a Funktion-One sound system. Without that, it can't say anything a local would say.
2. **The conversation flow is still query-response.** The discovery conversation (ask before recommending) is a start, but the agent doesn't truly explore what someone wants. It asks one vibe question, then dumps picks.

## Section 1: Venue Knowledge Layer

The biggest unlock for "feel like a local" is giving the agent **venue personality** — not just coordinates and capacity, but what a venue feels like, who goes there, and what it's known for.

### Venue profiles

A `venue-knowledge.js` module with structured venue profiles:

```js
{
  "Union Pool": {
    neighborhood: "Williamsburg",
    size: "medium",
    vibe: "Sweaty dive bar with a backyard. Cheap beer, loud bands.",
    known_for: "indie rock, punk, free late-night shows",
    crowd: "20s-30s Williamsburg locals, not tourist-heavy",
    tips: "Gets packed by 9 on weekends. The back room is free after 11.",
    good_for: ["friends", "date (casual)", "solo"]
  },
  "Sistas' Place": {
    neighborhood: "Bed-Stuy",
    vibe: "Living room-sized jazz venue run by a legend. Feels like being invited to someone's house.",
    known_for: "jazz, world music",
    tips: "Get there 15 min early, it fills up. BYOB-friendly. Cash preferred.",
    good_for: ["date", "solo", "something different"]
  }
}
```

### How it flows to the agent

When `serializePoolForContinuation()` builds the event pool, attach venue context to each event. Instead of `{ "venue_name": "Union Pool", "venue_size": "medium" }`, the agent sees `{ "venue_name": "Union Pool", "venue_size": "medium", "venue_vibe": "Sweaty dive bar, loud bands, cheap beer", "venue_tip": "Gets packed by 9 on weekends" }`.

### How to build it

1. **Manual seed** — Write profiles for the top ~50 venues that appear most in event data. These are the ones the agent mentions most often.
2. **LLM-assisted expansion** — For venues without profiles, use a one-time extraction: feed venue name + neighborhood + event history to Claude and generate draft profiles. Human-review before adding.

## Section 2: Conversation Depth

The vision calls for conversation-as-curation — understand before recommending. The key insight: **narrow by contrasting picks, not by asking questions.**

### The pattern

Instead of:
```
User: "bushwick"
Agent: "What's the vibe? Date night, friends, solo?"
User: "friends"
Agent: [dumps 2 picks]
```

Do this:
```
User: "bushwick"
Pulse: "Bushwick's got a lot tonight — are you trying to see
       music, or more of a hang?"
User: "more of a hang"
Pulse: "There's a vinyl night at Mood Ring — good speakers,
       cheap drinks, low-key. Or Houdini Kitchen has a comedy
       open mic if you want something interactive. The Mood Ring
       thing is more of a vibe, the comedy is more of a scene."
```

The agent offered two contrasting options that serve as the clarification. "Do you want vibe or scene?" is embedded in the recommendation itself.

### What changes

Mostly **prompt engineering**, not code:

1. **Replace "ask one vibe question" with "narrow by contrasting picks."** Show two different things and let the user react.
2. **Mood vocabulary, not category vocabulary.** Users say "something chill" or "I want to dance," not "live_music" or "dj." Teach the agent to map mood to picks, not mood to category filter.
3. **Let the agent hold a hypothesis.** "Low-key in Bushwick" probably means intimate venue, vinyl night or jazz, not the big warehouse party. The curation signals (venue size, interaction format) support this reasoning.
4. **Acknowledge and build.** Every response shows the agent heard the last thing: "Gotcha, something mellower..." / "OK so not the loud stuff..."

### Tool schema

No schema changes needed. The agent already has `categories` (array) for multi-category search. "Chill" → `["jazz", "dj", "art", "film"]` + the agent uses venue_size to prefer intimate. The intelligence is in the prompt teaching the agent what moods mean in event terms.

## Section 3: The Details Experience

The initial picks hook someone, but the details response is where trust is built.

### Today vs. vision

Today: `"Gun Outfit at Union Pool tonight at 8:30. Free show, doors at 8. Post-punk duo from LA."`

Vision: `"Union Pool's a proper Williamsburg dive — dark room, loud sound, cheap tall boys. Gun Outfit is a scuzzy post-punk duo from LA touring a new record, perfect fit for this room. Free, doors 8, music at 8:30. Gets packed early on free show nights — I'd aim for 8."`

The agent leads with **the venue and the experience**, not event metadata.

### What changes

1. **Inject venue knowledge into details responses.** When `executeTool` handles details, look up venue profile and attach to result.
2. **Teach the prompt a details structure:** Lead with venue (what it feels like, what to expect) → event (who's playing, why interesting) → logistics (time, price, when to arrive) → practical tip.
3. **Consider consolidating `composeDetails` in `ai.js`.** With venue knowledge in the agent loop, the brain model can compose details inline — it has conversation context that `composeDetails` doesn't.

## Section 4: Enrichment Data Speaking Through the Agent

The serialized pool already includes `venue_size`, `source_vibe`, `scarcity`, `editorial`, `interaction_format`. The gap is the agent doesn't know how to turn metadata into language.

### Prompt-level translation guide

Add to system prompt:

```
HOW TO TALK ABOUT PICKS:
- source_vibe "discovery" → "this popped up on the underground radar"
- venue_size "intimate" → "tiny room, maybe 50 people, right up front"
- scarcity "one-night-only" → "one-off, not coming back"
- editorial: true → "a tastemaker picked this one out"
- interaction_format "interactive" → "you're not just watching, you're in it"
```

Cheap to implement, high-impact. The data is there; the agent needs to know how to wear it.

## Section 5: The Serendipity Engine

Serendipity is what makes people tell their friends about Pulse. It's not search — it's curation. "Give me comedy in Williamsburg" is search. "Show me something I didn't know I wanted" is serendipity.

### The formula

Serendipity = high quality x low expectation. An event is serendipitous when it's genuinely good AND the user wouldn't have found it themselves.

**Quality model** (does this event deserve attention?):
- Source authority: Nonsense NYC pick > Eventbrite listing
- Editorial signal: explicitly recommended by a tastemaker
- Scarcity: one-night-only > daily recurring
- Venue reputation: intimate with scene connections > generic large venue
- Temporal relevance: tonight > tomorrow > this weekend

**Surprise model** (would the user have found this without Pulse?):
- Category distance: how far from their usual preferences
- Neighborhood distance: how far from their usual haunts
- Source obscurity: email newsletter vs. public listing
- Format novelty: if they usually attend passive events, an interactive one is surprising
- Scene cross-pollination: a comedy person getting a one-night-only jazz show at a venue they love

### The "serendipity slot"

In every set of 2-3 picks, the agent can reserve one slot for the highest-serendipity event — even if it's not the best match for the explicit query. The user texts "comedy bushwick" and gets: (1) best comedy match, (2) a one-night-only interactive art show in Bushwick that they'd never search for but might love. The agent frames it naturally: "Also tonight — this weird immersive thing at a gallery on Wyckoff. Not comedy, but it's a one-time deal."

### Implementation

The existing `scoreInterestingness()` already captures quality. Add a `scoreSurprise(event, userProfile)` that measures category distance, neighborhood distance, source obscurity, and format novelty against the user's history. The serendipity score is `quality * surprise`. High quality + high surprise = magic. High quality + low surprise = reliable but boring. Low quality + high surprise = random noise.

This requires persistent user profiles (Tier 3, item 7) to work fully. But even without personalization, the serendipity slot can use global surprise signals: discovery source + one-night-only + interactive format = likely serendipitous for anyone.

## Section 6: Personalization Flywheel

The agent should get smarter about each user over time, not just within a 2-hour session.

### What you learn from the first 3 interactions

**Interaction 1 — the opening text.** More revealing than it seems:
- "williamsburg" → knows NYC neighborhoods, probably lives in/near Brooklyn
- "what's happening tonight" → spontaneous, already-out behavior
- "comedy near me" → has a category preference
- "hey" → needs onboarding, uncertain what the product does

**Interaction 2 — refinement or pivot.** The richest signal:
- "2" (details) → found something interesting. Record the category/venue/vibe.
- "more" → first set wasn't compelling. Negative signal for those categories.
- "how about comedy" → exploring but has a direction.
- No response → session died. Can't distinguish positive from negative without follow-up.

**Interaction 3 — commitment or pattern.**
- **Explorer pattern**: broad queries, neighborhood pivots, "surprise me" → bias toward serendipity, diverse picks
- **Targeted pattern**: specific categories, "more like this," details requests → bias toward depth, similar events
- **Social pattern**: "my friend is visiting," time constraints → bias toward accessibility, logistics

### The flywheel stages

**Cold start (interactions 1-3):**
City-level curation only (interestingness score, no personalization). Record neighborhood, category, time, engagement signals. Serendipity slot uses global "most interesting" pick. The default curation must be genuinely good — this is where editorial weighting does the most work.

**Warm (interactions 4-10):**
Category weighting from user profile influences pool ranking. Neighborhood affinity narrows "nearby" queries. Serendipity slot starts using surprise model. Proactive messaging begins (1x/week, highest-match event).

**Engaged (interactions 11+):**
Full personalization: pool ranked by quality x user-affinity x surprise. Venue-level preferences (went to Elsewhere 3x → recommend similar venues). Scene-level connections (likes Bushwick comedy → surface adjacent scene events). Proactive messaging calibrated to their response patterns.

**Advocate (interactions 30+):**
Referral prompts at natural moments ("your friend might like this — forward this text"). Their engagement signals improve scoring for everyone. Premium upsell signal.

### Where the profile lives

Today: ephemeral `preference-profile.js`, lost after session TTL. Target: SQLite (already in codebase for recurring patterns), keyed by hashed phone. Fields: neighborhood frequency, category frequency, time preferences, venue preferences, engagement rates, serendipity acceptance rate, proactive response patterns.

## Section 7: Yutori Enhancement

Yutori is the highest-value editorial source — discovery tier, newsletter-based, covers underground NYC events no aggregator touches.

### What's working
- Dual parsing strategy (deterministic first, LLM fallback)
- Trivia parser catches recurring patterns
- Quality gates filter non-events and low-completeness entries
- Recurrence detection and DB persistence

### What to improve

1. **Preserve editorial voice.** Keep the source's actual description — the newsletter blurb — as `editorial_note` or `source_description`. Pass to agent. Let it say "Yutori called this 'the best kept secret in Bushwick'" rather than generating a generic description.

2. **Reduce the "other" category bucket.** 41% of events land in "other." Many are classifiable — "immersive theater" is theater, "sound bath" is community, "zine fair" is art. A category mapping pass (rules-based or quick LLM reclassification at scrape time) would make these events findable.

3. **Cache raw newsletter content** alongside extracted events. Enables re-extraction if prompts improve. Extend existing `.cache.json` to include raw text.

## Section 8: Failure Modes — What Breaks First

### Scraper rot (already happening)

Source websites change markup. A source adds Cloudflare bot protection. Event count drops to 0 for that source, and if it's high-weight (Skint at 0.9), an entire category loses coverage.

**Current mitigation:** Baseline quarantine in `scrape-guard.js` detects count drift (>30% drop). Yesterday's cache serves as fallback.

**Gap:** If Skint drops from 30 events to 5 (not 0), the baseline gate doesn't trigger but coverage is materially worse. Need continuous health metrics (rolling 7-day score, extraction confidence average, consecutive failure count) and auto-disable after N failures, not just binary pass/fail.

### Proactive message fatigue (existential risk)

When proactive messaging ships, calibration is everything. Too many texts and the user sends STOP — relationship burned permanently (TCPA). Too few and they forget Pulse exists.

**Design:** Start at 1 proactive message per week, only for events with >0.8 match confidence to demonstrated preferences. Track response rate per user. If a user never responds after 4 attempts, stop sending. Increase frequency only for users who actively engage. Kill metric: if opt-out rate exceeds 3% for any proactive messaging cohort, pause and diagnose.

### Model drift in SMS composition

A model update changes behavior in subtle ways — Haiku 4.5 to 4.6 starts writing longer SMS, or stops using the contrasting-picks pattern.

**Current mitigation:** `smartTruncate` (480-char hard cap), `validateComposeSms` (pick count), `injectMissingPrices`. These are the right pattern — deterministic guardrails that don't trust the LLM.

**Gap:** No runtime quality monitoring. Sample 5% of production SMS and run LLM-as-judge eval asynchronously. Track quality score over time. Alert if 7-day rolling average drops below 3.5/5.0.

### Cold start death spiral

New users get generic, unimpressive picks on their first 2-3 interactions, don't come back, never reach the personalization payoff.

**Defense:** The cold start problem is actually a curation quality problem. If city-level interestingness scoring is good enough, even unpersonalized picks should feel better than Google. This is where editorial weighting (source vibe, scarcity, venue size) and the serendipity slot do the most work. The first pick must be great — everything else follows from that.

### Losing the editorial voice

All failure modes share a common root: the product stops feeling like it has a point of view. Scraper rot degrades coverage, proactive messages go generic, SMS quality drifts, cold start picks are bland — the user experience converges toward "Eventbrite search via text message."

The defense is continuous quality monitoring tied to the editorial standard. The 417 golden scenarios, the LLM-as-judge evals, the source health dashboard — these aren't testing infrastructure. They're the immune system that protects the editorial voice at scale.

## Section 9: Build Sequence

### Tier 1: High leverage, prompt/data changes (days)

| # | Change | Type | Impact |
|---|--------|------|--------|
| 1 | **Prompt overhaul for tastemaker voice** — translation guide for metadata fields, rewrite examples to show contrasting-picks style | Prompt | Highest ROI single change |
| 2 | **Conversation depth** — replace "ask one vibe question" with "narrow by contrasting picks," teach mood-to-category mapping | Prompt | Transforms interaction model |
| 3 | **Details structure** — lead with venue experience, then event, then logistics, then tips | Prompt | Builds trust on every details request |

### Tier 2: Data enrichment (1-2 weeks)

| # | Change | Type | Impact |
|---|--------|------|--------|
| 4 | **Venue knowledge layer** — seed 50 top venues with personality profiles, wire into pool serialization | Code + data | Enables "feel like a local" details |
| 5 | **Yutori editorial preservation** — keep source blurbs through extraction, reduce "other" bucket | Code | Better pick explanations, more findable events |
| 6 | **Serendipity slot** — reserve one pick per response for high-surprise events, using global signals initially | Code | The moment that makes users tell friends |
| 7 | **Venue learning persistence** — wire export/import to disk, load on startup | Code | Fewer geocode misses over time |

### Tier 3: Structural improvements (2-4 weeks)

| # | Change | Type | Impact |
|---|--------|------|--------|
| 8 | **Persistent taste profiles** — move preference learning from ephemeral session to SQLite | Code | Agent sees lifetime patterns, enables personalized serendipity |
| 9 | **Runtime quality monitoring** — sample 5% of production SMS, async LLM judge, 7-day rolling score with alerts | Code | Catches model drift before users notice |
| 10 | **Intraday scrape updates** — evening refresh for day-of announcements, sold-out status | Infra | Fresher data when users actually text |
| 11 | **Proactive outreach** — "thing tonight you'd love" texts for opted-in users, conservative cadence (1x/week), kill switch at 3% opt-out rate | Code + product | Closes the retention loop |
| 12 | **Source health scoring** — rolling 7-day health per source, auto-disable after N failures, graduated recovery | Code | Prevents silent coverage degradation |

### Tier 4: Platform expansion (later)

| # | Change | Type | Impact |
|---|--------|------|--------|
| 13 | **Multi-channel** — intelligence layer serves SMS today, web/WhatsApp later | Architecture | SMS is distribution; the agent is the product |
| 14 | **Multi-city** — only launch when 3+ editorial sources (weight >= 0.85) are identified for the city | Architecture + data | Don't expand until quality bar is met |
