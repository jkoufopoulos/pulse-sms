/**
 * Assembles the compose system prompt from conditional skill modules.
 *
 * buildComposePrompt(events, options) → string
 *   options.isLastBatch       — include last-batch skill (no MORE option)
 *   options.exhaustionSuggestion — appended to last-batch text
 *   options.isFree            — include free-emphasis skill
 *   options.pendingMessage    — include pending-intent skill with user's original message
 */
const skills = require('./compose-skills');
const { getNycDateString } = require('../geo');

function buildComposePrompt(events, options = {}) {
  const parts = [skills.core.text];

  // Always include source tiers
  parts.push(skills.sourceTiers.text);

  // Tonight priority — when at least one event is today
  const todayNyc = getNycDateString(0);
  const hasToday = events.some(e => {
    const d = e.date_local || e.day;
    return d === todayNyc || d === 'TODAY';
  });
  if (hasToday) {
    parts.push(skills.tonightPriority.text);
  }

  // Neighborhood mismatch — when no events match the requested hood
  // (Caller can set options.requestedNeighborhood to enable this check)
  if (options.requestedNeighborhood) {
    const inHood = events.some(e => e.neighborhood === options.requestedNeighborhood);
    if (!inHood) {
      parts.push(skills.neighborhoodMismatch.text);
    }
  }

  // Perennial framing — when batch contains perennial events
  if (events.some(e => e.source_name === 'perennial')) {
    parts.push(skills.perennialFraming.text);
  }

  // Venue framing — when batch contains Tavily venue items
  if (events.some(e => e.source_name === 'tavily')) {
    parts.push(skills.venueFraming.text);
  }

  // Last batch — when this is the final batch of events
  if (options.isLastBatch) {
    let lastBatchText = skills.lastBatch.text;
    if (options.exhaustionSuggestion) {
      lastBatchText += ` Then add "${options.exhaustionSuggestion}"`;
    }
    parts.push(lastBatchText);
  }

  // Free emphasis — when user asked for free events
  if (options.isFree) {
    parts.push(skills.freeEmphasis.text);
  }

  // Pending intent — when restoring a pending message
  if (options.pendingMessage) {
    parts.push(`\nUser's original request: "${options.pendingMessage}". Prioritize events matching that intent.`);
  }

  // Activity adherence — when user asks for a specific activity type not covered by category routing
  if (options.userMessage && !options.requestedCategory) {
    const ACTIVITY_KEYWORDS = /\b(trivia|karaoke|bingo|open mic|drag|burlesque|poetry|salsa|bachata|swing|vinyl|happy hour|game night|pub quiz|board game)\b/i;
    if (ACTIVITY_KEYWORDS.test(options.userMessage)) {
      parts.push(skills.activityAdherence.text);
    }
  }

  return parts.join('\n');
}

module.exports = { buildComposePrompt };
