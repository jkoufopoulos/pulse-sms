require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const cheerio = require('cheerio');

const client = new Anthropic.default();

const prompt = `Extract ALL events from this Skint newsletter content as a JSON array. Today is Sunday March 15, 2026. The content covers two posts: THURS-MON 3/13-16 and TUES-THURS 3/10-12.

For each event, extract: name, date_local (YYYY-MM-DD), start_time_local (ISO datetime if known, null otherwise), venue_name, neighborhood, category (comedy/live_music/film/art/theater/dance/tours/food/trivia/literature/market/nightlife/community/other), is_free (boolean), price_display, description_short (1 sentence).

IMPORTANT: Include ALL events including past ones (Friday, Saturday) and all bullet sub-events (each ► is a separate event, like each Oscars watch party venue). Return ONLY a JSON array, no markdown wrapping, no explanation.`;

const content = fs.readFileSync('./data/skint-raw-2026-03-15.html', 'utf8');
const $ = cheerio.load(content);
let text = '';
$('.entry-content').each((i, el) => { text += $(el).text().trim() + '\n\n---\n\n'; });

(async () => {
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16384,
    messages: [{ role: 'user', content: prompt + '\n\n' + text.slice(0, 25000) }],
  });
  const raw = resp.content[0].text;

  let events;
  try {
    events = JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) events = JSON.parse(match[0]);
    else { console.error('Failed to parse. First 500 chars:', raw.slice(0, 500)); process.exit(1); }
  }

  fs.writeFileSync('./data/skint-llm-2026-03-15.json', JSON.stringify(events, null, 2));
  console.log('LLM extracted', events.length, 'events');

  const byDate = {};
  const byCat = {};
  let freeCount = 0, noVenue = 0;
  for (const e of events) {
    byDate[e.date_local] = (byDate[e.date_local] || 0) + 1;
    byCat[e.category] = (byCat[e.category] || 0) + 1;
    if (e.is_free) freeCount++;
    if (!e.venue_name) noVenue++;
  }
  console.log('By date:', JSON.stringify(byDate));
  console.log('By category:', JSON.stringify(byCat));
  console.log('Free:', freeCount, '| No venue:', noVenue);
})().catch(e => console.error(e.message));
