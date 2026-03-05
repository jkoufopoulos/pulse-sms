# Quality Evals Design

## Problem

Current eval system measures mechanical correctness (filter persistence, neighborhood accuracy, char limits) but not product quality. 417 scenarios, 24 code evals, zero taste evaluation. Running evals takes an hour+ of manual effort and doesn't answer "is the product good?" or "what should I work on next?"

## Design

### Conversation file: `data/fixtures/quality-conversations.json`

Array of 20-30 conversations. User messages only -- no ideal responses. You're testing what Pulse actually does with realistic inputs.

```json
[
  {
    "name": "boring jazz picks",
    "turns": [
      { "user": "jazz in west village" }
    ]
  },
  {
    "name": "generic bushwick",
    "turns": [
      { "user": "bushwick" },
      { "user": "anything weird?" }
    ]
  },
  {
    "name": "one word vibe",
    "turns": [
      { "user": "vibes" }
    ]
  },
  {
    "name": "group plans",
    "turns": [
      { "user": "4 of us looking for something fun in williamsburg tonight" },
      { "user": "anything cheaper?" }
    ]
  }
]
```

Multi-turn: turns played sequentially against the same session. Judge scores each Pulse response independently.

### Runner: `scripts/run-quality-evals.js`

1. For each conversation: clear session, replay turns against live pipeline (`/api/sms/test`)
2. For each Pulse response: one Haiku judge call with rubric-only prompt:

```
You are evaluating an SMS nightlife recommendation bot called Pulse.
Pulse is supposed to feel like texting a cool friend who always knows what's
happening tonight -- not a search engine, not a customer service bot.

The user texted: {user_message}
Pulse responded: {actual_response}

Score each dimension 1-5:

- Voice (1-5): 5 = sounds like a friend who actually goes out, uses natural
  language, has personality. 1 = robotic, formal, "I'd be happy to help",
  bullet-point listing.

- Picks (1-5): 5 = recommendations feel genuinely curated and interesting,
  the kind of thing a knowledgeable local would suggest. 1 = generic, obvious,
  feels like the first 3 results from a search engine.

- Density (1-5): 5 = every word earns its place, punchy, respects that this
  is SMS. 1 = padded with filler, unnecessary preambles, verbose.

Respond in JSON:
{"voice": N, "picks": N, "density": N, "note": "one sentence explaining the weakest score"}
```

3. Save report to `data/reports/quality-eval-{timestamp}.json`

Cost: ~$0.01-0.02 for 30 conversations. Runtime: ~15-30 seconds.

### Report format

```json
{
  "timestamp": "2026-03-05T...",
  "base_url": "http://localhost:3000",
  "judge_model": "claude-haiku-4-5-20251001",
  "summary": {
    "conversations": 30,
    "avg_score": 3.6,
    "voice": 4.1,
    "picks": 3.2,
    "density": 3.4
  },
  "conversations": [
    {
      "name": "boring jazz picks",
      "avg_score": 2.0,
      "turns": [
        {
          "user": "jazz in west village",
          "response": "Here are some jazz events...",
          "scores": { "voice": 2, "picks": 2, "density": 2 },
          "note": "Reads like a database query result, no personality or curation."
        }
      ]
    }
  ]
}
```

### CLI output

```
Quality eval: 30 conversations, avg 3.6/5
  Voice: 4.1  Picks: 3.2  Density: 3.4
  Worst: "boring jazz picks" (2.0), "generic bushwick" (2.3)
  Browse: http://localhost:3000/eval-quality
```

### Browse page: `/eval-quality`

- Dimension averages at top with trend sparkline (last 10 runs)
- Conversations sorted worst-first
- Each conversation card shows:
  - User message and actual Pulse response side by side
  - Per-dimension scores with color coding (1-2 red, 3 yellow, 4-5 green)
  - Judge's note
- Filter by dimension (e.g. "show me everything where picks < 3")
- Report selector dropdown to compare across runs

### npm script

```json
"eval:quality": "node scripts/run-quality-evals.js"
```

Flags: `--url` (default localhost:3000), `--concurrency` (default 5).

## What this does NOT include

- Golden/ideal response comparison (add later if rubric alone isn't specific enough)
- Synthetic user swarm
- Integration with existing code evals
- Category/neighborhood coverage tracking
- Regression detection or CI gating

## User work required

Spend 20 minutes writing 20-30 conversation inputs in `quality-conversations.json`. Just the user messages -- things you'd actually text. Mix of:
- Single neighborhood ("bushwick", "les")
- Category requests ("jazz tonight", "free comedy")
- Vibes ("anything weird", "chill spot")
- Multi-turn (neighborhood -> filter -> details -> more)
- One-worders ("vibes", "techno")
- Group/context ("4 people, under $20 each")

## Future additions (not in scope now)

- **Golden responses**: Add `ideal` field to turns for tighter taste anchoring
- **Synthetic user swarm**: LLM-generated conversations for discovering failure modes you didn't think of
- **Flow dimension**: 4th scoring dimension for multi-turn conversational naturalness
- **Discovery dimension**: 5th dimension for "would you have found this yourself"
- **Trend alerts**: Flag when a dimension drops >0.5 across runs
