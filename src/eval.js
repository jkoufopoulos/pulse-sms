const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const MODEL = process.env.PULSE_MODEL_EVAL || process.env.PULSE_MODEL_EXTRACT || 'claude-sonnet-4-5-20250929';
const BATCH_SIZE = 15;

const EVAL_SYSTEM = `You are an event quality evaluator for Pulse, an NYC event recommendation SMS bot.

Score each event 1-10 on how "worth recommending" it is to a cool NYC local looking for interesting things to do tonight.

SCORING CRITERIA:
- 8-10: Great pick — clear name, known venue, specific time, interesting/cool/unique
- 5-7: Decent — has most info, could recommend with caveats
- 3-4: Weak — missing key info, generic, or touristy
- 1-2: Unusable — stale, no time, no venue, too vague to recommend

FLAG TYPES (include all that apply):
- "stale" — date appears to be in the past
- "missing_venue" — venue is "TBA", empty, or null
- "no_neighborhood" — no neighborhood resolved
- "no_time" — no start time or only a date with no time
- "touristy" — looks corporate, touristy, or generic (e.g. Times Square bus tours, Statue of Liberty)
- "vague" — name or details too ambiguous to recommend confidently
- "duplicate" — appears to be the same as another event in this batch

Return STRICT JSON array — one object per event, in the same order as input:
[
  {
    "event_id": "the event id",
    "score": 7,
    "flags": ["flag1"],
    "note": "Brief reason for score"
  }
]`;

/**
 * Score a batch of events using Claude.
 * Returns array of { event_id, score, flags, note } objects.
 */
async function scoreEvents(events) {
  if (!events || events.length === 0) return [];

  const batches = [];
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    batches.push(events.slice(i, i + BATCH_SIZE));
  }

  const results = [];

  for (const batch of batches) {
    const eventsForPrompt = batch.map(e => ({
      id: e.id,
      name: e.name,
      venue_name: e.venue_name,
      neighborhood: e.neighborhood,
      start_time_local: e.start_time_local,
      date_local: e.date_local,
      category: e.category,
      is_free: e.is_free,
      price_display: e.price_display,
      source_name: e.source_name,
      confidence: e.confidence,
      description_short: e.description_short || e.short_detail,
    }));

    const userPrompt = `Score these ${batch.length} events:\n\n${JSON.stringify(eventsForPrompt, null, 2)}`;

    try {
      const response = await getClient().messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: EVAL_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      }, { timeout: 30000 });

      const text = response.content?.[0]?.text || '';
      const parsed = parseJsonArray(text);

      if (parsed) {
        results.push(...parsed);
      } else {
        console.error('scoreEvents: failed to parse batch response');
        // Return unscored entries for this batch
        results.push(...batch.map(e => ({
          event_id: e.id,
          score: null,
          flags: [],
          note: 'Scoring failed',
        })));
      }
    } catch (err) {
      console.error('scoreEvents batch error:', err.message);
      results.push(...batch.map(e => ({
        event_id: e.id,
        score: null,
        flags: [],
        note: `Error: ${err.message}`,
      })));
    }
  }

  return results;
}

/**
 * Parse a JSON array from Claude's response text.
 */
function parseJsonArray(text) {
  // Try code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Find first [ and last ]
  const start = text.indexOf('[');
  if (start === -1) return null;

  for (let end = text.lastIndexOf(']'); end > start; end = text.lastIndexOf(']', end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch { /* try shorter */ }
  }

  return null;
}

module.exports = { scoreEvents };
