const { getEvents } = require('./events');
const { composeDetails } = require('./ai');
const { sendSMS } = require('./twilio');
const { setSession } = require('./session');
const { formatEventDetails, smartTruncate } = require('./formatters');
const { getAdjacentNeighborhoods } = require('./pre-router');
const { getPerennialPicks, toEventObjects } = require('./perennial');
const { filterKidsEvents, validatePerennialActivity } = require('./curation');
const { filterByTimeAfter } = require('./geo');

function applyFilters(events, filters) {
  let filtered = events;
  if (filters?.free_only) {
    filtered = filtered.filter(e => e.is_free);
  }
  if (filters?.category) {
    const catFiltered = filtered.filter(e => e.category === filters.category);
    if (catFiltered.length > 0) filtered = catFiltered;
  }
  if (filters?.time_after) {
    filtered = filterByTimeAfter(filtered, filters.time_after);
  }
  return filtered;
}

// --- Send compose result (picks only, no link messages) ---
// Links are sent only when the user requests details (texts a number).
async function sendComposeWithLinks(phone, result, eventSource) {
  await sendSMS(phone, result.sms_text);
}

const VIBE_WORDS = { live_music: 'some music', nightlife: 'some nightlife', comedy: 'some comedy', art: 'some art', community: 'something cool', food_drink: 'some food & drinks', theater: 'some theater' };

function topVibeWord(events) {
  const cats = {};
  for (const e of events) cats[e.category || 'events'] = (cats[e.category || 'events'] || 0) + 1;
  const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'events';
  return VIBE_WORDS[topCat] || 'some stuff going on';
}

function stripMoreReferences(text) {
  return text
    .replace(/,?\s*MORE for extra picks/gi, '')
    .replace(/,?\s*or MORE for more/gi, '')
    .replace(/,?\s*MORE for more picks/gi, '')
    .replace(/\s*Reply MORE[^.!\n]*/gi, '')
    .replace(/,?\s*MORE for more/gi, '');
}

// --- Help ---
async function handleHelp(ctx) {
  const reply = ctx.route.reply || "Hey! I'm Pulse — text me a neighborhood and I'll find tonight's best events.\n\nTry: \"East Village\", \"prospect park\", \"bedford ave\"\n\nYou can ask for comedy, jazz, free events, or any vibe. Reply a number for details on a pick, or \"more\" for more options.";
  const sms = smartTruncate(reply);
  await sendSMS(ctx.phone, sms);
  console.log(`Help sent to ${ctx.masked}`);
  ctx.finalizeTrace(sms, 'help');
}

// --- Conversational ---
async function handleConversational(ctx) {
  let reply = ctx.route.reply || "Hey! Text a neighborhood whenever you're ready to go out.";
  if (ctx.session?.lastNeighborhood) {
    reply = reply.replace(
      /text (?:me )?a neighborhood[^.]*/i,
      `say "more" for more ${ctx.session.lastNeighborhood} picks, or text a different neighborhood`
    );
  }
  const sms = smartTruncate(reply);
  await sendSMS(ctx.phone, sms);
  console.log(`Conversational reply sent to ${ctx.masked}`);
  ctx.finalizeTrace(sms, 'conversational');
}

// --- Details ---
async function handleDetails(ctx) {
  const picks = ctx.session?.lastPicks;
  if (ctx.session && picks?.length > 0) {
    const ref = parseInt(ctx.route.event_reference, 10);

    if (!ref || isNaN(ref)) {
      const details = picks.map((pick, i) => {
        const event = ctx.session.lastEvents[pick.event_id];
        return event ? `${i + 1}. ${formatEventDetails(event)}` : null;
      }).filter(Boolean);
      const allText = details.join('\n\n');
      const sms = smartTruncate(allText);
      await sendSMS(ctx.phone, sms);
      console.log(`All details sent to ${ctx.masked}`);
      ctx.finalizeTrace(sms, 'details');
      return;
    }

    if (ref > picks.length) {
      const sms = picks.length === 1
        ? "I only showed you 1 pick — reply 1 for details."
        : `I only showed you ${picks.length} picks — reply 1-${picks.length} for details.`;
      await sendSMS(ctx.phone, sms);
      ctx.finalizeTrace(sms, 'details');
      return;
    }
    const pickIndex = Math.max(0, ref - 1);
    const pick = picks[pickIndex];
    const event = ctx.session.lastEvents[pick.event_id];
    if (event) {
      try {
        const composeStart = Date.now();
        const result = await composeDetails(event, pick.why);
        ctx.trace.composition.latency_ms = Date.now() - composeStart;
        ctx.trace.composition.raw_response = result._raw || null;
        ctx.trackAICost?.(result._usage);
        const sms = result.sms_text;
        await sendSMS(ctx.phone, sms);
        console.log(`Details ${ref} sent to ${ctx.masked}`);
        ctx.finalizeTrace(sms, 'details');
        return;
      } catch (err) {
        console.error('composeDetails error, falling back:', err.message);
        const sms = formatEventDetails(event);
        await sendSMS(ctx.phone, sms);
        ctx.finalizeTrace(sms, 'details');
        return;
      }
    }
  }
  const sms = "I don't have any recent picks to pull up — text me a neighborhood and let's start fresh!";
  await sendSMS(ctx.phone, sms);
  ctx.finalizeTrace(sms, 'details');
}

// --- More ---
async function handleMore(ctx) {
  const allOfferedIds = new Set(ctx.session?.allOfferedIds || []);
  const allPickIds = new Set((ctx.session?.allPicks || ctx.session?.lastPicks || []).map(p => p.event_id));
  const allShownIds = new Set([...allOfferedIds, ...allPickIds]);
  const hood = ctx.neighborhood || ctx.session?.lastNeighborhood;

  if (ctx.session && ctx.session.lastEvents) {
    const allRemaining = Object.values(ctx.session.lastEvents).filter(e => !allShownIds.has(e.id));

    if (allRemaining.length > 0) {
      // Strictly prefer remaining events in the requested neighborhood
      const inHoodRemaining = allRemaining.filter(e => e.neighborhood === hood);
      const composePool = inHoodRemaining.length > 0 ? inHoodRemaining : allRemaining;
      const composeRemaining = composePool.slice(0, 8);
      const isLastBatch = allRemaining.length <= 8;
      const nearbyForExhaustion = isLastBatch ? getAdjacentNeighborhoods(hood, 3).filter(n => !(ctx.session?.visitedHoods || []).includes(n))[0] : null;
      const exhaustionSuggestion = nearbyForExhaustion
        ? `That's everything I've got in ${hood}! ${nearbyForExhaustion} is right nearby — want picks from there?`
        : `That's everything I've got in ${hood}! Try a different neighborhood for more.`;

      ctx.trace.events.cache_size = Object.keys(ctx.session.lastEvents).length;
      ctx.trace.events.candidates_count = allRemaining.length;
      ctx.trace.events.candidate_ids = allRemaining.map(e => e.id);
      const skills = isLastBatch ? { isLastBatch: true, exhaustionSuggestion } : {};
      const result = await ctx.composeAndSend(composeRemaining, hood, ctx.route.filters, 'more', { excludeIds: [...allShownIds], skills });

      // Name-based dedup: filter out picks that share a name with previously shown events
      const prevPickNames = new Set(
        (ctx.session.allPicks || ctx.session.lastPicks || [])
          .map(p => ctx.session.lastEvents[p.event_id]?.name?.toLowerCase())
          .filter(Boolean)
      );
      result.picks = (result.picks || []).filter(p => {
        const evt = ctx.session.lastEvents[p.event_id];
        return !evt || !prevPickNames.has(evt.name?.toLowerCase());
      });

      if (isLastBatch) {
        result.sms_text = stripMoreReferences(result.sms_text);
      }

      const newAllPicks = [...(ctx.session.allPicks || ctx.session.lastPicks || []), ...(result.picks || [])];
      const newAllOfferedIds = [...allOfferedIds, ...composeRemaining.map(e => e.id)];
      const visitedHoods = new Set([...(ctx.session.visitedHoods || []), hood]);
      setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: newAllPicks, allOfferedIds: newAllOfferedIds, lastEvents: ctx.session.lastEvents, lastNeighborhood: hood, lastFilters: ctx.route.filters || null, visitedHoods: [...visitedHoods] });
      await sendComposeWithLinks(ctx.phone, result, ctx.session.lastEvents);

      console.log(`More sent to ${ctx.masked} (${allRemaining.length} remaining${isLastBatch ? ', last batch' : ''})`);
      ctx.finalizeTrace(result.sms_text, 'more');
      return;
    }
  }

  if (!ctx.session?.lastNeighborhood) {
    const sms = "Text me a neighborhood and I'll find you something! East Village, Williamsburg, LES — whatever's close.";
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'more');
    return;
  }

  // All scraped events exhausted — check for unshown perennial picks
  const morePicks = getPerennialPicks(hood);
  const moreLocalPerennials = validatePerennialActivity(toEventObjects(morePicks.local, hood));
  const moreNearbyPerennials = validatePerennialActivity(toEventObjects(morePicks.nearby, hood, { isNearby: true }));
  const allMorePerennials = [...moreLocalPerennials, ...moreNearbyPerennials];
  const allShownMoreIds = new Set([...(ctx.session?.allOfferedIds || []), ...(ctx.session?.allPicks || ctx.session?.lastPicks || []).map(p => p.event_id)]);
  const unshownPerennials = allMorePerennials.filter(e => !allShownMoreIds.has(e.id));

  if (unshownPerennials.length > 0) {
    const perennialBatch = unshownPerennials.slice(0, 4);
    const eventMap = { ...ctx.session.lastEvents };
    for (const e of perennialBatch) eventMap[e.id] = e;
    ctx.trace.events.cache_size = 0;
    ctx.trace.events.candidates_count = perennialBatch.length;
    ctx.trace.events.candidate_ids = perennialBatch.map(e => e.id);
    const perennialNearby = getAdjacentNeighborhoods(hood, 3).filter(n => !(ctx.session?.visitedHoods || []).includes(n))[0];
    const perennialSuggestion = perennialNearby
      ? `That's everything I've got in ${hood}! ${perennialNearby} is right nearby — want picks from there?`
      : `That's everything I've got in ${hood}! Try a different neighborhood for more.`;
    const result = await ctx.composeAndSend(perennialBatch, hood, ctx.route.filters, 'more', { excludeIds: [...allShownMoreIds], skills: { isLastBatch: true, exhaustionSuggestion: perennialSuggestion } });
    result.sms_text = stripMoreReferences(result.sms_text);
    const newAllPicks = [...(ctx.session.allPicks || ctx.session.lastPicks || []), ...(result.picks || [])];
    const newAllOfferedIds = [...(ctx.session.allOfferedIds || []), ...perennialBatch.map(e => e.id)];
    const visitedHoods = new Set([...(ctx.session.visitedHoods || []), hood]);
    setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: newAllPicks, allOfferedIds: newAllOfferedIds, lastEvents: eventMap, lastNeighborhood: hood, visitedHoods: [...visitedHoods] });
    await sendComposeWithLinks(ctx.phone, result, eventMap);
    console.log(`Perennial picks sent to ${ctx.masked} after events exhausted in ${hood}`);
    ctx.finalizeTrace(result.sms_text, 'more');
    return;
  }

  // All events and perennials exhausted — suggest specific nearby neighborhood
  const visited = new Set(ctx.session?.visitedHoods || [hood]);
  const nearby = getAdjacentNeighborhoods(hood, 4).filter(n => !visited.has(n));
  const suggestion = nearby.length > 0 ? ` ${nearby[0]} is right nearby — want picks from there?` : ' Try a different neighborhood or check back later!';
  const sms = `That's all I've got in ${hood} tonight!${suggestion}`;
  await sendSMS(ctx.phone, sms);
  ctx.finalizeTrace(sms, 'more');
}

// --- Free ---
async function handleFree(ctx) {
  const hood = ctx.neighborhood;
  if (!hood) {
    setSession(ctx.phone, { pendingFilters: { ...ctx.route.filters, free_only: true }, pendingMessage: ctx.message });
    const sms = "Where are you headed? Drop me a neighborhood like East Village, Williamsburg, or LES.";
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'free');
    return;
  }

  const freeEventsStart = Date.now();
  const events = await getEvents(hood);
  ctx.trace.events.getEvents_ms = Date.now() - freeEventsStart;

  // Strictly filter to the requested neighborhood — "free in Williamsburg" means Williamsburg only
  const inHood = events.filter(e => e.neighborhood === hood);
  const pool = inHood.length > 0 ? inHood : events;

  // Apply filters: free is always hard, category is hard when explicitly requested
  // (e.g. "free comedy" → must match BOTH free AND comedy, not just free)
  let freeEvents = pool.filter(e => e.is_free);
  if (ctx.route.filters?.category) {
    freeEvents = freeEvents.filter(e => e.category === ctx.route.filters.category);
  }
  if (ctx.route.filters?.time_after) {
    freeEvents = filterByTimeAfter(freeEvents, ctx.route.filters.time_after);
  }

  if (freeEvents.length === 0) {
    const nearbyHoods = getAdjacentNeighborhoods(hood, 3);
    const suggestion = nearbyHoods.length > 0
      ? ` ${nearbyHoods[0]} is right nearby — want free picks from there?`
      : ' Try a different neighborhood!';
    if (nearbyHoods.length > 0) {
      // Preserve both the nearby suggestion AND the active filters for nudge_accept
      setSession(ctx.phone, { pendingNearby: nearbyHoods[0], pendingFilters: { ...ctx.route.filters, free_only: true } });
    }
    const catLabel = ctx.route.filters?.category ? ctx.route.filters.category.replace(/_/g, ' ') + ' ' : '';
    const sms = `Nothing free ${catLabel}near ${hood} tonight.${suggestion}`;
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'free');
    return;
  }

  ctx.trace.events.cache_size = events.length;
  ctx.trace.events.candidates_count = Math.min(freeEvents.length, 8);
  ctx.trace.events.candidate_ids = freeEvents.slice(0, 8).map(e => e.id);
  const result = await ctx.composeAndSend(freeEvents.slice(0, 8), hood, ctx.route.filters, 'free', { skills: { isFree: true, pendingMessage: ctx.pendingMessage || undefined } });
  const eventMap = {};
  for (const e of freeEvents) eventMap[e.id] = e;
  setSession(ctx.phone, {
    lastPicks: result.picks || [],
    allPicks: result.picks || [],
    lastEvents: eventMap,
    lastNeighborhood: hood,
    lastFilters: ctx.route.filters || null,
  });
  await sendComposeWithLinks(ctx.phone, result, eventMap);
  console.log(`Free events sent to ${ctx.masked}`);
  ctx.finalizeTrace(result.sms_text, 'free');
}

// --- Nudge accept (user said yes to travel suggestion) ---
// Returns true if handled, false to fall through to events
async function handleNudgeAccept(ctx) {
  const acceptedHood = ctx.route.neighborhood;
  const pendingFilters = ctx.session?.pendingFilters;
  const activeFilters = pendingFilters || ctx.route.filters;
  if (acceptedHood === ctx.session?.pendingNearby && ctx.session?.pendingNearbyEvents && Object.keys(ctx.session.pendingNearbyEvents).length > 0) {
    const nearbyEvents = ctx.session.pendingNearbyEvents;
    const composeEvents = applyFilters(Object.values(nearbyEvents), activeFilters).slice(0, 8);
    ctx.trace.events.cache_size = Object.keys(nearbyEvents).length;
    ctx.trace.events.candidates_count = composeEvents.length;
    ctx.trace.events.candidate_ids = composeEvents.map(e => e.id);
    const result = await ctx.composeAndSend(composeEvents, acceptedHood, ctx.route.filters, 'nudge_accept');
    setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: nearbyEvents, lastNeighborhood: acceptedHood });
    await sendComposeWithLinks(ctx.phone, result, nearbyEvents);
    console.log(`Nudge accept: served ${acceptedHood} picks to ${ctx.masked}`);
    ctx.finalizeTrace(result.sms_text, 'nudge_accept');
    return true;
  }
  if (acceptedHood) {
    const counterEvents = await getEvents(acceptedHood);
    const filteredCounter = applyFilters(counterEvents, activeFilters);
    if (filteredCounter.length > 0) {
      const composeEvents = filteredCounter.slice(0, 8);
      ctx.trace.events.cache_size = counterEvents.length;
      ctx.trace.events.candidates_count = composeEvents.length;
      ctx.trace.events.candidate_ids = composeEvents.map(e => e.id);
      const eventMap = {};
      for (const e of filteredCounter) eventMap[e.id] = e;
      const result = await ctx.composeAndSend(composeEvents, acceptedHood, ctx.route.filters, 'nudge_accept');
      setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: acceptedHood });
      await sendComposeWithLinks(ctx.phone, result, eventMap);
      console.log(`Nudge accept (counter-suggestion): served ${acceptedHood} picks to ${ctx.masked}`);
      ctx.finalizeTrace(result.sms_text, 'nudge_accept');
      return true;
    }
    const nearby2 = getAdjacentNeighborhoods(acceptedHood, 5);
    for (const nearbyHood of nearby2) {
      const nearbyEvents = await getEvents(nearbyHood);
      const filteredNearby = applyFilters(nearbyEvents, activeFilters);
      if (filteredNearby.length > 0) {
        const composeEvents = filteredNearby.slice(0, 8);
        const eventMap = {};
        for (const e of filteredNearby) eventMap[e.id] = e;
        const result = await ctx.composeAndSend(composeEvents, nearbyHood, activeFilters, 'nudge_accept');
        setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
        await sendComposeWithLinks(ctx.phone, result, eventMap);
        console.log(`Nudge accept (nearby fallback): served ${nearbyHood} picks to ${ctx.masked}`);
        ctx.finalizeTrace(result.sms_text, 'nudge_accept');
        return true;
      }
    }
  }
  console.warn('Nudge accept but no saved events, falling through to events');
  return false;
}

// --- Events (default) ---
async function handleEventsDefault(ctx) {
  const hood = ctx.neighborhood;
  const eventsStart = Date.now();
  let events = await getEvents(hood);
  ctx.trace.events.getEvents_ms = Date.now() - eventsStart;
  console.log(`Found ${events.length} events near ${hood}`);

  // Apply free_only filter when routed as events but user asked for free
  if (ctx.route.filters?.free_only) {
    events = events.filter(e => e.is_free);
  }

  // Apply time_after filter (e.g. "later tonight" → "22:00")
  if (ctx.route.filters?.time_after) {
    events = filterByTimeAfter(events, ctx.route.filters.time_after);
  }

  // Pre-compose curation: remove kids events from NYC Parks
  events = filterKidsEvents(events);

  // Perennial picks — merge LOCAL picks only as event objects for compose
  const perennialPicks = getPerennialPicks(hood);
  const localPerennials = validatePerennialActivity(toEventObjects(perennialPicks.local, hood));
  const perennialCap = Math.min(4, 8 - Math.min(events.length, 8));
  const perennialEvents = localPerennials.slice(0, perennialCap);
  const composeEventsWithPerennials = [...events.slice(0, 8 - perennialEvents.length), ...perennialEvents];

  // Nearby neighborhoods for Claude to suggest when picks are thin
  const nearbyHoods = getAdjacentNeighborhoods(hood, 3);

  if (composeEventsWithPerennials.length === 0) {
    // Nothing at all — send quiet-night message with nearby suggestion
    const suggestion = nearbyHoods.length > 0
      ? ` ${nearbyHoods[0]} is right nearby — want picks from there?`
      : ' Try a different neighborhood or check back later!';
    const sms = `Quiet night in ${hood} — not seeing much right now.${suggestion}`;
    if (nearbyHoods.length > 0) {
      setSession(ctx.phone, { pendingNearby: nearbyHoods[0] });
    }
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'events');
    return;
  }

  // Compose response — Claude handles category/activity filtering, nearby suggestions
  ctx.trace.events.cache_size = events.length;
  ctx.trace.events.candidates_count = composeEventsWithPerennials.length;
  ctx.trace.events.candidate_ids = composeEventsWithPerennials.map(e => e.id);
  const result = await ctx.composeAndSend(composeEventsWithPerennials, hood, ctx.route.filters, 'events', {
    skills: { userMessage: ctx.message, requestedCategory: ctx.route.filters?.category, nearbyNeighborhoods: nearbyHoods },
  });

  const eventMap = {};
  const moreBuffer = events.slice(0, 12); // cap for 1 MORE batch before exhaustion
  for (const e of moreBuffer) eventMap[e.id] = e;
  for (const e of perennialEvents) eventMap[e.id] = e;

  // Validate picks — filter out any hallucinated event_ids not in event map
  const validPicks = (result.picks || []).filter(p => eventMap[p.event_id]);
  if (validPicks.length < (result.picks || []).length) {
    console.warn(`Filtered ${(result.picks || []).length - validPicks.length} hallucinated pick IDs`);
  }

  // If Claude suggested a nearby neighborhood, validate and store for nudge_accept
  // Also preserve active filters so they persist across the redirect (e.g. "later tonight", category)
  if (result.suggested_neighborhood && nearbyHoods.includes(result.suggested_neighborhood)) {
    const filtersToPreserve = ctx.route.filters && Object.values(ctx.route.filters).some(Boolean) ? ctx.route.filters : null;
    setSession(ctx.phone, { pendingNearby: result.suggested_neighborhood, ...(filtersToPreserve && { pendingFilters: filtersToPreserve }) });
  }

  setSession(ctx.phone, { lastPicks: validPicks, allPicks: validPicks, allOfferedIds: composeEventsWithPerennials.map(e => e.id), lastEvents: eventMap, lastNeighborhood: result.neighborhood_used || hood, lastFilters: ctx.route.filters || null, visitedHoods: [hood] });
  await sendComposeWithLinks(ctx.phone, result, eventMap);
  console.log(`AI response sent to ${ctx.masked}`);
  ctx.finalizeTrace(result.sms_text, 'events');
}

module.exports = { sendComposeWithLinks, topVibeWord, stripMoreReferences, handleHelp, handleConversational, handleDetails, handleMore, handleFree, handleNudgeAccept, handleEventsDefault };
