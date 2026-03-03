/**
 * Composable skill modules for the compose prompt.
 * Each skill has: id, condition (checked by builder), text (appended to prompt).
 * Note: core skill removed (#17) — UNIFIED_SYSTEM in prompts.js provides the role/rules.
 */

const tonightPriority = {
  id: 'tonight-priority',
  text: `
<skill name="tonight-priority">
A decent tonight event beats a great tomorrow event — the user is asking what's happening now.
</skill>`,
};

const sourceTiers = {
  id: 'source-tiers',
  text: `
<skill name="source-tiers">
Use source_tier to break ties between similar events:
- "unstructured" (Skint, Nonsense NYC, Oh My Rockness, Yutori): curated editorial picks — trust these, they've been hand-selected.
- "primary" (RA, Dice, BrooklynVegan, BAM, SmallsLIVE): structured high-quality listings.
- "secondary" (NYC Parks, DoNYC, Songkick, Ticketmaster, Eventbrite, NYPL, Tavily): broader aggregators.
Prefer unstructured and primary over secondary when choosing between similar events.
When extraction_confidence is present, prefer events with 0.8+ (reliable data) over 0.5-0.7 (uncertain). null means structured source — treat as reliable.
</skill>`,
};

const neighborhoodMismatch = {
  id: 'neighborhood-mismatch',
  text: `
<skill name="neighborhood-mismatch">
None of the events are in the requested neighborhood. Acknowledge this upfront by naming the user's requested neighborhood (from the "Neighborhood:" field) — e.g. "Not much tonight in [requested neighborhood], but nearby:" or "Slim pickings in [requested neighborhood] — here's what's close by:". Do not substitute a different neighborhood name or silently show events from a different neighborhood.
</skill>`,
};

const lastBatch = {
  id: 'last-batch',
  text: `
<skill name="last-batch">
This is the last batch of events available. Instead of "Reply 1-N for details, MORE for extra picks", use "Reply 1-N for details" (no MORE option).
</skill>`,
};

const freeEmphasis = {
  id: 'free-emphasis',
  text: `
<skill name="free-emphasis">
User asked for free events. List them with numbers even if they seem niche — the user specifically wants free.
</skill>`,
};

const pendingIntent = {
  id: 'pending-intent',
  // text is dynamically set by the builder
  text: '',
};

const activityAdherence = {
  id: 'activity-adherence',
  text: `
<skill name="activity-adherence">
The user asked for a specific type of activity. If none of the events match that activity type, say honestly you don't have that tonight — e.g. "No trivia in Fort Greene tonight." Then suggest trying a different neighborhood or event type. Do not recommend unrelated events as alternatives.
Only claim an event happens on a particular day (e.g. "trivia on Thursdays") if you can verify from the event data that today is that day. Check "Current time (NYC)" above.
</skill>`,
};

const conversationAwareness = {
  id: 'conversation-awareness',
  text: `
<skill name="conversation-awareness">
- Use conversation history to understand what the user has been asking about.
- TEMPORAL INTENT: If user asks about "tomorrow", prefer TOMORROW events. For a "tomorrow" query, a great tomorrow event beats a decent tonight event — override the "tonight first" rule.
- FILTER PERSISTENCE: If user asked for "free comedy" earlier and is now accepting a redirect or saying "yes", maintain both "free" and "comedy" as constraints. Do not silently drop filters across turns.
- REPEAT AVOIDANCE: Do not recommend events already mentioned in conversation history.
</skill>`,
};

const nearbySuggestion = {
  id: 'nearby-suggestion',
  text: `
<skill name="nearby-suggestion">
When picks are thin (< 2 good options) or nothing matches the user's request, suggest a nearby neighborhood conversationally — e.g. "Slim pickings in Fort Greene tonight — Park Slope is right nearby, want picks from there?"
</skill>`,
};

const singlePick = {
  id: 'single-pick',
  text: `
<skill name="single-pick">
There is only one matching event. Override the normal numbered format:
- Write it naturally without numbering — e.g. "There's a great jazz show at Smalls tonight at 9pm, $20 cover — always a vibe."
- Close with something like "Reply for details, or want picks from [nearby neighborhood]?" using the nearby neighborhood if available.
- Keep the same voice and character limit (480 chars).
</skill>`,
};

const citywide = {
  id: 'citywide',
  text: `
<skill name="citywide">
You're serving events from across NYC — no specific neighborhood was requested.
- Include the neighborhood in parentheses for every pick: "1) Jazz at Smalls (West Village) — ..."
- Prefer geographic diversity — avoid all picks being from the same neighborhood.
- Lead with "Here's what's good tonight:" or similar — not "Tonight in [hood]:".
- Close with "Reply 1-N for details, MORE for extra picks, or try a neighborhood for local picks."
</skill>`,
};

const multiDay = {
  id: 'multi-day',
  text: `
<skill name="multi-day">
Events in this pool span multiple days. State the day for each pick — "tomorrow night", "this Friday", "Saturday".
If all picks happen to fall on the same day, mention it once in the intro instead of repeating.
</skill>`,
};

const recurringEvent = {
  id: 'recurring-event',
  text: `
<skill name="recurring-event">
Some events in the pool are marked "recurring" (e.g. "every Tuesday"). When picking recurring events:
- Mention the recurrence naturally — "Trivia at Black Rabbit (every Tues, 8pm)"
- This signals to the user they can come back next week — it's a community anchor, not a one-off
</skill>`,
};

const ALL_SKILLS = { tonightPriority, sourceTiers, neighborhoodMismatch, lastBatch, freeEmphasis, pendingIntent, activityAdherence, conversationAwareness, nearbySuggestion, singlePick, citywide, multiDay, recurringEvent };

module.exports = ALL_SKILLS;
