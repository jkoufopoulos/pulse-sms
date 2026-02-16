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

Red flags: numbered lists, bullet points, excessive exclamation marks, corporate language ("we recommend", "please visit"), overly structured format, hashtags.

Green flags: casual tone, NYC shorthand, personal opinion ("this one's sick", "worth checking out"), natural flow between recommendations.

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

module.exports = { judgeTone, judgePickRelevance, runJudgeEvals };
