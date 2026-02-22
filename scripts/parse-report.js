const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2] || 'data/reports/scenario-eval-2026-02-22T03-10-53.json', 'utf8'));
console.log(`Total: ${r.total}  Pass: ${r.passed}  Fail: ${r.failed}  Error: ${r.errors}`);
console.log(`Pass rate: ${(r.passed / r.total * 100).toFixed(1)}%\n`);
const cats = {};
r.scenarios.forEach(s => {
  const c = s.category || 'unknown';
  if (!cats[c]) cats[c] = { p: 0, t: 0 };
  cats[c].t++;
  if (s.pass) cats[c].p++;
});
Object.entries(cats).forEach(([c, d]) => console.log(`  ${c}: ${d.p}/${d.t}`));

// Show failed scenario names
console.log('\nFailed:');
r.scenarios.filter(s => !s.pass).forEach(s => console.log(`  - ${s.name}`));
