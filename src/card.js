/**
 * Card HTML renderer — server-side rendered event card pages with OG meta tags.
 * Used for shareable Pulse URLs that show rich previews in iMessage/WhatsApp.
 */

const PULSE_PHONE = process.env.TWILIO_PHONE_NUMBER || '+18337857300';

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPhone(phone) {
  // Format +18337857300 → (833) 785-7300
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

function formatTime(isoStr) {
  if (!isoStr) return null;
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

/**
 * Build the OG description line: "Tonight 10pm · Free — Bushwick"
 */
function buildDescription(event) {
  const parts = [];
  const time = formatTime(event.start_time_local);
  if (time) parts.push(time);
  if (event.is_free) parts.push('Free');
  else if (event.price_display) parts.push(event.price_display);
  if (event.neighborhood) parts.push(event.neighborhood);
  return parts.join(' · ') || 'NYC Event';
}

/**
 * Map source_name to a friendly display name for "View on ..." CTA.
 */
const SOURCE_DISPLAY = {
  ra: 'RA',
  dice: 'Dice',
  eventbrite: 'Eventbrite',
  songkick: 'Songkick',
  brooklynvegan: 'BrooklynVegan',
  ohmyrockness: 'Oh My Rockness',
  donyc: 'DoNYC',
  bam: 'BAM',
  smallslive: 'SmallsLIVE',
  nyc_parks: 'NYC Parks',
  nypl: 'NYPL',
  ticketmaster: 'Ticketmaster',
  nonsensenyc: 'Nonsense NYC',
  skint: 'The Skint',
  yutori: 'Yutori',
  tavily: 'the event page',
};

function getSourceLabel(event) {
  if (event.source_name && SOURCE_DISPLAY[event.source_name]) {
    return SOURCE_DISPLAY[event.source_name];
  }
  return 'the event page';
}

/**
 * Build platform-aware SMS URI.
 * iOS uses sms:number&body=text, Android uses sms:number?body=text.
 * We use a JS redirect to detect platform at render time.
 */
function smsUri(phone, body) {
  return { phone, body: encodeURIComponent(body) };
}

function renderEventCard(event, formattedPhone, pulsePhone, domain, refCode) {
  const title = escapeHtml(event.name || 'Event');
  const venue = escapeHtml(event.venue_name || '');
  const description = escapeHtml(buildDescription(event));
  const hood = escapeHtml(event.neighborhood || '');
  const time = formatTime(event.start_time_local);
  const price = event.is_free ? 'Free' : (event.price_display || '');
  const detail = escapeHtml(event.description_short || event.short_detail || '');
  const ticketUrl = event.ticket_url || event.source_url || '';
  const sourceLabel = escapeHtml(getSourceLabel(event));
  const sms = smsUri(pulsePhone, `ref:${refCode}`);
  const phoneFmt = formattedPhone;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Pulse</title>
  <meta property="og:title" content="${title}${venue ? ` at ${escapeHtml(venue)}` : ''}">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Pulse">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}${venue ? ` at ${escapeHtml(venue)}` : ''}">
  <meta name="twitter:description" content="${description}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #08070d;
      --text: #ede9e3;
      --text-dim: #7a756d;
      --text-muted: #4a463f;
      --coral: #ff6b42;
      --font-display: 'Syne', sans-serif;
      --font-body: 'DM Sans', sans-serif;
    }
    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      max-width: 440px;
      width: 100%;
      padding: 48px 28px 40px;
    }
    .brand {
      font-family: var(--font-display);
      font-size: 1.1rem;
      font-weight: 800;
      color: var(--coral);
      margin-bottom: 32px;
    }
    .event-name {
      font-family: var(--font-display);
      font-size: 1.8rem;
      font-weight: 800;
      line-height: 1.1;
      letter-spacing: -0.03em;
      margin-bottom: 8px;
    }
    .event-venue {
      font-size: 1.05rem;
      color: var(--text-dim);
      margin-bottom: 24px;
    }
    .event-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 20px;
    }
    .meta-tag {
      padding: 6px 14px;
      border-radius: 100px;
      font-size: 0.82rem;
      font-weight: 600;
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--text-dim);
    }
    .meta-tag.free {
      border-color: var(--coral);
      color: var(--coral);
    }
    .event-detail {
      font-size: 0.92rem;
      color: var(--text-dim);
      line-height: 1.65;
      margin-bottom: 32px;
    }
    .cta-btn {
      display: block;
      width: 100%;
      padding: 16px;
      background: var(--coral);
      color: #fff;
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 700;
      text-align: center;
      text-decoration: none;
      border-radius: 14px;
      border: none;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.2s;
      box-shadow: 0 4px 20px rgba(255,107,66,0.2);
      margin-bottom: 16px;
    }
    .cta-btn:hover { opacity: 0.92; transform: translateY(-1px); }
    .divider {
      height: 1px;
      background: rgba(255,255,255,0.05);
      margin: 28px 0 20px;
    }
    .pulse-promo {
      text-align: center;
      padding: 0 8px;
    }
    .pulse-promo p {
      font-size: 0.82rem;
      color: var(--text-dim);
      margin-bottom: 12px;
      line-height: 1.5;
    }
    .pulse-promo a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--coral);
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 600;
      transition: opacity 0.2s;
    }
    .pulse-promo a:hover { opacity: 0.8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">Pulse</div>
    <h1 class="event-name">${title}</h1>
    ${venue ? `<p class="event-venue">at ${escapeHtml(venue)}</p>` : ''}
    <div class="event-meta">
      ${time ? `<span class="meta-tag">${escapeHtml(time)}</span>` : ''}
      ${event.is_free ? '<span class="meta-tag free">Free</span>' : (price ? `<span class="meta-tag">${escapeHtml(price)}</span>` : '')}
      ${hood ? `<span class="meta-tag">${hood}</span>` : ''}
    </div>
    ${detail ? `<p class="event-detail">${detail}</p>` : ''}
    ${ticketUrl ? `<a class="cta-btn" href="${escapeHtml(ticketUrl)}">View on ${sourceLabel}</a>` : ''}
    <div class="divider"></div>
    <div class="pulse-promo">
      <p>Discover more events like this via text</p>
      <a id="sms-link" href="sms:${escapeHtml(sms.phone)}?body=${sms.body}">Text Pulse &rarr;</a>
    </div>
  </div>
  <script>
    // Platform-aware SMS URI: iOS needs &body=, Android needs ?body=
    (function() {
      var link = document.getElementById('sms-link');
      if (!link) return;
      var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
      var phone = ${JSON.stringify(sms.phone)};
      var body = ${JSON.stringify(decodeURIComponent(sms.body))};
      var encoded = encodeURIComponent(body);
      link.href = isIOS
        ? 'sms:' + phone + '&body=' + encoded
        : 'sms:' + phone + '?body=' + encoded;
    })();
  </script>
</body>
</html>`;
}

function renderStaleCard(formattedPhone, pulsePhone) {
  const sms = smsUri(pulsePhone, 'hey');
  const phoneFmt = escapeHtml(formattedPhone);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pulse — NYC Events</title>
  <meta property="og:title" content="Pulse — NYC Events, One Text Away">
  <meta property="og:description" content="Text a neighborhood, get tonight's best events.">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Pulse">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #08070d;
      --text: #ede9e3;
      --text-dim: #7a756d;
      --text-muted: #4a463f;
      --coral: #ff6b42;
      --font-display: 'Syne', sans-serif;
      --font-body: 'DM Sans', sans-serif;
    }
    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      max-width: 440px;
      width: 100%;
      padding: 48px 28px;
      text-align: center;
    }
    .brand {
      font-family: var(--font-display);
      font-size: 1.3rem;
      font-weight: 800;
      color: var(--coral);
      margin-bottom: 24px;
    }
    h1 {
      font-family: var(--font-display);
      font-size: 1.6rem;
      font-weight: 800;
      line-height: 1.15;
      letter-spacing: -0.03em;
      margin-bottom: 12px;
    }
    p {
      color: var(--text-dim);
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .cta-btn {
      display: block;
      width: 100%;
      padding: 16px;
      background: var(--coral);
      color: #fff;
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 700;
      text-align: center;
      text-decoration: none;
      border-radius: 14px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(255,107,66,0.2);
    }
    .cta-btn:hover { opacity: 0.92; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">Pulse</div>
    <h1>This event has expired</h1>
    <p>Text ${phoneFmt} with any NYC neighborhood to discover tonight's best events.</p>
    <a id="cta" class="cta-btn" href="sms:${escapeHtml(sms.phone)}?body=${sms.body}">Text Pulse</a>
  </div>
  <script>
    (function() {
      var cta = document.getElementById('cta');
      if (!cta) return;
      var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
      var phone = ${JSON.stringify(sms.phone)};
      cta.href = isIOS
        ? 'sms:' + phone + '&body=hey'
        : 'sms:' + phone + '?body=hey';
    })();
  </script>
</body>
</html>`;
}

module.exports = { renderEventCard, renderStaleCard, escapeHtml };
