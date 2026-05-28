# Phase 0.5 — Failure-Mode Atlas (clean re-run with rotated phones)

**Phase 0.5 methodology change:** Each of the 25 queries used a UNIQUE phone number (`+15550002000` through `+15550002024`), eliminating the session-state carry-over that contaminated the original Phase 0 results (especially Bucket C). This is the clean comparison. **Hypothesis confirmed:** the original Phase 0's Bucket C losses for the agent were almost entirely state-contamination artifacts, not retrieval failures.

Generated: 2026-05-28T03:37:51.664Z
Events in corpus: 2743
Queries: 25 across 4 buckets

---

**How to read the columns:**
- _Agent response_: full SMS captured from agent-Pulse on port 3000
- _Hybrid top-3_: top 3 events from BM25+vector RRF fusion over the same corpus
- _Agent right?_, _Hybrid right?_, _Failure mode_: leave blank during initial run; hand-annotate in Task 11

---

## A-1: "more"

**Agent response:**
> I need a bit of context — what were we just looking at? If you want more picks from the same search (like more comedy in Bushwick, or more bars in the East Village), I'm ready. Just remind me what direction you were headed.

**Hybrid top-3:**
1. **powerful voices open mic show live music comedy po** — Bayonne (?) [comedy] _bm25=#4 vec=#48_
2. **powerful voices open mic show live music comedy po** — Union City (?) [comedy] _bm25=#27 vec=#17_
3. **powerful voices open mic show live music comedy po** — Jersey City (Chelsea) [comedy] _bm25=#29 vec=#24_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | state required + duplicate pollution (3x same near-dupe) |

---

## A-2: "2"

**Agent response:**
> I need a bit more context. Are you replying to something from earlier, or starting fresh?
> 
> If you're picking a specific event from a list I gave you, just let me know which one by describing it (the name, neighborhood, or vibe) and I'll give you the details.
> 
> If you're starting a new search, what are you in the mood for tonight?

**Hybrid top-3:**
1. **Vibecode V2 SaaS-sy** — Midtown South (Kips Bay) [community] _bm25=#- vec=#1_
2. **2 Kims Take Brooklyn! - Friday Show** — Eris Mainstage (Williamsburg) [comedy] _bm25=#- vec=#2_
3. **Visionary Stakes｜Rooftop Mixer｜Jsquare** — Garment District (Midtown) [community] _bm25=#- vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | reference resolution + false positive on noise floor |

---

## A-3: "i meant brooklyn not bushwick"

**Agent response:**
> Got it — what part of Brooklyn are you thinking? And what kind of night?
> 
> 1) (Recommended) Live music or a show
> 2) Drinks / bar scene
> 3) Comedy
> 4) Something else entirely
> 
> Where in Brooklyn and what's the vibe?

**Hybrid top-3:**
1. **Best of Brooklyn Stand-Up Comedy** — The Tiny Cupboard (Bushwick) [comedy] _bm25=#25 vec=#12_
2. **Best of Brooklyn Stand-Up Comedy** — The Tiny Cupboard (Bushwick) [comedy] _bm25=#26 vec=#13_
3. **Best of Brooklyn Stand-Up Comedy** — The Tiny Cupboard (Bushwick) [comedy] _bm25=#27 vec=#14_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| partial | no | state required + duplicate pollution (3x same Bushwick event) |

---

## A-4: "send me the link"

**Agent response:**
> I don't have a recent pick to grab a link for yet — we haven't searched for anything. What are you in the mood for tonight?

**Hybrid top-3:**
1. **get lost (& send love)** — Boerum Hill (Cobble Hill) [art] _bm25=#1 vec=#2_
2. **The Industry Shift** — Brooklyn (DUMBO) [community] _bm25=#- vec=#1_
3. **Spring Sip & Shoot (w/ Juice Generation)** — Manhattan (West Village) [food_drink] _bm25=#2 vec=#-_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | reference resolution (no prior pick to send link for) |

---

## A-5: "actually skip the music, just bars"

**Agent response:**
> What kind of bar vibe tonight?
> 1) (Recommended) Cocktails — craft, upscale
> 2) Dive bar — casual, cheap drinks
> 3) Wine bar
> 4) Rooftop or outdoor
> 5) Surprise me

**Hybrid top-3:**
1. **HOBOKEN ST.PADDYS BAR EVENT 2026!** — Hoboken Bars (West Village) [nightlife] _bm25=#3 vec=#27_
2. **skaiwater** — Music Hall of Williamsburg (Greenpoint) [live_music] _bm25=#17 vec=#13_
3. **breaking sound nyc** — Brooklyn Music Kitchen (Clinton Hill) [nightlife] _bm25=#33 vec=#31_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | state required + false positive (Hoboken bar surfaced for NYC query) |

---

## B-6: "something romantic and intimate in BK"

**Agent response:**
> What's the vibe for tonight?
> 1) (Recommended) Dinner or drinks, just the two of you
> 2) Live music or a show
> 3) Art gallery or cultural thing
> 4) Surprise me

**Hybrid top-3:**
1. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#1 vec=#1_
2. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#2 vec=#2_
3. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#3 vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| partial | partial | agent over-clarifies + duplicate pollution (3x Weekday Happy Hour) |

---

## B-7: "cozy date night spot"

**Agent response:**
> What's your vibe for cozy tonight?
> 1) (Recommended) Wine bar or intimate spot
> 2) Dinner + drinks
> 3) Low-key cocktails or coffee
> 4) Something with live music

**Hybrid top-3:**
1. **date night vinyl happy hour** — Sleepwalk (Williamsburg) [nightlife] _bm25=#1 vec=#1_
2. **Blind Dinner Date - Ladies in their 20s** — Nolita (SoHo) [food_drink] _bm25=#6 vec=#7_
3. **Midnights Late Afternoon Happy Hour** — Midnights (Williamsburg) [food_drink] _bm25=#8 vec=#8_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| partial | yes | agent over-clarifies (hybrid found "date night vinyl" first hit) |

---

## B-8: "weird underground vibes tonight"

**Agent response:**
> I need to narrow this down a bit. What neighborhood are you thinking, and what's the energy level?
> 
> 1) (Recommended) Bushwick / Williamsburg — dj / dance-heavy underground
> 2) Lower East Side / East Village — live music or experimental 
> 3) Anywhere in the city — just show me the weirdest stuff
> 4) Something specific — art, theater, late-night club?
> 
> What pulls you in?

**Hybrid top-3:**
1. **Village Underground – Late Show** — Village Underground (East Village) [comedy] _bm25=#1 vec=#8_
2. **the underground open mic** — Bar Freda (Ridgewood) [comedy] _bm25=#2 vec=#7_
3. **dlr, kalahari, pva** — Nublu (East Village) [nightlife] _bm25=#30 vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | semantic vibe — both methods earned their keep |

---

## B-9: "low-key bar that isnt another wine bar"

**Agent response:**
> What's your vibe tonight?
> 1) (Recommended) Dive bar — cheap drinks, dark corner
> 2) Cocktail spot — craft but unpretentious
> 3) Beer bar — casual, good selection
> 4) Surprise me

**Hybrid top-3:**
1. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#38 vec=#1_
2. **Happy Hour at Therapy Wine Bar 2.0** — Therapy Wine Bar 2.0 (?) [food_drink] _bm25=#3 vec=#34_
3. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#39 vec=#2_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| partial | no | hybrid fails negation + duplicate pollution |

---

## B-10: "where do creatives hang out in brooklyn"

**Agent response:**
> Not specific enough to search yet — let me ask first.
> 
> When you say creatives, are you thinking:
> 1) (Recommended) Late-night bars with artists, DJs, eclectic crowds
> 2) Coffee spots / daytime work hangouts
> 3) Art galleries and studio spaces
> 4) Live music / performance venues
> 
> And tonight or general recommendations?

**Hybrid top-3:**
1. **Community Craft Night** — Brooklyn Spark (Bushwick) [art] _bm25=#20 vec=#6_
2. **Design Your Next Chapter — A Salon for Creatives** — 68 Jay St (DUMBO) [art] _bm25=#30 vec=#9_
3. **aci-d club weekly hang 029** — telos.haus (Williamsburg) [art] _bm25=#49 vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| partial | yes | agent over-clarifies; hybrid semantic match was strong |

---

## B-11: "something different tonight"

**Agent response:**
> What kind of "different" are you after tonight?
> 1) (Recommended) Something weird or experimental
> 2) A totally new neighborhood
> 3) A different vibe than usual (chill, loud, social?)
> 4) Surprise me — just give me the oddest thing happening

**Hybrid top-3:**
1. **Just Vegetarian Dinner** — 304 Bond St (Gowanus) [food_drink] _bm25=#10 vec=#45_
2. **tom ds big new york show** — TBA (Hell's Kitchen) [comedy] _bm25=#1 vec=#-_
3. **an immersive dinner experience** — Greenpoint (Greenpoint) [food_drink] _bm25=#- vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | intent ambiguity (abstract "different" — hybrid surfaces noise) |

---

## B-12: "after-work drinks but not basic"

**Agent response:**
> What's "not basic" mean for tonight?
> 1) (Recommended) Craft cocktails, upscale vibe
> 2) Dive bar with character
> 3) Wine or natural wine spot
> 4) Live music + drinks

**Hybrid top-3:**
1. **after work after class jokes with shivani dave and** — St. Marks Comedy Club (NoHo) [comedy] _bm25=#3 vec=#35_
2. **After Work, After Class Laughs** — St. Marks Comedy Club (NoHo) [comedy] _bm25=#1 vec=#47_
3. **Happy Hour at Therapy Wine Bar 2.0** — Therapy Wine Bar 2.0 (?) [food_drink] _bm25=#10 vec=#29_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | vocabulary mismatch (hybrid hit "after-work" on comedy not bars) |

---

## B-13: "actually fun trivia somewhere"

**Agent response:**
> Where in NYC are you? (Or anywhere works tonight?)
> 1) (Recommended) Anywhere — just good trivia
> 2) Brooklyn (Williamsburg, Park Slope area)
> 3) Manhattan (Midtown, East Village, wherever)
> 4) Surprise me

**Hybrid top-3:**
1. **Trivia Night at The Steel Mill Bar & Kitchen** — The Steel Mill Bar & Kitchen (Bushwick) [trivia] _bm25=#6 vec=#13_
2. **Steel Mill Bar & Kitchen Trivia Night** — The Steel Mill Bar & Kitchen (Bushwick) [trivia] _bm25=#5 vec=#32_
3. **Trivia Night at Covenhoven** — Covenhoven (Prospect Heights) [trivia] _bm25=#49 vec=#11_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | both work; agent clarifies neighborhood, hybrid finds real trivia |

---

## C-14: "williamsburg"

**Agent response:**
> What's the vibe tonight in Williamsburg?
> 1) (Recommended) Music or a show
> 2) DJ / dance floor
> 3) Chill drinks
> 4) Surprise me

**Hybrid top-3:**
1. **Project Hail Mary** — Nitehawk Cinema - Williamsburg (Williamsburg) [film] _bm25=#4 vec=#22_
2. **The Descent** — Nitehawk Cinema - Williamsburg (Williamsburg) [film] _bm25=#1 vec=#32_
3. **Trivia Night at Northern Bell (Williamsburg)** — Northern Bell (Williamsburg) [trivia] _bm25=#34 vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | no contamination this run — agent clean clarify, hybrid finds Williamsburg cinema |

---

## C-15: "free events"

**Agent response:**
> I need to narrow this down a bit — what's the vibe you're after?
> 
> 1) (Recommended) Live music or comedy
> 2) Art, film, or something cultural
> 3) Community events, markets, talks
> 4) Surprise me with whatever's free tonight

**Hybrid top-3:**
1. **Street Hockey Maddness** — Gymnasium (Crown Heights) [community] _bm25=#18 vec=#10_
2. **InspiredWordNYC Open Mic** — Brooklyn Music Kitchen (Clinton Hill) [live_music] _bm25=#28 vec=#11_
3. **BNB Chain & YZi Labs @ NYU** — Greenwich Village (Greenwich Village) [community] _bm25=#2 vec=#48_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | partial | agent over-clarifies; hybrid mix of free + random |

---

## C-16: "comedy in the lower east side"

**Agent response:**
> What kind of comedy night are you after?
> 1) (Recommended) Seated show with a real lineup
> 2) Loud bar comedy / open mic
> 3) Late-night anything goes
> 4) Surprise me

**Hybrid top-3:**
1. **Lectures on Tap - "The Seduction of Unfreedom: A P** — Lower East Side (Lower East Side) [comedy] _bm25=#1 vec=#3_
2. **Lectures on Tap-"The 3% Who Broke Into The Economi** — Lower East Side (Lower East Side) [comedy] _bm25=#2 vec=#4_
3. **Capital Comedy Presented by Banc of California, An** — Lower East Side (Lower East Side) [comedy] _bm25=#6 vec=#14_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | both work — agent clarifies comedy type, hybrid finds real LES comedy events |

---

## C-17: "jazz tonight"

**Agent response:**
> Quick clarify before I search — what's the vibe you're after?
> 
> 1) (Recommended) Live jam session — intimate, musicians riffing
> 2) Seated show with a specific lineup
> 3) Jazz bar — good drinks, chill background vibe
> 4) Surprise me

**Hybrid top-3:**
1. **vinyl after hours** — Smalls Jazz Club (West Village) [live_music] _bm25=#14 vec=#1_
2. **Weekly Jazz Night** — The Keep (Ridgewood) [live_music] _bm25=#1 vec=#15_
3. **vinyl after hours** — Smalls Jazz Club (West Village) [live_music] _bm25=#15 vec=#2_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | both work — agent clarifies, hybrid finds Smalls Jazz Club + Weekly Jazz |

---

## C-18: "events tomorrow night"

**Agent response:**
> Quick clarify — what's the vibe tomorrow night?
> 
> 1) (Recommended) Comedy or live music
> 2) DJ / dance floor
> 3) Art, film, or something chill
> 4) Surprise me — show me what's good

**Hybrid top-3:**
1. **Echoes of Tomorrow** — Tisch School Of The Arts (NoHo) [community] _bm25=#1 vec=#7_
2. **Lady Harlem presents: African Night** — SOBs (SoHo) [nightlife] _bm25=#48 vec=#21_
3. **Stitch Night, Upper EAST Side Event/Canvas - Wedne** — La Bomboniera (Carnegie Hill) [art] _bm25=#- vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | vocabulary mismatch — hybrid matches literal "Tomorrow" in name, no temporal understanding |

---

## C-19: "anything happening in bushwick"

**Agent response:**
> What's the vibe tonight in Bushwick?
> 1) (Recommended) Live music or a show
> 2) DJ / dance floor
> 3) Chill drinks
> 4) Something else

**Hybrid top-3:**
1. **Trivia Night at Nook (Bushwick)** — Nook (Bushwick) [trivia] _bm25=#5 vec=#1_
2. **Trivia Night at Danger Danger (Bushwick)** — Danger Danger (Bushwick) [trivia] _bm25=#9 vec=#3_
3. **Open Decks** — Signal (Bushwick) [nightlife] _bm25=#17 vec=#2_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | both work — agent clarifies Bushwick vibe, hybrid finds Bushwick trivia + Open Decks |

---

## C-20: "dj set in brooklyn"

**Agent response:**
> Which Brooklyn neighborhood, and what time?
> 1) (Recommended) Williamsburg / Greenpoint, around 11 PM
> 2) Downtown Brooklyn / DUMBO, earlier (9-10 PM)
> 3) Bushwick, late (midnight+)
> 4) Surprise me, anywhere in Brooklyn

**Hybrid top-3:**
1. **Emo Night Brooklyn Featuring a Special DJ Set Cele** — Le Poisson Rouge (Greenwich Village) [live_music] _bm25=#4 vec=#1_
2. **neuebabylon, Karryl Eugene, tescowrldbby (dj set)** — TBA - Miss Barb's | 1038 Nostrand Ave, Brooklyn, NY 11225 (?) [nightlife] _bm25=#2 vec=#3_
3. **Nightmares on Wax (dj set), Marco Weibel, Queen Ma** — Good Room (Greenpoint) [live_music] _bm25=#3 vec=#11_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | both work — agent clarifies neighborhood + time, hybrid finds real Brooklyn DJ sets |

---

## D-21: "help"

**Agent response:**
> I'm Pulse — your plugged-in friend for NYC. I dig through the best of what's happening daily that you'll never find on Google or Instagram alone. Comedy, DJ sets, trivia, indie film, art, late-night weirdness, and more across every neighborhood.
>
> Tell me what you're into tonight, just ask. Text a neighborhood like "Bushwick" or a vibe like "something weird tonight" to start exploring. Ask about any pick for details. The more you text, the better it gets.

**Hybrid top-3:**
1. **5 Improv Techniques To Help You Improve Your Pitch** — Edge Studio Voice Over (Midtown) [comedy] _bm25=#1 vec=#-_
2. **Today I Don't Feel Like Doing Anything** — Bathhouse Flatiron (Flatiron) [community] _bm25=#- vec=#1_
3. **First Day of Spring Equinox: Journaling Workshop i** — McCarren Parkhouse (Greenpoint) [art] _bm25=#2 vec=#-_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | mechanical help vs hybrid noise (false positive at noise floor) |

---

## D-22: "dinner and a show"

**Agent response:**
> What kind of show are you thinking?
> 1) (Recommended) Comedy
> 2) Live music
> 3) Theater
> 4) Surprise me

**Hybrid top-3:**
1. **an immersive dinner experience** — Greenpoint (Greenpoint) [food_drink] _bm25=#1 vec=#4_
2. **Hypernative x Safe Executive Dinner - NYC** — Theater District (Midtown) [food_drink] _bm25=#3 vec=#13_
3. **Just Vegetarian Dinner** — 304 Bond St (Gowanus) [food_drink] _bm25=#15 vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | partial | agent clarifies show type; hybrid finds dinners but no "show" component |

---

## D-23: "how about comedy later tonight"

**Agent response:**
> I need to narrow this down a bit. It's 11:40 PM right now, so "later" is pretty late. A couple things first:
> 
> 1) Are you looking for a comedy show (seated lineup) or bar comedy (more casual/loud)?
> 2) How late are you willing to go — midnight-ish, or are you a 2-3 AM person?
> 
> Also, any neighborhood preference, or anywhere in the city works?

**Hybrid top-3:**
1. **Comedy Cellar Friday Night** — Comedy Cellar (Greenwich Village) [comedy] _bm25=#40 vec=#8_
2. **Comedy Cellar Friday Night** — Comedy Cellar (Greenwich Village) [comedy] _bm25=#41 vec=#9_
3. **Comedy Cellar Monday Night** — Comedy Cellar (Greenwich Village) [comedy] _bm25=#39 vec=#16_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | partial | duplicate pollution (3x Comedy Cellar); agent time-aware reply sharp |

---

## D-24: "wburg"

**Agent response:**
> What's the vibe for Williamsburg tonight?
> 1) (Recommended) Live music or a show
> 2) DJ / dance floor
> 3) Chill drinks
> 4) Surprise me

**Hybrid top-3:**
1. **Weekly Sunday Night Cultural Programming** — Superior Ingredients (Williamsburg) [community] _bm25=#- vec=#1_
2. **Trivia Night at Brooklyn Brewery (Williamsburg)** — Brooklyn Brewery (Williamsburg) [trivia] _bm25=#- vec=#2_
3. **Trivia Night at The Hub Bike Lounge (Williamsburg)** — The Hub Bike Lounge (Williamsburg) [trivia] _bm25=#- vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | yes | both resolve "wburg" → Williamsburg; agent NO LONGER BUDGET-CAPPED with fresh phone |

---

## D-25: "free or cheap things this weekend"

**Agent response:**
> What kind of weekend vibe?
> 1) (Recommended) Live music or comedy
> 2) Art, film, or something cultural
> 3) Bars and hanging out
> 4) Surprise me with a mix

**Hybrid top-3:**
1. **Board Game Meetup 3pm-10pm!** — The Tiny Cupboard (Bushwick) [community] _bm25=#30 vec=#4_
2. **Swedish Cottage Marionette Theatre: Little Red’s H** — Swedish Cottage Marionette Theatre (?) [theater] _bm25=#32 vec=#6_
3. **Swedish Cottage Little Red's Hood** — Swedish Cottage Marionette Theatre (?) [other] _bm25=#29 vec=#8_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| yes | no | agent clarifies weekend vibe; hybrid weak on abstract "free or cheap" |

---

