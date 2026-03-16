// Batch extraction script - takes file list as JSON arg
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { extractYutoriEvents } = require('../src/ai');
const { preprocessYutoriHtml } = require('../src/sources/yutori/html-preprocess');

const files = JSON.parse(process.argv[2]);

(async () => {
  const results = [];
  for (const file of files) {
    const basename = path.basename(file);
    try {
      const html = fs.readFileSync(file, 'utf8');
      const text = preprocessYutoriHtml(html);
      const result = await extractYutoriEvents(text, basename);
      const events = result.events || [];
      const recurring = events.filter(e => e.is_recurring);
      results.push({
        file: basename,
        total: events.length,
        recurring: recurring.length,
        events: events.map(e => ({
          name: e.name,
          venue: e.venue_name,
          address: e.venue_address,
          date: e.date_local,
          time: e.start_time_local,
          end: e.end_time_local,
          price: e.price_display,
          category: e.category,
          recurring: e.is_recurring,
          recurrence_day: e.recurrence_day,
          url: e.source_url,
          desc: (e.description_short || '').slice(0, 80),
        })),
      });
      console.error('Done: ' + basename + ' → ' + events.length + ' events');
    } catch (err) {
      results.push({ file: basename, error: err.message, total: 0, recurring: 0, events: [] });
      console.error('Error: ' + basename + ' → ' + err.message);
    }
  }
  // Write results to stdout
  console.log(JSON.stringify(results, null, 2));
})();
