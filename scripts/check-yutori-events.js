const https = require('https');

const url = 'https://web-production-c8fdb.up.railway.app/api/events';

https.get(url, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    const data = JSON.parse(body);
    const events = data.events || [];

    const searches = [
      ['Cherm/JesseK/RaidenX', ['cherm', 'jessek', 'raidenx']],
      ['Mamady Kouyate Mandingo', ['mandingo', 'kouyate', 'mamady']],
      ['Crescent Open Decks', ['crescent', 'open decks']],
      ['Beginner DJ Workshop', ['beginner dj', 'nextdimensional']],
      ['DJ Kuff B2B Egipto', ['kuff', 'egipto']],
      ['Sabo unders House of Yes', ['sabo']],
      ['abunDANCE Global Sounds', ['abundance', 'global sounds']],
      ['FOMO Secret Cinema KIDS', ['fomo secret', 'kids 1995', 'fomo']],
      ['Art House Cinema Week', ['art house cinema']],
      ['DCTV Firehouse Cinema', ['firehouse cinema', 'built to move', 'dctv']],
    ];

    // Also search by venue
    const venueSearches = ['berlin', 'barbes', 'keybar', 'caffeine underground', 'eris', 'house of yes'];

    console.log('=== EVENT NAME SEARCH ===\n');
    for (const [label, terms] of searches) {
      let found = false;
      for (const q of terms) {
        const matches = events.filter(e =>
          (e.name || '').toLowerCase().includes(q) ||
          (e.description || '').toLowerCase().includes(q) ||
          (e.description_short || '').toLowerCase().includes(q)
        );
        if (matches.length > 0) {
          found = true;
          for (const m of matches) {
            const missing = [];
            if (m.start_time_local == null) missing.push('time');
            if (m.venue_name == null || m.venue_name === 'TBA') missing.push('venue');
            if (m.neighborhood == null) missing.push('neighborhood');
            if (m.price_display == null && m.is_free !== true) missing.push('price');
            if (m.description == null && m.description_short == null) missing.push('description');
            if (m.source_url == null && m.ticket_url == null) missing.push('url');
            if (m.category == null || m.category === 'other') missing.push('category');
            console.log(`FOUND [${label}] via "${q}":`);
            console.log(`  name: ${m.name}`);
            console.log(`  venue: ${m.venue_name || '--'} | hood: ${m.neighborhood || '--'} | date: ${m.date_local || '--'}`);
            console.log(`  source: ${m.source_name} | cat: ${m.category || '--'} | price: ${m.is_free ? 'Free' : (m.price_display || '--')}`);
            console.log(`  time: ${m.start_time_local || '--'} | url: ${(m.source_url || m.ticket_url || '--').slice(0, 60)}`);
            console.log(`  missing: ${missing.length ? missing.join(', ') : 'COMPLETE'}`);
            console.log();
          }
          break;
        }
      }
      if (!found) {
        console.log(`NOT FOUND: ${label}\n`);
      }
    }

    console.log('\n=== VENUE SEARCH ===\n');
    for (const v of venueSearches) {
      const matches = events.filter(e =>
        (e.venue_name || '').toLowerCase().includes(v)
      );
      console.log(`"${v}": ${matches.length} events`);
      if (matches.length > 0 && matches.length <= 5) {
        for (const m of matches) {
          console.log(`  - ${m.name} (${m.date_local}) [${m.source_name}]`);
        }
      }
    }

    console.log('\n=== YUTORI STATS ===\n');
    const yutori = events.filter(e => (e.source_name || '').toLowerCase().includes('yutori'));
    console.log(`Total events in cache: ${events.length}`);
    console.log(`Yutori events: ${yutori.length}`);
    if (yutori.length > 0) {
      console.log(`Sample Yutori events:`);
      yutori.slice(0, 5).forEach(e => {
        console.log(`  - ${e.name} | ${e.venue_name || '--'} | ${e.date_local} | ${e.category}`);
      });
    }
  });
});
