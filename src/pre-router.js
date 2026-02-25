const { NEIGHBORHOODS, BOROUGHS, extractNeighborhood } = require('./neighborhoods');

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

  // Casual acknowledgments (session-aware — only when picks are loaded)
  // Skip when pendingNearby is set — "bet"/"ok" are nudge accepts, let unified handle them
  if (/^(k|ok|cool|bet|word|aight|ight|gotcha|copy)$/i.test(msg) && !session?.pendingNearby) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'conversational', neighborhood: null, reply: `Your ${session.lastNeighborhood || ''} picks are above — reply a number for details, MORE for extra picks, or try a different neighborhood.` };
    }
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! Text me a neighborhood and I'll find you something good tonight." };
  }

  // Impatient follow-up
  if (/^(hello\?+|hey\?+|\?\?+|yo\?+|you there\??|helloooo+|hellooo+)$/i.test(msg)) {
    if (session?.lastPicks?.length > 0) {
      return { ...base, intent: 'conversational', neighborhood: null, reply: `Sorry for the wait! Your ${session.lastNeighborhood} picks should be above — reply MORE for extra picks or try a different neighborhood.` };
    }
    return { ...base, intent: 'conversational', neighborhood: null, reply: "Hey! Text me a neighborhood and I'll find you something good tonight." };
  }

  // Category map — shared between filter clearing, session-aware checks, and compound extraction
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

  // Explicit filter clearing — requires active filters in session
  if (session?.lastFilters && Object.values(session.lastFilters).some(Boolean)) {
    // Targeted filter clearing — "forget the comedy", "drop the free", "never mind the time"
    const targetedCatClear = msg.match(/^(?:forget|never mind|drop|lose|ditch)\s+(?:the\s+)?(.+)$/i);
    if (targetedCatClear) {
      const target = targetedCatClear[1].trim().toLowerCase();
      // Check if target matches an active category
      for (const [pattern, catInfo] of Object.entries(catMap)) {
        if (new RegExp(`^(?:${pattern})(?:\\s+(?:filter|stuff))?$`, 'i').test(target)) {
          const clearFilters = {};
          for (const key of Object.keys(catInfo)) clearFilters[key] = null;
          return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, ...clearFilters } };
        }
      }
      // Check for free clear
      if (/^free(?:\s+(?:filter|stuff|only))?$/i.test(target)) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, free_only: false } };
      }
      // Check for time clear
      if (/^(?:time|late|tonight|after midnight|time (?:filter|constraint))$/i.test(target)) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, time_after: null } };
      }
    }

    // Full filter clearing — generic phrases
    if (/^(show me everything|all events|no filter|drop the filter|clear filters?|just regular stuff|everything|show all|nvm|forget it|nah forget it|drop it|start over)$/i.test(msg)) {
      return { ...base, intent: 'clear_filters', neighborhood: session.lastNeighborhood };
    }
  }

  // --- Session-aware filter follow-ups (deterministic detection → unified LLM composition) ---
  // These return intent='events' with filters; the handler injects filters and uses the unified branch.
  if (session?.lastNeighborhood && session?.lastPicks?.length > 0) {
    // Free (single-dimension)
    if (/^(free|free stuff|free events|anything free)$/i.test(msg)) {
      return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, free_only: true } };
    }

    // Category follow-ups (single-dimension, structured prefix required)
    for (const [pattern, catInfo] of Object.entries(catMap)) {
      const catRegex = new RegExp(`^(?:how about|what about|any|show me|got any|have any|know any)\\s+(?:${pattern})(?:\\s+(?:night|stuff|shows?|events?|tonight|picks?|options?))*$`, 'i');
      if (catRegex.test(msg)) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, ...catInfo } };
      }
    }

    // Bare category words (no prefix): "comedy", "jazz", "live music", "comedy shows"
    // Excludes "tonight"/"late" suffixes — those have a time component and should fall through
    // to compound extraction which handles category + time together.
    for (const [pattern, catInfo] of Object.entries(catMap)) {
      const bareRegex = new RegExp(`^(?:${pattern})(?:\\s+(?:stuff|shows?|events?|picks?))?$`, 'i');
      if (bareRegex.test(msg)) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, ...catInfo } };
      }
    }

    // Specific time follow-ups: "after 8pm", "around 9:30", "anything after 10"
    // Skip if a category word is present — let compound extraction handle "comedy after 9pm"
    const specificTime = parseTimeExpr(msg);
    if (specificTime && /\b(?:after|around|past|by|at|starting|from)\b/i.test(msg)) {
      const hasCatWord = Object.keys(catMap).some(p => new RegExp(`\\b(?:${p})\\b`, 'i').test(msg));
      const hasFreeWord = /\bfree\b/i.test(msg);
      if (!hasCatWord && !hasFreeWord) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, time_after: specificTime } };
      }
    }

    // Time follow-ups (single-dimension) — fuzzy phrases
    if (/^(?:how about\s+)?(?:later(?:\s+tonight)?|after\s+midnight|late(?:r)?\s*night|anything?\s+late)$/i.test(msg)) {
      const timeAfter = /midnight/i.test(msg) ? '00:00' : '22:00';
      return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, time_after: timeAfter } };
    }

    // Vibe follow-ups (single-dimension)
    const vibeMatch = msg.match(/^(?:something|anything|how about something|got anything)\s+(chill|wild|weird|romantic|low-key|fun|crazy|mellow|cozy|rowdy|intimate|energetic|upbeat|laid-back)$/i);
    if (vibeMatch) {
      return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { ...base.filters, vibe: vibeMatch[1].toLowerCase() } };
    }
  }

  // --- Compound filter extraction (multi-dimension: "free comedy", "late jazz", "comedy in bushwick") ---
  // Catches compound messages that single-dimension checks miss.
  // Does NOT require session — works for first messages like "free comedy in bushwick".
  // Additive: if it misses a compound, LLM still works — just won't persist filters.
  const hasFree = /\bfree\b/i.test(lower);

  let compoundTime = null;
  if (/\b(?:after\s+midnight|midnight)\b/i.test(lower)) {
    compoundTime = '00:00';
  } else if (/\b(?:tonight|later?|late\s*night)\b/i.test(lower)) {
    compoundTime = '22:00';
  } else {
    compoundTime = parseTimeExpr(lower);
  }

  let detectedCat = null;
  for (const [pattern, catInfo] of Object.entries(catMap)) {
    const wordRegex = new RegExp(`\\b(?:${pattern})\\b`, 'i');
    if (wordRegex.test(lower)) {
      detectedCat = catInfo;
      break;
    }
  }

  const detectedHood = extractNeighborhood(msg);

  const filterDims = [hasFree, compoundTime, detectedCat].filter(Boolean).length;
  if (filterDims >= 2 || (filterDims >= 1 && detectedHood)) {
    const hood = detectedHood || session?.lastNeighborhood || null;
    const filters = { ...base.filters };
    if (hasFree) filters.free_only = true;
    if (compoundTime) filters.time_after = compoundTime;
    if (detectedCat) Object.assign(filters, detectedCat);
    return { ...base, intent: 'events', neighborhood: hood, filters, confidence: 0.9 };
  }

  return null; // Fall through to unified LLM
}

module.exports = { getAdjacentNeighborhoods, preRoute };
