// Reads and validates carryover scenario JSON files.
// A scenario: { id, description?, turns: [{ user, expect? }] }.
// The expect block is optional — turns without it are scored only by the rubric.

const fs = require('fs');
const path = require('path');

function validateScenario(s, sourcePath) {
  const where = sourcePath ? ` (${sourcePath})` : '';
  if (typeof s !== 'object' || s === null) throw new Error(`scenario must be object${where}`);
  if (typeof s.id !== 'string' || s.id.length === 0) throw new Error(`scenario missing id${where}`);
  if (!Array.isArray(s.turns) || s.turns.length === 0) throw new Error(`scenario ${s.id} has no turns${where}`);
  for (let i = 0; i < s.turns.length; i++) {
    const t = s.turns[i];
    if (typeof t.user !== 'string') throw new Error(`scenario ${s.id} turn ${i} missing user${where}`);
    if (t.expect !== undefined) {
      if (typeof t.expect.tool !== 'string') {
        throw new Error(`scenario ${s.id} turn ${i} missing expect.tool${where}`);
      }
      if (!t.expect.args || typeof t.expect.args !== 'object') {
        throw new Error(`scenario ${s.id} turn ${i} missing expect.args${where}`);
      }
    }
  }
  return s;
}

function loadScenario(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`scenario ${filePath} not valid JSON: ${e.message}`); }
  return validateScenario(parsed, filePath);
}

function loadAllScenarios(dirPath) {
  const files = fs.readdirSync(dirPath)
    .filter(f => f.endsWith('.json'))
    .sort();
  return files.map(f => loadScenario(path.join(dirPath, f)));
}

module.exports = { loadScenario, loadAllScenarios, validateScenario };
