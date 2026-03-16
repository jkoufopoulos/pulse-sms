// Run the full Yutori extraction pipeline on all dataset files
// Trivia parser → Structured parser → Haiku LLM fallback
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { preprocessYutoriHtml } = require('../src/sources/yutori/html-preprocess');
const { parseTriviaEvents } = require('../src/sources/yutori/trivia-parser');
const { parseStructuredYutoriHtml } = require('../src/sources/yutori/structured-parser');
const { isTriviaEmail, isEventEmail } = require('../src/sources/yutori/email-filter');
const { extractYutoriEvents } = require('../src/ai');
const { normalizeExtractedEvent } = require('../src/sources/shared');

const dir = 'data/yutori-llm-dataset';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort();

(async () => {
  const results = [];
  let totalTrivia = 0, totalStructured = 0, totalLlm = 0, totalEvents = 0;

  for (const file of files) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const fallbackDate = file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    let events = [];
    let method = 'none';

    // Step 1: Try trivia parser
    if (isTriviaEmail(file, html)) {
      const content = preprocessYutoriHtml(html);
      const parsed = parseTriviaEvents(content, file);
      if (parsed.length > 0) {
        events = parsed;
        method = 'trivia';
        totalTrivia += events.length;
      }
    }

    // Step 2: Try structured parser
    if (events.length === 0) {
      const parsed = parseStructuredYutoriHtml(html, fallbackDate);
      if (parsed.length > 0) {
        events = parsed;
        method = 'structured';
        totalStructured += events.length;
      }
    }

    // Step 3: LLM fallback (raw HTML)
    if (events.length === 0) {
      try {
        const result = await extractYutoriEvents(html, file);
        events = result.events || [];
        method = 'llm';
        totalLlm += events.length;
      } catch (err) {
        console.error('LLM failed for ' + file + ': ' + err.message);
        method = 'error';
      }
    }

    totalEvents += events.length;
    results.push({
      file,
      method,
      count: events.length,
      events: events.map(e => ({
        name: e.name,
        venue: e.venue_name,
        date: e.date_local,
        time: e.start_time_local,
        price: e.price_display,
        category: e.category,
        recurring: e.is_recurring || false,
        url: e.source_url,
      })),
    });

    console.error(`${method.padEnd(10)} ${String(events.length).padStart(3)} events  ${file}`);
  }

  console.error('\n=== PIPELINE SUMMARY ===');
  console.error('Files: ' + files.length);
  console.error('Total events: ' + totalEvents);
  console.error('Trivia parser: ' + totalTrivia);
  console.error('Structured parser: ' + totalStructured);
  console.error('LLM fallback: ' + totalLlm);

  fs.mkdirSync('data/yutori-llm-dataset/results', { recursive: true });
  fs.writeFileSync('data/yutori-llm-dataset/results/pipeline-all.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ total: totalEvents, trivia: totalTrivia, structured: totalStructured, llm: totalLlm, files: files.length }));
})();
