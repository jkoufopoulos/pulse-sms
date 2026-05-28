#!/usr/bin/env node
/**
 * atlas-runner.js — Phase 0 orchestrator.
 *
 * For each query in scripts/phase-0/comparison-queries.txt:
 *   1. Run hybrid retrieval (BM25 + dense) over cached events + embeddings
 *   2. POST the query to agent-Pulse on port 3000
 *   3. Capture both outputs into a markdown atlas
 *
 * Writes the atlas to docs/superpowers/plans/phase-0-output-atlas.md.
 *
 * Prerequisites:
 *   - agent-Pulse running on port 3000 with PULSE_TEST_MODE=true
 *   - data/embeddings-cache.json populated (from Task 2)
 *   - GEMINI_API_KEY in environment
 *
 * Usage:
 *   GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2- | tr -d '"') \
 *     node scripts/phase-0/atlas-runner.js
 */

const fs = require('fs');
const path = require('path');

const { buildIndex, hybridRetrieve } = require('./hybrid-retrieve');
const { embedQuery } = require('./embed-query');
const { callAgent } = require('./agent-caller');

const ROOT = path.resolve(__dirname, '../..');
const QUERIES_FILE = path.join(ROOT, 'scripts/phase-0/comparison-queries.txt');
const EVENTS_FILE = path.join(ROOT, 'data/events-cache.json');
const EMBED_FILE = path.join(ROOT, 'data/embeddings-cache.json');
const OUT_FILE = process.env.PULSE_OUT_FILE
  ? path.resolve(process.env.PULSE_OUT_FILE)
  : path.join(ROOT, 'docs/superpowers/plans/phase-0-output-atlas.md');

// PULSE_ROTATE_PHONE=true → use a fresh phone per query so the agent loop
// can't accumulate session state across the suite. Default is single phone
// to match the original Phase 0 run.
const ROTATE_PHONE = process.env.PULSE_ROTATE_PHONE === 'true';

const PAUSE_MS = 4000;   // pause between queries to be kind to LLM rate limits

function readQueries(text) {
  const lines = text.split('\n');
  let bucket = '?';
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/BUCKET (\w)/);
      if (m) bucket = m[1];
      continue;
    }
    out.push({ bucket, query: line });
  }
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmtAgentResponse(agentResp) {
  if (agentResp.error) return `_(error: ${agentResp.error})_`;
  const bodies = (agentResp.messages || []).map(m => m.body || JSON.stringify(m));
  if (bodies.length === 0) return '_(no SMS captured)_';
  return bodies.map(b => `> ${b.replace(/\n/g, '\n> ')}`).join('\n>\n');
}

function fmtHybridTop(hybridTop, eventsById) {
  if (hybridTop.length === 0) return '_(no results)_';
  return hybridTop.slice(0, 3).map((r, i) => {
    const e = eventsById[r.id];
    if (!e) return `${i + 1}. _(unknown event id ${r.id})_`;
    const hood = e.neighborhood || '?';
    const cat = e.category || '?';
    const ranks = `bm25=#${r.bm25Rank ?? '-'} vec=#${r.vecRank ?? '-'}`;
    return `${i + 1}. **${(e.name || '').slice(0, 50)}** — ${e.venue_name || '?'} (${hood}) [${cat}] _${ranks}_`;
  }).join('\n');
}

(async () => {
  // Load data
  console.log('Loading events cache...');
  const eventsCache = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  const events = eventsCache.events;
  const eventsById = Object.fromEntries(events.map(e => [e.id, e]));

  console.log(`Loading embeddings cache (this may take ~1s for 60MB)...`);
  const embedStore = JSON.parse(fs.readFileSync(EMBED_FILE, 'utf8'));
  const vectors = {};
  for (let i = 0; i < embedStore.ids.length; i++) {
    vectors[embedStore.ids[i]] = embedStore.vectors[i];
  }

  console.log('Building BM25 index over event cards...');
  const idx = buildIndex(events);

  console.log('Loading queries...');
  const queries = readQueries(fs.readFileSync(QUERIES_FILE, 'utf8'));
  console.log(`  ${queries.length} queries across ${new Set(queries.map(q => q.bucket)).size} buckets`);

  // Header
  let atlas = `# Phase 0 — Failure-Mode Atlas\n\n`;
  atlas += `Generated: ${new Date().toISOString()}\n`;
  atlas += `Events in corpus: ${events.length}\n`;
  atlas += `Queries: ${queries.length} across 4 buckets\n\n`;
  atlas += `---\n\n`;
  atlas += `**How to read the columns:**\n`;
  atlas += `- _Agent response_: full SMS captured from agent-Pulse on port 3000\n`;
  atlas += `- _Hybrid top-3_: top 3 events from BM25+vector RRF fusion over the same corpus\n`;
  atlas += `- _Agent right?_, _Hybrid right?_, _Failure mode_: leave blank during initial run; hand-annotate in Task 11\n\n`;
  atlas += `---\n\n`;

  for (let i = 0; i < queries.length; i++) {
    const { query, bucket } = queries[i];
    console.log(`\n[${i + 1}/${queries.length}] (${bucket}) "${query}"`);

    let hybridTop = [];
    let qVec = null;
    try {
      qVec = await embedQuery(query);
      hybridTop = hybridRetrieve({
        queryText: query,
        queryVector: qVec,
        index: idx,
        vectors,
        topK: 10,
        rrfK: 60,
      });
      console.log(`  hybrid: ${hybridTop.length} results, top = ${eventsById[hybridTop[0]?.id]?.name?.slice(0, 40) || '?'}`);
    } catch (err) {
      console.error(`  hybrid failed: ${err.message}`);
    }

    // Rotate phone per query when ROTATE_PHONE is set, to avoid session-state
    // carry-over from one query polluting the next (real issue surfaced by
    // the original Phase 0 run, esp. in Bucket C).
    const queryPhone = ROTATE_PHONE
      ? `+1555000${String(2000 + i).padStart(4, '0')}`
      : '+15550001234';

    let agentResp;
    try {
      agentResp = await callAgent(query, { phone: queryPhone });
      console.log(`  agent: ${(agentResp.messages || []).length} msg, intent=${agentResp.trace_summary?.intent || '?'}`);
    } catch (err) {
      agentResp = { error: err.message };
      console.error(`  agent failed: ${err.message}`);
    }

    atlas += `## ${bucket}-${i + 1}: "${query}"\n\n`;
    atlas += `**Agent response:**\n${fmtAgentResponse(agentResp)}\n\n`;
    atlas += `**Hybrid top-3:**\n${fmtHybridTop(hybridTop, eventsById)}\n\n`;
    atlas += `| Agent right? | Hybrid right? | Failure mode |\n`;
    atlas += `|---|---|---|\n`;
    atlas += `| _(annotate)_ | _(annotate)_ | _(annotate)_ |\n\n`;
    atlas += `---\n\n`;

    if (i < queries.length - 1) await sleep(PAUSE_MS);
  }

  fs.writeFileSync(OUT_FILE, atlas);
  console.log(`\nWrote ${OUT_FILE}`);
})().catch(e => { console.error('Atlas run failed:', e); process.exit(1); });
