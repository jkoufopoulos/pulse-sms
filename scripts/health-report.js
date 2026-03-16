// Quick script to dump source health history and failure patterns
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('data/health-cache.json', 'utf8'));

console.log('=== SOURCE HEALTH REPORT ===\n');

// All sources with any non-ok history
for (const [label, h] of Object.entries(data)) {
  if (!h || !h.history || h.history.length === 0) continue;
  const failures = h.history.filter(e => e.status !== 'ok');
  if (failures.length === 0 && !h.consecutiveZeros && !h.lastQuarantineReason) continue;

  console.log(`\n--- ${label} ---`);
  console.log(`  Scrapes: ${h.totalScrapes} | Successes: ${h.totalSuccesses} | Success rate: ${h.totalScrapes ? ((h.totalSuccesses / h.totalScrapes) * 100).toFixed(0) : 0}%`);
  console.log(`  Consecutive zeros: ${h.consecutiveZeros} | Last status: ${h.lastStatus}`);
  if (h.lastQuarantineReason) console.log(`  Quarantine reason: ${h.lastQuarantineReason}`);
  if (h.lastError) console.log(`  Last error: ${h.lastError}`);
  console.log(`  History (${h.history.length} entries):`);
  for (const e of h.history) {
    const d = (e.timestamp || '?').slice(0, 16);
    const dur = e.durationMs ? (e.durationMs / 1000).toFixed(1) + 's' : '?';
    console.log(`    ${d} | ${e.status.padEnd(12)} | count=${String(e.count).padStart(4)} | ${dur}`);
  }
}

// Summary table
console.log('\n\n=== SUMMARY ===\n');
const rows = [];
for (const [label, h] of Object.entries(data)) {
  if (!h || !h.history) continue;
  const total = h.totalScrapes || 0;
  const ok = h.totalSuccesses || 0;
  const failCount = h.history.filter(e => e.status !== 'ok').length;
  const histTotal = h.history.length;
  rows.push({ label, total, ok, rate: total ? ((ok / total) * 100).toFixed(0) : '0', failCount, histTotal, status: h.lastStatus, zeros: h.consecutiveZeros || 0 });
}
rows.sort((a, b) => a.rate - b.rate);
console.log('Source'.padEnd(20) + 'Scrapes'.padStart(8) + 'OK'.padStart(5) + 'Rate'.padStart(6) + 'ConsecZ'.padStart(8) + '  Status');
for (const r of rows) {
  console.log(r.label.padEnd(20) + String(r.total).padStart(8) + String(r.ok).padStart(5) + (r.rate + '%').padStart(6) + String(r.zeros).padStart(8) + '  ' + r.status);
}

// Also check digests
console.log('\n\n=== DAILY DIGESTS ===\n');
try {
  const Database = require('better-sqlite3');
  const db = new Database('data/pulse.db', { readonly: true });
  const digests = db.prepare('SELECT id, status, generated_at, report FROM daily_digests ORDER BY id DESC LIMIT 14').all();
  for (const d of digests) {
    const report = JSON.parse(d.report);
    const attention = (report.sourcesNeedingAttention || []).map(s => `${s.label}(${s.severity})`).join(', ');
    console.log(`  ${d.id} | ${d.status.padEnd(7)} | events=${String(report.totalEvents || '?').padStart(5)} | sources_ok=${report.scrape?.sourcesOk || '?'} failed=${report.scrape?.sourcesFailed || '?'} empty=${report.scrape?.sourcesEmpty || '?'} quarantined=${report.scrape?.sourcesQuarantined || '?'}`);
    if (attention) console.log(`    attention: ${attention}`);
  }
  db.close();
} catch (err) {
  console.log('  Could not read digests:', err.message);
}

// Alert history
console.log('\n\n=== RECENT ALERTS ===\n');
try {
  const lines = fs.readFileSync('data/alerts.jsonl', 'utf8').trim().split('\n').filter(Boolean);
  const alerts = lines.map(l => JSON.parse(l)).slice(-20);
  for (const a of alerts) {
    const ts = (a.timestamp || '').slice(0, 16);
    console.log(`  ${ts} | ${a.type} | ${a.details?.label || a.details?.message || JSON.stringify(a.details).slice(0, 80)}`);
  }
} catch (err) {
  console.log('  Could not read alerts:', err.message);
}
