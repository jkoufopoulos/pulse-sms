/**
 * LLM-as-judge evals — binary judges for subjective quality checks.
 * Only run when explicitly requested (--judges flag) since they cost API calls.
 */

const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const MODEL = process.env.PULSE_MODEL_JUDGE || 'claude-sonnet-4-5-20250929';

/**
 * Judge: Does the SMS sound like a friend texting, not a bot?
 * @param {Object} trace
 * @returns {{ name: string, pass: boolean, detail: string }}
 */
async function judgeTone(trace) {
  const sms = trace.output_sms || '';
  if (!sms.trim()) {
    return { name: 'judge_tone', pass: false, detail: 'empty SMS' };
  }

  const prompt = `You are evaluating an SMS message from "Pulse", an NYC event recommendation bot that texts like a friend.

SMS to evaluate:
"${sms}"

Does this SMS sound like a real friend texting you about things to do tonight? It should feel warm, natural, and concise — not robotic, not overly formal, not like a newsletter or marketing email.

IMPORTANT: Pulse uses a numbered pick format ("1) Event at Venue — take. Time, price"). This is intentional and expected — do NOT penalize the numbered format itself. Judge the VOICE within that structure: does each pick sound opinionated and personal, or generic and robotic?

Red flags: bullet points, excessive exclamation marks, corporate language ("we recommend", "please visit", "don't miss"), marketing speak, hashtags, generic descriptions that could apply to any event ("a great time", "fun for everyone").

Green flags: casual tone, NYC shorthand, personal opinion ("legendary spot", "always goes off", "worth every penny"), specific vibe cues ("tiny basement", "goes late"), concise but informative.

Respond with EXACTLY one line:
PASS: [one sentence explaining why it sounds natural]
or
FAIL: [one sentence explaining what makes it sound robotic]`;

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: 10000 });

    const text = (response.content?.[0]?.text || '').trim();
    const passed = text.toUpperCase().startsWith('PASS');
    return {
      name: 'judge_tone',
      pass: passed,
      detail: text,
    };
  } catch (err) {
    return { name: 'judge_tone', pass: false, detail: `judge error: ${err.message}` };
  }
}

/**
 * Judge: Are picked events relevant to the user's neighborhood and request?
 * @param {Object} trace
 * @returns {{ name: string, pass: boolean, detail: string }}
 */
async function judgePickRelevance(trace) {
  const picks = trace.composition.picks || [];
  if (picks.length === 0) {
    return { name: 'judge_pick_relevance', pass: true, detail: 'no picks to evaluate' };
  }

  const hood = trace.composition.neighborhood_used || trace.routing.result?.neighborhood;
  const userMsg = trace.input_message;
  const sms = trace.output_sms || '';

  const prompt = `You are evaluating whether an event recommendation bot picked relevant events.

User's message: "${userMsg}"
Requested neighborhood: ${hood || 'not specified'}
Events picked: ${JSON.stringify(picks.map(p => ({ event_id: p.event_id, why: p.why })))}
Bot's SMS response: "${sms}"

Are the picked events relevant to what the user asked for? Consider:
1. Are events in or near the requested neighborhood?
2. Do the events match any filters/preferences the user mentioned?
3. Are the events actually happening soon (tonight/tomorrow)?

Respond with EXACTLY one line:
PASS: [one sentence explaining relevance]
or
FAIL: [one sentence explaining the mismatch]`;

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: 10000 });

    const text = (response.content?.[0]?.text || '').trim();
    const passed = text.toUpperCase().startsWith('PASS');
    return {
      name: 'judge_pick_relevance',
      pass: passed,
      detail: text,
    };
  } catch (err) {
    return { name: 'judge_pick_relevance', pass: false, detail: `judge error: ${err.message}` };
  }
}

/**
 * Run all judge evals on a trace.
 * @param {Object} trace
 * @returns {Promise<Array<{name, pass, detail}>>}
 */
async function runJudgeEvals(trace) {
  const [tone, relevance] = await Promise.all([
    judgeTone(trace),
    judgePickRelevance(trace),
  ]);
  return [tone, relevance];
}

/**
 * Judge: Head-to-head preference between two SMS responses to the same prompt.
 * Randomly assigns position A/B to control for position bias.
 * @param {string} userMessage - the user's original SMS
 * @param {string} neighborhood - the target neighborhood
 * @param {string} sms1 - first model's response
 * @param {string} sms2 - second model's response
 * @param {string} label1 - label for first model (e.g. 'sonnet')
 * @param {string} label2 - label for second model (e.g. 'haiku')
 * @returns {{ name: string, winner: string, confidence: string, detail: string, position_swapped: boolean }}
 */
async function judgePreference(userMessage, neighborhood, sms1, sms2, label1, label2) {
  // Randomly swap positions to control for position bias
  const swap = Math.random() < 0.5;
  const responseA = swap ? sms2 : sms1;
  const responseB = swap ? sms1 : sms2;

  const prompt = `You are comparing two SMS responses from an NYC event recommendation bot called Pulse.
Both responses were generated from the exact same event list and user request.

User's message: "${userMessage}"
Neighborhood: ${neighborhood || 'not specified'}

<response_a>
${responseA}
</response_a>

<response_b>
${responseB}
</response_b>

Compare them on these criteria:
1. TONE — Does it sound like a friend texting, not a bot? Warm, opinionated, NYC shorthand.
2. CURATION — Did it pick the most interesting events? Good taste, not generic.
3. FORMAT — Correct numbered format? Under 480 chars? Clean structure?
4. HELPFULNESS — Enough context to decide without Googling (time, price, vibe)?
5. HONESTY — Correct day labels (tonight vs tomorrow)? Honest about neighborhood mismatch?

Respond with EXACTLY one line in this format:
WINNER: A|B|TIE — [confidence: high|medium|low] — [one sentence explaining why]`;

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: 10000 });

    const text = (response.content?.[0]?.text || '').trim();
    const match = text.match(/WINNER:\s*(A|B|TIE)\s*[—-]\s*\[?confidence:\s*(high|medium|low)\]?\s*[—-]\s*(.*)/i);

    if (!match) {
      return { name: 'judge_preference', winner: 'error', confidence: 'low', detail: `unparseable: ${text}`, position_swapped: swap };
    }

    let rawWinner = match[1].toUpperCase();
    const confidence = match[2].toLowerCase();
    const reason = match[3].trim();

    // Map position back to model label
    let winner;
    if (rawWinner === 'TIE') {
      winner = 'tie';
    } else if (rawWinner === 'A') {
      winner = swap ? label2 : label1;
    } else {
      winner = swap ? label1 : label2;
    }

    return { name: 'judge_preference', winner, confidence, detail: reason, position_swapped: swap };
  } catch (err) {
    return { name: 'judge_preference', winner: 'error', confidence: 'low', detail: `judge error: ${err.message}`, position_swapped: swap };
  }
}

module.exports = { judgeTone, judgePickRelevance, runJudgeEvals, judgePreference };
