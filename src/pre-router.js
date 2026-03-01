const { NEIGHBORHOODS, BOROUGHS, extractNeighborhood, detectBorough } = require('./neighborhoods');
const { getNycDateString } = require('./geo');

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

// --- Parse natural date range expressions → { start, end } or null ---
function parseDateRange(text) {
  const lower = text.toLowerCase().trim();

  // Get current day of week (0=Sun, 1=Mon, ... 6=Sat) in NYC timezone
  const now = new Date();
  const nycDay = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'narrow' }).format(now).replace(/[^0-6]/, ''), 10);
  const dayOfWeek = new Date(getNycDateString(0) + 'T12:00:00').getDay();

  const today = getNycDateString(0);
  const tomorrow = getNycDateString(1);

  // "tonight" / "today"
  if (/^(tonight|today)$/.test(lower)) {
    return { start: today, end: today };
  }

  // "tomorrow"
  if (/^tomorrow(?:\s+night)?$/.test(lower)) {
    return { start: tomorrow, end: tomorrow };
  }

  // "this weekend"
  if (/\b(this\s+)?weekend\b/.test(lower)) {
    // Friday=5, Saturday=6, Sunday=0
    // If Thu(4) or Fri(5), include Friday
    let satOffset = (6 - dayOfWeek + 7) % 7;
    if (satOffset === 0) satOffset = 0; // Today is Saturday
    const sunOffset = satOffset + 1;
    // Include Friday if asked on Thu/Fri
    const startOffset = (dayOfWeek === 4 || dayOfWeek === 5) ? (5 - dayOfWeek + 7) % 7 || 0 : satOffset;
    return { start: getNycDateString(startOffset), end: getNycDateString(sunOffset) };
  }

  // Day names: "friday night", "this saturday", "on sunday"
  const DAY_NAMES = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  const dayMatch = lower.match(/\b(?:this\s+|on\s+|next\s+)?(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat)\b/i);
  if (dayMatch) {
    const targetDay = DAY_NAMES[dayMatch[1].toLowerCase()];
    if (targetDay !== undefined) {
      let offset = (targetDay - dayOfWeek + 7) % 7;
      if (offset === 0 && !/\btoday\b/.test(lower)) offset = 0; // same day = today
      const date = getNycDateString(offset);
      return { start: date, end: date };
    }
  }

  // "next few days" / "this week"
  if (/\b(next\s+few\s+days|this\s+week|coming\s+days)\b/.test(lower)) {
    return { start: today, end: getNycDateString(6) };
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
    // Only emit the key(s) being cleared so other filters compound via mergeFilters.
    const targetedCatClear = msg.match(/^(?:forget|never mind|drop|lose|ditch)\s+(?:the\s+)?(.+)$/i);
    if (targetedCatClear) {
      const target = targetedCatClear[1].trim().toLowerCase();
      // Check if target matches an active category
      for (const [pattern, catInfo] of Object.entries(catMap)) {
        if (new RegExp(`^(?:${pattern})(?:\\s+(?:filter|stuff))?$`, 'i').test(target)) {
          const clearFilters = {};
          for (const key of Object.keys(catInfo)) clearFilters[key] = null;
          return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: clearFilters };
        }
      }
      // Check for free clear
      if (/^free(?:\s+(?:filter|stuff|only))?$/i.test(target)) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { free_only: false } };
      }
      // Check for time clear
      if (/^(?:time|late|tonight|after midnight|time (?:filter|constraint))$/i.test(target)) {
        return { ...base, intent: 'events', neighborhood: session.lastNeighborhood, filters: { time_after: null } };
      }
    }

    // Full filter clearing — generic phrases
    if (/^(show me everything|all events|no filter|drop the filter|clear filters?|just regular stuff|everything|show all|nvm|forget it|nah forget it|drop it|start over)$/i.test(msg)) {
      return { ...base, intent: 'clear_filters', neighborhood: session.lastNeighborhood };
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
    // Excludes "tonight"/"late" suffixes — those have a time component and should fall through
    // to compound extraction which handles category + time together.
    for (const [pattern, catInfo] of Object.entries(catMap)) {
      const bareRegex = new RegExp(`^(?:${pattern})(?:\\s+(?:stuff|shows?|events?|picks?))?$`, 'i');
      if (bareRegex.test(msg)) {
        return { ...base, intent: 'events', neighborhood: sessionHood, filters: { ...catInfo } };
      }
    }

    // Specific time follow-ups: "after 8pm", "around 9:30", "anything after 10"
    // Skip if a category word is present — let compound extraction handle "comedy after 9pm"
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

  // --- First-message vibe/category/time detection (no session required) ---
  // Detects single-dimension filters as first messages and routes to citywide serving.
  if (!session?.lastNeighborhood) {
    // Open-ended: "surprise me", "what's good", "what's happening"
    if (/^(surprise me|what's good|whats good|what's happening|whats happening|what's out there|show me something|anything good|what do you got)$/i.test(msg)) {
      return { ...base, intent: 'events', neighborhood: null, filters: { ...base.filters } };
    }

    // Date range: "this weekend", "friday night", "tomorrow"
    const dateRange = parseDateRange(msg);
    if (dateRange && /^(tonight|today|tomorrow|this weekend|weekend|friday|saturday|sunday|fri|sat|sun|next few days|this week|monday|tuesday|wednesday|thursday|mon|tue|wed|thu)(?:\s+night)?$/i.test(msg)) {
      return { ...base, intent: 'events', neighborhood: null, filters: { ...base.filters, date_range: dateRange } };
    }

    // Bare category: "comedy", "jazz", "live music"
    for (const [pattern, catInfo] of Object.entries(catMap)) {
      const bareRegex = new RegExp(`^(?:${pattern})(?:\\s+(?:stuff|shows?|events?|picks?|tonight|night))?$`, 'i');
      if (bareRegex.test(msg)) {
        const dr = parseDateRange(msg);
        return { ...base, intent: 'events', neighborhood: null, filters: { ...base.filters, ...catInfo, ...(dr ? { date_range: dr } : {}) } };
      }
    }

    // Bare vibe: "something weird", "something chill", "I want to dance"
    const vibeFirstMatch = msg.match(/^(?:something|anything|i want to|i wanna|let's|lets)\s+(chill|wild|weird|romantic|low-key|fun|crazy|mellow|cozy|rowdy|intimate|energetic|upbeat|laid-back|dance|party)$/i);
    if (vibeFirstMatch) {
      const vibe = vibeFirstMatch[1].toLowerCase();
      // "dance" and "party" map to nightlife category
      if (vibe === 'dance' || vibe === 'party') {
        return { ...base, intent: 'events', neighborhood: null, filters: { ...base.filters, category: 'nightlife', vibe } };
      }
      return { ...base, intent: 'events', neighborhood: null, filters: { ...base.filters, vibe } };
    }
  }

  // --- Compound filter extraction (multi-dimension: "free comedy", "late jazz", "comedy in bushwick") ---
  // Catches compound messages that single-dimension checks miss.
  // Does NOT require session — works for first messages like "free comedy in bushwick".
  // Additive: if it misses a compound, LLM still works — just won't persist filters.
  const hasFree = /\bfree\b/i.test(lower);

  let compoundTime = null;
  const hasEarly = /\b(?:early|earlier)\b/i.test(lower);
  if (/\b(?:after\s+midnight|midnight)\b/i.test(lower)) {
    compoundTime = '00:00';
  } else if (!hasEarly && /\b(?:later?|late\s*night)\b/i.test(lower)) {
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

  // Date range in compound context: "free comedy this weekend", "jazz friday night"
  const compoundDateRange = parseDateRange(lower);

  // "tonight" is an event-context signal (not a time filter) — counts toward compound threshold
  const hasTonight = /\btonight\b/i.test(lower) && !compoundTime;
  // Session-aware: single-dim refinement ("anything later tonight", "how about free") when user
  // has an active neighborhood and message doesn't contain clear/forget/drop/reset language
  const isSessionRefinement = !!session?.lastNeighborhood && !/\b(?:forget|drop|clear|reset|start over|show me everything|show all|nvm)\b/i.test(lower);
  const filterDims = [hasFree, compoundTime, detectedCat, compoundDateRange].filter(Boolean).length;
  if (filterDims >= 2 || (filterDims >= 1 && (detectedHood || hasTonight || isSessionRefinement))) {
    const hood = detectedHood || session?.lastNeighborhood || null;
    // Only include detected keys — undetected keys fall back to session via mergeFilters
    const filters = {};
    if (hasFree) filters.free_only = true;
    if (compoundTime) filters.time_after = compoundTime;
    if (detectedCat) Object.assign(filters, detectedCat);
    if (compoundDateRange) filters.date_range = compoundDateRange;
    return { ...base, intent: 'events', neighborhood: hood, filters, confidence: 0.9 };
  }

  return null; // Fall through to unified LLM
}

module.exports = { getAdjacentNeighborhoods, preRoute };
