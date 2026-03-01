/**
 * Code-based evals — deterministic checks on traces.
 * Each returns { name, pass, detail }
 */

const { NEIGHBORHOODS } = require('../neighborhoods');

const VALID_INTENTS = ['events', 'details', 'more', 'free', 'help', 'conversational'];
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

// Subcategory→category mapping shared by category_adherence and compound_filter_accuracy
const CATEGORY_PARENTS = {
  jazz: 'live_music', rock: 'live_music', indie: 'live_music', folk: 'live_music',
  punk: 'live_music', hip_hop: 'live_music', electronic: 'nightlife',
  standup: 'comedy', improv: 'comedy', sketch: 'comedy',
};

const evals = {
  /**
   * SMS must be <= 480 chars
   */
  char_limit(trace) {
    const len = trace.output_sms_length || 0;
    // Multi-pick details responses can exceed 480 chars (intentional multi-SMS)
    if (trace.output_intent === 'details' && len > 480) {
      return { name: 'char_limit', pass: true, detail: `${len} chars (multi-SMS details, exempt)` };
    }
    return {
      name: 'char_limit',
      pass: len <= 480,
      detail: `${len} chars${len > 480 ? ` (${len - 480} over)` : ''}`,
    };
  },

  /**
   * Intent must be one of the 6 valid intents
   */
  valid_intent(trace) {
    const intent = trace.output_intent;
    return {
      name: 'valid_intent',
      pass: VALID_INTENTS.includes(intent),
      detail: intent || 'null',
    };
  },

  /**
   * If a neighborhood was resolved, it must be in the NEIGHBORHOODS map
   */
  valid_neighborhood(trace) {
    const hood = trace.composition.neighborhood_used || trace.routing.result?.neighborhood;
    if (!hood) return { name: 'valid_neighborhood', pass: true, detail: 'no neighborhood (ok)' };
    return {
      name: 'valid_neighborhood',
      pass: NEIGHBORHOOD_NAMES.includes(hood),
      detail: hood,
    };
  },

  /**
   * Every picked event_id must be in the sent_ids list
   */
  picked_events_exist(trace) {
    const picks = trace.composition.picks || [];
    const sentIds = new Set(trace.events.sent_ids || []);
    if (picks.length === 0) return { name: 'picked_events_exist', pass: true, detail: 'no picks' };
    const missing = picks.filter(p => !sentIds.has(p.event_id));
    return {
      name: 'picked_events_exist',
      pass: missing.length === 0,
      detail: missing.length > 0 ? `missing: ${missing.map(p => p.event_id).join(', ')}` : `${picks.length} picks all valid`,
    };
  },

  /**
   * All URLs in SMS are parseable (no truncation)
   */
  valid_urls(trace) {
    const sms = trace.output_sms || '';
    const urlPattern = /https?:\/\/[^\s)]+/g;
    const urls = sms.match(urlPattern) || [];
    if (urls.length === 0) return { name: 'valid_urls', pass: true, detail: 'no URLs' };
    const broken = urls.filter(u => {
      try { new URL(u); return false; } catch { return true; }
    });
    return {
      name: 'valid_urls',
      pass: broken.length === 0,
      detail: broken.length > 0 ? `broken: ${broken.join(', ')}` : `${urls.length} URLs valid`,
    };
  },

  /**
   * Conversational intent should redirect to events, not answer off-topic
   */
  off_topic_redirect(trace) {
    if (trace.output_intent !== 'conversational') {
      return { name: 'off_topic_redirect', pass: true, detail: 'not conversational' };
    }
    const sms = (trace.output_sms || '').toLowerCase();
    const input = (trace.input_message || '').toLowerCase().trim();
    // Goodbyes and thanks don't need a redirect — they're natural conversation endings
    const isFarewell = /^(bye|later|peace|gn|good night|night|see ya|cya|deuces)\b/i.test(input)
      || /\b(thanks|thank you|thx|ty|appreciate it|cheers)\b/i.test(input);
    if (isFarewell) {
      return { name: 'off_topic_redirect', pass: true, detail: 'farewell/thanks (no redirect needed)' };
    }
    // Price inquiry or event-specific question — direct answer is correct, not off-topic
    const isPriceInquiry = /how much|what does it cost|what.s the price|how expensive|is it free/i.test(input);
    if (isPriceInquiry) {
      return { name: 'off_topic_redirect', pass: true, detail: 'price inquiry (direct answer appropriate)' };
    }
    // Clarification prompt — user is mid-conversation, short response is natural
    const isClarification = /^(what.s up|what do you mean|huh|like what|one more thing|actually)/i.test(input);
    if (isClarification) {
      return { name: 'off_topic_redirect', pass: true, detail: 'clarification prompt (no redirect needed)' };
    }
    // Event-specific questions about picks or recommendations — direct answer is correct
    const isEventQuestion = /which.*(recommend|pick|choose|best)|top pick|is .{1,20} (any )?good|send.*(link|url)|your (fav|pick)|what do you think/i.test(input);
    if (isEventQuestion) {
      return { name: 'off_topic_redirect', pass: true, detail: 'event-specific question (direct answer appropriate)' };
    }
    // Casual banter about the bot itself — deflection + brief redirect is fine
    const isBotBanter = /not a real person|are you (a |an )?(bot|ai|real|human)|you.re (a |an )?(bot|ai)|lol$/i.test(input);
    if (isBotBanter) {
      return { name: 'off_topic_redirect', pass: true, detail: 'bot banter (deflection appropriate)' };
    }
    // Zero-pick graceful degradation: if the response discusses events/neighborhoods,
    // it's an appropriate event-related response, not off-topic
    const isEventDiscussion = /no .{1,30} in|nothing .{1,30} tonight|slim pickings|exhausted|cleaned out|already (got|showed)|drop(ping)? the .{1,20} filter|no free|no comedy|no jazz|no live|no match|not my (beat|thing)|not much .{1,30} in|nearby has|you want .{1,30}(comedy|jazz|music|dance|art|free)|dropping the|back to|that.s (really )?it|that.s all|cycled through|dead\b|just the events/i.test(sms);
    if (isEventDiscussion) {
      return { name: 'off_topic_redirect', pass: true, detail: 'zero-match graceful degradation (event-related)' };
    }
    // Check that the response contains a redirect to neighborhoods/events
    const hasRedirect = /text (me )?a neighborhood|text me a|drop me a|go out|tonight.s picks|when you.re ready|mood for|what you.re looking|vibe|try a|want me to check|want .{1,30} picks|want more .{1,30} stuff|check .{1,30} instead|still .{1,20} tonight|hit me up|reply \d|want those|up for something|neighborhood|what.re you (in the )?mood|what.s (actually )?good|happening .{0,10}(in|tonight)|good .{0,10} tonight|dig up|something else|can.t click|just help find|i just find|events (guy|bot)/i.test(sms);
    return {
      name: 'off_topic_redirect',
      pass: hasRedirect,
      detail: hasRedirect ? 'redirects to events' : 'may answer off-topic without redirect',
    };
  },

  /**
   * Response must not be empty
   */
  response_not_empty(trace) {
    const sms = (trace.output_sms || '').trim();
    return {
      name: 'response_not_empty',
      pass: sms.length > 0,
      detail: sms.length > 0 ? `${sms.length} chars` : 'empty response',
    };
  },

  /**
   * Day-label accuracy: "tonight" must not refer to a tomorrow event, and vice versa.
   * Requires trace.composition.picks to include date_local (enriched in handler trace recording).
   */
  day_label_accuracy(trace) {
    const picks = trace.composition.picks || [];
    const sms = (trace.output_sms || '').toLowerCase();
    if (picks.length === 0 || !sms) {
      return { name: 'day_label_accuracy', pass: true, detail: 'no picks or no SMS' };
    }

    // Determine today/tomorrow at trace time
    const traceDate = trace.timestamp ? new Date(trace.timestamp) : new Date();
    const todayStr = traceDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const tomorrowDate = new Date(traceDate.getTime() + 86400000);
    const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Check for affirmative usage — exclude negation contexts like "no jazz tonight"
    const tonightNegated = /\b(no|nothing|not much|slim|none)\b.{0,30}\btonight\b/i.test(sms);
    const saysTonight = /\btonight\b|\btoday\b/.test(sms) && !tonightNegated;
    const tomorrowNegated = /\b(no|nothing|not much|slim|none)\b.{0,30}\btomorrow\b/i.test(sms);
    const saysTomorrow = /\btomorrow\b/.test(sms) && !tomorrowNegated;

    // Categorize picks by date
    const todayPicks = picks.filter(p => p.date_local === todayStr);
    const tomorrowPicks = picks.filter(p => p.date_local === tomorrowStr);

    // Mixed-date response: SMS mentions both "tonight" and "tomorrow" and has
    // picks on both days — Claude is correctly distinguishing them.
    if (saysTonight && saysTomorrow && todayPicks.length > 0 && tomorrowPicks.length > 0) {
      return { name: 'day_label_accuracy', pass: true, detail: 'mixed-date response with both labels (correct)' };
    }

    const errors = [];

    // "tonight"/"today" in SMS but ALL picks are tomorrow (none are today)
    if (saysTonight && tomorrowPicks.length > 0 && todayPicks.length === 0) {
      errors.push(`says "tonight" but all picks are tomorrow: ${tomorrowPicks.map(p => p.event_id).join(', ')}`);
    }

    // "tomorrow" in SMS but ALL picks are today (none are tomorrow)
    if (saysTomorrow && todayPicks.length > 0 && tomorrowPicks.length === 0) {
      errors.push(`says "tomorrow" but all picks are today: ${todayPicks.map(p => p.event_id).join(', ')}`);
    }

    return {
      name: 'day_label_accuracy',
      pass: errors.length === 0,
      detail: errors.length > 0 ? errors.join('; ') : 'day labels correct',
    };
  },

  /**
   * Pick count: numbered items in SMS should match picks.length.
   * Skip for non-event intents, single-pick (natural prose), and details.
   */
  pick_count_accuracy(trace) {
    const picks = trace.composition.picks || [];
    const sms = trace.output_sms || '';
    const intent = trace.output_intent;
    if (!['events', 'more'].includes(intent) || picks.length === 0) {
      return { name: 'pick_count_accuracy', pass: true, detail: 'not applicable' };
    }
    // Single-pick responses use natural prose (singlePick skill), no numbered list
    if (picks.length === 1) {
      return { name: 'pick_count_accuracy', pass: true, detail: 'single pick (prose)' };
    }
    // Count numbered items (e.g. "1)", "2)", "3)")
    const numbered = sms.match(/\d\)/g) || [];
    const smsCount = numbered.length;
    const match = smsCount === picks.length;
    return {
      name: 'pick_count_accuracy',
      pass: match,
      detail: match ? `${picks.length} picks, ${smsCount} numbered` : `${picks.length} picks but ${smsCount} numbered in SMS`,
    };
  },

  /**
   * Neighborhood accuracy: picked events should be in the claimed neighborhood.
   * Pass if no picks, no neighborhood claim, or at least 1 pick is in the claimed hood.
   */
  neighborhood_accuracy(trace) {
    const picks = trace.composition.picks || [];
    const hood = trace.composition.neighborhood_used;
    if (picks.length === 0 || !hood) {
      return { name: 'neighborhood_accuracy', pass: true, detail: 'no picks or no neighborhood' };
    }
    const picksWithHood = picks.filter(p => p.neighborhood);
    if (picksWithHood.length === 0) {
      return { name: 'neighborhood_accuracy', pass: true, detail: 'no neighborhood data on picks' };
    }
    const inHood = picksWithHood.filter(p => p.neighborhood === hood);
    if (inHood.length > 0) {
      return { name: 'neighborhood_accuracy', pass: true, detail: `${inHood.length}/${picksWithHood.length} picks in ${hood}` };
    }
    // No picks in claimed hood — pass if the SMS acknowledges the expansion
    const sms = (trace.output_sms || '').toLowerCase();
    const actualHoods = [...new Set(picksWithHood.map(p => p.neighborhood))];
    const expansionAck = /nearby|next door|next to|not much|close to|closest|right there|over in|but .{1,30} has|around\b|\barea\b|just (across|over|down)|steps away/i.test(sms);
    // Also count naming the actual neighborhood explicitly as acknowledgment
    const namedActualHood = actualHoods.some(h => sms.includes(h.toLowerCase()));
    if (expansionAck || namedActualHood) {
      return { name: 'neighborhood_accuracy', pass: true, detail: `0/${picksWithHood.length} in ${hood} but expansion acknowledged (${actualHoods.join(', ')})` };
    }
    return {
      name: 'neighborhood_accuracy',
      pass: false,
      detail: `0/${picksWithHood.length} picks in ${hood} (found: ${[...new Set(picksWithHood.map(p => p.neighborhood))].join(', ')})`,
    };
  },

  /**
   * Category adherence: when a category filter is active, picked events should match.
   * Pass if no category filter, or >=50% of picks match the filtered category.
   */
  category_adherence(trace) {
    const picks = trace.composition.picks || [];
    const filters = trace.composition.active_filters;
    if (!filters?.category || picks.length === 0) {
      return { name: 'category_adherence', pass: true, detail: 'no category filter or no picks' };
    }
    const picksWithCat = picks.filter(p => p.category);
    if (picksWithCat.length === 0) {
      return { name: 'category_adherence', pass: true, detail: 'no category data on picks' };
    }
    const filterCat = filters.category;
    const matching = picksWithCat.filter(p =>
      p.category === filterCat || CATEGORY_PARENTS[p.category] === filterCat
    );
    const ratio = matching.length / picksWithCat.length;
    const pass = ratio >= 0.75;
    return {
      name: 'category_adherence',
      pass,
      detail: `${matching.length}/${picksWithCat.length} picks match "${filters.category}" (${Math.round(ratio * 100)}%)`,
    };
  },

  /**
   * Free claim accuracy: when free_only filter is active, picked events should be free.
   * Pass if no free filter, or >=50% of picks are free.
   */
  free_claim_accuracy(trace) {
    const picks = trace.composition.picks || [];
    const filters = trace.composition.active_filters;
    if (!filters?.free_only || picks.length === 0) {
      return { name: 'free_claim_accuracy', pass: true, detail: 'no free filter or no picks' };
    }
    const freePicks = picks.filter(p => p.is_free);
    const ratio = freePicks.length / picks.length;
    const pass = ratio >= 0.75;
    return {
      name: 'free_claim_accuracy',
      pass,
      detail: `${freePicks.length}/${picks.length} picks are free (${Math.round(ratio * 100)}%)`,
    };
  },

  /**
   * Compound filter accuracy: when both free_only AND category are active,
   * picks must satisfy both simultaneously (not just each independently).
   */
  compound_filter_accuracy(trace) {
    const picks = trace.composition.picks || [];
    const filters = trace.composition.active_filters;
    if (!filters?.free_only || !filters?.category || picks.length === 0) {
      return { name: 'compound_filter_accuracy', pass: true, detail: 'no compound filter or no picks' };
    }
    const filterCat = filters.category;
    const bothMatch = picks.filter(p =>
      p.is_free === true && (p.category === filterCat || CATEGORY_PARENTS[p.category] === filterCat)
    );
    const ratio = bothMatch.length / picks.length;
    const pass = ratio >= 0.75;
    return {
      name: 'compound_filter_accuracy',
      pass,
      detail: `${bothMatch.length}/${picks.length} picks match free+${filterCat} (${Math.round(ratio * 100)}%)`,
    };
  },

  /**
   * Filter match alignment: when filters are active and matched events exist,
   * picked events should have been from the [MATCH]-tagged pool.
   */
  filter_match_alignment(trace) {
    const picks = trace.composition.picks || [];
    const poolMeta = trace.composition.pool_meta;
    const sentPool = trace.events.sent_pool;
    if (!poolMeta || !poolMeta.matchCount || !sentPool || picks.length === 0) {
      return { name: 'filter_match_alignment', pass: true, detail: 'no pool_meta, no matches, no sent_pool, or no picks' };
    }
    const poolById = new Map(sentPool.map(e => [e.event_id, e]));
    const fromMatched = picks.filter(p => {
      const poolEvent = poolById.get(p.event_id);
      return poolEvent && poolEvent.filter_match && poolEvent.filter_match !== false;
    });
    const ratio = fromMatched.length / picks.length;
    const pass = ratio >= 0.5;
    return {
      name: 'filter_match_alignment',
      pass,
      detail: `${fromMatched.length}/${picks.length} picks from matched pool (${Math.round(ratio * 100)}%)`,
    };
  },

  /**
   * Time filter accuracy: when time_after filter is active, picked events
   * should start after the filter time. Uses after-midnight wrapping (6am boundary).
   */
  time_filter_accuracy(trace) {
    const picks = trace.composition.picks || [];
    const filters = trace.composition.active_filters;
    if (!filters?.time_after || picks.length === 0) {
      return { name: 'time_filter_accuracy', pass: true, detail: 'no time filter or no picks' };
    }
    const picksWithTime = picks.filter(p => p.start_time_local);
    if (picksWithTime.length === 0) {
      return { name: 'time_filter_accuracy', pass: true, detail: 'no picks with parseable start times' };
    }
    // Parse filter time (e.g. "21:00" or "9pm") into minutes since midnight
    const filterStr = filters.time_after;
    let filterMinutes;
    const hhmm = filterStr.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) {
      filterMinutes = parseInt(hhmm[1]) * 60 + parseInt(hhmm[2]);
    } else {
      const ampm = filterStr.match(/^(\d{1,2})\s*(am|pm)$/i);
      if (ampm) {
        let h = parseInt(ampm[1]);
        if (ampm[2].toLowerCase() === 'pm' && h < 12) h += 12;
        if (ampm[2].toLowerCase() === 'am' && h === 12) h = 0;
        filterMinutes = h * 60;
      } else {
        return { name: 'time_filter_accuracy', pass: true, detail: `unparseable filter time: ${filterStr}` };
      }
    }
    // After-midnight wrapping: times before 6am are treated as next-day (add 24h)
    const WRAP_HOUR = 6;
    const wrapMinutes = (m) => m < WRAP_HOUR * 60 ? m + 1440 : m;
    const filterWrapped = wrapMinutes(filterMinutes);

    let passing = 0;
    for (const pick of picksWithTime) {
      try {
        // Extract hour:minute from ISO local time (e.g. "2026-02-25T21:00:00")
        const tMatch = pick.start_time_local.match(/T(\d{2}):(\d{2})/);
        if (!tMatch) continue;
        const pickMinutes = parseInt(tMatch[1]) * 60 + parseInt(tMatch[2]);
        const pickWrapped = wrapMinutes(pickMinutes);
        if (pickWrapped >= filterWrapped) passing++;
      } catch {
        // skip unparseable
      }
    }
    const ratio = passing / picksWithTime.length;
    const pass = ratio >= 0.75;
    return {
      name: 'time_filter_accuracy',
      pass,
      detail: `${passing}/${picksWithTime.length} picks after ${filterStr} (${Math.round(ratio * 100)}%)`,
    };
  },

  /**
   * Neighborhood expansion transparency: when picks are from a different
   * neighborhood than claimed, the SMS should acknowledge the expansion.
   */
  neighborhood_expansion_transparency(trace) {
    const picks = trace.composition.picks || [];
    const hood = trace.composition.neighborhood_used;
    const sms = (trace.output_sms || '').toLowerCase();
    if (!hood || picks.length === 0) {
      return { name: 'neighborhood_expansion_transparency', pass: true, detail: 'no neighborhood or no picks' };
    }
    const picksWithHood = picks.filter(p => p.neighborhood);
    if (picksWithHood.length === 0) {
      return { name: 'neighborhood_expansion_transparency', pass: true, detail: 'no neighborhood data on picks' };
    }
    const outOfHood = picksWithHood.filter(p => p.neighborhood !== hood);
    const majorityOutside = outOfHood.length / picksWithHood.length > 0.5;
    if (!majorityOutside) {
      return { name: 'neighborhood_expansion_transparency', pass: true, detail: 'majority of picks in claimed hood' };
    }
    // Majority of picks are outside claimed hood — SMS should acknowledge
    const actualHoods = [...new Set(outOfHood.map(p => p.neighborhood))];
    const namedActualHood = actualHoods.some(h => sms.includes(h.toLowerCase()));
    const hasAck = namedActualHood || /nearby|next door|next to|not much .{0,20} in|not much else|checking|close to|closest|over in|around\b|\barea\b|right there|but .{1,30} has|but .{1,30} is right|just (across|over|down)|steps away|a walk/i.test(sms);
    return {
      name: 'neighborhood_expansion_transparency',
      pass: hasAck,
      detail: hasAck
        ? `expansion acknowledged (${outOfHood.length}/${picksWithHood.length} outside ${hood})`
        : `${outOfHood.length}/${picksWithHood.length} picks outside ${hood} but SMS doesn't acknowledge expansion`,
    };
  },

  /**
   * Price transparency: event picks in SMS should mention price or "free".
   * Skip for non-event intents, details, and single-pick prose.
   */
  price_transparency(trace) {
    const picks = trace.composition.picks || [];
    const sms = trace.output_sms || '';
    const intent = trace.output_intent;
    if (!['events', 'more'].includes(intent) || picks.length === 0) {
      return { name: 'price_transparency', pass: true, detail: 'not applicable' };
    }
    // Check if any picked events have actionable price data (actual amount or explicit free)
    // is_free=false with no price_display only tells Claude "not free" — no price to display
    const picksWithPrice = picks.filter(p => p.is_free === true || p.price_display);
    if (picksWithPrice.length === 0) {
      return { name: 'price_transparency', pass: true, detail: 'no actionable price data on picked events (source gap)' };
    }
    // Check for price-like patterns in the SMS: "$5", "$10-20", "Free", "free!", "no cover", "cover charge", "ticketed", "paid"
    const pricePattern = /\$\d|free\b|no cover|cover charge|\bcover\b|ticketed|\bpaid\b|price TBD/i;
    const hasPrice = pricePattern.test(sms);
    return {
      name: 'price_transparency',
      pass: hasPrice,
      detail: hasPrice ? 'price info found in SMS' : `no price mention in SMS (${picksWithPrice.length}/${picks.length} picks have price data)`,
    };
  },

  /**
   * Schema compliance: LLM raw response must be valid JSON with required fields.
   * Detects parse failures that produce the "hit a snag" fallback.
   */
  schema_compliance(trace) {
    const raw = trace.composition.raw_response;
    const sms = trace.output_sms || '';
    const intent = trace.output_intent;
    // Skip if no raw response (mechanical pre-router shortcuts have no LLM call)
    if (raw === null || raw === undefined) {
      return { name: 'schema_compliance', pass: true, detail: 'no LLM call (pre-routed)' };
    }
    // Skip non-unified LLM paths (details/more use compose, which returns text not JSON)
    if (intent === 'details' || intent === 'more') {
      return { name: 'schema_compliance', pass: true, detail: `${intent} uses compose path (text, not JSON)` };
    }
    // Detect the fallback error message
    if (sms === "Having a moment — try again in a sec!" || sms === "Bestie hit a snag — try again in a sec!") {
      return { name: 'schema_compliance', pass: false, detail: 'fallback error response (JSON parse likely failed)' };
    }
    // Try to parse the raw response
    try {
      const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw;
      const start = jsonStr.indexOf('{');
      if (start === -1) {
        return { name: 'schema_compliance', pass: false, detail: 'no JSON object in raw response' };
      }
      const parsed = JSON.parse(jsonStr.slice(start));
      const hasType = typeof parsed.type === 'string';
      const hasSmsText = typeof parsed.sms_text === 'string';
      if (!hasSmsText) {
        return { name: 'schema_compliance', pass: false, detail: `missing sms_text field (has: ${Object.keys(parsed).join(', ')})` };
      }
      return { name: 'schema_compliance', pass: true, detail: 'valid JSON with required fields' };
    } catch {
      return { name: 'schema_compliance', pass: false, detail: 'raw response is not valid JSON' };
    }
  },

  /**
   * Model routing must be captured for all LLM-hitting traces.
   * Verifies trace.routing.model_routing has score, tier, and model fields.
   */
  model_routing_captured(trace) {
    const intent = trace.output_intent;
    // Skip pre-routed mechanical shortcuts (no LLM call)
    if (trace.routing.pre_routed && !trace.composition.raw_response) {
      return { name: 'model_routing_captured', pass: true, detail: 'pre-routed (no LLM call)' };
    }
    // Skip non-unified LLM paths (details/more use legacy compose, no model routing)
    if (intent === 'details' || intent === 'more') {
      return { name: 'model_routing_captured', pass: true, detail: `${intent} uses compose path (no model routing)` };
    }
    // Skip zero-match bypass (no LLM call)
    if (trace.composition.zero_match_bypass) {
      return { name: 'model_routing_captured', pass: true, detail: 'zero-match bypass (no LLM call)' };
    }
    const mr = trace.routing?.model_routing;
    if (!mr) {
      return { name: 'model_routing_captured', pass: false, detail: 'model_routing missing from trace' };
    }
    const hasFields = typeof mr.score === 'number' && typeof mr.tier === 'string' && typeof mr.model === 'string';
    return {
      name: 'model_routing_captured',
      pass: hasFields,
      detail: hasFields
        ? `tier=${mr.tier}, score=${mr.score}, model=${mr.model}`
        : `missing fields: score=${mr.score}, tier=${mr.tier}, model=${mr.model}`,
    };
  },

  /**
   * AI cost must be tracked for all LLM-hitting traces.
   */
  ai_cost_tracked(trace) {
    const intent = trace.output_intent;
    // Skip pre-routed mechanical shortcuts (no LLM call)
    if (trace.routing.pre_routed && !trace.composition.raw_response) {
      return { name: 'ai_cost_tracked', pass: true, detail: 'pre-routed (no LLM call)' };
    }
    // Skip non-unified LLM paths (details/more may not have cost tracking wired up yet)
    if (intent === 'details' || intent === 'more') {
      // Details/more DO call Claude — check cost is tracked but don't fail if not yet wired
      const costs = trace.ai_costs || [];
      if (costs.length > 0) {
        const total = trace.total_ai_cost_usd || 0;
        return { name: 'ai_cost_tracked', pass: true, detail: `$${total.toFixed(5)} (${intent} path)` };
      }
      return { name: 'ai_cost_tracked', pass: true, detail: `${intent} path (cost tracking optional)` };
    }
    // Skip zero-match bypass (no LLM call)
    if (trace.composition.zero_match_bypass) {
      return { name: 'ai_cost_tracked', pass: true, detail: 'zero-match bypass (no LLM call)' };
    }
    const costs = trace.ai_costs || [];
    const total = trace.total_ai_cost_usd || 0;
    if (costs.length === 0) {
      return { name: 'ai_cost_tracked', pass: false, detail: 'LLM call made but no cost recorded' };
    }
    const callTypes = costs.map(c => c.call_type).join(', ');
    return {
      name: 'ai_cost_tracked',
      pass: total > 0,
      detail: `$${total.toFixed(5)} (${costs.length} call${costs.length > 1 ? 's' : ''}: ${callTypes})`,
    };
  },

  /**
   * Total latency should be under 10s
   */
  latency_under_10s(trace) {
    const ms = trace.total_latency_ms || 0;
    return {
      name: 'latency_under_10s',
      pass: ms < 10000,
      detail: `${ms}ms`,
    };
  },
};

/**
 * Run all code evals on a trace.
 * @param {Object} trace
 * @returns {Array<{name, pass, detail}>}
 */
function runCodeEvals(trace) {
  return Object.values(evals).map(fn => fn(trace));
}

module.exports = { runCodeEvals, evals };
