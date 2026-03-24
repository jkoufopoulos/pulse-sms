#!/usr/bin/env node
/**
 * daily-trace-digest.js — Sample 10 random traces from yesterday and email a summary.
 * Run manually: node scripts/daily-trace-digest.js
 * Or hooked into scheduleDailyScrape post-scrape.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

function getYesterdayDateString() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const year = parseInt(parts.find(p => p.type === 'year').value);
  const month = parseInt(parts.find(p => p.type === 'month').value);
  const day = parseInt(parts.find(p => p.type === 'day').value);
  const yesterday = new Date(year, month - 1, day - 1);
  const yyyy = yesterday.getFullYear();
  const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
  const dd = String(yesterday.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function sampleTraces(traces, n) {
  const shuffled = [...traces].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function formatTrace(t, i) {
  const latency = t.total_latency_ms ? `${(t.total_latency_ms / 1000).toFixed(1)}s` : '?';
  const cost = t.total_ai_cost_usd ? `$${t.total_ai_cost_usd.toFixed(4)}` : '$0';
  const error = t.brain_error ? `  ERROR: ${t.brain_error}` : '';
  const sms = (t.output_sms || '').slice(0, 120);

  return [
    `#${i + 1} [${t.phone_masked || '???'}] ${latency} | ${cost}`,
    `  IN:  "${t.input_message || '?'}"`,
    `  OUT: "${sms}${sms.length >= 120 ? '...' : ''}"`,
    `  Tool: ${t.brain_tool || 'none'} | Provider: ${t.brain_provider || '?'} | Iterations: ${t.brain_iterations?.length || 0}`,
    error,
  ].filter(Boolean).join('\n');
}

async function run() {
  const dateStr = getYesterdayDateString();
  const traceFile = path.join(__dirname, '..', 'data', 'traces', `traces-${dateStr}.jsonl`);

  if (!fs.existsSync(traceFile)) {
    console.log(`No trace file for ${dateStr}`);
    return;
  }

  const lines = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
  const traces = [];
  for (const line of lines) {
    try { traces.push(JSON.parse(line)); } catch {}
  }

  if (traces.length === 0) {
    console.log(`No traces found for ${dateStr}`);
    return;
  }

  const sampled = sampleTraces(traces, 10);
  const errors = traces.filter(t => t.brain_error);
  const avgLatency = traces.reduce((s, t) => s + (t.total_latency_ms || 0), 0) / traces.length;
  const totalCost = traces.reduce((s, t) => s + (t.total_ai_cost_usd || 0), 0);

  const summary = [
    `DAILY TRACE DIGEST — ${dateStr}`,
    `${traces.length} conversations | ${errors.length} errors | avg ${(avgLatency / 1000).toFixed(1)}s | $${totalCost.toFixed(4)} total`,
    '',
    '--- 10 RANDOM SAMPLES ---',
    '',
    ...sampled.map((t, i) => formatTrace(t, i)),
  ].join('\n');

  console.log(summary);

  // Send via email if configured
  const { sendRuntimeAlert } = require('../src/alerts');
  await sendRuntimeAlert('daily-trace-digest', {
    date: dateStr,
    total_conversations: traces.length,
    errors: errors.length,
    avg_latency: `${(avgLatency / 1000).toFixed(1)}s`,
    total_cost: `$${totalCost.toFixed(4)}`,
    impact: `${traces.length} conversations sampled`,
    samples: '\n' + sampled.map((t, i) => formatTrace(t, i)).join('\n\n'),
  });
}

run().catch(err => {
  console.error('Trace digest failed:', err.message);
  process.exit(1);
});
