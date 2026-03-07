/**
 * Non-event scout categories — skip these before extraction.
 */
const NON_EVENT_CATEGORIES = [
  /fintech/i, /banking/i, /finance/i, /investment/i, /portfolio/i, /market/i,
  /sports?\s+(betting|ticket|fan)/i, /fantasy\s+sports/i,
  /crypto/i, /blockchain/i, /defi/i,
  /real\s+estate/i, /mortgage/i,
  /insurance/i, /health\s*care/i,
  // personal development / advice / lifestyle
  /personal\s+dev/i, /self[- ]?help/i, /coaching/i, /leadership/i,
  /psychology/i, /relationship/i, /social\s+skills/i, /friendships?/i,
  /productivity/i, /career/i, /hiring/i, /recruiting/i,
  /legal/i, /compliance/i, /tax\b/i,
  // streaming / media releases
  /streaming/i, /netflix/i, /hulu/i, /disney\+/i, /prime\s+video/i, /apple\s+tv/i,
  /release\s+date/i, /coming\s+soon/i,
  // academic / research
  /research/i, /whitepaper/i, /case\s+study/i,
];

/**
 * Non-event filename patterns — catch fintech/sports emails by subject slug.
 */
const NON_EVENT_FILENAMES = [
  /fintech/i, /agentic-ai/i, /banking/i, /jpmorgan/i, /stripe/i, /vestwell/i,
  /apple-s-bonus/i, /de-risking/i, /price-drop/i, /occ-nod/i,
  /cpb-screen/i, /index-trigger/i, /value-setup/i,
  /knicks/i, /nets/i, /yankees/i, /mets/i,
  // personal development / advice
  /friendship/i, /relationship/i, /self-help/i, /coaching/i,
  /leadership/i, /career-/i, /hiring-/i, /tax-/i, /legal-/i,
  /productivity/i, /psychology/i, /social-skill/i,
  /netflix/i, /streaming/i, /hulu/i, /disney/i,
  /release-date/i, /coming-soon/i,
  /research/i, /whitepaper/i, /case-study/i,
];

/**
 * Check if a Yutori email contains events worth extracting.
 * Returns false for fintech, sports, and other non-event scout categories.
 */
function isEventEmail(filename, html) {
  // Check filename patterns first (cheap)
  for (const pat of NON_EVENT_FILENAMES) {
    if (pat.test(filename)) {
      return false;
    }
  }

  // Extract the scout category label from the uppercase <p> near the top
  const categoryMatch = html.match(
    /text-transform:\s*uppercase[^>]*>\s*<a[^>]*style="[^"]*text-decoration-line:\s*none"[^>]*>([^<]+)<\/a>/i
  );
  if (categoryMatch) {
    const category = categoryMatch[1].trim();
    for (const pat of NON_EVENT_CATEGORIES) {
      if (pat.test(category)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Check if a Yutori email is a trivia-focused scout.
 * Matches by filename keyword or HTML category label.
 */
function isTriviaEmail(filename, html) {
  if (/trivia/i.test(filename)) return true;
  const categoryMatch = html.match(
    /text-transform:\s*uppercase[^>]*>\s*<a[^>]*style="[^"]*text-decoration-line:\s*none"[^>]*>([^<]+)<\/a>/i
  );
  if (categoryMatch && /trivia/i.test(categoryMatch[1])) return true;
  return false;
}

module.exports = { isEventEmail, isTriviaEmail };
