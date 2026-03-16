// Fetch health data from Railway and display source histories
const https = require('https');

const url = 'https://web-production-c8fdb.up.railway.app/health';

https.get(url, (res) => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    try {
      const d = JSON.parse(Buffer.concat(chunks).toString());
      if (d.error || d.status === 'unauthorized') {
        console.log('Auth required or error:', d.error || d.status);
        return;
      }

      console.log('Status:', d.status);
      console.log('Cache:', d.cache ? `${d.cache.size} events, ${d.cache.age_minutes}min old` : 'n/a');

      if (!d.sources) { console.log('No source data'); return; }

      // All sources with history
      console.log('\n=== ALL SOURCES WITH FAILURES ===\n');
      for (const [label, s] of Object.entries(d.sources)) {
        const hist = s.history || [];
        const fails = hist.filter(h => h.status !== 'ok');
        if (fails.length === 0 && s.consecutive_zeros === 0 && !s.quarantine_reason) continue;

        console.log(`${label} (zeros=${s.consecutive_zeros}, success_rate=${s.success_rate}):`);
        if (s.quarantine_reason) console.log(`  QUARANTINED: ${s.quarantine_reason}`);
        if (s.last_error) console.log(`  Last error: ${s.last_error}`);
        for (const h of hist) {
          const ts = (h.timestamp || '').slice(0, 16);
          const dur = h.durationMs ? (h.durationMs / 1000).toFixed(1) + 's' : '?';
          const flag = h.status !== 'ok' ? ' <<<' : '';
          console.log(`  ${ts} | ${h.status.padEnd(12)} | count=${String(h.count).padStart(4)} | ${dur}${flag}`);
        }
        console.log('');
      }

      // Stable sources
      console.log('=== STABLE SOURCES ===\n');
      for (const [label, s] of Object.entries(d.sources)) {
        const hist = s.history || [];
        const fails = hist.filter(h => h.status !== 'ok');
        if (fails.length > 0 || s.consecutive_zeros > 0 || s.quarantine_reason) continue;
        const counts = hist.map(h => h.count);
        if (counts.length === 0) continue;
        const avg = (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(0);
        const min = Math.min(...counts);
        const max = Math.max(...counts);
        console.log(`  ${label.padEnd(20)} avg=${String(avg).padStart(4)}  min=${String(min).padStart(4)}  max=${String(max).padStart(4)}  (${hist.length} scrapes)`);
      }
    } catch (e) {
      console.log('Parse error:', e.message);
    }
  });
}).on('error', (e) => {
  console.log('Request error:', e.message);
});
