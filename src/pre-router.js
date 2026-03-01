const { NEIGHBORHOODS, BOROUGHS, extractNeighborhood, detectBorough } = require('./neighborhoods');

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

// --- Parse natural time expressions → HH:MM or null ---
function parseTimeExpr(text) {
  // "after 8pm", "around 9:30pm", "8 pm or later", "starting at 10pm"
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const isPm = m[3].toLowerCase() === 'pm';
    if (isPm && h < 12) h += 12;
    if (!isPm && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }
  // "after 21:00" or "after 9:30" (24h format)
  const m24 = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    if (h > 23 || min > 59) return null;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }
  // Bare hour without am/pm: "after 10", "around 9" — assume PM for nightlife context
  const mBare = text.match(/\b(?:after|around|past|starting\s+(?:at|around))\s+(\d{1,2})\b/i);
  if (mBare) {
    let h = parseInt(mBare[1], 10);
    if (h >= 1 && h <= 11) h += 12; // assume PM
    if (h > 23) return null;
    return String(h).padStart(2, '0') + ':00';
  }
  return null;
}

// --- Deterministic pre-router (mechanical shortcuts only) ---
// All semantic understanding (neighborhoods, categories, time, vibes, free,
// nudge accepts, boroughs, off-topic) goes through the unified LLM call.
function preRoute(message, session) {
  const trimmed = message.trim();
  const msg = /^[!?.]+$/.test(trimmed) ? trimmed : trimmed.replace(/(?<=\S)[!?.]+$/, '');
  const lower = msg.toLowerCase();
  const base = { filters: { free_only: false, category: null, subcategory: null, vibe: null, time_after: null }, event_reference: null, reply: null, confidence: 1.0 };

  // Referral code intake
  const refMatch = msg.match(/^ref:([a-zA-Z0-9_-]{6,12})$/i);
  if (refMatch) {
    return { ...base, intent: 'referral', neighborhood: null, referralCode: refMatch[1] };
  }

  // Help
  if (/^(help|\?)$/i.test(msg)) {
    return { ...base, intent: 'help', neighborhood: null };
  }

  // Bare numbers → details (skip when pendingNearby — let unified handle as nudge accept)
  if (/^[1-5]$/.test(msg)) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'details', neighborhood: null, event_reference: msg };
    }
    if (!session?.pendingNearby) {
      return { ...base, intent: 'conversational', neighborhood: null, reply: "I don't have picks loaded — tell me what you're looking for!" };
    }
  }

  // More (skip when pendingNearby + no picks — let unified handle as nudge accept)
  if (/^(more|show me more|what else|anything else|what else you got|next|what's next)$/i.test(msg)) {
    if (session?.pendingNearby && !(session?.lastPicks?.length > 0)) {
      // "MORE" after zero-match nudge = acceptance of nearby suggestion → fall through to unified
    } else {
      return { ...base, intent: 'more', neighborhood: session?.lastNeighborhood || null };
    }
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
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! What are you in the mood for tonight? Drop a vibe, a category, or a neighborhood." };
  }

  // Thanks
  if (/^(thanks|thank you|thx|ty|appreciate it|cheers)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Anytime! Hit me up when you're ready to go out again." };
  }

  // Bye
  if (/^(bye|later|peace|gn|good night|night|see ya|cya|deuces)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Later! Hit me up whenever." };
  }

  // Satisfied-exit signals — user is done, warm sign-off (zero AI cost)
  // Works regardless of lastPicks — user can sign off after zero-match nudges too
  if (/^(cool|perfect|sick|dope|nice|sweet|awesome|amazing|fire|love it|sounds good|sounds great)(\s+thanks?)?$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Have fun tonight! Hit me up whenever you want more picks." };
  }

  // Decline signals — user declining a nudge or done exploring
  if (/^(nah|nope|no thanks|no thank you|nah i'?m good|i'?m good|all good|all set|i'?m set|pass|no)$/i.test(msg)) {
    return { ...base, intent: 'conversational', neighborhood: null, reply: "No worries! Hit me up whenever you want picks." };
  }

  // Casual acknowledgments (session-aware — only when picks are loaded)
  // Skip when pendingNearby is set — "bet"/"ok" are nudge accepts, let unified handle them
  if (/^(k|ok|bet|word|aight|ight|gotcha|copy)$/i.test(msg) && !session?.pendingNearby) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'conversational', neighborhood: null, reply: `Your ${session.lastNeighborhood || ''} picks are above — reply a number for details, MORE for extra picks, or try a different neighborhood.` };
    }
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! Tell me what you're looking for — comedy, jazz, something weird — or a neighborhood." };
  }

  // Impatient follow-up
  if (/^(hello\?+|hey\?+|\?\?+|yo\?+|you there\??|helloooo+|hellooo+)$/i.test(msg)) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'conversational', neighborhood: null, reply: `Sorry for the wait! Your ${session.lastNeighborhood || 'picks'} should be above — reply MORE for extra picks or try a different neighborhood.` };
    }
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! Tell me what you're looking for — comedy, jazz, something weird — or a neighborhood." };
  }

  // Borough detection — ask user to narrow to a neighborhood
  const boroughResult = detectBorough(msg);
  if (boroughResult && !extractNeighborhood(msg)) {
    const topHoods = boroughResult.neighborhoods.slice(0, 4).join(', ');
    return { ...base, intent: 'conversational', neighborhood: null, reply: `${boroughResult.borough.charAt(0).toUpperCase() + boroughResult.borough.slice(1)} is a big place! Which neighborhood? I can check ${topHoods}...` };
  }

  // Category map — used for session-aware single-dimension filter detection
  const catMap = {
    'comedy|standup|stand-up|improv': { category: 'comedy' },
    'theater|theatre': { category: 'theater' },
    'jazz': { category: 'live_music', subcategory: 'jazz' },
    'music|live music|rock|punk|metal|folk|indie|hip hop|hip-hop|r&b|soul|funk|rap': { category: 'live_music' },
    'techno|house|electronic|dj': { category: 'nightlife' },
    'art': { category: 'art' },
    'nightlife': { category: 'nightlife' },
    'dance': { category: 'nightlife' },
    'trivia|bingo|open mic|poetry|karaoke|drag|burlesque': { category: 'community' },
    'salsa|bachata|swing': { category: 'nightlife' },
  };

  // --- Filter clearing (deterministic — P6: catch clear phrases before they hit the LLM) ---
  // Only trigger when session has active filters. Falls through to unified LLM otherwise.
  const hasActiveFilters = session?.lastFilters && Object.values(session.lastFilters).some(Boolean);
  if (hasActiveFilters && (session?.lastNeighborhood || session?.lastPicks?.length > 0)) {
    if (/^(?:nvm|nevermind|never\s*mind|forget\s*(?:it|that|the\s+\w+)|drop\s+(?:the\s+)?filter|no\s+(?:more\s+)?filter|start\s*(?:fresh|over)|show\s*(?:me\s+)?(?:everything|whatever|whats?\s*good)|just\s+show\s+me\s+(?:everything|whatever|whats?\s*good)|(?:i(?:'?m| am)\s+)?open\s+to\s+(?:anything|whatever)|(?:anything|whatever)\s+works|(?:just\s+)?surprise\s+me|clear\s+filter)s?$/i.test(msg)) {
      return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, clearFilters: true };
    }
  }

  // --- Session-aware filter follow-ups (deterministic detection → unified LLM composition) ---
  // These return intent='events' with ONLY the detected filter key(s).
  // mergeFilters uses key-presence semantics: keys absent from the incoming object
  // fall back to existing session filters (compounding). Including all keys from
  // base.filters would overwrite existing filters with null — causing the
  // "free replaces comedy" stacking bug.
  // Guard: requires active session (picks loaded OR neighborhood set). lastNeighborhood
  // is NOT required — misspelled neighborhoods leave it null but filters should still detect.
  const sessionHood = session?.lastNeighborhood || null;
  if (sessionHood || session?.lastPicks?.length > 0) {
    // Free (single-dimension) — permissive: any message centered on "free"
    if (/^(?:how about |what about |ok )?(?:anything |something )?free(?:\s+(?:stuff|events?|shows?|picks?|again|please|too|only))?(?:\s+(?:for .+|tho|though|instead))?$/i.test(msg)) {
      return { ...base, intent: 'events', neighborhood: sessionHood, filters: { free_only: true } };
    }

    // Category follow-ups — permissive prefixes including corrections and "more"
    for (const [pattern, catInfo] of Object.entries(catMap)) {
      const catRegex = new RegExp(`^(?:how about|what about|any|show me|got any|have any|know any|more|ok (?:how about|what about)|actually|no i meant|i (?:said|meant|want)|anything with)\\s+(?:${pattern})(?:\\s+(?:night|stuff|shows?|events?|tonight|picks?|options?|tho|though|instead|please))*$`, 'i');
      if (catRegex.test(msg)) {
        return { ...base, intent: 'events', neighborhood: sessionHood, filters: { ...catInfo } };
      }
    }

    // Bare category words (no prefix): "comedy", "jazz", "live music", "comedy shows"
    for (const [pattern, catInfo] of Object.entries(catMap)) {
      const bareRegex = new RegExp(`^(?:${pattern})(?:\\s+(?:stuff|shows?|events?|picks?))?$`, 'i');
      if (bareRegex.test(msg)) {
        return { ...base, intent: 'events', neighborhood: sessionHood, filters: { ...catInfo } };
      }
    }

    // Specific time follow-ups: "after 8pm", "around 9:30", "anything after 10"
    // Skip if a category word is present — let unified LLM handle "comedy after 9pm"
    const specificTime = parseTimeExpr(msg);
    if (specificTime && /\b(?:after|around|past|by|at|starting|from)\b/i.test(msg)) {
      const hasCatWord = Object.keys(catMap).some(p => new RegExp(`\\b(?:${p})\\b`, 'i').test(msg));
      const hasFreeWord = /\bfree\b/i.test(msg);
      if (!hasCatWord && !hasFreeWord) {
        return { ...base, intent: 'events', neighborhood: sessionHood, filters: { time_after: specificTime } };
      }
    }

    // Time follow-ups (single-dimension) — fuzzy phrases
    if (/^(?:how about\s+)?(?:later(?:\s+tonight)?|after\s+midnight|late(?:r)?\s*night|anything?\s+late)$/i.test(msg)) {
      const timeAfter = /midnight/i.test(msg) ? '00:00' : '22:00';
      return { ...base, intent: 'events', neighborhood: sessionHood, filters: { time_after: timeAfter } };
    }

    // Vibe follow-ups (single-dimension)
    const vibeMatch = msg.match(/^(?:something|anything|how about something|got anything)\s+(chill|wild|weird|romantic|low-key|fun|crazy|mellow|cozy|rowdy|intimate|energetic|upbeat|laid-back)$/i);
    if (vibeMatch) {
      return { ...base, intent: 'events', neighborhood: sessionHood, filters: { vibe: vibeMatch[1].toLowerCase() } };
    }
  }

  return null; // Fall through to unified LLM
}

module.exports = { getAdjacentNeighborhoods, preRoute };
