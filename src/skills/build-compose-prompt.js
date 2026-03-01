const skills = require('./compose-skills');
const { getNycDateString } = require('../geo');

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

  // Activity adherence — for specific activities AND active category filters
  {
    let needsAdherence = false;
    if (options.userMessage) {
      const ACTIVITY_KEYWORDS = /\b(trivia|karaoke|bingo|open mic|drag|burlesque|poetry|salsa|bachata|swing|vinyl|happy hour|game night|pub quiz|board game)\b/i;
      if (ACTIVITY_KEYWORDS.test(options.userMessage)) needsAdherence = true;
    }
    if (options.hasActiveCategory) needsAdherence = true;
    if (needsAdherence) parts.push(skills.activityAdherence.text);
  }

  // Conversation awareness
  if (options.hasConversationHistory) {
    parts.push(skills.conversationAwareness.text);
  }

  // Nearby suggestion — when a specific neighborhood has been determined
  if (options.suggestedNeighborhood) {
    parts.push(`\nNEARBY SUGGESTION: Picks are thin — suggest ${options.suggestedNeighborhood} as an alternative (e.g. "Slim pickings tonight — ${options.suggestedNeighborhood} is nearby, want picks from there?").`);
  } else if (options.nearbyNeighborhoods?.length > 0) {
    parts.push(skills.nearbySuggestion.text);
  }

  // Single pick — when exactly 1 filter match or pool is truly tiny
  if (options.matchCount === 1 ||
      (options.poolSize != null && options.poolSize <= 1)) {
    parts.push(skills.singlePick.text);
  }

  // Citywide — when no neighborhood and events exist
  if (!options.requestedNeighborhood && events && events.length > 0) {
    parts.push(skills.citywide.text);
  }

  // Multi-day — when events span 2+ distinct dates
  if (events && events.length > 0) {
    const uniqueDates = new Set(events.map(e => e.date_local).filter(Boolean));
    if (uniqueDates.size >= 2) {
      parts.push(skills.multiDay.text);
    }
  }

  return parts.join('\n');
}

module.exports = { buildUnifiedPrompt };
