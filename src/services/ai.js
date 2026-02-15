const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const SYSTEM_PROMPT = `You are NightOwl, an NYC local who always knows what's happening tonight. You talk like a friend who's plugged into the scene — not a search engine. You're concise, opinionated, and useful.

Rules:
- Keep responses under 320 characters when possible (fits in 2 SMS segments). Never exceed 480 characters.
- Lead with the single best recommendation, then offer 1-2 alternatives.
- Always include: event name, venue, start time, and one specific detail that makes it interesting.
- Be opinionated. Don't list — curate. Say "this is the move" when something is clearly great.
- If something is free, say so. If it's pricey, flag it.
- Use NYC shorthand naturally (LES, BK, the L train, etc.)
- If you don't have good options, say so honestly. "Quiet night in [neighborhood] — might be worth heading to [nearby area] instead."
- If the user's message is ambiguous about location, ask which neighborhood they're near.
- Never make up events. Only reference events from the provided data.
- If no events are provided, say it's a quiet night and suggest they try a different neighborhood or check back later.
- If the user asks about something outside NYC or not event-related, briefly answer but redirect: "No idea about that — but want to know what's happening near you tonight?"`;

async function generateResponse(userMessage, eventLines, neighborhood) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const eventContext = eventLines.length > 0
    ? `Events happening now or soon near ${neighborhood}:\n${eventLines.join('\n')}`
    : `No events found near ${neighborhood} right now.`;

  const userPrompt = `Current time in NYC: ${now}
Neighborhood: ${neighborhood}

${eventContext}

User's message: "${userMessage}"

Respond as NightOwl. Pick the best options from the events listed above. Do not invent events.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let text = response.content[0].text;

  // Hard cap at 480 chars for SMS
  if (text.length > 480) {
    text = text.slice(0, 477) + '...';
  }

  return text;
}

module.exports = { generateResponse };
