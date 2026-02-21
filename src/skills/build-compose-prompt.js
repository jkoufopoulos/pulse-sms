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

  // Activity adherence — when user asks for a specific activity type
  // Always enable for activity keywords, even when requestedCategory is set,
  // because categories (e.g. 'community') are broader than specific activities (e.g. 'trivia')
  if (options.userMessage) {
    const ACTIVITY_KEYWORDS = /\b(trivia|karaoke|bingo|open mic|drag|burlesque|poetry|salsa|bachata|swing|vinyl|happy hour|game night|pub quiz|board game)\b/i;
    if (ACTIVITY_KEYWORDS.test(options.userMessage)) {
      parts.push(skills.activityAdherence.text);
    }
  }

  // Conversation awareness — when history is available
  if (options.hasConversationHistory) {
    parts.push(skills.conversationAwareness.text);
  }

  // Nearby suggestion — when nearby neighborhoods are provided
  if (options.nearbyNeighborhoods?.length > 0) {
    parts.push(skills.nearbySuggestion.text);
  }

  return parts.join('\n');
}

/**
 * Assembles the unified system prompt from UNIFIED_SYSTEM base + conditional skill modules.
 *
 * buildUnifiedPrompt(events, options) → string
 *   options.requestedNeighborhood — the resolved neighborhood (for mismatch check)
 *   options.isLastBatch           — include last-batch skill
 *   options.exhaustionSuggestion  — appended to last-batch text
 *   options.isFree                — include free-emphasis skill
 *   options.pendingMessage        — include pending-intent skill
 *   options.userMessage           — the raw user message (for activity adherence)
 *   options.hasConversationHistory — whether conversation history exists
 *   options.nearbyNeighborhoods   — array of nearby hoods for suggestion skill
 */
function buildUnifiedPrompt(events, options = {}) {
  const { UNIFIED_SYSTEM } = require('../prompts');
  const parts = [UNIFIED_SYSTEM];

  // Source tiers — always included when events are present
  if (events && events.length > 0) {
    parts.push(skills.sourceTiers.text);
  }

  // Tonight priority
  if (events && events.length > 0) {
    const todayNyc = getNycDateString(0);
    const hasToday = events.some(e => {
      const d = e.date_local || e.day;
      return d === todayNyc || d === 'TODAY';
    });
    if (hasToday) {
      parts.push(skills.tonightPriority.text);
    }
  }

  // Neighborhood mismatch
  if (options.requestedNeighborhood && events && events.length > 0) {
    const inHood = events.some(e => e.neighborhood === options.requestedNeighborhood);
    if (!inHood) {
      parts.push(skills.neighborhoodMismatch.text);
    }
  }

  // Perennial framing
  if (events && events.some(e => e.source_name === 'perennial')) {
    parts.push(skills.perennialFraming.text);
  }

  // Venue framing
  if (events && events.some(e => e.source_name === 'tavily')) {
    parts.push(skills.venueFraming.text);
  }

  // Last batch
  if (options.isLastBatch) {
    let lastBatchText = skills.lastBatch.text;
    if (options.exhaustionSuggestion) {
      lastBatchText += ` Then add "${options.exhaustionSuggestion}"`;
    }
    parts.push(lastBatchText);
  }

  // Free emphasis
  if (options.isFree) {
    parts.push(skills.freeEmphasis.text);
  }

  // Pending intent
  if (options.pendingMessage) {
    parts.push(`\nUser's original request: "${options.pendingMessage}". Prioritize events matching that intent.`);
  }

  // Activity adherence
  if (options.userMessage) {
    const ACTIVITY_KEYWORDS = /\b(trivia|karaoke|bingo|open mic|drag|burlesque|poetry|salsa|bachata|swing|vinyl|happy hour|game night|pub quiz|board game)\b/i;
    if (ACTIVITY_KEYWORDS.test(options.userMessage)) {
      parts.push(skills.activityAdherence.text);
    }
  }

  // Conversation awareness
  if (options.hasConversationHistory) {
    parts.push(skills.conversationAwareness.text);
  }

  // Nearby suggestion
  if (options.nearbyNeighborhoods?.length > 0) {
    parts.push(skills.nearbySuggestion.text);
  }

  return parts.join('\n');
}

module.exports = { buildComposePrompt, buildUnifiedPrompt };
