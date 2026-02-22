const { NEIGHBORHOODS, BOROUGHS } = require('./neighborhoods');

// Build reverse map: neighborhood → borough
const HOOD_TO_BOROUGH = {};
for (const [borough, hoods] of Object.entries(BOROUGHS)) {
  for (const h of hoods) HOOD_TO_BOROUGH[h] = borough;
}

// --- Adjacent neighborhood helper (Euclidean approx, borough-aware) ---
// Same-borough neighbors are preferred; cross-borough gets a 3x distance penalty
// to account for rivers/bridges making them less accessible by transit.
function getAdjacentNeighborhoods(hood, count = 3) {
  const target = NEIGHBORHOODS[hood];
  if (!target) return [];
  const sourceBoro = HOOD_TO_BOROUGH[hood] || null;
  return Object.entries(NEIGHBORHOODS)
    .filter(([name]) => name !== hood)
    .map(([name, data]) => {
      const rawDist = Math.sqrt(Math.pow(target.lat - data.lat, 2) + Math.pow(target.lng - data.lng, 2));
      const sameBoro = sourceBoro && HOOD_TO_BOROUGH[name] === sourceBoro;
      return { name, dist: sameBoro ? rawDist : rawDist * 3 };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, count)
    .map(d => d.name);
}

// --- Deterministic pre-router (mechanical shortcuts only) ---
// All semantic understanding (neighborhoods, categories, time, vibes, free,
// nudge accepts, boroughs, off-topic) goes through the unified LLM call.
function preRoute(message, session) {
  const msg = message.trim();
  const lower = msg.toLowerCase();
  const base = { filters: { free_only: false, category: null, vibe: null, time_after: null }, event_reference: null, reply: null, confidence: 1.0 };

  // Help
  if (/^(help|\?)$/i.test(msg)) {
    return { ...base, intent: 'help', neighborhood: null };
  }

  // Bare numbers → details
  if (/^[1-5]$/.test(msg)) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'details', neighborhood: null, event_reference: msg };
    }
    return { ...base, intent: 'conversational', neighborhood: null, reply: "I don't have any picks loaded right now — text me a neighborhood and I'll find what's good tonight!" };
  }

  // More
  if (/^(more|show me more|what else|anything else|what else you got|next|what's next)$/i.test(msg)) {
    return { ...base, intent: 'more', neighborhood: session?.lastNeighborhood || null };
  }

  // Event name match from session picks
  if (session?.lastPicks && session?.lastEvents && lower.length >= 3) {
    for (let i = 0; i < session.lastPicks.length; i++) {
      const event = session.lastEvents[session.lastPicks[i].event_id];
      if (!event?.name) continue;
      const eventNameLower = event.name.toLowerCase();
      const eventNameClean = eventNameLower.replace(/^(the|a|an)\s+/i, '');
      if (eventNameLower.includes(lower) || (eventNameClean.length >= 3 && lower.includes(eventNameClean))) {
        return { ...base, intent: 'details', neighborhood: null, event_reference: String(i + 1) };
      }
    }
  }

  // Greetings
  if (/^(hey|hi|hello|yo|sup|what's up|wassup|hola|howdy)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! Text me a neighborhood and I'll find you something good tonight." };
  }

  // Thanks
  if (/^(thanks|thank you|thx|ty|appreciate it|cheers)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Anytime! Text a neighborhood when you're ready to go out again." };
  }

  // Bye
  if (/^(bye|later|peace|gn|good night|night|see ya|cya|deuces)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Later! Hit me up whenever." };
  }

  // Impatient follow-up
  if (/^(hello\?+|hey\?+|\?\?+|yo\?+|you there\??|helloooo+|hellooo+)$/i.test(msg)) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'conversational', neighborhood: null, reply: `Sorry for the wait! Your ${session.lastNeighborhood} picks should be above — reply MORE for extra picks or try a different neighborhood.` };
    }
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! Text me a neighborhood and I'll find you something good tonight." };
  }

  // Explicit filter clearing — requires active filters in session
  if (session?.lastFilters && Object.values(session.lastFilters).some(Boolean)) {
    if (/^(show me everything|all events|no filter|drop the filter|clear filters?|forget the .+|never mind the .+|just regular stuff|everything|show all)$/i.test(msg)) {
      return { ...base, intent: 'clear_filters', neighborhood: session.lastNeighborhood };
    }
  }

  // --- Session-aware filter follow-ups (deterministic detection → unified LLM composition) ---
  // These return intent='events' with filters; the handler injects filters and uses the unified branch.
  if (session?.lastNeighborhood && session?.lastPicks?.length > 0) {
    // Free
    if (/^(free|free stuff|free events|free tonight|anything free)$/i.test(msg)) {
      return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, free_only: true } };
    }

    // Category follow-ups
    const catMap = {
      'comedy|standup|stand-up|improv': 'comedy',
      'theater|theatre': 'theater',
      'jazz|music|live music|rock|punk|metal|folk|indie|hip hop|hip-hop|r&b|soul|funk|rap': 'live_music',
      'techno|house|electronic|dj': 'nightlife',
      'art': 'art',
      'nightlife': 'nightlife',
      'dance': 'nightlife',
      'trivia|bingo|open mic|poetry|karaoke|drag|burlesque': 'community',
      'salsa|bachata|swing': 'nightlife',
    };
    for (const [pattern, category] of Object.entries(catMap)) {
      const catRegex = new RegExp(`^(?:how about|what about|any|show me|got any|have any|know any)\\s+(?:${pattern})(?:\\s+(?:night|stuff|shows?|events?|tonight|picks?|options?))*$`, 'i');
      if (catRegex.test(msg)) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, category } };
      }
    }

    // Time follow-ups
    if (/^(?:how about\s+)?(?:later(?:\s+tonight)?|after\s+midnight|late(?:r)?\s*night|anything?\s+late)$/i.test(msg)) {
      const timeAfter = /midnight/i.test(msg) ? '00:00' : '22:00';
      return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, time_after: timeAfter } };
    }

    // Vibe follow-ups
    const vibeMatch = msg.match(/^(?:something|anything|how about something|got anything)\s+(chill|wild|weird|romantic|low-key|fun|crazy|mellow|cozy|rowdy|intimate|energetic|upbeat|laid-back)$/i);
    if (vibeMatch) {
      return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, vibe: vibeMatch[1].toLowerCase() } };
    }
  }

  return null; // Fall through to unified LLM
}

module.exports = { getAdjacentNeighborhoods, preRoute };
