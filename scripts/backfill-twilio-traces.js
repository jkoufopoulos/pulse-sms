#!/usr/bin/env node
// scripts/backfill-twilio-traces.js
//
// Pulls SMS history from Twilio for a phone number (or all numbers),
// pairs inbound with outbound, writes JSONL into data/traces/ matching
// the shape that scripts/ingest-production-traces.js consumes.
//
// Why: data/traces/ rotates at MAX_TRACE_FILES=4 and Railway storage
// is ephemeral, so real-user conversations older than ~4 days are
// gone locally. Twilio retains inbound SMS for ~13 months and is the
// only durable source. See memory: pulse-trace-persistence-gap.
//
// Usage:
//   node scripts/backfill-twilio-traces.js +12034149957
//   node scripts/backfill-twilio-traces.js 2034149957 --since 2026-03-01
//   node scripts/backfill-twilio-traces.js --all-inbound  # every number that has texted Pulse
//   node scripts/backfill-twilio-traces.js +12034149957 --dry
//
// Output: data/traces/backfill-twilio-{tail}-{YYYY-MM-DD}.jsonl
// Then:   node scripts/ingest-production-traces.js  (to load into bench)

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const twilio = require('twilio');
const { maskPhone } = require('../src/twilio');

const TRACES_DIR = path.join(__dirname, '..', 'data', 'traces');
const PAIRING_WINDOW_MS = 5 * 60 * 1000;  // 5 min — generous; Pulse usually responds <10s

function parseArgs(argv) {
  const args = { phone: null, since: null, allInbound: false, dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') args.since = argv[++i];
    else if (a === '--dry') args.dry = true;
    else if (a === '--all-inbound') args.allInbound = true;
    else if (!a.startsWith('--') && !args.phone) args.phone = a;
  }
  return args;
}

function normalizePhone(input) {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (input.startsWith('+') && digits.length >= 10) return '+' + digits;
  throw new Error(`Cannot parse phone "${input}" — provide E.164 (+12034149957) or 10 digits`);
}

async function listMessages(client, params) {
  const out = [];
  let pageOpts = { ...params, pageSize: 1000 };
  let page = await client.messages.page(pageOpts);
  while (page) {
    for (const m of page.instances) out.push(m);
    if (!page.nextPageUrl) break;
    page = await page.nextPage();
  }
  return out;
}

function pairConversation(inbound, outbound) {
  const events = [
    ...inbound.map(m => ({ kind: 'in', m })),
    ...outbound.map(m => ({ kind: 'out', m })),
  ].sort((a, b) => new Date(a.m.dateSent || a.m.dateCreated) - new Date(b.m.dateSent || b.m.dateCreated));

  const turns = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind !== 'in') continue;
    const inMsg = events[i].m;
    const inTime = new Date(inMsg.dateSent || inMsg.dateCreated);

    let pairedOut = null;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].kind === 'in') break;  // next inbound — stop searching
      const outTime = new Date(events[j].m.dateSent || events[j].m.dateCreated);
      if (outTime - inTime > PAIRING_WINDOW_MS) break;
      pairedOut = events[j].m;
      break;
    }
    turns.push({ inMsg, outMsg: pairedOut });
  }
  return turns;
}

function toTrace(inMsg, outMsg) {
  return {
    id: `twilio-backfill-${inMsg.sid}`,
    timestamp: new Date(inMsg.dateSent || inMsg.dateCreated).toISOString(),
    phone_masked: maskPhone(inMsg.from),
    input_message: inMsg.body || '',
    session_before: { lastNeighborhood: null, lastPicks: null },
    routing: null,
    events: null,
    composition: null,
    output_sms: outMsg ? (outMsg.body || '') : null,
    output_sms_length: outMsg ? (outMsg.body || '').length : 0,
    output_intent: null,
    total_latency_ms: outMsg ? (new Date(outMsg.dateSent || outMsg.dateCreated) - new Date(inMsg.dateSent || inMsg.dateCreated)) : 0,
    ai_costs: [],
    total_ai_cost_usd: 0,
    brain_prompt: null,
    brain_messages: null,
    brain_tool_calls: null,
    source: 'twilio-backfill',
  };
}

async function main() {
  const args = parseArgs(process.argv);

  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const PULSE_PHONE = process.env.TWILIO_PHONE_NUMBER;
  if (!SID || !TOKEN || !PULSE_PHONE) {
    console.error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER in env');
    process.exit(2);
  }
  const client = twilio(SID, TOKEN);

  const since = args.since ? new Date(args.since) : null;

  let conversations;  // Map<userPhone, { inbound: [], outbound: [] }>
  if (args.allInbound) {
    console.log(`[backfill] fetching ALL inbound to ${maskPhone(PULSE_PHONE)}${since ? ' since ' + args.since : ''}`);
    const allInbound = await listMessages(client, { to: PULSE_PHONE, dateSentAfter: since });
    const allOutbound = await listMessages(client, { from: PULSE_PHONE, dateSentAfter: since });
    conversations = new Map();
    for (const m of allInbound) {
      if (!conversations.has(m.from)) conversations.set(m.from, { inbound: [], outbound: [] });
      conversations.get(m.from).inbound.push(m);
    }
    for (const m of allOutbound) {
      if (!conversations.has(m.to)) conversations.set(m.to, { inbound: [], outbound: [] });
      conversations.get(m.to).outbound.push(m);
    }
  } else {
    if (!args.phone) {
      console.error('Provide a phone number or --all-inbound. See usage in file header.');
      process.exit(2);
    }
    const user = normalizePhone(args.phone);
    console.log(`[backfill] fetching ${maskPhone(user)} ↔ ${maskPhone(PULSE_PHONE)}${since ? ' since ' + args.since : ''}`);
    const inbound = await listMessages(client, { from: user, to: PULSE_PHONE, dateSentAfter: since });
    const outbound = await listMessages(client, { from: PULSE_PHONE, to: user, dateSentAfter: since });
    conversations = new Map([[user, { inbound, outbound }]]);
  }

  let totalTurns = 0, totalPhones = 0, totalUnpaired = 0;
  const tracesOut = [];

  for (const [userPhone, { inbound, outbound }] of conversations) {
    if (inbound.length === 0) continue;
    totalPhones++;
    const turns = pairConversation(inbound, outbound);
    let unpaired = 0;
    for (const t of turns) {
      tracesOut.push(toTrace(t.inMsg, t.outMsg));
      if (!t.outMsg) unpaired++;
    }
    totalTurns += turns.length;
    totalUnpaired += unpaired;
    console.log(`  ${maskPhone(userPhone)}: ${inbound.length} inbound, ${outbound.length} outbound → ${turns.length} turns (${unpaired} unpaired)`);
  }

  console.log(`[backfill] ${totalPhones} conversation(s), ${totalTurns} turns total, ${totalUnpaired} unpaired (no response in 5min)`);

  if (args.dry) {
    console.log('[dry-run] no file written. Sample (first 3 turns):');
    for (const t of tracesOut.slice(0, 3)) {
      console.log(`  ${t.timestamp} ${t.phone_masked} "${t.input_message.slice(0, 40)}" → "${(t.output_sms || '(none)').slice(0, 40)}"`);
    }
    return;
  }

  if (tracesOut.length === 0) {
    console.log('[backfill] nothing to write');
    return;
  }

  if (!fs.existsSync(TRACES_DIR)) fs.mkdirSync(TRACES_DIR, { recursive: true });
  const tail = args.allInbound ? 'all' : args.phone.replace(/\D/g, '').slice(-4);
  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(TRACES_DIR, `backfill-twilio-${tail}-${today}.jsonl`);
  const content = tracesOut.map(t => JSON.stringify(t)).join('\n') + '\n';
  fs.writeFileSync(outPath, content);

  console.log(`[backfill] wrote ${tracesOut.length} traces to ${outPath}`);
  console.log('[backfill] next: node scripts/ingest-production-traces.js');
}

main().catch(err => { console.error(err); process.exit(1); });
