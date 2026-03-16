# Events Analytics Section Redesign

## Problem
The analytics section on /events is buried behind a toggle, dumps 7 charts at once with no hierarchy, and includes redundant/diagnostic data that belongs on /health. The 80% use case is a quick health check ("is today's cache healthy?"), but that requires expanding a panel and scrolling through a wall of charts.

## Design

**Always visible** — no toggle. Six components in a compact layout.

### Row 1: Date + Price (two equal columns)
- **Date sparkline** — next 7-10 days only, ~50px tall, today highlighted. Drops the 30+ day sprawl.
- **Price distribution** — larger than current. Full-width stacked bar (free/paid) + bucket breakdown (Free, $1-20, $21-50, $51+, Unknown).

### Row 2: Three equal columns
- **Category distribution** — horizontal bars, colored by category. Unchanged.
- **Source coverage** — horizontal bars, sorted by count. Unchanged.
- **Neighborhood coverage** — horizontal bars, top 15 + "show more" toggle. Unchanged.

### Row 3: Full-width map
- **Event map** — full width (~400px tall) instead of sharing a row with borough bars. More visual real estate.

### Row 4: Coverage gaps
- Yellow callout, always visible when gaps exist. Unchanged.

### Removed
- **Borough distribution bars** — redundant with the map.
- **Price Coverage by Source** — diagnostic, belongs on /health.
- **Analytics toggle** — section is always open now.

## Signals addressed
1. **Coverage balance** — category bars + neighborhood bars + map show distribution at a glance.
2. **Price data quality** — enlarged price distribution card with bucket breakdown.
3. **Date spread** — compact sparkline for next 7-10 days.
