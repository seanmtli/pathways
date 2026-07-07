# Pathways — Product Context

**What:** Career-navigation tool. Type a target role in plain English, see the
real career paths real people took to get there — 4-6 named archetypes with %
shares and browsable rosters of actual professionals.

**Register:** product (design serves the data). Data-dense, scanability over
decoration. Trust is the product: honest sample framing, honest loading, honest
empty/degraded states.

**Users:** students + career switchers. **Primary surface is desktop web** —
this is a sit-down research tool; design for data density on a laptop screen
first. Shared links still open fine on phones (responsive is table stakes,
not the design driver).

**Voice:** a field atlas of careers — evidence, not hype. Never implies ground
truth about all humans in a role; always "of the professionals we analyzed."

**Key flows:**
1. Landing → free-text role query (or example chip) → staged real progress
   (cache miss ≈ 40s) → results.
2. Results: ranked path list with share bars → Explore Path roster (name,
   current role, education, ~years, LinkedIn) → per-cluster thumbs feedback.
3. Edge states are first-class: invalid query bounce, thin data, rate limited,
   degraded (cached-only), error — all with cached-role escape hatches.

**Constraints:** no accounts; anonymous httpOnly session cookie for rate
limiting only. Cache hits ~2s; misses 36-55s (staged loading copy covers it).
Backend pipeline lives in src/lib and is already built (Phases 1-3).
