# Quality Evals Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a quality eval system that scores Pulse responses on voice, picks, and density using an LLM judge, with a CLI runner and browse page.

**Architecture:** A standalone runner script (`scripts/run-quality-evals.js`) replays user inputs from a fixture file against the live pipeline, judges each response with Haiku on a 3-dimension rubric, saves a report JSON, and prints a CLI summary. A new `/eval-quality` page in server.js serves an HTML dashboard that loads quality reports via the existing `/api/eval-reports` infrastructure.

**Tech Stack:** Node.js, Anthropic SDK (Haiku judge), Express (dashboard route), vanilla HTML/JS (dashboard UI).

---

### Task 1: Starter conversation fixture file

**Files:**
- Create: `data/fixtures/quality-conversations.json`

**Step 1: Create the fixture file with 10 starter conversations**

These are placeholder inputs the user will replace/extend. They cover the basic input variety described in the design doc.

```json
[
  {
    "name": "cold neighborhood open",
    "turns": [
      { "user": "bushwick" }
    ]
  },
  {
    "name": "category with neighborhood",
    "turns": [
      { "user": "jazz in west village" }
    ]
  },
  {
    "name": "vibe request",
    "turns": [
      { "user": "anything weird tonight" }
    ]
  },
  {
    "name": "one word category",
    "turns": [
      { "user": "techno" }
    ]
  },
  {
    "name": "free filter",
    "turns": [
      { "user": "free stuff in greenpoint" }
    ]
  },
  {
    "name": "group context",
    "turns": [
      { "user": "4 of us looking for something fun in williamsburg tonight" },
      { "user": "anything cheaper?" }
    ]
  },
  {
    "name": "multi-turn browse and filter",
    "turns": [
      { "user": "east village" },
      { "user": "any comedy?" },
      { "user": "2" }
    ]
  },
  {
    "name": "pivot mid-conversation",
    "turns": [
      { "user": "les" },
      { "user": "actually bushwick" },
      { "user": "techno stuff" }
    ]
  },
  {
    "name": "skeptic follow-up",
    "turns": [
      { "user": "williamsburg" },
      { "user": "those sound basic" }
    ]
  },
  {
    "name": "minimal effort",
    "turns": [
      { "user": "vibes" }
    ]
  }
]
```

**Step 2: Verify the file is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('data/fixtures/quality-conversations.json','utf8')); console.log('Valid JSON')"`
Expected: `Valid JSON`

**Step 3: Commit**

```bash
git add data/fixtures/quality-conversations.json
git commit -m "feat: add starter quality eval conversations fixture"
```

---

### Task 2: Quality eval runner script

**Files:**
- Create: `scripts/run-quality-evals.js`

**Reference:** Follow the patterns from `scripts/run-scenario-evals.js` for:
- Arg parsing (`--url`, `--concurrency`, `--name`)
- Session clearing via `POST /api/eval/session`
- Sending turns via `POST /api/sms/test`
- Concurrency-limited worker pattern
- Report saving to `data/reports/`
- Cost tracking with `PRICING` map

**Step 1: Create the runner script**

```js
#!/usr/bin/env node
/**
 * Quality eval runner.
 *
 * Replays conversations from quality-conversations.json against the live
 * pipeline, then uses an LLM judge to score each response on voice, picks,
 * and density (1-5 rubric).
 *
 * Usage:
 *   node scripts/run-quality-evals.js                         # Run all
 *   node scripts/run-quality-evals.js --name "jazz"           # Filter by name
 *   node scripts/run-quality-evals.js --url http://...        # Custom server
 *   node scripts/run-quality-evals.js --concurrency 8         # Parallel (default: 5)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// --- Arg parsing ---
const args = process.argv.slice(2);
function getArg(name) {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const nameFilter = getArg('name');
const BASE = getArg('url') || 'http://localhost:3000';
const isRemote = BASE !== 'http://localhost:3000';
const CONCURRENCY = parseInt(getArg('concurrency') || (isRemote ? '3' : '5'), 10);
const JUDGE_MODEL = process.env.PULSE_MODEL_JUDGE || 'claude-haiku-4-5-20251001';

const client = new Anthropic();

// Cost tracking
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80 / 1_000_000, output: 4.0 / 1_000_000 },
  'claude-sonnet-4-5-20250929': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};
let judgeCostTotal = 0;

const JUDGE_SYSTEM = `You are evaluating an SMS nightlife recommendation bot called Pulse.
Pulse is supposed to feel like texting a cool friend who always knows what's happening tonight -- not a search engine, not a customer service bot.

Score each dimension 1-5:

- Voice (1-5): 5 = sounds like a friend who actually goes out, uses natural language, has personality, maybe a little opinionated. 3 = fine but generic, could be any bot. 1 = robotic, formal, "I'd be happy to help", bullet-point listing.

- Picks (1-5): 5 = recommendations feel genuinely curated and interesting, the kind of thing a knowledgeable local who goes out a lot would suggest. 3 = reasonable but obvious, stuff you'd find on the first page of Google. 1 = generic, irrelevant, or clearly just the first items from a database.

- Density (1-5): 5 = every word earns its place, punchy, respects that this is SMS and the reader is on their phone. 3 = acceptable length but has some filler. 1 = padded with unnecessary preambles, verbose, wastes the reader's time.

IMPORTANT: If the response is a non-event message (greeting, help text, clarifying question, off-topic redirect), score Voice and Density only. Set Picks to null. These are valid responses that just don't contain event recommendations.

Respond in STRICT JSON (no markdown fencing):
{"voice": N, "picks": N_or_null, "density": N, "note": "one sentence explaining the weakest score"}`;

async function judgeResponse(userMessage, actualResponse) {
  const prompt = `The user texted: "${userMessage}"

Pulse responded: "${actualResponse}"

Score this response.`;

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

  // Parse JSON
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

async function runConversation(conversation, phoneNumber) {
  // Clear session
  await fetch(`${BASE}/api/eval/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneNumber, session: null }),
  });

  const turns = [];

  for (const turn of conversation.turns) {
    let response, data;
    try {
      response = await fetch(`${BASE}/api/sms/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: turn.user, From: phoneNumber }),
        signal: AbortSignal.timeout(28000),
      });
      data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    } catch (err) {
      const msg = err.name === 'TimeoutError' ? 'fetch timeout (28s)' : err.message;
      turns.push({ user: turn.user, response: `[ERROR: ${msg}]`, scores: null, note: 'Request failed' });
      continue;
    }

    if (!response.ok) {
      turns.push({ user: turn.user, response: `[ERROR: ${data.error || response.status}]`, scores: null, note: 'Request failed' });
      continue;
    }

    // Collect response text (may be multiple messages for link previews)
    const messages = data.messages || [];
    const responseText = messages.map(m => m.body).join('\n') || '[NO RESPONSE]';

    // Judge this turn
    const judgment = await judgeResponse(turn.user, responseText);

    turns.push({
      user: turn.user,
      response: responseText,
      scores: {
        voice: judgment.voice,
        picks: judgment.picks,
        density: judgment.density,
      },
      note: judgment.note || '',
    });

    // Small delay between turns
    await new Promise(r => setTimeout(r, 300));
  }

  return turns;
}

function avgScore(turns) {
  const validScores = [];
  for (const t of turns) {
    if (!t.scores) continue;
    const dims = [t.scores.voice, t.scores.picks, t.scores.density].filter(s => s != null);
    validScores.push(...dims);
  }
  return validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : null;
}

function dimensionAvg(conversations, dim) {
  const scores = [];
  for (const c of conversations) {
    for (const t of c.turns) {
      if (t.scores && t.scores[dim] != null) scores.push(t.scores[dim]);
    }
  }
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

async function main() {
  const fixturePath = path.join(__dirname, '..', 'data', 'fixtures', 'quality-conversations.json');
  if (!fs.existsSync(fixturePath)) {
    console.error('No conversations found at data/fixtures/quality-conversations.json');
    console.error('See docs/plans/quality-eval-conversations-guide.md for how to create them.');
    process.exit(1);
  }

  let conversations = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  if (nameFilter) {
    const lower = nameFilter.toLowerCase();
    conversations = conversations.filter(c => c.name.toLowerCase().includes(lower));
    console.log(`Filtered to ${conversations.length} conversations matching "${nameFilter}"`);
  }

  if (conversations.length === 0) {
    console.log('No conversations to run.');
    process.exit(0);
  }

  console.log(`Running ${conversations.length} quality evals against ${BASE} (concurrency: ${CONCURRENCY})\n`);

  const startTime = Date.now();
  const runId = Date.now() % 10000;
  let completed = 0;

  const results = new Array(conversations.length);

  async function worker(queue) {
    while (queue.length > 0) {
      const { conversation, index } = queue.shift();
      const nameHash = conversation.name.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0) >>> 0;
      const phoneNumber = `+1555${String(runId).padStart(4, '0')}${String(nameHash % 1000).padStart(3, '0')}`;

      try {
        const turns = await runConversation(conversation, phoneNumber);
        const avg = avgScore(turns);
        results[index] = { name: conversation.name, avg_score: avg, turns };
      } catch (err) {
        results[index] = { name: conversation.name, avg_score: null, turns: [], error: err.message };
      }

      completed++;
      const pct = ((completed / conversations.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const r = results[index];
      const scoreStr = r.avg_score != null ? r.avg_score.toFixed(1) : 'ERR';
      const color = r.error ? '\x1b[33m' : r.avg_score >= 4 ? '\x1b[32m' : r.avg_score >= 3 ? '\x1b[33m' : '\x1b[31m';
      console.log(`[${completed}/${conversations.length} ${pct}% ${elapsed}s] ${color}${scoreStr}\x1b[0m  ${r.name}${r.error ? `: ${r.error}` : ''}`);
    }
  }

  const queue = conversations.map((conversation, index) => ({ conversation, index }));
  const workers = Array.from({ length: Math.min(CONCURRENCY, conversations.length) }, () => worker(queue));
  await Promise.all(workers);

  // Build report
  const voiceAvg = dimensionAvg(results, 'voice');
  const picksAvg = dimensionAvg(results, 'picks');
  const densityAvg = dimensionAvg(results, 'density');
  const allDims = [voiceAvg, picksAvg, densityAvg].filter(d => d != null);
  const overallAvg = allDims.length > 0 ? allDims.reduce((a, b) => a + b, 0) / allDims.length : null;

  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    judge_model: JUDGE_MODEL,
    judge_cost: parseFloat(judgeCostTotal.toFixed(4)),
    elapsed_seconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(1)),
    summary: {
      conversations: conversations.length,
      avg_score: overallAvg != null ? parseFloat(overallAvg.toFixed(2)) : null,
      voice: voiceAvg != null ? parseFloat(voiceAvg.toFixed(2)) : null,
      picks: picksAvg != null ? parseFloat(picksAvg.toFixed(2)) : null,
      density: densityAvg != null ? parseFloat(densityAvg.toFixed(2)) : null,
    },
    conversations: results,
  };

  // CLI summary
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Quality eval: ${conversations.length} conversations, avg ${overallAvg != null ? overallAvg.toFixed(1) : '?'}/5`);
  console.log(`  Voice: ${voiceAvg != null ? voiceAvg.toFixed(1) : '?'}  Picks: ${picksAvg != null ? picksAvg.toFixed(1) : '?'}  Density: ${densityAvg != null ? densityAvg.toFixed(1) : '?'}`);

  // Show worst 5
  const sorted = [...results].filter(r => r.avg_score != null).sort((a, b) => a.avg_score - b.avg_score);
  if (sorted.length > 0) {
    const worst = sorted.slice(0, 5);
    console.log(`  Worst: ${worst.map(w => `"${w.name}" (${w.avg_score.toFixed(1)})`).join(', ')}`);
  }

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
```

**Step 2: Verify it parses without errors**

Run: `node -c scripts/run-quality-evals.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add scripts/run-quality-evals.js
git commit -m "feat: add quality eval runner with rubric judge"
```

---

### Task 3: Register quality reports in server.js

**Files:**
- Modify: `src/server.js` (lines 139-153, the `REPORT_PREFIXES` and `isValidReportFilename` section)

The existing report infrastructure uses a `REPORT_PREFIXES` map to recognize report types. Add `quality-eval-` to it. This makes quality reports show up in `/api/eval-reports` and be loadable by the dashboard.

**Step 1: Add quality-eval prefix to REPORT_PREFIXES**

In `src/server.js`, find:
```js
const REPORT_PREFIXES = {
  'scenario-eval-': 'scenario',
  'regression-eval-': 'regression',
  'extraction-audit-': 'extraction',
  'scrape-audit-': 'scrape',
};
```

Add the quality entry:
```js
const REPORT_PREFIXES = {
  'scenario-eval-': 'scenario',
  'regression-eval-': 'regression',
  'extraction-audit-': 'extraction',
  'scrape-audit-': 'scrape',
  'quality-eval-': 'quality',
};
```

**Step 2: Add quality report summary to the `/api/eval-reports` listing**

In the same file, find the `summaries` mapping in the `/api/eval-reports` GET handler (~line 165-186). After the `if (type === 'scrape')` block, add:

```js
if (type === 'quality') {
  return { ...base, ...data.summary, judge_model: data.judge_model, judge_cost: data.judge_cost, elapsed_seconds: data.elapsed_seconds, base_url: data.base_url };
}
```

**Step 3: Verify the server still starts**

Run: `node -c src/server.js`
Expected: No output (syntax OK)

**Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: register quality-eval reports in server report infrastructure"
```

---

### Task 4: Quality eval browse page

**Files:**
- Create: `src/eval-quality.html`
- Modify: `src/server.js` (add route for `/eval-quality`)

**Step 1: Add the `/eval-quality` route to server.js**

After the existing `/eval-report` route (~line 136), add:

```js
app.get('/eval-quality', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.sendFile(require('path').join(__dirname, 'eval-quality.html'));
});
```

**Step 2: Create the HTML dashboard**

Create `src/eval-quality.html`. This is a single-file HTML page (same pattern as `eval-report.html`) that:

- Fetches quality reports from `/api/eval-reports?type=quality`
- Has a report selector dropdown at top
- Shows dimension averages (voice, picks, density) with color coding
- Shows trend sparkline across last 10 reports (inline SVG)
- Lists conversations sorted worst-first
- Each card: name, per-turn user message + response + scores + note
- Dimension filter buttons (e.g. "picks < 3")
- Color coding: 1-2 red (#e74c3c), 3 yellow (#f39c12), 4-5 green (#27ae60)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pulse Quality Evals</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.4em; margin-bottom: 16px; color: #fff; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
  select { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 6px 10px; border-radius: 4px; font-size: 0.85em; }
  .summary { display: flex; gap: 24px; margin-bottom: 20px; flex-wrap: wrap; }
  .dim-card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px 20px; min-width: 120px; text-align: center; }
  .dim-card .label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 4px; }
  .dim-card .score { font-size: 2em; font-weight: 700; }
  .dim-card .score.red { color: #e74c3c; }
  .dim-card .score.yellow { color: #f39c12; }
  .dim-card .score.green { color: #27ae60; }
  .sparkline { margin-bottom: 20px; }
  .sparkline svg { width: 100%; height: 60px; }
  .sparkline .spark-line { fill: none; stroke: #666; stroke-width: 1.5; }
  .sparkline .spark-dot { fill: #fff; }
  .filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filters button { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 4px 10px; border-radius: 4px; font-size: 0.8em; cursor: pointer; }
  .filters button.active { background: #333; border-color: #666; }
  .convo { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .convo-header { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
  .convo-header:hover { background: #222; }
  .convo-name { font-weight: 600; font-size: 0.9em; }
  .convo-score { font-weight: 700; font-size: 0.9em; }
  .convo-body { padding: 0 16px 16px; display: none; }
  .convo.open .convo-body { display: block; }
  .turn { margin-top: 12px; padding-top: 12px; border-top: 1px solid #222; }
  .turn:first-child { border-top: none; margin-top: 0; padding-top: 0; }
  .turn-user { color: #888; font-size: 0.85em; margin-bottom: 6px; }
  .turn-user span { color: #aaa; font-weight: 600; }
  .turn-response { background: #111; border-radius: 6px; padding: 10px 12px; font-size: 0.85em; line-height: 1.5; margin-bottom: 8px; white-space: pre-wrap; }
  .turn-scores { display: flex; gap: 12px; font-size: 0.8em; }
  .turn-scores .dim { display: flex; align-items: center; gap: 4px; }
  .turn-scores .dim-label { color: #888; }
  .turn-note { color: #888; font-size: 0.8em; font-style: italic; margin-top: 4px; }
  .empty { color: #666; text-align: center; padding: 40px; }
</style>
</head>
<body>
<h1>Pulse Quality Evals</h1>

<div class="controls">
  <select id="reportSelect"><option>Loading...</option></select>
</div>

<div class="summary" id="summary"></div>

<div class="sparkline" id="sparkline"></div>

<div class="filters" id="filters">
  <button data-filter="all" class="active">All</button>
  <button data-filter="voice<3">Voice &lt; 3</button>
  <button data-filter="picks<3">Picks &lt; 3</button>
  <button data-filter="density<3">Density &lt; 3</button>
</div>

<div id="conversations"></div>

<script>
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentReport = null;
let allReports = [];
let activeFilter = 'all';

function scoreColor(s) {
  if (s == null) return 'yellow';
  if (s >= 4) return 'green';
  if (s >= 3) return 'yellow';
  return 'red';
}

function scoreColorHex(s) {
  if (s == null) return '#888';
  if (s >= 4) return '#27ae60';
  if (s >= 3) return '#f39c12';
  return '#e74c3c';
}

function renderSummary(report) {
  const s = report.summary;
  const dims = [
    { label: 'Overall', score: s.avg_score },
    { label: 'Voice', score: s.voice },
    { label: 'Picks', score: s.picks },
    { label: 'Density', score: s.density },
  ];
  $('#summary').innerHTML = dims.map(d => `
    <div class="dim-card">
      <div class="label">${d.label}</div>
      <div class="score ${scoreColor(d.score)}">${d.score != null ? d.score.toFixed(1) : '?'}</div>
    </div>
  `).join('');
}

function renderSparkline(reports) {
  const recent = reports.slice(0, 10).reverse();
  if (recent.length < 2) { $('#sparkline').innerHTML = ''; return; }

  const scores = recent.map(r => r.avg_score).filter(s => s != null);
  if (scores.length < 2) { $('#sparkline').innerHTML = ''; return; }

  const min = Math.min(...scores, 1);
  const max = Math.max(...scores, 5);
  const w = 400;
  const h = 50;
  const pad = 10;

  const points = scores.map((s, i) => {
    const x = pad + (i / (scores.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (s - min) / (max - min || 1)) * (h - 2 * pad);
    return { x, y, s };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const dots = points.map(p => `<circle class="spark-dot" cx="${p.x}" cy="${p.y}" r="3"/>`).join('');
  const labels = [points[0], points[points.length - 1]].map(p =>
    `<text x="${p.x}" y="${p.y - 8}" fill="#888" font-size="10" text-anchor="middle">${p.s.toFixed(1)}</text>`
  ).join('');

  $('#sparkline').innerHTML = `<svg viewBox="0 0 ${w} ${h + 10}"><path class="spark-line" d="${pathD}"/>${dots}${labels}</svg>`;
}

function matchesFilter(convo) {
  if (activeFilter === 'all') return true;
  const [dim, threshold] = activeFilter.split('<');
  const thresh = parseFloat(threshold);
  for (const t of convo.turns) {
    if (t.scores && t.scores[dim] != null && t.scores[dim] < thresh) return true;
  }
  return false;
}

function renderConversations(report) {
  const convos = [...report.conversations]
    .filter(c => c.avg_score != null)
    .sort((a, b) => a.avg_score - b.avg_score)
    .filter(matchesFilter);

  if (convos.length === 0) {
    $('#conversations').innerHTML = '<div class="empty">No conversations match this filter.</div>';
    return;
  }

  $('#conversations').innerHTML = convos.map((c, ci) => `
    <div class="convo" id="convo-${ci}">
      <div class="convo-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="convo-name">${esc(c.name)}</span>
        <span class="convo-score" style="color:${scoreColorHex(c.avg_score)}">${c.avg_score != null ? c.avg_score.toFixed(1) : '?'}</span>
      </div>
      <div class="convo-body">
        ${c.turns.map(t => `
          <div class="turn">
            <div class="turn-user"><span>User:</span> ${esc(t.user)}</div>
            <div class="turn-response">${esc(t.response)}</div>
            <div class="turn-scores">
              ${t.scores ? ['voice', 'picks', 'density'].map(d =>
                t.scores[d] != null ? `<div class="dim"><span class="dim-label">${d}:</span> <span style="color:${scoreColorHex(t.scores[d])};font-weight:700">${t.scores[d]}</span></div>` : ''
              ).join('') : '<span style="color:#666">No scores</span>'}
            </div>
            ${t.note ? `<div class="turn-note">${esc(t.note)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Filter buttons
$('#filters').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  $$('#filters button').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  activeFilter = e.target.dataset.filter;
  if (currentReport) renderConversations(currentReport);
});

// Report selector
$('#reportSelect').addEventListener('change', async (e) => {
  const filename = e.target.value;
  if (!filename) return;
  const res = await fetch(`/api/eval-reports/${filename}`);
  currentReport = await res.json();
  renderSummary(currentReport);
  renderConversations(currentReport);
});

// Init
(async function init() {
  const res = await fetch('/api/eval-reports?type=quality');
  const reports = await res.json();
  allReports = reports;

  if (reports.length === 0) {
    $('#reportSelect').innerHTML = '<option>No quality reports yet</option>';
    $('#conversations').innerHTML = '<div class="empty">Run <code>npm run eval:quality</code> to generate your first report.</div>';
    return;
  }

  $('#reportSelect').innerHTML = reports.map(r =>
    `<option value="${r.filename}">${new Date(r.timestamp).toLocaleString()} - avg ${r.avg_score != null ? r.avg_score.toFixed(1) : '?'}/5 (${r.conversations} convos)</option>`
  ).join('');

  renderSparkline(reports);

  // Load most recent
  const latest = reports[0];
  const fullRes = await fetch(`/api/eval-reports/${latest.filename}`);
  currentReport = await fullRes.json();
  renderSummary(currentReport);
  renderConversations(currentReport);
})();
</script>
</body>
</html>
```

**Step 3: Verify syntax**

Run: `node -c src/server.js`
Expected: No output (syntax OK)

**Step 4: Commit**

```bash
git add src/eval-quality.html src/server.js
git commit -m "feat: add /eval-quality browse page for quality eval reports"
```

---

### Task 5: Add npm script

**Files:**
- Modify: `package.json`

**Step 1: Add the eval:quality script**

In `package.json` scripts section, add:

```json
"eval:quality": "node scripts/run-quality-evals.js"
```

**Step 2: Commit**

```bash
git add package.json
git commit -m "feat: add eval:quality npm script"
```

---

### Task 6: Smoke test end-to-end

**Step 1: Start the server**

Run: `PULSE_TEST_MODE=true PULSE_NO_RATE_LIMIT=true node src/server.js`

Wait for cache to load (look for "Bestie listening on port 3000" and cache ready message).

**Step 2: Run the quality eval against localhost**

Run (in another terminal): `npm run eval:quality`

Expected output pattern:
```
Running 10 quality evals against http://localhost:3000 (concurrency: 5)

[1/10 10% Xs] N.N  cold neighborhood open
[2/10 20% Xs] N.N  category with neighborhood
...
============================================================
Quality eval: 10 conversations, avg N.N/5
  Voice: N.N  Picks: N.N  Density: N.N
  Worst: "..." (N.N), "..." (N.N)
  Cost: $0.00XX  Time: XXs
  Browse: http://localhost:3000/eval-quality
============================================================
Report saved: data/reports/quality-eval-YYYY-MM-DDTHH-MM-SS.json
```

**Step 3: Verify the browse page loads**

Open `http://localhost:3000/eval-quality` in a browser. Check:
- Report selector shows the report you just generated
- Dimension averages display with color coding
- Conversations are listed, sorted worst-first
- Clicking a conversation card expands it to show turns
- Filter buttons work (e.g. "Picks < 3" filters the list)

**Step 4: Verify the report JSON is valid**

Run: `node -e "const r = JSON.parse(require('fs').readFileSync(require('fs').readdirSync('data/reports').filter(f=>f.startsWith('quality-eval')).sort().reverse().map(f=>'data/reports/'+f)[0],'utf8')); console.log('Conversations:', r.conversations.length, 'Avg:', r.summary.avg_score)"`

**Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: quality eval smoke test fixes"
```
