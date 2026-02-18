# Generate Multi-Turn SMS Eval Scenarios for Pulse

You are generating realistic multi-turn SMS conversation scenarios to test **Pulse**, an SMS bot that recommends NYC events and nightlife. These scenarios will be used as evaluation cases to catch regressions and edge cases.

## Instructions

Complete this task in two steps. Do both steps in a single response.

### Step 1: Coverage Audit

Read `PULSE_SPEC.md` and analyze Pulse's coverage surface:

1. **Neighborhood density tiers** — Classify every supported neighborhood as high / medium / low expected event density based on the spec and your knowledge of NYC nightlife. This determines which neighborhoods should trigger happy paths vs. travel nudges.

2. **User intents** — List every distinct user intent Pulse handles (e.g., `neighborhood_query`, `detail_request`, `more_command`, `free_filter`, `category_filter`, `compound_request`, `greeting`, `thanks`, `bye`, `impatient_followup`, `nudge_accept`, `nudge_decline`, `borough_name`, `unsupported_neighborhood`, `off_topic`, `gibberish`).

3. **Coverage gaps** — Identify ambiguities, missing edge cases, or flows the spec doesn't address. Examples: time-of-day requests ("late night stuff"), group size ("party of 8"), compound filters ("free comedy in chelsea"), vibe requests ("something chill"), date-specific requests ("this Saturday"), session expiry after 2 hours, typos in neighborhood names.

Include the audit in your output as the `coverage_audit` field.

### Step 2: Generate 20 Eval Scenarios

Using the audit to guide your coverage, generate exactly **40 multi-turn scenarios** across these categories:

| Category | Count | Focus |
|----------|-------|-------|
| `happy_path` | 12 | Core flows that must always work |
| `edge_case` | 12 | Inputs that are valid but tricky to handle |
| `poor_experience` | 10 | Situations where Pulse has limited data — test graceful degradation |
| `abuse_off_topic` | 6 | Inputs that are invalid or adversarial |

Keep scenarios varied in length. Some should be short (~4 turns, 1-2 user messages) to test single interactions. Others should be longer (6-10 turns) to test multi-step flows.

#### Scenario Requirements

Each scenario is a JSON object with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Short label, e.g., "Happy path: first-time EV user" |
| `category` | enum | `happy_path`, `edge_case`, `poor_experience`, `abuse_off_topic` |
| `turns` | array | 3–10 turn objects: `{ sender: "user" | "pulse", message: "..." }` |
| `testing` | string | One sentence: what this scenario evaluates |
| `expected_behavior` | string | What correct Pulse behavior looks like |
| `failure_modes` | string[] | 2+ ways this could go wrong |

#### Mandatory Coverage

Your 20 scenarios **must** include at least one scenario for each of these:

**Happy paths:**
- [ ] First-time user: neighborhood → picks → detail request → sign-off
- [ ] Category filter (comedy, live music, art, jazz, DJ)
- [ ] Free events filter (user says "free" after initial picks)
- [ ] "More" command returning fresh picks (no repeats, re-numbered from 1)
- [ ] Slang / abbreviation resolution (EV, BK, wburg, LES, etc.)
- [ ] Multi-neighborhood exploration in one session (detail request maps to correct neighborhood after switch)

**Edge cases:**
- [ ] Landmark or subway stop instead of neighborhood (union square, L at Bedford)
- [ ] Vague opener with no neighborhood ("anything tonight?")
- [ ] Borough name that's too broad ("brooklyn", "queens")
- [ ] Unsupported neighborhood (bay ridge, coney island) — suggests nearby alternatives
- [ ] Number / "more" / "free" with no active session (orphaned command)
- [ ] Compound request: category + neighborhood in one message ("comedy in the village", "free jazz in harlem")

**Poor experiences:**
- [ ] Quiet neighborhood → travel nudge → user says yes → picks from nearby
- [ ] Quiet neighborhood → travel nudge → user says no → graceful exit
- [ ] Nothing tonight → tomorrow events surfaced honestly
- [ ] "More" exhausts all events → last batch signal → exhaustion message → nearby suggestion
- [ ] User double-texts before response ("east village" then "hello??")

**Abuse / off-topic:**
- [ ] Non-event question (sports, food, trivia) → playful deflect + redirect
- [ ] Gibberish or single characters → patient recovery
- [ ] Jailbreak / prompt injection attempt → stays in character

#### Realism Rules

- **Pulse messages** feel like a real friend texting — warm, opinionated, concise. Use NYC-specific references (real venues, subway lines, cross streets).
- **User messages** feel like real texts: lowercase, typos, abbreviations, no punctuation, slang. At least 3 scenarios should have phone-style short messages.
- **Links** are always separate follow-up messages from Pulse (one per pick), never inline in the picks message.
- **Details** are a single natural paragraph, max 320 chars, with one link at the end.
- **Picks** use the numbered format: intro line, numbered items (1–3) with blank lines between, reply footer: `"Reply 1-N for details, MORE for extra picks, or FREE for free events"`.
- Show **ideal Pulse behavior** in every scenario — what it *should* say, not the broken version.
- **Date awareness**: TODAY events say "tonight"/"today", TOMORROW events say "tomorrow"/"tomorrow night". Never mislabel.
- **Travel nudge**: Include transit tips when relevant ("Both easy on the 7 train", "Quick ride on the G").
- **Last batch MORE removal**: When it's the last batch, the reply footer should NOT include "MORE for extra picks".

#### Known Failure Modes to Test Against

These are real regressions discovered during evaluation. Design scenarios that would catch them:

1. **Neighborhood mixing on MORE**: Claude includes events from nearby neighborhoods in "more" picks
2. **Tomorrow mislabeled as tonight**: Events for tomorrow described as "tonight"
3. **MORE not removed on last batch**: Closing line still says "MORE for extra picks" when there are no more
4. **Session context loss on neighborhood switch**: Detail request returns picks from previous neighborhood
5. **Travel nudge fires on category searches**: Nudge triggers when user searched for a specific category

## Output

Write a single JSON file to `data/fixtures/multi-turn-scenarios.json` that validates against `eval_schema.json`.

See `eval_example.json` for the exact format of one complete scenario.

Do NOT truncate or summarize. Output all 40 scenarios with full conversation turns.
