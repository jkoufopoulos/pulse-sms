const MAX_SMS_LENGTH = 480;

const CTA = '\nReply DETAILS, MORE, or FREE.';

/**
 * Render a final SMS message from Claude's JSON picks + event data.
 *
 * @param {Object} picksResult - { picks, need_clarification, clarifying_question, fallback_note }
 * @param {Object} eventMap - Map of event_id → event object
 * @returns {string} SMS-ready text, <= 480 chars
 */
function renderSMS(picksResult, eventMap) {
  // Handle clarification case
  if (picksResult.need_clarification && picksResult.clarifying_question) {
    return truncate(picksResult.clarifying_question, MAX_SMS_LENGTH);
  }

  const picks = picksResult.picks || [];

  // No picks at all
  if (picks.length === 0) {
    const fallback = picksResult.fallback_note || "Quiet night — try a different neighborhood or check back later.";
    return truncate(fallback + '\nText another neighborhood to try again.', MAX_SMS_LENGTH);
  }

  // Build lead pick
  const lead = picks[0];
  const leadEvent = eventMap[lead.event_id];
  const leadLine = formatLeadPick(leadEvent, lead.why);

  // Build alt picks (skip entries with missing events)
  const alts = picks.slice(1)
    .filter(p => eventMap[p.event_id])
    .map(p => formatAltPick(eventMap[p.event_id], p.why));

  // Assemble message, respecting char limit
  let msg = leadLine;

  for (const alt of alts) {
    const candidate = msg + '\n' + alt;
    if ((candidate + CTA).length <= MAX_SMS_LENGTH) {
      msg = candidate;
    } else {
      // Try truncated alt: budget = total limit minus what we have minus CTA minus newline
      const budget = MAX_SMS_LENGTH - msg.length - CTA.length - 1; // -1 for \n
      if (budget > 30) {
        // Truncated alt must fit in budget (including the "...")
        msg += '\n' + alt.slice(0, budget - 3) + '...';
      }
      break;
    }
  }

  msg += CTA;

  return truncate(msg, MAX_SMS_LENGTH);
}

function formatLeadPick(event, why) {
  if (!event) return why || 'Check this out tonight.';

  const parts = [];
  const displayName = event.name.length > 80 ? event.name.slice(0, 77) + '...' : event.name;
  parts.push(displayName);

  if (event.venue_name && event.venue_name !== 'TBA') {
    parts.push(`at ${event.venue_name}`);
  }

  if (event.neighborhood) {
    parts.push(`(${event.neighborhood})`);
  }

  const time = formatTime(event);
  if (time) parts.push(time);

  const price = formatPrice(event);
  if (price) parts.push(`— ${price}`);

  let line = parts.join(' ');

  if (why) {
    line += `. ${why}`;
  }

  return line;
}

function formatAltPick(event, why) {
  if (!event) return why || '';

  const parts = [];
  parts.push(`Also: ${event.name}`);

  if (event.venue_name && event.venue_name !== 'TBA') {
    parts.push(`at ${event.venue_name}`);
  }

  const time = formatTime(event);
  if (time) parts.push(time);

  const price = formatPrice(event);
  if (price) parts.push(`— ${price}`);

  return parts.join(' ');
}

function formatTime(event) {
  if (event.start_time_local) {
    // Skip date-only strings like "2026-02-14" — parsing them as Date gives midnight UTC
    // which converts to wrong time in NYC. Only format if there's an actual time component.
    if (/T\d{2}:/.test(event.start_time_local)) {
      try {
        const d = new Date(event.start_time_local);
        if (!isNaN(d.getTime())) {
          return d.toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: '2-digit',
          });
        }
      } catch {
        // fall through
      }
    }
    // If it looks like a bare time string (e.g. "8pm", "9:30 PM"), pass through
    if (/\d{1,2}(:\d{2})?\s*(am|pm)/i.test(event.start_time_local)) {
      return event.start_time_local;
    }
  }
  return event.time_window || null;
}

function formatPrice(event) {
  if (event.is_free) return 'FREE';
  if (event.price_display) return event.price_display;
  return null;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

module.exports = { renderSMS };
