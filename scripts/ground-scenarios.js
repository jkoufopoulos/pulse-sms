#!/usr/bin/env node
/**
 * Golden data generator for eval scenario turns.
 *
 * Two modes:
 *
 * 1. EXPAND (default) — Uses Claude to expand parenthetical placeholders
 *    like "(comedy picks)" into realistic golden SMS responses.
 *
 * 2. GENERATE (--generate N) — Creates N new scenarios for under-represented
 *    categories to rebalance toward target distribution:
 *      50% happy_path, 20% filter_drift, 15% edge_case, 15% poor_experience
 *
 * Golden examples serve as quality references for the LLM judge — the judge
 * compares actual responses against these for tone, structure, and behavior
 * (not exact content match, since events change daily).
 *
 * Usage:
 *   node scripts/ground-scenarios.js                          # Expand parenthetical turns
 *   node scripts/ground-scenarios.js --dry-run                # Preview without writing
 *   node scripts/ground-scenarios.js --reground               # Replace ALL non-asserted pulse turns
 *   node scripts/ground-scenarios.js --category edge_case     # Filter by category
 *   node scripts/ground-scenarios.js --name "orphaned"        # Filter by name
 *   node scripts/ground-scenarios.js --generate 30            # Generate 30 new scenarios
 *   node scripts/ground-scenarios.js --generate 30 --dry-run  # Preview generation plan
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reground = args.includes('--reground');
const generateCount = args.find(a => a.startsWith('--generate='))?.split('=')[1]
  || (args.includes('--generate') ? args[args.indexOf('--generate') + 1] : null);
const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1]
  || (args.includes('--category') ? args[args.indexOf('--category') + 1] : null);
const nameFilter = args.find(a => a.startsWith('--name='))?.split('=')[1]
  || (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);

const MODEL = process.env.PULSE_MODEL_GROUND || 'claude-sonnet-4-5-20250929';
const client = new Anthropic();

// ─── Target distribution ───────────────────────────────────────────
const TARGET_DIST = {
  happy_path: 0.50,
  filter_drift: 0.20,
  poor_experience: 0.15,
  edge_case: 0.15,
};

// ─── System prompts ────────────────────────────────────────────────

const EXPAND_SYSTEM = `You are writing golden example SMS responses for Pulse, an NYC nightlife SMS bot.

You'll receive a multi-turn scenario with context (what's being tested, expected behavior, failure modes) and a conversation where some pulse turns are parenthetical placeholders like "(comedy picks)". Your job is to write what an IDEAL pulse response would look like for each placeholder.

STYLE RULES (match these exactly — study the existing golden examples):
- Casual, opinionated, like a knowledgeable friend texting you
- Use dashes (—) not colons for descriptions
- Numbered picks: "1) Event Name at Venue — description. Time, Price"
- Keep under 480 characters per response
- End pick lists with "Reply 1-N for details, MORE for extra picks" (or just "Reply 1 for details" if single pick)
- Details responses: venue color + event specifics + time + price + URL
- Sign-offs: brief and warm ("Anytime! Have a great night.", "Enjoy! Text me anytime.")
- Conversational responses: brief, warm, redirect to events when appropriate
- Never robotic, never "I'm sorry", never overly formal
- Use real NYC venues that make sense for the neighborhood
- Made-up events are fine — these are golden examples, not live data
- When the scenario context says "nudge to nearby" — use actual nearby NYC neighborhoods
- Exhaustion messages: acknowledge honestly, suggest nearby neighborhood
- Filter clearing: brief acknowledgment + fresh picks

FORMATTING:
- Return ONLY a JSON array of strings, one per parenthetical turn to replace
- The array length must match exactly the number of parenthetical turns you're asked to expand
- No markdown fences, no explanation — just the JSON array`;

const GENERATE_SYSTEM = `You are writing multi-turn test scenarios for Pulse, an NYC nightlife SMS bot.

Pulse is an SMS service — users text a neighborhood name and get curated NYC event picks. They can reply numbers for details, "more" for extra picks, filter by category ("comedy", "jazz"), price ("free"), or time ("later tonight"), and switch neighborhoods.

You'll receive:
1. A category to write scenarios for (happy_path, filter_drift, poor_experience, edge_case)
2. A count of how many to generate
3. Existing scenario names to avoid duplicating
4. Example scenarios showing the exact format and tone

Your job: write NEW multi-turn scenarios with fully-written golden pulse responses (no parentheticals).

SCENARIO STRUCTURE:
{
  "name": "Category: descriptive name",
  "category": "the_category",
  "turns": [
    { "sender": "user", "message": "the text message" },
    { "sender": "pulse", "message": "the ideal SMS response" }
  ],
  "testing": "What this scenario specifically tests",
  "expected_behavior": "What should happen at each step",
  "failure_modes": ["specific failure 1", "specific failure 2"],
  "difficulty": "must_pass|should_pass|stretch"
}

CATEGORY GUIDELINES:

happy_path — Normal, successful interactions that cover the bread-and-butter flows:
- Neighborhood → picks → details → sign-off (2-4 turns)
- Neighborhood → picks → more → picks (2-3 turns)
- Category request ("comedy in EV") → picks → details (2-3 turns)
- Neighborhood switch → picks (2-3 turns)
- Free events → picks (2-3 turns)
- Difficulty: must_pass or should_pass
- Keep these SHORT (2-4 user turns). Most real conversations are brief.
- Use different neighborhoods — not just Williamsburg/EV/LES every time

filter_drift — Tests that filters persist, compound, and clear correctly:
- Category filter persists through MORE
- Category filter persists through neighborhood switch
- Free + category compound correctly
- Filter clearing ("forget the comedy", "show me everything")
- Category replacement ("actually jazz" after comedy)
- Difficulty: should_pass

poor_experience — Thin results, nudges, negative feedback, exhaustion:
- Sparse neighborhood → nudge → accept/decline
- MORE exhaustion → nearby suggestion
- Negative feedback → graceful recovery
- Difficulty: should_pass

edge_case — Unusual inputs, boundary conditions:
- Gibberish, emoji, long messages, URLs
- Boroughs, ambiguous inputs, unsupported neighborhoods
- Difficulty: stretch

SMS STYLE RULES (for pulse responses):
- Casual, opinionated, like a knowledgeable friend texting
- Use em-dashes (—) not colons for descriptions
- Numbered picks: "1) Event Name at Venue — description. Time, Price"
- Keep under 480 characters per response
- End pick lists with "Reply 1-N for details, MORE for extra picks"
- Details: venue color + event specifics + time + price + URL
- Sign-offs: brief and warm
- Use real NYC venues that make sense for the neighborhood
- Made-up events are fine — these are golden examples

NYC NEIGHBORHOODS to use (vary these):
Williamsburg, Bushwick, Greenpoint, East Village, LES, West Village, Chelsea,
SoHo, NoHo, Midtown, Hell's Kitchen, Harlem, Park Slope, Crown Heights,
Bed-Stuy, Fort Greene, DUMBO, Prospect Heights, Cobble Hill, Gowanus,
Red Hook, Astoria, Long Island City, Downtown BK, Sunset Park

FORMATTING:
- Return ONLY a JSON array of scenario objects
- No markdown fences, no explanation — just the JSON array`;

// ─── Expand mode ───────────────────────────────────────────────────

function shouldGround(turn, isReground) {
  if (turn.sender !== 'pulse') return false;
  if (turn.assert) return false;
  if (isReground) return true;
  return turn.message.startsWith('(');
}

function buildExpandPrompt(scenario, groundableIndices) {
  const conversation = scenario.turns.map((t, i) => {
    const prefix = t.sender.toUpperCase();
    const marker = groundableIndices.includes(i) ? ' [EXPAND THIS]' : '';
    const assertNote = t.assert ? ` [PINNED: ${t.assert}]` : '';
    return `${prefix}: ${t.message}${marker}${assertNote}`;
  }).join('\n\n');

  const placeholders = groundableIndices.map(i => scenario.turns[i].message);

  return `Scenario: ${scenario.name}
Category: ${scenario.category}
Testing: ${scenario.testing}
Expected behavior: ${scenario.expected_behavior}
Failure modes: ${JSON.stringify(scenario.failure_modes)}

<conversation>
${conversation}
</conversation>

Expand these ${placeholders.length} placeholder(s) into golden SMS responses:
${placeholders.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Return a JSON array of ${placeholders.length} string(s).`;
}

async function expandTurns(scenario, groundableIndices) {
  const prompt = buildExpandPrompt(scenario, groundableIndices);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: EXPAND_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 30000 });

  const text = response.content?.[0]?.text || '';
  return parseJsonArray(text, groundableIndices.length);
}

// ─── Generate mode ─────────────────────────────────────────────────

function computeGenerationPlan(existingScenarios, totalToGenerate) {
  const current = {};
  for (const cat of Object.keys(TARGET_DIST)) current[cat] = 0;
  for (const s of existingScenarios) {
    if (current[s.category] !== undefined) current[s.category]++;
  }
  const currentTotal = existingScenarios.length;
  const futureTotal = currentTotal + totalToGenerate;

  // Compute how many each category needs to reach target %
  const plan = {};
  let allocated = 0;
  const cats = Object.keys(TARGET_DIST);

  for (const cat of cats) {
    const targetCount = Math.round(futureTotal * TARGET_DIST[cat]);
    const needed = Math.max(0, targetCount - current[cat]);
    plan[cat] = needed;
    allocated += needed;
  }

  // If we allocated more or fewer than requested, adjust happy_path
  const diff = totalToGenerate - allocated;
  plan.happy_path = Math.max(0, plan.happy_path + diff);

  return { current, plan, futureTotal };
}

function buildGeneratePrompt(category, count, existingNames, exampleScenarios) {
  const examples = exampleScenarios.slice(0, 3).map(s => JSON.stringify(s, null, 2)).join('\n\n');

  return `Generate ${count} new "${category}" scenarios.

EXISTING SCENARIO NAMES (do not duplicate these themes):
${existingNames.map(n => `- ${n}`).join('\n')}

EXAMPLE SCENARIOS (match this format and tone exactly):
${examples}

Generate ${count} new, unique scenarios. Each should test a different specific behavior.
Vary the neighborhoods used. Keep user turns natural and casual.
For happy_path: keep scenarios short (2-4 user turns) — most real SMS conversations are brief.

Return a JSON array of ${count} scenario object(s).`;
}

async function generateScenarios(category, count, existingNames, exampleScenarios) {
  const prompt = buildGeneratePrompt(category, count, existingNames, exampleScenarios);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: GENERATE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 120000 });

  const text = response.content?.[0]?.text || '';
  return parseJsonArray(text, count);
}

// ─── Shared utilities ──────────────────────────────────────────────

function parseJsonArray(text, expectedLength) {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();

  const start = jsonStr.indexOf('[');
  if (start === -1) throw new Error('No JSON array found in response');

  for (let end = jsonStr.lastIndexOf(']'); end > start; end = jsonStr.lastIndexOf(']', end - 1)) {
    try {
      const parsed = JSON.parse(jsonStr.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      if (parsed.length !== expectedLength) {
        throw new Error(`Expected ${expectedLength} items, got ${parsed.length}`);
      }
      return parsed;
    } catch (e) {
      if (e.message.startsWith('Expected')) throw e;
    }
  }
  throw new Error('Failed to parse JSON array from response');
}

function validateScenario(scenario) {
  const issues = [];
  if (!scenario.name || typeof scenario.name !== 'string') issues.push('missing name');
  if (!scenario.category) issues.push('missing category');
  if (!Array.isArray(scenario.turns) || scenario.turns.length < 2) issues.push('needs 2+ turns');
  if (!scenario.testing) issues.push('missing testing');
  if (!scenario.expected_behavior) issues.push('missing expected_behavior');
  if (!Array.isArray(scenario.failure_modes)) issues.push('missing failure_modes');

  if (scenario.turns) {
    for (const turn of scenario.turns) {
      if (turn.sender === 'pulse' && turn.message.length > 480) {
        issues.push(`pulse turn over 480 chars (${turn.message.length})`);
      }
      if (turn.sender === 'pulse' && turn.message.startsWith('(')) {
        issues.push('has parenthetical placeholder');
      }
    }
  }
  return issues;
}

// ─── Main ──────────────────────────────────────────────────────────

async function runExpand(data, scenarios) {
  const toGround = [];
  for (const scenario of scenarios) {
    const groundableIndices = [];
    for (let i = 0; i < scenario.turns.length; i++) {
      if (shouldGround(scenario.turns[i], reground)) {
        groundableIndices.push(i);
      }
    }
    if (groundableIndices.length > 0) {
      toGround.push({ scenario, groundableIndices });
    }
  }

  if (toGround.length === 0) {
    console.log('No scenarios with groundable turns found.');
    return;
  }

  const totalTurns = toGround.reduce((sum, g) => sum + g.groundableIndices.length, 0);
  const mode = reground ? 'REGROUND' : 'EXPAND';
  console.log(`${mode}: ${toGround.length} scenarios, ${totalTurns} turns to expand`);
  if (dryRun) console.log('(dry run — no changes will be written)\n');
  else console.log('');

  let groundedScenarios = 0;
  let groundedTurns = 0;
  let warnings = 0;

  for (let i = 0; i < toGround.length; i++) {
    const { scenario, groundableIndices } = toGround[i];
    process.stdout.write(`[${i + 1}/${toGround.length}] ${scenario.name} (${groundableIndices.length} turns)... `);

    try {
      const goldenResponses = await expandTurns(scenario, groundableIndices);

      let turnWarnings = 0;
      for (let j = 0; j < goldenResponses.length; j++) {
        const resp = goldenResponses[j];
        if (typeof resp !== 'string' || resp.length === 0) {
          console.log(`\n  WARNING: Empty response for turn ${groundableIndices[j]}`);
          turnWarnings++;
          continue;
        }
        if (resp.length > 480) {
          console.log(`\n  WARNING: Response ${j + 1} is ${resp.length} chars (max 480)`);
          turnWarnings++;
        }
      }

      if (!dryRun) {
        for (let j = 0; j < groundableIndices.length; j++) {
          const resp = goldenResponses[j];
          if (typeof resp === 'string' && resp.length > 0) {
            scenario.turns[groundableIndices[j]].message = resp;
            groundedTurns++;
          }
        }
        scenario.grounded_at = new Date().toISOString();
        groundedScenarios++;
      } else {
        groundedTurns += groundableIndices.length;
        groundedScenarios++;
        const preview = goldenResponses[0];
        const truncated = preview.length > 80 ? preview.slice(0, 80) + '...' : preview;
        console.log(`\x1b[32mOK\x1b[0m  "${truncated}"`);
        continue;
      }

      warnings += turnWarnings;
      console.log(turnWarnings > 0 ? `\x1b[33mOK (${turnWarnings} warnings)\x1b[0m` : '\x1b[32mOK\x1b[0m');

    } catch (err) {
      warnings++;
      console.log(`\x1b[33mSKIPPED\x1b[0m  ${err.message}`);
    }
  }

  const skipped = scenarios.length - groundedScenarios;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${mode}: ${groundedScenarios} scenarios, ${groundedTurns} turns ${dryRun ? 'to expand' : 'expanded'}`);
  console.log(`SKIPPED:  ${skipped} scenarios (already grounded)`);
  console.log(`WARNINGS: ${warnings}`);
  console.log(`${'='.repeat(60)}`);
}

async function runGenerate(data, totalToGenerate) {
  const { current, plan, futureTotal } = computeGenerationPlan(data.scenarios, totalToGenerate);

  console.log('Current distribution:');
  for (const [cat, count] of Object.entries(current)) {
    const pct = data.scenarios.length > 0 ? Math.round(count / data.scenarios.length * 100) : 0;
    console.log(`  ${cat}: ${count} (${pct}%) — target ${Math.round(TARGET_DIST[cat] * 100)}%`);
  }

  const toGenerate = Object.entries(plan).filter(([, count]) => count > 0);
  const totalPlanned = toGenerate.reduce((s, [, c]) => s + c, 0);

  console.log(`\nGeneration plan (${totalPlanned} new scenarios → ${futureTotal} total):`);
  for (const [cat, count] of toGenerate) {
    const futurePct = Math.round((current[cat] + count) / futureTotal * 100);
    console.log(`  ${cat}: +${count} (→ ${current[cat] + count}, ${futurePct}%)`);
  }

  if (dryRun) {
    console.log('\n(dry run — no scenarios will be generated)');
    return;
  }

  console.log('');

  const existingNames = data.scenarios.map(s => s.name);
  let generated = 0;
  let warnings = 0;

  const BATCH_SIZE = 5;

  for (const [category, count] of toGenerate) {
    const batches = [];
    for (let i = 0; i < count; i += BATCH_SIZE) {
      batches.push(Math.min(BATCH_SIZE, count - i));
    }

    let catGenerated = 0;
    let catWarnings = 0;

    for (let b = 0; b < batches.length; b++) {
      const batchCount = batches[b];
      process.stdout.write(`  ${category} [${b + 1}/${batches.length}] generating ${batchCount}... `);

      try {
        const examples = data.scenarios.filter(s => s.category === category).slice(0, 3);
        const referenceExamples = examples.length > 0 ? examples : data.scenarios.filter(s => s.category === 'happy_path').slice(0, 3);

        const newScenarios = await generateScenarios(category, batchCount, existingNames, referenceExamples);

        for (const scenario of newScenarios) {
          if (!scenario.difficulty) scenario.difficulty = category === 'happy_path' ? 'should_pass' : 'stretch';
          scenario.grounded_at = new Date().toISOString();

          const issues = validateScenario(scenario);
          if (issues.length > 0) {
            console.log(`\n  WARNING: ${scenario.name || 'unnamed'}: ${issues.join(', ')}`);
            catWarnings++;
          }

          data.scenarios.push(scenario);
          existingNames.push(scenario.name);
          catGenerated++;
          generated++;
        }

        console.log('\x1b[32mOK\x1b[0m');
      } catch (err) {
        catWarnings++;
        warnings++;
        console.log(`\x1b[33mERROR\x1b[0m  ${err.message}`);
      }
    }

    console.log(`  ${category}: ${catGenerated}/${count} generated${catWarnings > 0 ? ` (${catWarnings} warnings)` : ''}`);
    warnings += catWarnings;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`GENERATED: ${generated} new scenarios`);
  console.log(`TOTAL:     ${data.scenarios.length} scenarios`);
  console.log(`WARNINGS:  ${warnings}`);

  // Show new distribution
  const newDist = {};
  for (const s of data.scenarios) {
    newDist[s.category] = (newDist[s.category] || 0) + 1;
  }
  console.log('\nNew distribution:');
  for (const [cat, count] of Object.entries(newDist)) {
    const pct = Math.round(count / data.scenarios.length * 100);
    const target = TARGET_DIST[cat] ? Math.round(TARGET_DIST[cat] * 100) : '?';
    console.log(`  ${cat}: ${count} (${pct}%) — target ${target}%`);
  }
  console.log(`${'='.repeat(60)}`);
}

async function main() {
  const scenariosPath = path.join(__dirname, '..', 'data', 'fixtures', 'multi-turn-scenarios.json');
  if (!fs.existsSync(scenariosPath)) {
    console.error('No scenarios found at data/fixtures/multi-turn-scenarios.json');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));

  if (generateCount) {
    // Generate mode
    const count = parseInt(generateCount, 10);
    if (isNaN(count) || count < 1) {
      console.error('--generate requires a positive number');
      process.exit(1);
    }
    await runGenerate(data, count);
  } else {
    // Expand mode
    let scenarios = data.scenarios;
    if (categoryFilter) {
      scenarios = scenarios.filter(s => s.category === categoryFilter);
      console.log(`Filtered to ${scenarios.length} scenarios in category "${categoryFilter}"`);
    }
    if (nameFilter) {
      const lower = nameFilter.toLowerCase();
      scenarios = scenarios.filter(s => s.name.toLowerCase().includes(lower));
      console.log(`Filtered to ${scenarios.length} scenarios matching "${nameFilter}"`);
    }
    await runExpand(data, scenarios);
  }

  // Write back (both modes)
  if (!dryRun) {
    fs.writeFileSync(scenariosPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`\nWrote ${scenariosPath}`);
  } else {
    console.log('\nRun without --dry-run to write changes.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
