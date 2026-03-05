#!/usr/bin/env node
/**
 * Quality eval runner for Pulse SMS.
 *
 * Replays conversations from quality-conversations.json through the live pipeline,
 * then uses Claude Haiku as a judge to score each response on voice, picks, and density.
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
const Anthropic = require('@anthropic-ai/sdk');

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

const JUDGE_MODEL = process.env.PULSE_MODEL_JUDGE || 'claude-haiku-4-5-20251001';

const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80 / 1_000_000, output: 4.0 / 1_000_000 },
  'claude-sonnet-4-5-20250929': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};
let judgeCostTotal = 0;

const client = new Anthropic();

const JUDGE_SYSTEM = `You are evaluating an SMS nightlife recommendation bot called Pulse.
Pulse is supposed to feel like texting a cool friend who always knows what's happening tonight -- not a search engine, not a customer service bot.

Score each dimension 1-5:

- Voice (1-5): 5 = sounds like a friend who actually goes out, uses natural language, has personality, maybe a little opinionated. 3 = fine but generic, could be any bot. 1 = robotic, formal, "I'd be happy to help", bullet-point listing.

- Picks (1-5): 5 = recommendations feel genuinely curated and interesting, the kind of thing a knowledgeable local who goes out a lot would suggest. 3 = reasonable but obvious, stuff you'd find on the first page of Google. 1 = generic, irrelevant, or clearly just the first items from a database.

- Density (1-5): 5 = every word earns its place, punchy, respects that this is SMS and the reader is on their phone. 3 = acceptable length but has some filler. 1 = padded with unnecessary preambles, verbose, wastes the reader's time.

IMPORTANT: If the response is a non-event message (greeting, help text, clarifying question, off-topic redirect), score Voice and Density only. Set Picks to null. These are valid responses that just don't contain event recommendations.

Respond in STRICT JSON (no markdown fencing):
{"voice": N, "picks": N_or_null, "density": N, "note": "one sentence explaining the weakest score"}`;

async function judgeResponse(userMessage, responseText) {
  const prompt = `The user texted: "${userMessage}"\n\nPulse responded: "${responseText}"\n\nScore this response.`;

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 256,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 15000 });

  // Track cost
  const pricing = PRICING[JUDGE_MODEL] || PRICING['claude-haiku-4-5-20251001'];
  const cost = (response.usage?.input_tokens || 0) * pricing.input
    + (response.usage?.output_tokens || 0) * pricing.output;
  judgeCostTotal += cost;

  const text = response.content?.[0]?.text || '';

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
  return { voice: null, picks: null, density: null, note: 'Judge returned unparseable response' };
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
      const judgment = await judgeResponse(turn.user, responseText);
      scores = { voice: judgment.voice, picks: judgment.picks, density: judgment.density };
      note = judgment.note || null;
    } catch (err) {
      scores = { voice: null, picks: null, density: null };
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
  const voiceAvg = dimensionAvg(convResults, 'voice');
  const picksAvg = dimensionAvg(convResults, 'picks');
  const densityAvg = dimensionAvg(convResults, 'density');
  const allScores = convResults.map(c => c.avg_score);
  const overallAvg = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    judge_model: JUDGE_MODEL,
    judge_cost: parseFloat(judgeCostTotal.toFixed(4)),
    elapsed_seconds: parseFloat(totalElapsed),
    summary: {
      conversations: conversations.length,
      avg_score: parseFloat(overallAvg.toFixed(1)),
      voice: parseFloat(voiceAvg.toFixed(1)),
      picks: parseFloat(picksAvg.toFixed(1)),
      density: parseFloat(densityAvg.toFixed(1)),
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
  console.log(`Quality eval: ${conversations.length} conversations, avg ${overallAvg.toFixed(1)}/5`);
  console.log(`  Voice: ${voiceAvg.toFixed(1)}  Picks: ${picksAvg.toFixed(1)}  Density: ${densityAvg.toFixed(1)}`);
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
