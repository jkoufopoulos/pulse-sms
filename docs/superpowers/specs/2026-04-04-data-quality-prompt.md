# Data Quality & Pool Coverage — Cross-Model Brainstorm Prompt

Paste this into Gemini and Claude to get outside perspectives on the three-layer approach.

---

**Context:** I'm building Pulse, an SMS-based AI assistant that recommends NYC nightlife and events. Users text a neighborhood and get curated picks back via SMS. The whole experience is text-based — no app, no links until asked.

**Current architecture:** We scrape 6 editorial newsletter sources (Skint, NonsenseNYC, Yutori, ScreenSlate, BKMag) daily at 10am ET. Events are extracted via LLM, stored in a serving cache, and an agent brain (tool-calling LLM) picks from the pool when users text in. Response time is 2-5 seconds, cost ~$0.001/message.

**The problem:** Our event pool is too thin and has data quality gaps that make events unusable:
- 449 events serving, but 272 are recurring (weekly trivia, open mics) and only ~174 are unique one-off events
- Yutori dominates (83% of events) with massive gaps: 41% missing URLs, 30% missing descriptions, 12% missing times
- We removed structured scrapers (Eventbrite, Dice, Ticketmaster, Resident Advisor) to focus on editorial sources, but that left us blind to most NYC nightlife
- When the pool has nothing for a query (e.g. "bushwick comedy tonight"), we have no fallback — the user just gets a weak response
- Users expect AI-level coverage (like asking ChatGPT or Gemini) but we have a fixed, small pool

**Our current thinking — three layers:**
1. **Curated pool (fast, trusted):** Editorial sources enriched to fill data gaps. Primary path, sub-second. Possibly re-enable some structured scrapers.
2. **Scrape-time enrichment:** When an event comes in missing URL/description/time, use a tool (Google search, venue website) to fill gaps before it hits the serving cache. Costs pennies at scrape time rather than at SMS response time.
3. **Real-time search fallback:** When the curated pool has nothing for a user's query, the agent brain searches the web in real-time. Adds 3-5s latency but better than "sorry, nothing found."

**Key constraint:** The curated pool exists as trusted metadata to make the agent brain fast and confident — without it, the model would either hallucinate, spend too long searching, or hedge. We're not replacing the model, we're giving it verified data so it can respond instantly.

**An observation from building this with Claude Code:**

We noticed that Claude Code itself handles "what movie should I watch" the same way — it has training data knowledge (instant but stale/canned) and web search tools (fresh but slow). Without fresh metadata, it gravitates toward the same safe popular recommendations every time. The times it gives *great* answers are when: (a) the user gives narrow constraints, (b) it searches for current info, or (c) it has context from earlier in the conversation.

This maps directly to our architecture:
- The curated editorial pool is what prevents the "canned" problem — it gives the model *fresh, local, opinionated* data that training knowledge can't provide. "NonsenseNYC says this warehouse party is the move" is infinitely better than generic training-data recommendations.
- The risk of layer 3 (real-time search) is that it falls into the canned trap — Google results for "comedy bushwick tonight" return the same SEO-optimized venues every time. Better than nothing, but it won't feel like Pulse.
- The editorial pool isn't just data — it's Pulse's *taste*. The model can search the web, but it can't have taste without the curation layer. So layer 1 is where the real differentiation lives. Layers 2 and 3 are safety nets.

**What I want from you:**
1. Do you agree with the three-layer approach? What's wrong with it or missing?
2. How would you prioritize across the three layers? What gives the most user value fastest?
3. For layer 1 (bigger pool): which sources should we re-enable or add? How do we balance editorial curation vs coverage volume?
4. For layer 2 (enrichment): what's the most cost-effective way to fill data gaps at scrape time? Which gaps matter most for SMS recommendations?
5. For layer 3 (real-time fallback): how should the agent decide when to search vs when to work with what it has? What's the UX for a slower response?
6. React to the "taste vs coverage" framing. Is the editorial pool really the differentiator, or is that a rationalization for a thin dataset? Would Pulse be better with 5,000 Eventbrite listings and a smart model, or 200 hand-curated picks?
7. Anything we're not thinking about? Blind spots, risks, alternative approaches?
