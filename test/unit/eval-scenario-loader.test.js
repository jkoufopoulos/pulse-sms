// test/unit/eval-scenario-loader.test.js
const { check } = require('../helpers');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadScenario, loadAllScenarios } = require('../../src/eval/carryover/scenario-loader');

console.log('\n--- eval-scenario-loader.test.js ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-scenarios-'));

// --- valid scenario with expect ---
const validPath = path.join(tmpDir, 'a-valid.json');
fs.writeFileSync(validPath, JSON.stringify({
  id: 'a-valid',
  description: 'test',
  turns: [{ user: 'hi', expect: { tool: 'search', args: { neighborhood: 'williamsburg' } } }],
}));
const valid = loadScenario(validPath);
check('loads valid scenario', valid.id === 'a-valid');
check('loaded scenario has 1 turn', valid.turns.length === 1);

// --- valid scenario WITHOUT expect (matcher is optional) ---
const noExpectPath = path.join(tmpDir, 'no-expect.json');
fs.writeFileSync(noExpectPath, JSON.stringify({
  id: 'no-expect',
  turns: [{ user: 'hi' }, { user: 'more' }],
}));
const noExpect = loadScenario(noExpectPath);
check('scenarios without expect blocks are valid', noExpect.turns.length === 2);

// --- missing id ---
const noIdPath = path.join(tmpDir, 'no-id.json');
fs.writeFileSync(noIdPath, JSON.stringify({ turns: [] }));
let threw = false;
try { loadScenario(noIdPath); } catch (e) { threw = true; }
check('throws when id missing', threw === true);

// --- empty turns ---
const noTurnsPath = path.join(tmpDir, 'no-turns.json');
fs.writeFileSync(noTurnsPath, JSON.stringify({ id: 'x', turns: [] }));
threw = false;
try { loadScenario(noTurnsPath); } catch (e) { threw = true; }
check('throws when turns empty', threw === true);

// --- turn missing user ---
const badTurnPath = path.join(tmpDir, 'bad-turn.json');
fs.writeFileSync(badTurnPath, JSON.stringify({ id: 'x', turns: [{ expect: { tool: 'search', args: {} } }] }));
threw = false;
try { loadScenario(badTurnPath); } catch (e) { threw = true; }
check('throws when turn missing user', threw === true);

// --- malformed expect (has expect but missing tool) ---
const badExpectPath = path.join(tmpDir, 'bad-expect.json');
fs.writeFileSync(badExpectPath, JSON.stringify({ id: 'x', turns: [{ user: 'hi', expect: { args: {} } }] }));
threw = false;
try { loadScenario(badExpectPath); } catch (e) { threw = true; }
check('throws when expect.tool missing', threw === true);

// --- loadAllScenarios reads dir, ignores non-json, sorts by filename ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-scenarios-dir-'));
fs.writeFileSync(path.join(dir, '02-second.json'), JSON.stringify({ id: '02', turns: [{ user: 'a' }] }));
fs.writeFileSync(path.join(dir, '01-first.json'), JSON.stringify({ id: '01', turns: [{ user: 'a' }] }));
fs.writeFileSync(path.join(dir, 'README.md'), 'ignore me');
const all = loadAllScenarios(dir);
check('loadAllScenarios skips non-json', all.length === 2);
check('loadAllScenarios sorts by filename', all[0].id === '01' && all[1].id === '02');

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(dir, { recursive: true, force: true });
