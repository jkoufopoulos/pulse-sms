# Pulse — Product Vision

**"Feel like a local."**

## The Thesis

Google indexes event pages but doesn't understand them. LLMs have knowledge but not today's data. Aggregators like DoNYC and Eventbrite have today's data but make you do the filtering across a wall of listings.

Pulse is the only product that combines **structured real-time event data + editorial taste + conversational intelligence.** An AI tastemaker that's already read every listing across dozens of sources today, and tells you what's actually worth your night.

This is a capability that didn't exist before: an agent with deep, structured knowledge of what's happening right now — not cached in model weights, not buried in 10 blue links, but assembled fresh every day from the sources that locals actually read.

## Why Google Structurally Can't Do This

Google indexes the *existence* of comedy venues in Brooklyn. They have not indexed what is happening at those venues *tonight.* Try it: Google "comedy brooklyn tonight." You get venue pages, Yelp reviews from 2019, a Timeout listicle from last month, and maybe 2-3 Eventbrite links that may or may not be current.

Three structural forces prevent Google from competing here:

**Advertiser neutrality.** Google can't rank a free DIY show in someone's backyard above a $200 Broadway ticket. Their business model requires equal treatment of paid listings. Pulse's entire value proposition is "we're biased toward interesting."

**Structured data dependency.** Google requires `schema.org/Event` markup or feeds from platforms. The most interesting events in NYC — the Nonsense NYC picks, the Sofar Sounds secret locations, the Yutori curated newsletters — don't have structured data. They exist as unstructured prose in emails and HTML pages that require LLM extraction. Google won't build bespoke extraction pipelines for 22 niche NYC sources.

**Freshness gap.** Google's index updates on a web-crawl cadence. Pulse's daily scrape with newsletter extraction means it has tonight's events from tastemaker sources before Google's crawler even sees the HTML. For email-based sources (Yutori, Nonsense NYC, Screen Slate), Google never sees the content at all — it lives in inboxes, not on the public web.

## Who It's For

NYC transplants and neighborhood explorers. People who've lived here 1-5 years, have taste but not connections. They *want* to find the underground comedy show, the warehouse party, the free jazz trio in a living room — but they don't know which 22 sources to read every morning, and they're not going to start.

Pulse makes them feel like they've lived here for 10 years.

## What "Tastemaker AI" Means

Pulse doesn't list options. It makes opinionated recommendations with reasons, like a plugged-in friend.

**An aggregator says:**
> Jazz at Sistas' Place. 9pm. $15. Bed-Stuy.

**Pulse says:**
> Sistas' Place is a living room-sized venue run by a jazz legend — incredible players, intimate room. Get there by 8:45, it fills up fast. No food but Peaches is around the corner if you want to eat first. $15 at the door.

The difference:
- **Why this pick** — not just what it is, but why it's interesting tonight specifically
- **Venue context** — what the room is like, when to show up, what to expect
- **Opinionated stance** — "this is the right room for this" is a judgment call, not a filter match
- **Practical local knowledge** — "gets packed by 9" is something only a regular would know

This is what no search engine or aggregator can do. It requires an agent that has both the data *and* a point of view.

## Conversation as Curation

The interaction model isn't search then results. It's **conversation then understanding then recommendation.**

The agent is curious about you before it recommends. Not in a "fill out this profile" way — in a "what are you in the mood for tonight?" way. A real friend doesn't rattle off options. They ask "are you trying to chill or go out out?" first.

A great Pulse exchange:

```
User: "what's good tonight"
Pulse: "Depends — are you trying to discover something new,
       or do you have a neighborhood in mind?"
User: "i'm in bed-stuy, want to go out but nothing too loud"
Pulse: "There's a jazz trio at Sistas' Place tonight — intimate
       room, incredible players, $15. Starts at 9. Or if you
       want something more low-key, Dynaco has a vinyl night
       with natural wine. Which sounds better?"
User: "the jazz thing"
Pulse: "Good call. Sistas' Place is a living room-sized venue
       run by a jazz legend — get there by 8:45, it fills up
       fast. No food but Peaches is around the corner if you
       want to eat first. $15 at the door."
```

Notice what happened:
- Pulse asked one narrowing question instead of dumping picks
- The user gave mood + constraint ("nothing too loud"), not a category filter
- Pulse offered two contrasting vibes with reasons, not three similar listings
- The details response added local knowledge
- The whole thing felt like a conversation, not a query

The agent's job is to **reduce the paradox of choice**, not present it. Two good contrasting options are better than three similar ones. One strong opinion beats a balanced list.

## Implicit Personalization

Over a conversation and across sessions, the agent pays attention:

- **Vibe preferences**: "nothing too loud" means prefer intimate venues next time
- **Price sensitivity**: keeps asking for free stuff, so weight free events higher
- **Neighborhood patterns**: always texts about Bushwick and Bed-Stuy, so this is a Brooklyn person
- **Category affinity**: picked jazz twice, skipped electronic, so lean into live music
- **Decision style**: picks fast, so give fewer options; asks lots of questions, so give more context

This isn't a settings page. It's the agent paying attention — the same way a good bartender remembers what you ordered last time.

## The Knowledge Advantage

For the tastemaker to be trustworthy, the data layer has to be genuinely better than what a user could assemble themselves.

**What "best event intelligence in NYC" looks like:**
- **Broad source coverage** — every comedy club calendar, gallery opening lists, restaurant event pages, popup markets, free museum nights. Not just aggregators.
- **Venue intelligence** — not just "Union Pool" but "dive bar, 200 capacity, loud, cheap drinks, Williamsburg staple, gets packed by 9 on weekends." This is the "feel like a local" data that no aggregator has.
- **Intraday freshness** — day-of announcements, cancellations, sold-out status. "That show sold out but there's a similar one at..."
- **Temporal knowledge** — "Saturday night in LES is a zoo" / "Tuesday is the best night for comedy because all the headliners drop in to test material"
- **Relational knowledge** — "if you liked that, the same promoter is doing something next week" / "this DJ also plays the Nowadays party on Sundays"

The tastemaker voice is the surface. The knowledge graph is the foundation.

## Growth Model

No ads. No SEO. The product grows the way a great bar grows — word of mouth.

Someone texts Pulse, gets a great pick, goes, tells their friend "I found this through a texting thing," friend texts Pulse. The SMS format is the growth loop: inherently shareable ("just text this number"), zero friction to try, and the first interaction proves the value immediately.

If the first pick is great, you have a user. If it's mediocre, you don't.

## Monetization (Later)

- **Free tier**: a few conversations per week
- **Paid tier** ($5-10/month): unlimited, proactive alerts ("there's a thing tonight you'd love"), priority for sold-out/limited events
- **Never**: selling user data, sponsored placements disguised as recommendations

The trust of the tastemaker is the entire product. The moment a user suspects a pick is paid placement, it's over.

## Why the Agent Loop IS the Product

Most event discovery products are built as data pipelines with a UI on top: scrape, store, index, search, display. The LLM is bolted on as a "natural language interface." Pulse is built the other way: the agent loop IS the product. The data pipeline feeds the agent. The agent's tool-calling decisions ARE the ranking algorithm. The conversation history IS the recommendation engine.

This means every improvement to the underlying model directly improves the product. Better tool-calling reliability means better intent classification means better recommendations. Better instruction following means more reliable SMS composition. Better long-context performance means richer conversation history means more natural multi-turn refinement.

Pulse's ceiling is determined by model capability, not engineering effort. Every other event discovery product's ceiling is determined by how good their search algorithm is or how clean their UI is. Pulse's ceiling is determined by how well the agent understands "I'm bored and it's raining" and turns it into two perfect picks.

## SMS as Strategic Distribution

SMS isn't a fallback for not having an app — it's the choice that enables the product's core retention mechanism.

**Why SMS wins:**
- **Zero friction** — no install, no account, no login. Text a number and you're using the product.
- **98% open rate** — the message sits in a thread the user already checks every day.
- **Bidirectional** — the user can text Pulse, and Pulse can text the user. That second direction (proactive outreach) is the entire retention model.
- **Forces decisiveness** — the 480-character cap means Pulse can't hedge with 20 options. It picks 1-2 and stands behind them. This builds trust faster than any app could.

**The proactive loop:** Without an app icon on someone's home screen, Pulse has no passive reminder that it exists. The conversation thread goes cold after the 2-hour session TTL. Proactive alerts — "there's a thing tonight you'd love" — are what close the retention loop. One to two proactive messages per week, tightly targeted, is the right cadence. Too many and the user sends STOP (permanent, TCPA-compliant severance). Too few and they forget Pulse exists.

## Strategic Sequencing

1. **Now** — Sharpen the editorial voice and taste. Make the agent opinionated, curious, and knowledgeable. The SMS-only constraint forces this discipline.
2. **Next** — Expand the knowledge graph. More sources, venue intelligence, intraday updates. The recommendations are only as good as what the agent knows.
3. **Then** — Personalization and proactive outreach. Once there are users and interaction data, the agent learns taste and reaches out when something matches.
4. **Eventually** — Multi-channel. The intelligence layer serves SMS, web, WhatsApp, whatever. SMS is the distribution channel; the agent is the product.

## Success Metrics

### 6 Months: Product-Market Fit Signal

- 500 weekly active texters in NYC
- 30% weekly retention (of users who text in week N, 30% text again in week N+1)
- Curation quality score of 4.0/5.0 on LLM-as-judge evals across 500+ real conversations
- Proactive messaging shipped and driving measurable return visits

The critical question at 6 months: **do users come back without being prompted?** Track organic return (user-initiated) and prompted return (responds to proactive alert) separately. The ratio tells you whether the product has pull or just push.

### 2 Years: Category Leadership

- 10,000 weekly active texters across 2-3 cities
- Paid tier launched ($5-10/month) with 5% conversion from free users
- Sub-2-second latency at p95 for SMS responses
- The taste graph (venue-scene-promoter relationships) is self-reinforcing: each new user's behavior improves recommendations for everyone

## Design Principles

- **Opinionated over comprehensive** — recommend 1-2 great things, don't list 10 options
- **Conversation over query** — understand before recommending
- **Local knowledge over metadata** — "gets packed by 9" matters more than "200 capacity"
- **Trust over growth** — never compromise recommendations for monetization
- **Taste over filters** — the agent has a point of view, not just a matching algorithm
- **Serendipity over relevance** — the best pick is something they didn't know they wanted
