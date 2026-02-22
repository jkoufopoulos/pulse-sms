const { composeDetails } = require('./ai');
const { sendSMS } = require('./twilio');
const { setSession } = require('./session');
const { formatEventDetails, smartTruncate } = require('./formatters');
const { getAdjacentNeighborhoods } = require('./pre-router');
const { getPerennialPicks, toEventObjects } = require('./perennial');
const { validatePerennialActivity } = require('./curation');
const { resolveActiveFilters, buildEventMap, saveResponseFrame, buildExhaustionMessage } = require('./pipeline');

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
  const activeFilters = resolveActiveFilters(ctx.route, ctx.session);

  if (ctx.session && ctx.session.lastEvents) {
    const allRemaining = Object.values(ctx.session.lastEvents).filter(e => !allShownIds.has(e.id));

    // Only compose from events in the requested neighborhood — never from foreign events.
    // This prevents geographic bleed (e.g. "Not much tonight on the UWS" when user is in West Village).
    const inHoodRemaining = allRemaining.filter(e => e.neighborhood === hood);

    if (inHoodRemaining.length > 0) {
      const composeRemaining = inHoodRemaining.slice(0, 8);
      const isLastBatch = inHoodRemaining.length <= 8;
      const exhaust = isLastBatch ? buildExhaustionMessage(hood, {
        adjacentHoods: getAdjacentNeighborhoods(hood, 3),
        visitedHoods: ctx.session?.visitedHoods || [],
      }) : null;

      ctx.trace.events.cache_size = Object.keys(ctx.session.lastEvents).length;
      ctx.trace.events.candidates_count = inHoodRemaining.length;
      ctx.trace.events.candidate_ids = inHoodRemaining.map(e => e.id);
      const skills = isLastBatch ? { isLastBatch: true, exhaustionSuggestion: exhaust.message } : {};
      const result = await ctx.composeAndSend(composeRemaining, hood, activeFilters, 'more', { excludeIds: [...allShownIds], skills });

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

      saveResponseFrame(ctx.phone, {
        mode: 'more',
        picks: result.picks || [],
        prevSession: ctx.session,
        eventMap: ctx.session.lastEvents,
        neighborhood: hood,
        filters: activeFilters,
        offeredIds: composeRemaining.map(e => e.id),
      });
      await sendComposeWithLinks(ctx.phone, result, ctx.session.lastEvents);

      console.log(`More sent to ${ctx.masked} (${inHoodRemaining.length} remaining in ${hood}${isLastBatch ? ', last batch' : ''})`);
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
    const eventMap = { ...ctx.session.lastEvents, ...buildEventMap(perennialBatch) };
    ctx.trace.events.cache_size = 0;
    ctx.trace.events.candidates_count = perennialBatch.length;
    ctx.trace.events.candidate_ids = perennialBatch.map(e => e.id);
    const perennialExhaust = buildExhaustionMessage(hood, {
      adjacentHoods: getAdjacentNeighborhoods(hood, 3),
      visitedHoods: ctx.session?.visitedHoods || [],
    });
    const result = await ctx.composeAndSend(perennialBatch, hood, activeFilters, 'more', { excludeIds: [...allShownMoreIds], skills: { isLastBatch: true, exhaustionSuggestion: perennialExhaust.message } });
    result.sms_text = stripMoreReferences(result.sms_text);
    saveResponseFrame(ctx.phone, {
      mode: 'more',
      picks: result.picks || [],
      prevSession: ctx.session,
      eventMap,
      neighborhood: hood,
      filters: activeFilters,
      offeredIds: perennialBatch.map(e => e.id),
    });
    await sendComposeWithLinks(ctx.phone, result, eventMap);
    console.log(`Perennial picks sent to ${ctx.masked} after events exhausted in ${hood}`);
    ctx.finalizeTrace(result.sms_text, 'more');
    return;
  }

  // All events and perennials exhausted — suggest specific nearby neighborhood
  const finalExhaust = buildExhaustionMessage(hood, {
    adjacentHoods: getAdjacentNeighborhoods(hood, 4),
    visitedHoods: ctx.session?.visitedHoods || [hood],
  });
  const sms = finalExhaust.message;
  await sendSMS(ctx.phone, sms);
  ctx.finalizeTrace(sms, 'more');
}

module.exports = { sendComposeWithLinks, topVibeWord, stripMoreReferences, handleHelp, handleConversational, handleDetails, handleMore };
