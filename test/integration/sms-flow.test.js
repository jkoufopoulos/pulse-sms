const { check } = require('../helpers');

module.exports.runAsync = async function() {
  console.log('\nIntegration: SMS hot path:');

  const { _handleMessage, setSession: hSetSession, clearSession: hClearSession, clearSmsIntervals } = require('../../src/handler');
  const { enableTestCapture, disableTestCapture } = require('../../src/twilio');
  const intPhone = '+10000000099';

  async function sendAndCapture(phone, message) {
    enableTestCapture(phone);
    await _handleMessage(phone, message);
    return disableTestCapture(phone);
  }

  // 1. Help flow
  hClearSession(intPhone);
  let msgs = await sendAndCapture(intPhone, 'help');
  check('help: sends 2 messages', msgs.length === 2);
  check('help: mentions neighborhoods', msgs[1]?.body.includes('Bushwick'));
  check('help: mentions details', msgs[1]?.body.includes('details'));

  // 2. Greeting flow — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'hey');
  check('greeting: sends 1 message', msgs.length === 1);

  // 3. Thanks flow — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'thanks');
  check('thanks: sends 1 message', msgs.length === 1);

  // 4. More without session — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'more');
  check('more (no session): sends 1 message', msgs.length === 1);

  // 5. TCPA compliance
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'STOP');
  check('TCPA: STOP sends 0 messages', msgs.length === 0);

  // 6. Bare number without session — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, '1');
  check('number (no session): sends 1 message', msgs.length === 1);

  // 7. Bare number with seeded session — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastPicks: [{ event_id: 'int_evt1', why: 'great vibes' }],
    lastEvents: {
      int_evt1: { id: 'int_evt1', name: 'Jazz Night at Smalls', venue_name: 'Smalls Jazz Club', neighborhood: 'West Village', start_time_local: '2026-02-18T21:00:00', is_free: false, price_display: '$20', ticket_url: 'https://example.com/jazz', source_url: 'https://example.com/jazz' }
    },
    lastNeighborhood: 'West Village',
  });
  msgs = await sendAndCapture(intPhone, '1');
  check('details (session): sends message', msgs.length >= 1);

  // 8. Free without neighborhood — now goes through unified LLM (needs API key)
  // In test env without API key, falls back to error message
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'free');
  check('free (no hood): sends 1 message', msgs.length === 1);

  // 9. Off-topic deflection — now goes through unified LLM (needs API key)
  // In test env without API key, falls back to error message
  hClearSession(intPhone);
  msgs = await sendAndCapture(intPhone, 'best pizza near me');
  check('off-topic food: sends 1 message', msgs.length === 1);

  // 10. Conversational with active session — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  hSetSession(intPhone, { lastNeighborhood: 'Bushwick', lastPicks: [{ event_id: 'x' }] });
  msgs = await sendAndCapture(intPhone, 'hey');
  check('greeting (active session): sends message', msgs.length >= 1);

  // 11. Out-of-range pick number — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastPicks: [
      { event_id: 'oor_evt1', why: 'great' },
      { event_id: 'oor_evt2', why: 'fun' },
    ],
    lastEvents: {
      oor_evt1: { id: 'oor_evt1', name: 'Event A', venue_name: 'Venue A' },
      oor_evt2: { id: 'oor_evt2', name: 'Event B', venue_name: 'Venue B' },
    },
    lastNeighborhood: 'East Village',
  });
  msgs = await sendAndCapture(intPhone, '3');
  check('out-of-range pick: sends 1 message', msgs.length === 1);

  // 12. Stale pendingNearby cleared on non-nudge intent
  hClearSession(intPhone);
  hSetSession(intPhone, {
    pendingNearby: 'Flatiron',
    lastNeighborhood: 'East Village',
    lastPicks: [{ event_id: 'pn_evt1', why: 'vibe' }],
    lastEvents: { pn_evt1: { id: 'pn_evt1', name: 'Test Event' } },
  });
  msgs = await sendAndCapture(intPhone, 'help');
  check('stale nudge: help still works', msgs.length === 2);
  const { getSession: hGetSession } = require('../../src/session');
  const sessionAfter = hGetSession(intPhone);
  check('stale nudge: pendingNearby cleared', sessionAfter?.pendingNearby === null || sessionAfter?.pendingNearby === undefined);

  // 13. Pick number "3" with only 1 pick — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastPicks: [{ event_id: 'one_evt', why: 'cool' }],
    lastEvents: { one_evt: { id: 'one_evt', name: 'Solo Event' } },
    lastNeighborhood: 'LES',
  });
  msgs = await sendAndCapture(intPhone, '3');
  check('1-pick range: sends 1 message', msgs.length === 1);

  // 14. "more" with session — now falls through to agent brain (Phase 4)
  hClearSession(intPhone);
  hSetSession(intPhone, {
    lastNeighborhood: 'Williamsburg',
    lastPicks: [{ event_id: 'fb_evt1', why: 'fun' }],
    lastEvents: {
      fb_evt1: { id: 'fb_evt1', name: 'Event Already Shown', venue_name: 'V1', neighborhood: 'Williamsburg' },
      fb_evt2: { id: 'fb_evt2', name: 'Unseen Event', venue_name: 'V2', neighborhood: 'Williamsburg' },
    },
  });
  msgs = await sendAndCapture(intPhone, 'more');
  check('more (with session): sends 1 message', msgs.length === 1);

  // Cleanup
  hClearSession(intPhone);
  clearSmsIntervals();
};
