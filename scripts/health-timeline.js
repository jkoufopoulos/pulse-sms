// Build per-source failure timeline from daily digests
const Database = require('better-sqlite3');
const db = new Database('data/pulse.db', { readonly: true });
const digests = db.prepare('SELECT id, report FROM daily_digests ORDER BY id ASC').all();

const timeline = {};
const dates = [];

for (const d of digests) {
  const r = JSON.parse(d.report);
  dates.push(d.id);
  for (const s of (r.sources || [])) {
    if (!timeline[s.name]) timeline[s.name] = {};
    timeline[s.name][d.id] = { count: s.count, status: s.status, avg: s.avg_7d };
  }
}

console.log('Dates covered:', dates[0], 'to', dates[dates.length - 1], '(' + dates.length + ' days)\n');

// Sources with any failures
console.log('=== SOURCES WITH FAILURES ===\n');
for (const [name, days] of Object.entries(timeline)) {
  const entries = Object.entries(days);
  const warns = entries.filter(([d, v]) => v.status === 'warn' || v.count === 0);
  if (warns.length === 0) continue;

  console.log(name + ' (' + warns.length + '/' + entries.length + ' days with issues):');
  for (const [date, v] of entries) {
    const flag = (v.status === 'warn' || v.count === 0) ? ' <<<' : '';
    console.log('  ' + date + ' | count=' + String(v.count).padStart(4) + ' | avg=' + String(v.avg || '?').padStart(4) + ' | ' + v.status + flag);
  }
  console.log('');
}

// Stable sources summary
console.log('\n=== STABLE SOURCES ===\n');
for (const [name, days] of Object.entries(timeline)) {
  const entries = Object.entries(days);
  const warns = entries.filter(([d, v]) => v.status === 'warn' || v.count === 0);
  if (warns.length > 0) continue;
  const counts = entries.map(([, v]) => v.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const avg = (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(0);
  console.log('  ' + name.padEnd(20) + 'avg=' + String(avg).padStart(4) + '  min=' + String(min).padStart(4) + '  max=' + String(max).padStart(4) + '  (' + entries.length + ' days)');
}

// Attention items across all digests
console.log('\n\n=== ATTENTION ITEMS BY DATE ===\n');
for (const d of digests) {
  const r = JSON.parse(d.report);
  const attn = r.needs_attention || [];
  if (attn.length === 0) continue;
  console.log(d.id + ' (' + r.status + '):');
  for (const a of attn) {
    console.log('  ' + a.severity + ': ' + a.source + ' -- ' + a.issue);
  }
  console.log('');
}

// Failure frequency
console.log('\n=== FAILURE FREQUENCY (sources ranked by failure days) ===\n');
const freq = [];
for (const [name, days] of Object.entries(timeline)) {
  const entries = Object.entries(days);
  const failDays = entries.filter(([d, v]) => v.status === 'warn' || v.count === 0).length;
  if (failDays > 0) {
    freq.push({ name, failDays, totalDays: entries.length, rate: ((failDays / entries.length) * 100).toFixed(0) });
  }
}
freq.sort((a, b) => b.failDays - a.failDays);
console.log('Source'.padEnd(20) + 'Fail days'.padStart(10) + '  /  Total'.padStart(10) + '  Rate');
for (const f of freq) {
  console.log(f.name.padEnd(20) + String(f.failDays).padStart(10) + ('  /  ' + f.totalDays).padStart(10) + ('  ' + f.rate + '%'));
}

db.close();
