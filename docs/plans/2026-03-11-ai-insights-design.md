# AI Insights — Events Dashboard

## Problem
The events analytics section shows data but doesn't tell you where to focus. You have to mentally synthesize coverage gaps, data quality issues, and source problems across multiple charts to figure out what to work on.

## Design
Replace the "Coverage gaps" callout with an AI-generated insights card. An LLM analyzes aggregated event stats and returns 3-5 prioritized, actionable bullets.

### Flow
1. Server endpoint `GET /api/events/insights` aggregates event data into summary stats
2. Stats sent to LLM (Haiku, ~$0.001) with ops analyst prompt
3. Response cached for the scrape cycle (no re-call on page refresh)
4. Frontend renders bullets in place of coverage gaps callout

### Stats sent to LLM
- Total events, source count, neighborhood count
- Per-source: event count, avg completeness, missing fields (time, venue, neighborhood, price), "other" category rate
- Category distribution with percentages
- Neighborhood distribution (top 20 + thin neighborhoods)
- Borough distribution
- Price coverage (free/paid/unknown breakdown)
- Date spread (events per day for next 7 days)

### Prompt direction
"You're an ops analyst for Pulse, an NYC events SMS product. Here's today's event cache stats. What are the 3-5 highest-impact things the operator should fix? Consider: scraper gaps, extraction quality, category balance, neighborhood coverage, price data completeness. Be specific — name sources, neighborhoods, categories. One sentence per item."

### UI
- Same position as coverage gaps (bottom of analytics panel)
- Blue/slate card styling (distinct from the yellow warning callout)
- Loading state while fetching
- Cached response shown instantly on subsequent loads

### Cost
~$0.001 per scrape cycle via Haiku. No hot-path cost.
