const { getEvents } = require('./events');
const { composeDetails, isSearchUrl } = require('./ai');
const { sendSMS } = require('./twilio');
const { setSession } = require('./session');
const { formatEventDetails, cleanUrl, smartTruncate } = require('./formatters');
const { getAdjacentNeighborhoods } = require('./pre-router');
const { getPerennialPicks, toEventObjects } = require('./perennial');

// --- Send compose result + follow-up link messages ---
// Sends the main sms_text, then each picked event's URL as a separate message
// so that iMessage/Android unfurls a rich link preview with venue images.
async function sendComposeWithLinks(phone, result, eventSource) {
  await sendSMS(phone, result.sms_text);

  const picks = result.picks || [];
  for (const pick of picks) {
    const event = eventSource[pick.event_id];
    if (!event) continue;
    const url = [event.ticket_url, event.source_url].find(u => u && !isSearchUrl(u));
    if (url) {
      await sendSMS(phone, cleanUrl(url));
    }
  }
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
      const composeRemaining = allRemaining.slice(0, 8);
      const isLastBatch = allRemaining.length <= 8;
      const nearbyForExhaustion = isLastBatch ? getAdjacentNeighborhoods(hood, 3).filter(n => !(ctx.session?.visitedHoods || []).includes(n))[0] : null;
      const exhaustionSuggestion = nearbyForExhaustion
        ? `That's everything I've got in ${hood}! ${nearbyForExhaustion} is right nearby — want picks from there?`
        : `That's everything I've got in ${hood}! Try a different neighborhood for more.`;
      const extraContext = isLastBatch
        ? `\nNOTE: This is the LAST batch of events I have.\nOVERRIDE CLOSING LINE: Instead of "Reply 1-N for details, MORE for extra picks", use "Reply 1-N for details" (no MORE option). Then add "${exhaustionSuggestion}"`
        : '';

      ctx.trace.events.cache_size = Object.keys(ctx.session.lastEvents).length;
      ctx.trace.events.candidates_count = allRemaining.length;
      ctx.trace.events.candidate_ids = allRemaining.map(e => e.id);
      const result = await ctx.composeAndSend(composeRemaining, hood, ctx.route.filters, 'more', { excludeIds: [...allShownIds], extraContext });

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
      setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: newAllPicks, allOfferedIds: newAllOfferedIds, lastEvents: ctx.session.lastEvents, lastNeighborhood: hood, visitedHoods: [...visitedHoods] });
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
  const moreLocalPerennials = toEventObjects(morePicks.local, hood);
  const moreNearbyPerennials = toEventObjects(morePicks.nearby, hood, { isNearby: true });
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
    const extraContext = `\nNOTE: This is the LAST batch of recommendations I have.\nOVERRIDE CLOSING LINE: Instead of "Reply 1-N for details, MORE for extra picks", use "Reply 1-N for details" (no MORE option). Then add "${perennialSuggestion}"`;
    const result = await ctx.composeAndSend(perennialBatch, hood, ctx.route.filters, 'more', { excludeIds: [...allShownMoreIds], extraContext });
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

  const events = await getEvents(hood);
  const freeEvents = events.filter(e => e.is_free);

  // Apply category filter if present (from pending filters or route)
  let filteredFree = freeEvents;
  if (ctx.route.filters?.category) {
    const catFiltered = freeEvents.filter(e => e.category === ctx.route.filters.category);
    if (catFiltered.length > 0) filteredFree = catFiltered;
  }

  if (filteredFree.length === 0) {
    const nearbyHoods = getAdjacentNeighborhoods(hood, 3);
    for (const nearbyHood of nearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      let nearbyFree = nearbyEvents.filter(e => e.is_free);
      if (ctx.route.filters?.category) {
        const nearbyCat = nearbyFree.filter(e => e.category === ctx.route.filters.category);
        if (nearbyCat.length > 0) nearbyFree = nearbyCat;
      }
      if (nearbyFree.length > 0) {
        ctx.trace.events.cache_size = nearbyEvents.length;
        ctx.trace.events.candidates_count = nearbyFree.length;
        ctx.trace.events.candidate_ids = nearbyFree.map(e => e.id);
        const eventMap = {};
        for (const e of nearbyFree) eventMap[e.id] = e;
        const nearbyFreeContext = ctx.pendingMessage
          ? `\nUser's original request: "${ctx.pendingMessage}". Prioritize events matching that intent.`
          : '';
        const result = await ctx.composeAndSend(nearbyFree.slice(0, 8), nearbyHood, { ...ctx.route.filters, free_only: true }, 'free', { extraContext: nearbyFreeContext });
        setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
        await sendComposeWithLinks(ctx.phone, result, eventMap);
        console.log(`Free events from nearby ${nearbyHood} sent to ${ctx.masked}`);
        ctx.finalizeTrace(result.sms_text, 'free');
        return;
      }
    }
    const catLabel = ctx.route.filters?.category ? ctx.route.filters.category.replace(/_/g, ' ') + ' ' : '';
    const sms = `Nothing free ${catLabel}near ${hood} tonight — text "${hood}" for all events or try a different neighborhood!`;
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'free');
    return;
  }

  ctx.trace.events.cache_size = events.length;
  ctx.trace.events.candidates_count = Math.min(filteredFree.length, 8);
  ctx.trace.events.candidate_ids = filteredFree.slice(0, 8).map(e => e.id);
  const freeExtraContext = ctx.pendingMessage
    ? `\nUser's original request: "${ctx.pendingMessage}". Prioritize events matching that intent.`
    : '\nUser asked for free events. ALWAYS list them with numbers even if they seem niche — the user specifically wants free.';
  const result = await ctx.composeAndSend(filteredFree.slice(0, 8), hood, ctx.route.filters, 'free', { extraContext: freeExtraContext });
  const eventMap = {};
  for (const e of filteredFree) eventMap[e.id] = e;
  setSession(ctx.phone, {
    lastPicks: result.picks || [],
    allPicks: result.picks || [],
    lastEvents: eventMap,
    lastNeighborhood: hood,
  });
  await sendComposeWithLinks(ctx.phone, result, eventMap);
  console.log(`Free events sent to ${ctx.masked}`);
  ctx.finalizeTrace(result.sms_text, 'free');
}

// --- Nudge accept (user said yes to travel suggestion) ---
// Returns true if handled, false to fall through to events
async function handleNudgeAccept(ctx) {
  const acceptedHood = ctx.route.neighborhood;
  if (acceptedHood === ctx.session?.pendingNearby && ctx.session?.pendingNearbyEvents && Object.keys(ctx.session.pendingNearbyEvents).length > 0) {
    const nearbyEvents = ctx.session.pendingNearbyEvents;
    const composeEvents = Object.values(nearbyEvents).slice(0, 8);
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
    if (counterEvents.length > 0) {
      const composeEvents = counterEvents.slice(0, 8);
      ctx.trace.events.cache_size = counterEvents.length;
      ctx.trace.events.candidates_count = composeEvents.length;
      ctx.trace.events.candidate_ids = composeEvents.map(e => e.id);
      const eventMap = {};
      for (const e of counterEvents) eventMap[e.id] = e;
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
      if (nearbyEvents.length > 0) {
        const composeEvents = nearbyEvents.slice(0, 8);
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        const result = await ctx.composeAndSend(composeEvents, nearbyHood, ctx.route.filters, 'nudge_accept');
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
  let hood = ctx.neighborhood;
  let events = await getEvents(hood);
  console.log(`Found ${events.length} events near ${hood}`);

  // Apply free_only filter when routed as events but user asked for free
  if (ctx.route.filters?.free_only) {
    events = events.filter(e => e.is_free);
  }

  // Apply category filter (e.g. comedy, art, live_music)
  let categoryApplied = false;
  if (ctx.route.filters?.category) {
    const catEvents = events.filter(e => e.category === ctx.route.filters.category);
    if (catEvents.length > 0) {
      events = catEvents;
      categoryApplied = true;
    } else {
      const nearbyHoods = getAdjacentNeighborhoods(hood, 5);
      for (const nearbyHood of nearbyHoods) {
        const nearbyEvents = await getEvents(nearbyHood);
        const nearbyCat = nearbyEvents.filter(e => e.category === ctx.route.filters.category);
        if (nearbyCat.length > 0) {
          events = nearbyCat;
          console.log(`Category ${ctx.route.filters.category}: found ${nearbyCat.length} in ${nearbyHood} (not in ${hood})`);
          hood = nearbyHood;
          categoryApplied = true;
          break;
        }
      }
      if (events.filter(e => e.category === ctx.route.filters.category).length === 0) {
        const catName = ctx.route.filters.category.replace(/_/g, ' ');
        const sms = `Not seeing any ${catName} near ${hood} tonight. Text "${hood}" to see everything, or try a different neighborhood!`;
        await sendSMS(ctx.phone, sms);
        ctx.finalizeTrace(sms, 'events');
        return;
      }
    }
  }

  // Perennial picks — merge LOCAL picks only as event objects for compose
  const perennialPicks = getPerennialPicks(hood);
  const localPerennials = toEventObjects(perennialPicks.local, hood);
  const perennialCap = Math.min(4, 8 - Math.min(events.length, 8));
  const perennialEvents = localPerennials.slice(0, perennialCap);
  const composeEventsWithPerennials = [...events.slice(0, 8 - perennialEvents.length), ...perennialEvents];

  // Prevent redirect loops: if user already got a travel nudge, serve nearby events directly
  const alreadyNudged = !!ctx.session?.pendingNearby;

  if (events.length === 0) {
    // Check LOCAL perennial picks before nudging to a nearby neighborhood
    const zeroPicks = getPerennialPicks(hood);
    const zeroLocal = toEventObjects(zeroPicks.local, hood);
    const zeroPerennials = zeroLocal.slice(0, 4);
    if (zeroPerennials.length > 0) {
      const eventMap = {};
      for (const e of zeroPerennials) eventMap[e.id] = e;
      ctx.trace.events.cache_size = 0;
      ctx.trace.events.candidates_count = zeroPerennials.length;
      ctx.trace.events.candidate_ids = zeroPerennials.map(e => e.id);
      const result = await ctx.composeAndSend(zeroPerennials, hood, ctx.route.filters, 'events');
      setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: hood, visitedHoods: [hood] });
      await sendComposeWithLinks(ctx.phone, result, eventMap);
      console.log(`Perennial picks sent to ${ctx.masked} (zero scraped events in ${hood})`);
      ctx.finalizeTrace(result.sms_text, 'events');
      return;
    }

    // Find nearby neighborhoods WITH events for a proper travel nudge
    const nearbyHoods = getAdjacentNeighborhoods(hood, 5);
    for (const nearbyHood of nearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      if (nearbyEvents.length > 0) {
        if (alreadyNudged) {
          const composeEvents = nearbyEvents.slice(0, 8);
          const eventMap = {};
          for (const e of nearbyEvents) eventMap[e.id] = e;
          ctx.trace.events.cache_size = nearbyEvents.length;
          ctx.trace.events.candidates_count = composeEvents.length;
          ctx.trace.events.candidate_ids = composeEvents.map(e => e.id);
          const result = await ctx.composeAndSend(composeEvents, nearbyHood, ctx.route.filters, 'events');
          setSession(ctx.phone, { lastPicks: result.picks || [], allPicks: result.picks || [], lastEvents: eventMap, lastNeighborhood: nearbyHood });
          await sendComposeWithLinks(ctx.phone, result, eventMap);
          console.log(`Loop prevention: served ${nearbyHood} picks to ${ctx.masked} (skipped nudge)`);
          ctx.finalizeTrace(result.sms_text, 'events');
          return;
        }
        const vibeWord = topVibeWord(nearbyEvents);
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        setSession(ctx.phone, { pendingNearby: nearbyHood, pendingNearbyEvents: eventMap });
        const sms = `Hey not much going on in ${hood}... would you travel to ${nearbyHood} for ${vibeWord}?`;
        await sendSMS(ctx.phone, sms);
        console.log(`Nudge sent to ${ctx.masked}: ${hood} → ${nearbyHood} (${nearbyEvents.length} events)`);
        ctx.finalizeTrace(sms, 'events');
        return;
      }
    }
    const sms = `Quiet night in ${hood} — not seeing much right now. Check back later!`;
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'events');
    return;
  }

  // Check if any events are actually in the requested neighborhood
  const inHood = events.filter(e => e.neighborhood === hood);

  // Redirect to travel nudge when events are thin
  const thinWithNoPerennial = events.length <= 1 && localPerennials.length === 0;
  const fewNearbyOnly = inHood.length === 0 && events.length <= 6;
  if ((fewNearbyOnly || thinWithNoPerennial) && !alreadyNudged && !categoryApplied) {
    const thinNearbyHoods = getAdjacentNeighborhoods(hood, 5);
    for (const nearbyHood of thinNearbyHoods) {
      const nearbyEvents = await getEvents(nearbyHood);
      if (nearbyEvents.length > 0) {
        const vibeWord = topVibeWord(nearbyEvents);
        const eventMap = {};
        for (const e of nearbyEvents) eventMap[e.id] = e;
        setSession(ctx.phone, { pendingNearby: nearbyHood, pendingNearbyEvents: eventMap });
        const sms = `Hey not much going on in ${hood}... would you travel to ${nearbyHood} for ${vibeWord}?`;
        await sendSMS(ctx.phone, sms);
        console.log(`Thin nudge to ${ctx.masked}: ${hood} → ${nearbyHood} (inHood=${inHood.length}, events=${events.length})`);
        ctx.finalizeTrace(sms, 'events');
        return;
      }
    }
  }

  // Compose response (scraped events + perennial picks merged)
  ctx.trace.events.cache_size = events.length;
  ctx.trace.events.candidates_count = composeEventsWithPerennials.length;
  ctx.trace.events.candidate_ids = composeEventsWithPerennials.map(e => e.id);
  const result = await ctx.composeAndSend(composeEventsWithPerennials, hood, ctx.route.filters, 'events');

  const eventMap = {};
  const moreBuffer = events.slice(0, 12); // cap for 1 MORE batch before exhaustion
  for (const e of moreBuffer) eventMap[e.id] = e;
  for (const e of perennialEvents) eventMap[e.id] = e;

  // Validate picks — filter out any hallucinated event_ids not in event map
  const validPicks = (result.picks || []).filter(p => eventMap[p.event_id]);
  if (validPicks.length < (result.picks || []).length) {
    console.warn(`Filtered ${(result.picks || []).length - validPicks.length} hallucinated pick IDs`);
  }

  setSession(ctx.phone, { lastPicks: validPicks, allPicks: validPicks, allOfferedIds: composeEventsWithPerennials.map(e => e.id), lastEvents: eventMap, lastNeighborhood: result.neighborhood_used || hood, visitedHoods: [hood] });
  await sendComposeWithLinks(ctx.phone, result, eventMap);
  console.log(`AI response sent to ${ctx.masked}`);
  ctx.finalizeTrace(result.sms_text, 'events');
}

module.exports = { sendComposeWithLinks, topVibeWord, stripMoreReferences, handleHelp, handleConversational, handleDetails, handleMore, handleFree, handleNudgeAccept, handleEventsDefault };
