const { composeDetails } = require('./ai');
const { sendSMS } = require('./twilio');
const { setSession } = require('./session');
const { formatEventDetails, smartTruncate } = require('./formatters');
const { getAdjacentNeighborhoods } = require('./pre-router');
const { filterByTimeAfter } = require('./geo');
const { resolveActiveFilters, buildEventMap, saveResponseFrame, buildExhaustionMessage, executeQuery } = require('./pipeline');
const { updateProfile } = require('./preference-profile');
const { generateReferralCode } = require('./referral');
const { extractNeighborhood, NEIGHBORHOODS } = require('./neighborhoods');
const NEIGHBORHOOD_NAMES = Object.keys(NEIGHBORHOODS);

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
  const msg1 = "Hey! I'm Bestie — I dig through the best of what's happening in NYC daily that you'll never find on Google or Instagram alone. Comedy, DJ sets, trivia, indie film, art, late-night weirdness, and more across every neighborhood.";
  const msg2 = 'Text me a neighborhood like "Bushwick" or a vibe like "jazz tonight" to start exploring. I\'ll send picks — reply a number for details, "more" to keep going, or just tell me what you\'re looking for. The more you text, the better it gets.';
  await sendSMS(ctx.phone, msg1);
  await sendSMS(ctx.phone, msg2);
  setSession(ctx.phone, { lastResponseHadPicks: false });
  console.log(`Help sent to ${ctx.masked}`);
  ctx.finalizeTrace(msg1 + '\n' + msg2, 'help');
}

// --- Conversational ---
async function handleConversational(ctx) {
  let reply = ctx.route.reply || "Hey! Tell me what you're in the mood for — a vibe, a category, or a neighborhood.";
  if (ctx.session?.lastNeighborhood) {
    reply = reply.replace(
      /text (?:me )?a neighborhood[^.]*/i,
      `say "more" for more ${ctx.session.lastNeighborhood} picks, or text a different neighborhood`
    );
  }
  const sms = smartTruncate(reply);
  await sendSMS(ctx.phone, sms);
  setSession(ctx.phone, { lastResponseHadPicks: false });
  console.log(`Conversational reply sent to ${ctx.masked}`);
  ctx.finalizeTrace(sms, 'conversational');
}

// --- Details ---
async function handleDetails(ctx) {
  const picks = ctx.session?.lastPicks;
  // Guard: if the last response didn't show a numbered pick list, the user is
  // referencing a list they can't see (stale picks from an earlier turn).
  if (ctx.session && picks?.length > 0 && ctx.session.lastResponseHadPicks === false) {
    const hood = ctx.session.lastNeighborhood;
    const sms = hood
      ? `I don't have a pick list up right now — say MORE for more ${hood} picks, or tell me what you're looking for!`
      : "I don't have a pick list up right now — tell me what you're looking for!";
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'details');
    return;
  }
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
    // Filter compliance: catch stale picks that clearly violate the free_only filter.
    // Only check free_only (binary/unambiguous). Category matching involves LLM judgment
    // (e.g. comedy-adjacent events) so we trust the LLM's original selection.
    const activeFilters = ctx.session.lastFilters;
    if (event && activeFilters?.free_only && !event.is_free) {
      const sms = smartTruncate("That pick isn't free — say MORE for more free picks or text a neighborhood!");
      await sendSMS(ctx.phone, sms);
      ctx.finalizeTrace(sms, 'details');
      return;
    }
    if (event) {
      // Generate referral code and Bestie URL for shareable details
      const refCode = generateReferralCode(ctx.phone, event.id);
      const domain = process.env.PULSE_CARD_DOMAIN || 'https://web-production-c8fdb.up.railway.app';
      const bestieUrl = `${domain}/e/${event.id}?ref=${refCode}`;

      try {
        const composeStart = Date.now();
        const result = await composeDetails(event, pick.why, { bestieUrl });
        ctx.trace.composition.latency_ms = Date.now() - composeStart;
        ctx.trace.composition.raw_response = result._raw || null;
        ctx.recordAICost?.(ctx.trace, 'details', result._usage, result._provider);
        ctx.trackAICost?.(result._usage, result._provider);
        const sms = smartTruncate(result.sms_text);
        await sendSMS(ctx.phone, sms);
        console.log(`Details ${ref} sent to ${ctx.masked}`);
        ctx.finalizeTrace(sms, 'details');
        return;
      } catch (err) {
        console.error('composeDetails error, falling back:', err.message);
        const sms = formatEventDetails(event, { bestieUrl });
        await sendSMS(ctx.phone, sms);
        ctx.finalizeTrace(sms, 'details');
        return;
      }
    }
  }
  const sms = "I don't have any picks loaded — tell me what you're looking for!";
  await sendSMS(ctx.phone, sms);
  ctx.finalizeTrace(sms, 'details');
}

/**
 * Record trace data for events sent to LLM and call executeQuery.
 * Replaces the composeAndSend closure — now uses the unified prompt path.
 */
async function composeViaExecuteQuery(events, ctx, { hood, activeFilters, excludeIds, skills } = {}) {
  const history = ctx.session?.conversationHistory || [];
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Record trace data
  ctx.trace.events.sent_to_claude = events.length;
  ctx.trace.events.sent_ids = events.map(e => e.id);
  ctx.trace.events.sent_pool = events.map(e => ({
    id: e.id,
    name: e.name,
    venue_name: e.venue_name,
    neighborhood: e.neighborhood,
    category: e.category,
    start_time_local: e.start_time_local,
    date_local: e.date_local,
    is_free: e.is_free,
    price_display: e.price_display,
    source_name: e.source_name,
    filter_match: e.filter_match,
    ticket_url: e.ticket_url || null,
  }));

  const composeStart = Date.now();
  const result = await executeQuery(ctx.message, events, {
    session: ctx.session,
    neighborhood: hood,
    conversationHistory: history,
    currentTime: now,
    validNeighborhoods: NEIGHBORHOOD_NAMES,
    activeFilters,
    excludeIds,
    hasConversationHistory: history.length > 0,
    ...skills,
  });
  ctx.trace.composition.latency_ms = Date.now() - composeStart;
  ctx.recordAICost?.(ctx.trace, 'compose', result._usage, result._provider);
  ctx.trackAICost?.(result._usage, result._provider);
  ctx.trace.composition.raw_response = result._raw || null;
  ctx.trace.composition.picks = (result.picks || []).map(p => {
    const evt = events.find(e => e.id === p.event_id);
    return {
      ...p,
      date_local: evt?.date_local || null,
      event_name: evt?.name || null,
      venue_name: evt?.venue_name || null,
      neighborhood: evt?.neighborhood || null,
      category: evt?.category || null,
      is_free: evt?.is_free ?? null,
      price_display: evt?.price_display || null,
      start_time_local: evt?.start_time_local || null,
    };
  });
  ctx.trace.composition.neighborhood_used = hood;

  return result;
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

    // Filter by neighborhood when one is set; borough-scope when borough is set; skip for citywide "more".
    const { BOROUGHS } = require('./neighborhoods');
    const boroughHoods = ctx.session.lastBorough ? new Set(BOROUGHS[ctx.session.lastBorough] || []) : null;
    const inHoodRemaining = hood
      ? allRemaining.filter(e => e.neighborhood === hood)
      : boroughHoods
        ? allRemaining.filter(e => boroughHoods.has(e.neighborhood))
        : allRemaining;
    // Hard time gate (P5): exclude events before time_after
    const timeGated = activeFilters.time_after
      ? filterByTimeAfter(inHoodRemaining, activeFilters.time_after)
      : inHoodRemaining;

    // Pre-compose name dedup: exclude events whose name matches any previously offered event
    // Catches cross-source duplicates with different IDs but same event name
    const offeredNames = new Set(
      [...allShownIds].map(id => ctx.session.lastEvents[id]?.name?.toLowerCase()).filter(Boolean)
    );
    const nameDeduped = timeGated.filter(e => !offeredNames.has(e.name?.toLowerCase()));
    const dedupedPool = nameDeduped.length > 0 ? nameDeduped : timeGated;

    if (dedupedPool.length > 0) {
      const composeRemaining = dedupedPool.slice(0, 8);
      const isLastBatch = dedupedPool.length <= 8;
      const exhaust = isLastBatch ? buildExhaustionMessage(hood, {
        adjacentHoods: hood ? getAdjacentNeighborhoods(hood, 3) : [],
        visitedHoods: ctx.session?.visitedHoods || [],
        filters: activeFilters,
        borough: ctx.session?.lastBorough,
      }) : null;

      ctx.trace.events.cache_size = Object.keys(ctx.session.lastEvents).length;
      ctx.trace.events.candidates_count = dedupedPool.length;
      ctx.trace.events.candidate_ids = dedupedPool.map(e => e.id);
      const skills = isLastBatch ? { isLastBatch: true, exhaustionSuggestion: exhaust.message } : {};
      const result = await composeViaExecuteQuery(composeRemaining, ctx, { hood, activeFilters, excludeIds: [...allShownIds], skills });

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
        pending: (isLastBatch && exhaust?.suggestedHood) ? { neighborhood: exhaust.suggestedHood, filters: activeFilters } : null,
      });
      updateProfile(ctx.phone, { neighborhood: hood, filters: activeFilters, responseType: 'more' })
        .catch(err => console.error('profile update failed:', err.message));
      await sendComposeWithLinks(ctx.phone, result, ctx.session.lastEvents);

      console.log(`More sent to ${ctx.masked} (${dedupedPool.length} remaining in ${hood}${isLastBatch ? ', last batch' : ''})`);
      ctx.finalizeTrace(result.sms_text, 'more');
      return;
    }
  }

  if (!ctx.session?.lastNeighborhood && !ctx.session?.lastBorough) {
    const sms = "Tell me what you're in the mood for — comedy, live music, something weird? Or drop a neighborhood.";
    await sendSMS(ctx.phone, sms);
    ctx.finalizeTrace(sms, 'more');
    return;
  }

  // All scraped events exhausted — suggest specific nearby neighborhood
  const finalExhaust = buildExhaustionMessage(hood, {
    adjacentHoods: hood ? getAdjacentNeighborhoods(hood, 4) : [],
    visitedHoods: ctx.session?.visitedHoods || [hood].filter(Boolean),
    filters: activeFilters,
    borough: ctx.session?.lastBorough,
  });
  const sms = finalExhaust.message;
  saveResponseFrame(ctx.phone, {
    mode: 'more',
    picks: [],
    prevSession: ctx.session,
    eventMap: ctx.session?.lastEvents || {},
    neighborhood: hood,
    filters: activeFilters,
    offeredIds: [],
    pending: finalExhaust.suggestedHood ? { neighborhood: finalExhaust.suggestedHood, filters: activeFilters } : null,
  });
  await sendSMS(ctx.phone, sms);
  ctx.finalizeTrace(sms, 'more');
}

module.exports = { sendComposeWithLinks, topVibeWord, stripMoreReferences, handleHelp, handleConversational, handleDetails, handleMore };
