# Phase 0 — Failure-Mode Atlas

Generated: 2026-05-28T03:27:54.166Z
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
> I need a bit more context. What kind of night are we talking about — are we looking for more of the same thing you just looked at, or something totally different? And where are you looking (neighborhood-wise)?

**Hybrid top-3:**
1. **powerful voices open mic show live music comedy po** — Bayonne (?) [comedy] _bm25=#4 vec=#48_
2. **powerful voices open mic show live music comedy po** — Union City (?) [comedy] _bm25=#27 vec=#17_
3. **powerful voices open mic show live music comedy po** — Jersey City (Chelsea) [comedy] _bm25=#29 vec=#24_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## A-2: "2"

**Agent response:**
> Looks like we don't have a prior search loaded. What are you in the mood for tonight? Drinks, a show, food, dancing — what's the vibe?

**Hybrid top-3:**
1. **Vibecode V2 SaaS-sy** — Midtown South (Kips Bay) [community] _bm25=#- vec=#1_
2. **2 Kims Take Brooklyn! - Friday Show** — Eris Mainstage (Williamsburg) [comedy] _bm25=#- vec=#2_
3. **Visionary Stakes｜Rooftop Mixer｜Jsquare** — Garment District (Midtown) [community] _bm25=#- vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## A-3: "i meant brooklyn not bushwick"

**Agent response:**
> What kind of night in Brooklyn?
> 1) (Recommended) Live music or a show
> 2) Drinks / bars
> 3) Comedy or spoken word
> 4) Surprise me

**Hybrid top-3:**
1. **Best of Brooklyn Stand-Up Comedy** — The Tiny Cupboard (Bushwick) [comedy] _bm25=#25 vec=#12_
2. **Best of Brooklyn Stand-Up Comedy** — The Tiny Cupboard (Bushwick) [comedy] _bm25=#26 vec=#13_
3. **Best of Brooklyn Stand-Up Comedy** — The Tiny Cupboard (Bushwick) [comedy] _bm25=#27 vec=#14_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## A-4: "send me the link"

**Agent response:**
> I don't have a specific event pulled up yet — we're just getting started. What kind of thing are you looking for in Brooklyn tonight? Once you pick something, I'll get you the details and link.

**Hybrid top-3:**
1. **get lost (& send love)** — Boerum Hill (Cobble Hill) [art] _bm25=#1 vec=#2_
2. **The Industry Shift** — Brooklyn (DUMBO) [community] _bm25=#- vec=#1_
3. **Spring Sip & Shoot (w/ Juice Generation)** — Manhattan (West Village) [food_drink] _bm25=#2 vec=#-_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## A-5: "actually skip the music, just bars"

**Agent response:**
> That's weird — let me try opening it up a bit. Brooklyn's huge. Which neighborhood? Williamsburg, Park Slope, DUMBO, Bushwick, Bed-Stuy — where are you headed?

**Hybrid top-3:**
1. **HOBOKEN ST.PADDYS BAR EVENT 2026!** — Hoboken Bars (West Village) [nightlife] _bm25=#3 vec=#27_
2. **skaiwater** — Music Hall of Williamsburg (Greenpoint) [live_music] _bm25=#17 vec=#13_
3. **breaking sound nyc** — Brooklyn Music Kitchen (Clinton Hill) [nightlife] _bm25=#33 vec=#31_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-6: "something romantic and intimate in BK"

**Agent response:**
> I need a Brooklyn neighborhood to narrow it down. Park Slope, Williamsburg, DUMBO, Cobble Hill, or Red Hook — which one's closest to you?

**Hybrid top-3:**
1. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#1 vec=#1_
2. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#2 vec=#2_
3. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#3 vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-7: "cozy date night spot"

**Agent response:**
> Got it — cozy date night. Which Brooklyn neighborhood?
> 1) Park Slope
> 2) Williamsburg
> 3) DUMBO or Brooklyn Heights
> 4) Surprise me — just pick the best spot

**Hybrid top-3:**
1. **date night vinyl happy hour** — Sleepwalk (Williamsburg) [nightlife] _bm25=#1 vec=#1_
2. **Blind Dinner Date - Ladies in their 20s** — Nolita (SoHo) [food_drink] _bm25=#6 vec=#7_
3. **Midnights Late Afternoon Happy Hour** — Midnights (Williamsburg) [food_drink] _bm25=#8 vec=#8_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-8: "weird underground vibes tonight"

**Agent response:**
> OK, pivoting from cozy date night. What kind of weird tonight?
> 1) (Recommended) Underground music — DJ or live electronic
> 2) Art, experimental theater, or performance
> 3) Late-night dive bar weirdness
> 4) Surprise me with the strangest thing

**Hybrid top-3:**
1. **Village Underground – Late Show** — Village Underground (East Village) [comedy] _bm25=#1 vec=#8_
2. **the underground open mic** — Bar Freda (Ridgewood) [comedy] _bm25=#2 vec=#7_
3. **dlr, kalahari, pva** — Nublu (East Village) [nightlife] _bm25=#30 vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-9: "low-key bar that isnt another wine bar"

**Agent response:**
> That's weird — the system's not returning bar results right now. But I know Brooklyn's got plenty of solid low-key spots that aren't wine bars. Are you thinking a specific neighborhood (Williamsburg, Park Slope, Greenpoint)? Or want me to search for events + bars together to see what's actually happening tonight?

**Hybrid top-3:**
1. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#38 vec=#1_
2. **Happy Hour at Therapy Wine Bar 2.0** — Therapy Wine Bar 2.0 (?) [food_drink] _bm25=#3 vec=#34_
3. **Weekday Happy Hour at Altar** — Altar (Crown Heights) [food_drink] _bm25=#39 vec=#2_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-10: "where do creatives hang out in brooklyn"

**Agent response:**
> That's a vibe question, not a "what's happening tonight" one — and honestly, it shifts by neighborhood and by night. Williamsburg's got the obvious spots (dive bars, late-night diner energy), but Bushwick's where a lot of the actual creative crowd is these days. Fort Greene and Bed-Stuy have that mix too.…

**Hybrid top-3:**
1. **Community Craft Night** — Brooklyn Spark (Bushwick) [art] _bm25=#20 vec=#6_
2. **Design Your Next Chapter — A Salon for Creatives** — 68 Jay St (DUMBO) [art] _bm25=#30 vec=#9_
3. **aci-d club weekly hang 029** — telos.haus (Williamsburg) [art] _bm25=#49 vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-11: "something different tonight"

**Agent response:**
> What kind of different?
> 1) (Recommended) Live music or DJ — something with energy
> 2) Art, film, or experimental event
> 3) Food or drink experience (not wine)
> 4) Weird / wildcard — surprise me

**Hybrid top-3:**
1. **Just Vegetarian Dinner** — 304 Bond St (Gowanus) [food_drink] _bm25=#10 vec=#45_
2. **tom ds big new york show** — TBA (Hell's Kitchen) [comedy] _bm25=#1 vec=#-_
3. **an immersive dinner experience** — Greenpoint (Greenpoint) [food_drink] _bm25=#- vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-12: "after-work drinks but not basic"

**Agent response:**
> Alright — nothing's showing for Brooklyn bars right now (late Wednesday night, listings are thin). But "after-work drinks, not basic" usually means cocktail bars with personality or dive spots with a real crowd. 
> 
> Want me to check a specific Brooklyn neighborhood (Williamsburg, Park Slope, DUMBO, Fort Greene)? Or pivot to events happening tonight — there might be a venue with a good bar scene attached to something live?

**Hybrid top-3:**
1. **after work after class jokes with shivani dave and** — St. Marks Comedy Club (NoHo) [comedy] _bm25=#3 vec=#35_
2. **After Work, After Class Laughs** — St. Marks Comedy Club (NoHo) [comedy] _bm25=#1 vec=#47_
3. **Happy Hour at Therapy Wine Bar 2.0** — Therapy Wine Bar 2.0 (?) [food_drink] _bm25=#10 vec=#29_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## B-13: "actually fun trivia somewhere"

**Agent response:**
> Nothing showing for trivia in Brooklyn tonight after 5. Which neighborhood are you in or closest to? Williamsburg, Park Slope, DUMBO, Bushwick? I can dig deeper once I know where you want to be.

**Hybrid top-3:**
1. **Trivia Night at The Steel Mill Bar & Kitchen** — The Steel Mill Bar & Kitchen (Bushwick) [trivia] _bm25=#6 vec=#13_
2. **Steel Mill Bar & Kitchen Trivia Night** — The Steel Mill Bar & Kitchen (Bushwick) [trivia] _bm25=#5 vec=#32_
3. **Trivia Night at Covenhoven** — Covenhoven (Prospect Heights) [trivia] _bm25=#49 vec=#11_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## C-14: "williamsburg"

**Agent response:**
> No trivia after 5 in Williamsburg tonight. But Williamsburg has solid after-work spots with actual energy — want me to find bars and venues with a good crowd instead? Or I can check what's happening live tonight and point you to a place with great drinks attached to it.

**Hybrid top-3:**
1. **Project Hail Mary** — Nitehawk Cinema - Williamsburg (Williamsburg) [film] _bm25=#4 vec=#22_
2. **The Descent** — Nitehawk Cinema - Williamsburg (Williamsburg) [film] _bm25=#1 vec=#32_
3. **Trivia Night at Northern Bell (Williamsburg)** — Northern Bell (Williamsburg) [trivia] _bm25=#34 vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## C-15: "free events"

**Agent response:**
> Nothing free in Williamsburg after 5 tonight. Want me to show you paid stuff in the neighborhood instead, or should I look at what's happening citywide? Most nights have at least a cover charge or cheap drink minimum anyway.

**Hybrid top-3:**
1. **Street Hockey Maddness** — Gymnasium (Crown Heights) [community] _bm25=#18 vec=#10_
2. **InspiredWordNYC Open Mic** — Brooklyn Music Kitchen (Clinton Hill) [live_music] _bm25=#28 vec=#11_
3. **BNB Chain & YZi Labs @ NYU** — Greenwich Village (Greenwich Village) [community] _bm25=#2 vec=#48_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## C-16: "comedy in the lower east side"

**Agent response:**
> No comedy in LES tonight after 5. Want me to show you what else is happening in LES — live music, bars, whatever's actually popping? Or I can check if there's comedy later (like 10 PM+) if you're staying out.

**Hybrid top-3:**
1. **Lectures on Tap - "The Seduction of Unfreedom: A P** — Lower East Side (Lower East Side) [comedy] _bm25=#1 vec=#3_
2. **Lectures on Tap-"The 3% Who Broke Into The Economi** — Lower East Side (Lower East Side) [comedy] _bm25=#2 vec=#4_
3. **Capital Comedy Presented by Banc of California, An** — Lower East Side (Lower East Side) [comedy] _bm25=#6 vec=#14_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## C-17: "jazz tonight"

**Agent response:**
> No jazz after 5 PM tonight citywide. Want me to dig into a specific neighborhood — LES, Williamsburg, East Village — and show you what IS happening live? Or if you're flexible on time, I can check what's kicking off later tonight.

**Hybrid top-3:**
1. **vinyl after hours** — Smalls Jazz Club (West Village) [live_music] _bm25=#14 vec=#1_
2. **Weekly Jazz Night** — The Keep (Ridgewood) [live_music] _bm25=#1 vec=#15_
3. **vinyl after hours** — Smalls Jazz Club (West Village) [live_music] _bm25=#15 vec=#2_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## C-18: "events tomorrow night"

**Agent response:**
> What kind of night tomorrow?
> 1) (Recommended) Jazz or live music
> 2) Comedy
> 3) Anything good — surprise me
> 4) Specific neighborhood or vibe?

**Hybrid top-3:**
1. **Echoes of Tomorrow** — Tisch School Of The Arts (NoHo) [community] _bm25=#1 vec=#7_
2. **Lady Harlem presents: African Night** — SOBs (SoHo) [nightlife] _bm25=#48 vec=#21_
3. **Stitch Night, Upper EAST Side Event/Canvas - Wedne** — La Bomboniera (Carnegie Hill) [art] _bm25=#- vec=#1_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## C-19: "anything happening in bushwick"

**Agent response:**
> Nothing coming up tomorrow night in Bushwick at the moment. Want me to check the rest of the week, or pivot to what's actually happening tomorrow citywide?

**Hybrid top-3:**
1. **Trivia Night at Nook (Bushwick)** — Nook (Bushwick) [trivia] _bm25=#5 vec=#1_
2. **Trivia Night at Danger Danger (Bushwick)** — Danger Danger (Bushwick) [trivia] _bm25=#9 vec=#3_
3. **Open Decks** — Signal (Bushwick) [nightlife] _bm25=#17 vec=#2_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## C-20: "dj set in brooklyn"

**Agent response:**
> Nothing specifically tagged as DJ tomorrow in Brooklyn's results. Want me to broaden to all nightlife/dance events, or narrow to a specific neighborhood like Williamsburg or DUMBO?

**Hybrid top-3:**
1. **Emo Night Brooklyn Featuring a Special DJ Set Cele** — Le Poisson Rouge (Greenwich Village) [live_music] _bm25=#4 vec=#1_
2. **neuebabylon, Karryl Eugene, tescowrldbby (dj set)** — TBA - Miss Barb's | 1038 Nostrand Ave, Brooklyn, NY 11225 (?) [nightlife] _bm25=#2 vec=#3_
3. **Nightmares on Wax (dj set), Marco Weibel, Queen Ma** — Good Room (Greenpoint) [live_music] _bm25=#3 vec=#11_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

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
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## D-22: "dinner and a show"

**Agent response:**
> What kind of show are we talking?
> 1) (Recommended) Comedy
> 2) Live music
> 3) Theater / performance art
> 4) Something else — surprise me

**Hybrid top-3:**
1. **an immersive dinner experience** — Greenpoint (Greenpoint) [food_drink] _bm25=#1 vec=#4_
2. **Hypernative x Safe Executive Dinner - NYC** — Theater District (Midtown) [food_drink] _bm25=#3 vec=#13_
3. **Just Vegetarian Dinner** — 304 Bond St (Gowanus) [food_drink] _bm25=#15 vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## D-23: "how about comedy later tonight"

**Agent response:**
> It's already past 11:30 PM — comedy venues mostly wind down by now. Late-night comedy shows typically run earlier in the evening.
> 
> Want me to look at what's happening tomorrow night instead? Or if you're still out, I can find bars with live music or late-night food spots in a neighborhood you're near?

**Hybrid top-3:**
1. **Comedy Cellar Friday Night** — Comedy Cellar (Greenwich Village) [comedy] _bm25=#40 vec=#8_
2. **Comedy Cellar Friday Night** — Comedy Cellar (Greenwich Village) [comedy] _bm25=#41 vec=#9_
3. **Comedy Cellar Monday Night** — Comedy Cellar (Greenwich Village) [comedy] _bm25=#39 vec=#16_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## D-24: "wburg"

**Agent response:**
> You've hit your daily limit — check back tomorrow for more picks!

**Hybrid top-3:**
1. **Weekly Sunday Night Cultural Programming** — Superior Ingredients (Williamsburg) [community] _bm25=#- vec=#1_
2. **Trivia Night at Brooklyn Brewery (Williamsburg)** — Brooklyn Brewery (Williamsburg) [trivia] _bm25=#- vec=#2_
3. **Trivia Night at The Hub Bike Lounge (Williamsburg)** — The Hub Bike Lounge (Williamsburg) [trivia] _bm25=#- vec=#3_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

## D-25: "free or cheap things this weekend"

**Agent response:**
> You've hit your daily limit — check back tomorrow for more picks!

**Hybrid top-3:**
1. **Board Game Meetup 3pm-10pm!** — The Tiny Cupboard (Bushwick) [community] _bm25=#30 vec=#4_
2. **Swedish Cottage Marionette Theatre: Little Red’s H** — Swedish Cottage Marionette Theatre (?) [theater] _bm25=#32 vec=#6_
3. **Swedish Cottage Little Red's Hood** — Swedish Cottage Marionette Theatre (?) [other] _bm25=#29 vec=#8_

| Agent right? | Hybrid right? | Failure mode |
|---|---|---|
| _(annotate)_ | _(annotate)_ | _(annotate)_ |

---

