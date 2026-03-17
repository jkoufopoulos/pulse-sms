#!/usr/bin/env node
/**
 * Quality eval runner for Pulse SMS.
 *
 * Replays conversations from quality-conversations.json through the live pipeline,
 * then uses Claude Haiku as a judge to score each response on tone, curation, intent match, and more.
 *
 * Usage:
 *   node scripts/run-quality-evals.js                          # Run all
 *   node scripts/run-quality-evals.js --name "bushwick"        # Filter by name
 *   node scripts/run-quality-evals.js --url http://...         # Custom server
 *   node scripts/run-quality-evals.js --concurrency 3          # Parallel conversations
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { generate } = require('../src/llm');
const { getProvider } = require('../src/model-config');

const args = process.argv.slice(2);
const nameFilter = args.find(a => a.startsWith('--name='))?.split('=')[1]
  || (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);
const BASE = args.find(a => a.startsWith('--url='))?.split('=')[1]
  || (args.includes('--url') ? args[args.indexOf('--url') + 1] : null)
  || 'http://localhost:3000';
const isRemote = BASE !== 'http://localhost:3000';
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]
  || (args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : null)
  || (isRemote ? '3' : '5'), 10);

const JUDGE_MODEL = process.env.PULSE_MODEL_JUDGE || 'gemini-2.5-flash';

const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80 / 1_000_000, output: 4.0 / 1_000_000 },
  'claude-sonnet-4-5-20250929': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'gemini-2.5-flash': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
};
let judgeCostTotal = 0;

const JUDGE_SYSTEM = `You are evaluating an SMS nightlife recommendation bot called Pulse.
Pulse texts like a plugged-in friend who knows NYC — not a search engine, not a customer service bot.

For each applicable dimension, give a binary PASS/FAIL verdict AND a 1-5 score. Set inapplicable dimensions to null.

DIMENSIONS:

- tone (ALWAYS judge):
  PASS if: casual, warm, opinionated, uses natural language, has personality. Reads like a friend texting.
  FAIL if: robotic, formal, "I'd be happy to help", bullet-point listing, corporate language, marketing speak, hashtags, excessive exclamation marks.
  Score 1-5 for granularity (5 = plugged-in friend, 3 = generic but fine, 1 = robotic).

- curation (ONLY when response contains event picks):
  PASS if: picks feel curated — interesting, not obvious, the kind of thing a local would suggest.
  FAIL if: generic database results, irrelevant to request, picks you'd find on the first page of Google.
  Score 1-5 (5 = genuinely curated, 3 = reasonable, 1 = generic).

- intent_match (ONLY when user had a clear request):
  PASS if: response aligns with what the user asked for (right neighborhood, right category, right vibe).
  FAIL if: response misses what the user wanted — wrong neighborhood, wrong category, ignored a filter.
  Score 1-5 (5 = nailed it, 3 = partially relevant, 1 = completely missed).

- probing (ONLY when user intent is vague/ambiguous):
  PASS if: asked a smart, specific follow-up OR made a reasonable inference and searched.
  FAIL if: asked nothing and guessed badly, or asked something uselessly generic.
  Score 1-5 (5 = smart follow-up, 3 = generic question, 1 = no follow-up, bad guess).

- inference (ONLY when there's an opportunity to go beyond the literal request):
  PASS if: connected context clues — group size, vibe, time constraints — and picks match.
  FAIL if: took request too literally, missed obvious context.
  Score 1-5 (5 = brilliant inference, 3 = reasonable, 1 = too literal).

- coherence (ONLY on turn 2+):
  PASS if: maintained context from previous turns, built on conversation naturally.
  FAIL if: lost context, contradicted previous turns, or started over.
  Score 1-5 (5 = perfect continuity, 3 = mostly coherent, 1 = lost context).

Respond in STRICT JSON (no markdown fencing):
{"tone": N_or_null, "tone_pass": bool_or_null, "curation": N_or_null, "curation_pass": bool_or_null, "intent_match": N_or_null, "intent_match_pass": bool_or_null, "probing": N_or_null, "probing_pass": bool_or_null, "inference": N_or_null, "inference_pass": bool_or_null, "coherence": N_or_null, "coherence_pass": bool_or_null, "note": "one sentence on the weakest dimension"}`;

async function judgeResponse(userMessage, responseText, { turnNumber, previousTurns } = {}) {
  let context = '';
  if (previousTurns?.length > 0) {
    context = '\n\nPrevious turns in this conversation:\n' +
      previousTurns.map(t => `User: "${t.user}"\nPulse: "${t.response}"`).join('\n\n') +
      '\n\n---\nNow scoring this turn:\n';
  }
  const turnLabel = turnNumber > 1 ? ` (turn ${turnNumber} of conversation)` : ' (first message, no prior context)';
  const prompt = `The user texted${turnLabel}: "${userMessage}"${context}\n\nPulse responded: "${responseText}"\n\nScore this response. Remember: only score dimensions that apply to this turn. Set others to null.`;

  const isGemini = getProvider(JUDGE_MODEL) === 'gemini';
  const result = await generate(JUDGE_MODEL, JUDGE_SYSTEM, prompt, {
    maxTokens: isGemini ? 2048 : 256,
    temperature: 0,
    timeout: 15000,
  });

  // Track cost
  const pricing = PRICING[JUDGE_MODEL] || PRICING['gemini-2.5-flash'];
  const usage = result.usage || {};
  const cost = (usage.input_tokens || usage.promptTokenCount || 0) * pricing.input
    + (usage.output_tokens || usage.candidatesTokenCount || 0) * pricing.output;
  judgeCostTotal += cost;

  const text = result.text || '';

  // Parse JSON: try fence match first, then raw extraction
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  const start = text.indexOf('{');
  if (start !== -1) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
  }
  return { tone: null, curation: null, intent_match: null, probing: null, inference: null, coherence: null, note: 'Judge returned unparseable response' };
}

function avgScore(turns) {
  let sum = 0;
  let count = 0;
  for (const t of turns) {
    if (!t.scores) continue;
    for (const [key, val] of Object.entries(t.scores)) {
      if (val !== null && val !== undefined) {
        sum += val;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

function dimensionAvg(conversations, dim) {
  let sum = 0;
  let count = 0;
  for (const conv of conversations) {
    for (const t of conv.turns) {
      if (t.scores && t.scores[dim] !== null && t.scores[dim] !== undefined) {
        sum += t.scores[dim];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

async function runConversation(conversation, phoneNumber) {
  // Clear session
  await fetch(`${BASE}/api/eval/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneNumber, session: null }),
  });

  const turnResults = [];

  for (const turn of conversation.turns) {
    let responseText;
    try {
      const res = await fetch(`${BASE}/api/sms/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: turn.user, From: phoneNumber }),
        signal: AbortSignal.timeout(28000),
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status} (non-JSON response)` }));

      if (!res.ok) {
        responseText = `[ERROR: ${data.error || res.status}]`;
      } else {
        const messages = data.messages || [];
        responseText = messages.map(m => m.body).join('\n') || '[NO RESPONSE]';
      }
    } catch (err) {
      const msg = err.name === 'TimeoutError' ? 'fetch timeout (28s)' : err.message;
      responseText = `[ERROR: ${msg}]`;
    }

    // Judge this turn
    let scores, note;
    try {
      const judgment = await judgeResponse(turn.user, responseText, {
        turnNumber: turnResults.length + 1,
        previousTurns: turnResults,
      });
      scores = {
        tone: judgment.tone ?? null,
        curation: judgment.curation ?? null,
        intent_match: judgment.intent_match ?? null,
        probing: judgment.probing ?? null,
        inference: judgment.inference ?? null,
        coherence: judgment.coherence ?? null,
      };
      const verdicts = {
        tone_pass: judgment.tone_pass ?? null,
        curation_pass: judgment.curation_pass ?? null,
        intent_match_pass: judgment.intent_match_pass ?? null,
        probing_pass: judgment.probing_pass ?? null,
        inference_pass: judgment.inference_pass ?? null,
        coherence_pass: judgment.coherence_pass ?? null,
      };
      scores._verdicts = verdicts;
      note = judgment.note || null;
    } catch (err) {
      scores = { tone: null, curation: null, intent_match: null, probing: null, inference: null, coherence: null };
      note = `Judge error: ${err.message}`;
    }

    turnResults.push({
      user: turn.user,
      response: responseText,
      scores,
      note,
    });

    // Session settling delay
    await new Promise(r => setTimeout(r, 300));
  }

  return turnResults;
}

async function main() {
  const conversationsPath = path.join(__dirname, '..', 'data', 'fixtures', 'quality-conversations.json');
  if (!fs.existsSync(conversationsPath)) {
    console.error('No conversations found at data/fixtures/quality-conversations.json');
    process.exit(1);
  }

  let conversations = JSON.parse(fs.readFileSync(conversationsPath, 'utf8'));

  if (nameFilter) {
    const lower = nameFilter.toLowerCase();
    conversations = conversations.filter(c => c.name.toLowerCase().includes(lower));
    console.log(`Filtered to ${conversations.length} conversations matching "${nameFilter}"`);
  }

  if (conversations.length === 0) {
    console.log('No conversations to run.');
    process.exit(0);
  }

  console.log(`Running ${conversations.length} quality conversations against ${BASE} (concurrency: ${CONCURRENCY})\n`);

  const runId = Date.now() % 10000;
  const startTime = Date.now();
  let completed = 0;
  const convResults = new Array(conversations.length);

  async function runOne(conversation, index) {
    const nameHash = conversation.name.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0) >>> 0;
    const phoneNumber = `+1555${String(runId).padStart(4, '0')}${String(nameHash % 1000).padStart(3, '0')}`;

    try {
      const turns = await runConversation(conversation, phoneNumber);
      const avg = avgScore(turns);
      return { name: conversation.name, avg_score: parseFloat(avg.toFixed(1)), turns };
    } catch (err) {
      return { name: conversation.name, avg_score: 0, turns: [], error: err.message };
    }
  }

  async function worker(taskQueue) {
    while (taskQueue.length > 0) {
      const { conversation, index } = taskQueue.shift();
      const result = await runOne(conversation, index);
      convResults[index] = result;
      completed++;

      const pct = ((completed / conversations.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const prefix = `[${completed}/${conversations.length} ${pct}% ${elapsed}s]`;

      if (result.error) {
        console.log(`${prefix} \x1b[33mERROR\x1b[0m  ${result.name}: ${result.error}`);
      } else if (result.avg_score >= 4) {
        console.log(`${prefix} \x1b[32m${result.avg_score.toFixed(1)}\x1b[0m  ${result.name}`);
      } else if (result.avg_score >= 3) {
        console.log(`${prefix} \x1b[33m${result.avg_score.toFixed(1)}\x1b[0m  ${result.name}`);
      } else {
        console.log(`${prefix} \x1b[31m${result.avg_score.toFixed(1)}\x1b[0m  ${result.name}`);
      }
    }
  }

  const taskQueue = conversations.map((conversation, index) => ({ conversation, index }));
  const workers = Array.from({ length: Math.min(CONCURRENCY, conversations.length) }, () => worker(taskQueue));
  await Promise.all(workers);

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Build report
  const dims = ['tone', 'curation', 'intent_match', 'probing', 'inference', 'coherence'];
  const dimAvgs = {};
  for (const d of dims) dimAvgs[d] = dimensionAvg(convResults, d);
  const scoredDims = dims.filter(d => dimAvgs[d] > 0);
  const overallAvg = scoredDims.length > 0 ? scoredDims.reduce((s, d) => s + dimAvgs[d], 0) / scoredDims.length : 0;

  // Compute binary pass rates per dimension
  const dimPassRates = {};
  for (const d of dims) {
    let passed = 0, total = 0;
    for (const conv of convResults) {
      for (const t of (conv.turns || [])) {
        const v = t.scores?._verdicts?.[`${d}_pass`];
        if (v !== null && v !== undefined) {
          total++;
          if (v) passed++;
        }
      }
    }
    dimPassRates[d] = total > 0 ? { passed, total, rate: parseFloat((passed / total * 100).toFixed(1)) } : null;
  }
  const totalVerdicts = Object.values(dimPassRates).filter(Boolean);
  const overallPassRate = totalVerdicts.length > 0
    ? totalVerdicts.reduce((s, d) => s + d.rate, 0) / totalVerdicts.length
    : 0;

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    judge_model: JUDGE_MODEL,
    judge_cost: parseFloat(judgeCostTotal.toFixed(4)),
    elapsed_seconds: parseFloat(totalElapsed),
    summary: {
      conversations: conversations.length,
      avg_score: parseFloat(overallAvg.toFixed(1)),
      pass_rate: parseFloat(overallPassRate.toFixed(1)),
      tone: parseFloat(dimAvgs.tone.toFixed(1)),
      curation: parseFloat(dimAvgs.curation.toFixed(1)),
      intent_match: parseFloat(dimAvgs.intent_match.toFixed(1)),
      probing: parseFloat(dimAvgs.probing.toFixed(1)),
      inference: parseFloat(dimAvgs.inference.toFixed(1)),
      coherence: parseFloat(dimAvgs.coherence.toFixed(1)),
      pass_rates: dimPassRates,
    },
    conversations: convResults,
  };

  // CLI summary
  const worst = [...convResults]
    .sort((a, b) => a.avg_score - b.avg_score)
    .slice(0, 5)
    .map(c => `"${c.name}" (${c.avg_score.toFixed(1)})`)
    .join(', ');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Quality: ${overallAvg.toFixed(1)}/5.0 | Pass rate: ${overallPassRate.toFixed(0)}% (${conversations.length} conversations)`);
  console.log(`  Scores:     Tone: ${dimAvgs.tone.toFixed(1)}  Curation: ${dimAvgs.curation.toFixed(1)}  Intent: ${dimAvgs.intent_match.toFixed(1)}`);
  console.log(`              Probing: ${dimAvgs.probing.toFixed(1)}  Inference: ${dimAvgs.inference.toFixed(1)}  Coherence: ${dimAvgs.coherence.toFixed(1)}`);
  const prLine = dims.map(d => {
    const pr = dimPassRates[d];
    return pr ? `${d}: ${pr.rate}%` : null;
  }).filter(Boolean).join('  ');
  if (prLine) console.log(`  Pass rates: ${prLine}`);
  console.log(`  Worst: ${worst}`);
  console.log(`  Cost: $${judgeCostTotal.toFixed(4)}  Time: ${totalElapsed}s`);
  console.log(`  Browse: ${BASE}/eval-quality`);
  console.log(`${'='.repeat(60)}`);

  // Save report
  const reportsDir = path.join(__dirname, '..', 'data', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(reportsDir, `quality-eval-${now}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved: ${reportPath}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
