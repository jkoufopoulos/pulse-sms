#!/usr/bin/env node
/**
 * Review captured test conversations and optionally convert them to eval scenarios.
 *
 * Usage:
 *   node scripts/review-conversations.js              # interactive review
 *   node scripts/review-conversations.js --list       # list all conversations
 *   node scripts/review-conversations.js --date 2026-02-23  # filter by date
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONVERSATIONS_DIR = path.join(__dirname, '..', 'data', 'conversations');
const SCENARIOS_FILE = path.join(__dirname, '..', 'data', 'fixtures', 'multi-turn-scenarios.json');

function loadConversations(dateFilter) {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    console.log('No conversations directory found. Run the server in test mode first.');
    process.exit(0);
  }

  const files = fs.readdirSync(CONVERSATIONS_DIR)
    .filter(f => f.startsWith('conversations-') && f.endsWith('.jsonl'))
    .filter(f => !dateFilter || f.includes(dateFilter))
    .sort();

  if (files.length === 0) {
    console.log('No conversation files found.' + (dateFilter ? ` (filter: ${dateFilter})` : ''));
    process.exit(0);
  }

  const conversations = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf8')
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      try {
        conversations.push({ ...JSON.parse(line), _file: file });
      } catch { /* skip malformed */ }
    }
  }

  return conversations;
}

function displayConversation(conv, index, total) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Conversation ${index + 1}/${total}  |  ${conv.turn_count} turns  |  ${conv.phone_masked}`);
  console.log(`${conv.started_at} → ${conv.ended_at}`);
  console.log('='.repeat(60));

  for (const turn of conv.turns) {
    const prefix = turn.sender === 'user' ? '  YOU>' : 'PULSE>';
    console.log(`${prefix} ${turn.message}`);
    if (turn._meta) {
      const meta = turn._meta;
      const tags = [
        meta.intent,
        meta.neighborhood,
        meta.pre_routed ? 'pre-routed' : null,
        meta.latency_ms ? `${meta.latency_ms}ms` : null
      ].filter(Boolean).join(', ');
      if (tags) console.log(`       [${tags}]`);
    }
  }
  console.log();
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function stripMeta(turns) {
  return turns.map(t => {
    const clean = { sender: t.sender, message: t.message };
    return clean;
  });
}

async function saveAsScenario(rl, conv) {
  const name = await prompt(rl, 'Scenario name: ');
  if (!name.trim()) {
    console.log('Skipped (no name).');
    return false;
  }

  const categoryInput = await prompt(rl, 'Category (happy_path/filter_drift/temporal/off_topic/edge_case): ');
  const category = categoryInput.trim() || 'happy_path';

  const testing = await prompt(rl, 'What is this testing? ');
  const expected = await prompt(rl, 'Expected behavior: ');
  const failureInput = await prompt(rl, 'Failure modes (comma-separated): ');
  const failure_modes = failureInput.split(',').map(s => s.trim()).filter(Boolean);

  const scenario = {
    name: name.trim(),
    category,
    turns: stripMeta(conv.turns),
    testing: testing.trim() || `Captured from test session ${conv.started_at}`,
    expected_behavior: expected.trim() || 'Matches captured behavior',
    failure_modes: failure_modes.length ? failure_modes : ['Regression from captured behavior']
  };

  // Append to scenarios file
  const data = JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8'));
  data.scenarios.push(scenario);
  fs.writeFileSync(SCENARIOS_FILE, JSON.stringify(data, null, 2) + '\n');

  console.log(`Saved as scenario "${name.trim()}" (${data.scenarios.length} total scenarios)`);
  return true;
}

async function interactiveReview(conversations) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let saved = 0;
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    displayConversation(conv, i, conversations.length);

    const action = await prompt(rl, '[s]ave as scenario, [d]elete, [enter] to skip: ');

    if (action.toLowerCase() === 's') {
      const ok = await saveAsScenario(rl, conv);
      if (ok) saved++;
    } else if (action.toLowerCase() === 'd') {
      console.log('(Delete not implemented — manually remove from JSONL if needed)');
    }
  }

  console.log(`\nDone. ${saved} conversations saved as scenarios.`);
  rl.close();
}

function listConversations(conversations) {
  console.log(`\n${conversations.length} captured conversations:\n`);
  for (let i = 0; i < conversations.length; i++) {
    const c = conversations[i];
    const firstUser = c.turns.find(t => t.sender === 'user');
    const preview = firstUser ? firstUser.message.slice(0, 40) : '(empty)';
    console.log(`  ${i + 1}. [${c.turn_count} turns] ${c.phone_masked}  "${preview}"  (${c.started_at})`);
  }
  console.log();
}

// --- Main ---
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const dateIdx = args.indexOf('--date');
const dateFilter = dateIdx >= 0 ? args[dateIdx + 1] : null;

const conversations = loadConversations(dateFilter);

if (listOnly) {
  listConversations(conversations);
} else {
  interactiveReview(conversations).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
