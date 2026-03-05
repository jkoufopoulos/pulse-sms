# Writing Quality Eval Conversations

## What to do

Open the simulator (`/test`) and text Pulse naturally. For each conversation, save just the user messages in `data/fixtures/quality-conversations.json`. You're building a set of 20-30 realistic inputs that cover how people actually text.

## Format

```json
[
  {
    "name": "short descriptive name",
    "turns": [
      { "user": "what you texted" },
      { "user": "your follow-up" }
    ]
  }
]
```

Single-turn is fine. Multi-turn is better for testing flow.

## Mix to aim for (20-30 total)

### Neighborhoods (5-8)
- A popular one: "east village", "williamsburg"
- A quiet one: "sunnyside", "gowanus"
- A borough: "queens", "brooklyn"
- Misspelled or casual: "wburg", "les", "bk"

### Categories (5-8)
- Bare category: "jazz", "comedy", "techno"
- Category + neighborhood: "free comedy in bushwick"
- Category + vibe: "something chill tonight"
- Niche: "trivia", "open mic", "drag"

### Vibes and context (3-5)
- Vague: "vibes", "what's good", "entertain me"
- Group: "4 of us, fun tonight"
- Budget: "free stuff in greenpoint"
- Time: "anything after 10pm"

### Multi-turn flows (5-8)
- Browse + filter: "bushwick" -> "anything weird?"
- Browse + details: "les" -> "2"
- Browse + more: "williamsburg" -> "more"
- Filter stack: "comedy" -> "free ones" -> "in brooklyn"
- Pivot: "jazz in west village" -> "actually bushwick" -> "techno instead"
- Skeptic: "bushwick" -> "those sound basic" -> "anything more underground"

### Edge cases (2-3)
- One word: "vibes"
- Emoji or slang: "what's poppin"
- Off topic then back: "how's the weather" -> "ok fine comedy tonight"

## Tips

- Text like a real person, not a QA tester
- Don't optimize for coverage -- text what you'd actually text
- If a response is great, still include it (calibrates the high end)
- If a response is terrible, definitely include it
- 20 conversations is enough to start. Add more over time.
