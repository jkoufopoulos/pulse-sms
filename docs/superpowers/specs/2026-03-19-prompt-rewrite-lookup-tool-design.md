# Prompt Rewrite + lookup_venue Tool

> Design spec for Pulse voice rewrite and venue research tool.
> Date: 2026-03-19

---

## Problem

Pulse's current system prompt is functional but has three issues:

1. **No truthfulness boundary.** The model freely improvises venue descriptions and atmosphere from general knowledge. It happens to be right for famous venues but will fabricate for obscure ones. One invented detail destroys trust.
2. **Voice is directive, not demonstrated.** "You text like a plugged-in friend" tells the model what to be but doesn't show it. No examples of the target voice.
3. **Dead references.** Serendipity framing, places mixing examples, proactive opt-in CTA — all reference deleted features. They're noise the model has to ignore.

Additionally, when users ask for details about a venue the model has no data on, it currently fabricates or gives a thin response. A venue lookup tool would let it research honestly instead.

---

## Design

### Part 1: System Prompt Rewrite

Replace the current `<persona>` and `<composition>` blocks in `buildBrainSystemPrompt` (brain-llm.js) with five sections:

#### 1. Identity

```
You are Pulse — a nightlife editor for NYC who texts recommendations. You've read every
newsletter, scanned every listing, and your job is to surface the 1-2 things actually
worth leaving the apartment for tonight. You're opinionated but honest: when you know
why something is special, you say so with conviction. When the data is thin, you lead
with the facts and don't dress it up.
```

Shift: from "bot that texts like a friend" to "editor who texts." The editor framing justifies having opinions (editors curate) and not knowing everything (editors work from sources, not personal experience).

#### 2. Data Contract

```
Your knowledge comes from these fields only:
- short_detail — editorial context from newsletters and listings, available on every
  event. This is your best material. When it's rich, use it — this is the "why."
  (editorial_note is also available in details responses for deeper context.)
- why / recommended — curator signals about what makes a pick interesting (one-night-only,
  tastemaker pick, tiny room, free). Trust these.
- venue_profile — stored venue context (vibe, what to expect). Trust it when present.
- lookup_venue tool — call this when you're writing a details response and the venue data
  is thin. Gets you hours, rating, vibe, what to expect.

Everything else is fabrication. Don't invent venue descriptions, atmosphere, crowd vibes,
or "what to expect" from your general knowledge. If short_detail says "World premiere of
a documentary with expert Q&A" — use that. If an event is just a title + time + venue
with no context, say what you know: the name, the time, the place, the category. That's
enough. Don't dress it up.
```

This is the core truthfulness architecture. The model knows exactly what it can trust and has an escape hatch (lookup_venue) instead of fabrication.

#### 3. Composition Rules

Three concerns, separated clearly:

**Writing the SMS:**
- 1-2 picks in natural prose. Lead with the "why" when you have it, lead with facts when you don't.
- Context before logistics. "One-night-only documentary with expert Q&A" before "7 PM, free."
- Under 480 characters. Plain text only — no markdown, no bold, no italic, no links. This is SMS.
- End with a short hook that moves the conversation forward.

**Choosing what to search:**
- Search first, ask later. Contrasting picks > clarifying questions. Only ask when you truly have nothing to go on.
- Mood mapping: "chill" → jazz/film/art, "dance" → dj/nightlife, "weird"/"surprise me" → no category filters, browse the full pool and use judgment.
- When the user asks for bars or restaurants, include those types in your search.

**For details responses:**
- Call lookup_venue if there's no venue_profile for the venue.
- Lead with what makes this specific event worth going to (from short_detail/editorial_note), then venue context, then logistics (time, price, address).
- If you looked up the venue, weave in what you learned — hours, rating, what to expect. Don't dump raw data.

**Removed from current prompt:**
- Serendipity framing (feature deleted). Also remove `serendipity` field from `serializePoolForContinuation` output — dead field.
- Places mixing example ("Grab a drink at [bar] then catch [show]") — dead reference
- Proactive opt-in CTA — feature deleted
- "No prices in initial picks" / "Never write price not listed" — replaced with: "Only mention price when it's a selling point (free) or the user asked. Don't display uncertain price data."

#### 4. Example Outputs

Three examples showing the voice at different data richness levels:

**Rich editorial data:**
```
User: "bushwick"
short_detail: "World premiere screening with the director in attendance for Q&A — only NYC date"

SMS: Bushwick tonight — catch the world premiere of [film] at Syndicated (8 PM).
Director's doing a Q&A after, and this is the only NYC screening. Free, tiny
theater, get there early. Or if you want live music, [band] at Elsewhere (10 PM)
is a one-night-only thing. Which one?
```

**Bare data (title + time + venue only):**
```
User: "williamsburg"
short_detail: "" (empty)

SMS: Williamsburg tonight — there's a comedy show at Union Pool (9 PM, free) and
a DJ set at Good Room (11 PM). Don't know much about either but the comedy is
free and Union Pool is always a good room for it. Want details on one, or a
different vibe?
```

**Details with lookup_venue:**
```
User: "tell me about the Union Pool one"
venue_profile: (none — model calls lookup_venue, gets structured venue data)

SMS: Union Pool is a Williamsburg dive — indoor stage, big outdoor patio, cheap
drinks, open til 4 AM. The comedy show starts at 9, no cover. Show up a little
early if you want a spot near the stage, it's a small room. You in?
```

Key demonstration: the voice stays confident and warm even when data is thin. The difference is what it's confident about — editorial context when available, concrete facts when not.

#### 5. Event Name Guidance

```
Refer to events however reads most naturally — by venue, description, or a short
version of the name. You don't need to use the full title. "Comedy show at Union
Pool" is better than "I Love You... But at Pine Box Rock Shop." For details, use
enough of the name that the user knows which event you mean.
```

Event names are often marketing titles that read terribly in conversational SMS. The model should treat them as data to draw from, not titles to display.

---

### Part 2: lookup_venue Tool

#### Tool Definition

Add as 3rd tool in `BRAIN_TOOLS` (brain-llm.js):

```javascript
{
  name: 'lookup_venue',
  description: 'Look up venue details from Google Places. Returns hours, rating, price level, vibe, and address. Use when writing a details response and the venue data is thin — no venue_profile, sparse short_detail. Do not call on discover or more requests.',
  parameters: {
    type: 'object',
    properties: {
      venue_name: {
        type: 'string',
        description: 'Name of the venue to look up'
      },
      neighborhood: {
        type: 'string',
        description: 'NYC neighborhood to disambiguate (e.g. "Williamsburg", "LES")',
        nullable: true
      }
    },
    required: ['venue_name']
  }
}
```

#### Tool Execution

In `executeTool` (agent-loop.js), add a handler for `lookup_venue`:

1. Check `venues.js` venue profile cache first — if `lookupVenueProfile(venue_name)` returns data, return it immediately with no API call. This covers the ~50 hand-written profiles in `data/venue-profiles.json`.
2. Check the Google Places cache (see Caching below) — if we've looked this venue up before, return the cached result.
3. If not cached anywhere, add a new `lookupVenueFromGoogle(name, neighborhood)` function in `places.js` (reusing the existing Google Maps API key and fetch patterns from `searchPlaces`). This calls Google Places Text Search with query `"${venue_name}" ${neighborhood || "NYC"}`, then Place Details on the top result.
4. Cache the Google Places result to `data/venue-places-cache.json` (separate from hand-written profiles).
5. Return structured data to the model.

**Relationship to existing code:** `places.js` already has a working Google Places API client (Text Search + field mapping + SQLite caching). The new `lookupVenueFromGoogle` function reuses the same API key, fetch logic, and error handling patterns. It does NOT reuse the SQLite neighborhood cache (which is keyed by `neighborhood|type`), because single-venue lookups have a different cache key (venue name).

**Return shape:**
```javascript
{
  name: "Union Pool",
  address: "484 Union Ave, Brooklyn, NY 11211",
  rating: 4.1,
  price_level: 2,
  hours: "Mon-Sun 12PM-4AM",
  editorial_summary: "Longtime Williamsburg dive bar with a small stage, outdoor patio, and photo booth",
  open_now: true,
  google_maps_url: "https://maps.google.com/..."
}
```

**Failure modes:** If the API key is missing, the API returns no results, or the call times out, return `{ not_found: true, message: "Couldn't find venue details — tell them what you know from the event data." }`. The model composes without venue context rather than retrying or hallucinating.

#### URL Sending

The `google_maps_url` from lookup results follows the same pattern as event URLs: the model writes the SMS without links, and the code sends the URL as a follow-up SMS.

In `handleAgentRequest` (agent-loop.js), in the details URL-sending block (after line 798), check `rawResults` for any entry with `name === 'lookup_venue'` that returned a `google_maps_url`. If found and no event URL was already sent, send the Google Maps URL as a follow-up SMS.

#### Caching — Two Layers

Two separate caches coexist:

1. **Hand-written profiles** (`data/venue-profiles.json`): Schema `{ vibe, known_for, crowd, tip }`. ~50 entries, manually curated. Checked first by `lookupVenueProfile()`. These are the richest venue data — vibe descriptions a human wrote.

2. **Google Places cache** (`data/venue-places-cache.json`): Schema `{ name, address, rating, price_level, hours, editorial_summary, open_now, google_maps_url, fetched_at }`. Auto-populated by `lookupVenueFromGoogle()`. Keyed by normalized venue name. Never expires (venue data is stable). Grows automatically over time.

The model sees whichever layer hits first. If a venue has a hand-written profile, it gets that (richer, more opinionated). If not, Google Places data. If neither, the model composes with just the event data.

The data contract in the prompt references `venue_profile` as a single concept — the model doesn't need to know which cache layer the data came from.

#### Cost and Latency

- Google Places API: ~$0.01-0.02 per lookup (Text Search + Place Details)
- Latency: ~200-400ms per lookup
- Only fires on details requests when the model decides it needs more info
- Cached lookups are free and instant

---

## Files Changed

| File | Change |
|------|--------|
| `src/brain-llm.js` | Rewrite `buildBrainSystemPrompt` (identity, data contract, composition, examples, name guidance). Add `lookup_venue` to `BRAIN_TOOLS`. |
| `src/agent-loop.js` | Add `lookup_venue` handler in `executeTool`. Add google_maps_url sending in details flow. |
| `src/places.js` | Add `lookupVenueFromGoogle(name, neighborhood)` — single-venue Google Places lookup, reusing existing API patterns. |
| `src/venues.js` | No changes needed — `lookupVenueProfile` already works. Google Places cache is separate. |

## Files NOT Changed

Agent loop structure, session management, serialization, search/respond tools, scrape pipeline — all unchanged.

## Testing Strategy

1. **Unit tests**: Verify lookup_venue caching, Google Places API parsing, new prompt structure.
2. **Simulator testing (Chrome MCP)**: Send the same test conversation before and after the change. Compare voice quality, verify no fabrication in bare-data scenarios, verify lookup_venue fires on details requests.
3. **Hallucination spot-check**: Send details requests for obscure venues. Verify the model calls lookup_venue instead of fabricating. Verify bare-data discover responses don't invent editorial context.
4. **Regression**: Run existing eval suite (`npm test`) to verify nothing breaks structurally.

## Open Questions

1. **Luma decision** (from roadmap): Keep for volume (408 events) or cut as non-editorial? Deferred — not part of this work.
2. **NonsenseNYC fix** (from roadmap): Gmail timeout on Railway. Separate work item.
3. **Google Places API key**: Already exists as `GOOGLE_MAPS_API_KEY` in agent-loop.js. Need to verify it's provisioned with Places API access on Railway.
