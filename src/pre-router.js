const { extractNeighborhood, detectBorough, detectUnsupported, NEIGHBORHOODS } = require('./neighborhoods');

// --- Adjacent neighborhood helper (Euclidean approx, fine for NYC scale) ---
function getAdjacentNeighborhoods(hood, count = 3) {
  const target = NEIGHBORHOODS[hood];
  if (!target) return [];
  return Object.entries(NEIGHBORHOODS)
    .filter(([name]) => name !== hood)
    .map(([name, data]) => ({
      name,
      dist: Math.sqrt(Math.pow(target.lat - data.lat, 2) + Math.pow(target.lng - data.lng, 2)),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, count)
    .map(d => d.name);
}

// --- Deterministic pre-router (skips Claude for obvious intents) ---
function preRoute(message, session) {
  const msg = message.trim();
  const lower = msg.toLowerCase();
  const base = { filters: { free_only: false, category: null, vibe: null }, event_reference: null, reply: null, confidence: 1.0 };

  // Help
  if (/^(help|\?)$/i.test(msg)) {
    return { ...base, intent: 'help', neighborhood: null };
  }

  // Bare numbers → details
  if (/^[1-3]$/.test(msg)) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'details', neighborhood: null, event_reference: msg };
    }
    return { ...base, intent: 'conversational', neighborhood: null, reply: "I don't have any picks loaded right now — text me a neighborhood and I'll find what's good tonight!" };
  }

  // Affirmative reply to "would you travel to X?" nudge
  if (session?.pendingNearby && /^(yes|yeah|ya|yea|yep|yup|sure|ok|okay|down|let's go|lets go|bet|absolutely|definitely|why not|i'm down|im down)\b/i.test(msg)) {
    const counterHood = extractNeighborhood(msg);
    return { ...base, intent: 'nudge_accept', neighborhood: counterHood || session.pendingNearby };
  }

  // More
  if (/^(more|show me more|what else|anything else|what else you got|next|what's next)$/i.test(msg)) {
    return { ...base, intent: 'more', neighborhood: session?.lastNeighborhood || null };
  }

  // Free
  if (/^(free|free stuff|free events|free tonight|anything free)$/i.test(msg)) {
    return { ...base, intent: 'free', neighborhood: session?.lastNeighborhood || null, filters: { free_only: true, category: null, vibe: null } };
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

  // Bare neighborhood — check BEFORE borough detection
  const CATEGORY_KEYWORDS = /\b(comedy|standup|stand-up|music|jazz|rock|techno|house|art|gallery|theater|theatre|dance|food|drink|free|cheap|underground|improv|hip hop|hip-hop|rap|r&b|soul|funk|punk|metal|folk|indie|electronic|dj)\b/i;
  if (msg.length <= 25 && !CATEGORY_KEYWORDS.test(msg)) {
    const hood = extractNeighborhood(msg);
    if (hood) {
      return { ...base, intent: 'events', neighborhood: hood };
    }
  }

  // Borough detection — ask user to narrow down
  const borough = detectBorough(msg);
  if (borough) {
    const name = borough.borough.charAt(0).toUpperCase() + borough.borough.slice(1);
    return { ...base, intent: 'conversational', neighborhood: null, reply: `${name}'s a big place! Which neighborhood?\n\n${borough.neighborhoods.join(', ')}` };
  }

  // Unsupported but recognized NYC neighborhood
  const unsupported = detectUnsupported(msg);
  if (unsupported) {
    const suggestion = unsupported.nearby.length > 0
      ? `Closest I've got is ${unsupported.nearby.join(' or ')}. Want picks from ${unsupported.nearby.length === 1 ? 'there' : 'either of those'}?`
      : 'Try East Village, Williamsburg, or LES — I know those areas well!';
    return { ...base, intent: 'conversational', neighborhood: null, reply: `Hmm ${unsupported.name} isn't on my radar yet — still expanding! ${suggestion}` };
  }

  return null; // Fall through to Claude
}

module.exports = { getAdjacentNeighborhoods, preRoute };
