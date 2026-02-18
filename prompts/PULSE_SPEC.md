# Pulse SMS Bot — Product Spec

## What Pulse Does

Pulse is an SMS bot that recommends NYC events and nightlife. Users text a neighborhood, get curated picks, and can drill into details or explore more options — all via text message.

## Core Interaction Model

### Message Format
- **Picks message**: Intro line → numbered picks (1–3) with blank lines between → reply footer. 480-char hard limit.
- **Links**: Always sent as **separate follow-up messages** (one per pick), never inline.
- **Details**: Single natural paragraph, max 320 characters, with link at the end. Vibe-first, then time, price, URL.
- **Tone**: Like a friend who knows the city — warm, opinionated, concise. Not robotic. NYC shorthand OK.

### User Commands
| Input | Behavior |
|-------|----------|
| Neighborhood name | Returns 1–3 numbered picks with links |
| Number (1, 2, 3) | Returns details on that pick from the active session |
| `more` / `what else` / `next` | Returns additional picks in the same neighborhood (no repeats) |
| `free` / `free stuff` / `anything free` | Filters to free events only in the current neighborhood |
| Category keyword | Filters by type: comedy, live music, art, nightlife, jazz, DJ, theater, etc. |
| `yes` / `yeah` / `sure` / `bet` | Accepts travel nudge suggestion |
| `no` / `nah` | Declines travel nudge suggestion |
| `hey` / `hi` / `yo` / `sup` | Greeting → "text a neighborhood" |
| `thanks` / `thx` / `ty` | Sign-off |
| `bye` / `later` / `peace` / `gn` | Sign-off |
| `hello??` / `??` / `you there?` | Impatient follow-up → acknowledges delay |
| `help` / `?` | Help text |

### Slang & Abbreviations
- **EV** → East Village
- **LES** → Lower East Side
- **BK** → Brooklyn (too broad — asks to narrow)
- **wburg** → Williamsburg
- **UWS** / **UES** → Upper West Side / Upper East Side
- **LIC** → Long Island City
- **fidi** → Financial District
- **the village** → West Village
- **the heights** → Washington Heights

### Landmarks → Neighborhoods
prospect park → Park Slope, central park → Midtown, mccarren park → Williamsburg, tompkins square → East Village, highline → Chelsea, barclays center → Downtown Brooklyn, lincoln center → Upper West Side, bam → Fort Greene, industry city → Sunset Park

### Subway Stops → Neighborhoods
"L at Bedford" → Williamsburg, "F at 2nd ave" → East Village, "14th street" → Flatiron

## Supported Neighborhoods (36)

### Manhattan (17)
East Village, West Village, Greenwich Village, Lower East Side, Chelsea, SoHo, NoHo, Tribeca, Flatiron/Gramercy, Midtown, Hell's Kitchen, Upper West Side, Upper East Side, Harlem, East Harlem, Washington Heights, Financial District

### Brooklyn (15)
Williamsburg, Bushwick, Greenpoint, Park Slope, Downtown Brooklyn, DUMBO, Crown Heights, Bed-Stuy, Fort Greene, Prospect Heights, Cobble Hill/Boerum Hill, Gowanus, Red Hook, Brooklyn Heights, Sunset Park

### Queens (4)
Astoria, Long Island City, Jackson Heights, Flushing

### Boroughs (Too Broad → Asks to Narrow)
- `brooklyn` / `bk` → lists Brooklyn neighborhoods
- `queens` / `qns` → lists Queens neighborhoods
- `manhattan` / `nyc` → lists Manhattan neighborhoods

### Unsupported but Recognized (suggests nearby)
Bay Ridge, Bensonhurst, Brighton Beach, Coney Island, Ditmas Park, Flatbush, Sheepshead Bay, Borough Park, Woodside, Sunnyside, Forest Hills, Mott Haven, Roosevelt Island

## Neighborhood Density

### High (always have events)
East Village, Williamsburg, Bushwick, Lower East Side, Chelsea, SoHo, Greenpoint, Park Slope, Crown Heights, Bed-Stuy, Downtown Brooklyn, Midtown, Hell's Kitchen

### Medium (events most nights)
West Village, Greenwich Village, NoHo, Tribeca, Flatiron, Harlem, Fort Greene, Prospect Heights, Cobble Hill, Gowanus, Astoria, Upper West Side, Upper East Side

### Low (often trigger travel nudge or thin cache)
Red Hook, DUMBO, Brooklyn Heights, Sunset Park, East Harlem, Washington Heights, Long Island City, Jackson Heights, Flushing, Financial District

## Event Categories
`art | nightlife | live_music | comedy | community | food_drink | theater | other`

## Special Flows

### Travel Nudge (Not Enough Local Events)
When a neighborhood has few/no events tonight:
```
"Hey not much going on in [X] tonight... would you travel to [Y] for [vibe]?"
```
- If user says **yes** → serve picks from suggested neighborhood
- If user says **no** → graceful sign-off, leave door open
- If user **counter-suggests** ("actually how about park slope") → serve that instead
- Never fires when user asked for a specific category (e.g., "comedy in the village")

### Tomorrow Fallback
When a neighborhood has no events tonight but has events tomorrow:
- Lead with "Nothing tonight in [X], but tomorrow:" and use tomorrow framing
- Offer to try a different neighborhood for tonight

### Perennial Picks Supplement
When a neighborhood has fewer than 3 events (thin cache):
- Supplement with perennial venue recommendations (bars, clubs that are always good)
- Common in: Washington Heights, Jackson Heights, Financial District

### Event Exhaustion ("more" with nothing left)
- Last batch: closing line drops "MORE for extra picks"
- After exhaustion: "That's all I've got in [X]! [Nearby neighborhood] is right next door — want picks?"
- Never repeats previously shown picks

### Free Events
- Filters to free events only
- If none in requested hood → searches nearby neighborhoods
- If still none: "Nothing free near [X] tonight..."

### Category Filter
- Filters by category keyword
- If none locally → searches nearby for that category
- If still none: "Not seeing any [category] near [X]..."

### Orphaned Commands
- Number / `more` / `free` with no active session → "I don't have any recent picks — text me a neighborhood"

### Unsupported Neighborhood
- Acknowledges it's not covered yet
- Suggests 1–2 nearby supported neighborhoods

### Borough-Level Input
- Recognizes as too broad, lists supported neighborhoods in that borough

## Session Behavior
- Sessions last 2 hours, then expire silently
- Switching neighborhoods replaces the active picks — detail requests always map to the most recent neighborhood
- MORE tracks all previously shown picks and never repeats them
- Travel nudge stores a pending suggestion; cleared when user starts a new neighborhood request
