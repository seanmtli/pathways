# Pathways — v1.2 Product Requirements Document

**Status:** Ready for build
**Owner:** Sean Li
**Prepared for:** Coding agent implementation (Claude Code or equivalent)
**Supersedes:** v1.1. Changes in v1.2: seed/golden-set list restructured as a single mixed list (sports and general roles interleaved, no longer two separate blocks); golden set reduced and reset to the renamed sports role plus four general roles; legal action items section removed (resolved directly by Sean, outside this document); database moved from Railway Postgres to Supabase Postgres. Everything else unchanged from v1.1.

---

## 1. What we're building

Pathways is a career-navigation tool. A user types a target role in plain English — *"I want to be a Chief Data Officer at a sports team"* — and the app shows them **real career paths that real people took to get there**, clustered into a small number of named archetypes (e.g. "Sports analytics → ops," "Academic/data science track," "Consulting → team analyst"), each with the share of analyzed professionals who took that path and a browsable roster of actual people (name, current role, education, LinkedIn link).

This is the single differentiated feature validated across 25 customer discovery interviews. **v1 builds only Pathways.** The three sibling use cases from discovery (open role search, alumni/networking search, talent-density search) are explicitly out of scope.

### 1.1 Positioning (context, not buildable)
"An AI career intelligence platform for data-driven career decisions." Pathways sits earlier in the career funnel than application tools (resume optimizers) or networking tools (warm-intro finders): it answers *"I don't even know how people get to where I want to go."* Under the hood it is a vertical application layer on top of a horizontal people-data vendor (Crustdata), with the parsing, clustering, honesty-of-presentation, and UX as the differentiation.

---

## 2. Goals for this version

- Ship something **real users (students, career switchers) can use and give feedback on** — a learning instrument, not an investor demo.
- Validate whether the clustering output is accurate, legible, and trustworthy to a person genuinely exploring their career.
- Keep build scope and run-rate cost small enough to sustain a no-revenue testing phase.

## 3. Explicit non-goals for v1

Do not build:
- User accounts / login / saved searches
- AI-drafted outreach messages to displayed people
- Resume/LinkedIn upload and personalized match scoring
- The other three discovery use cases
- A maintained job-title ontology / semantic layer (the clustering LLM handles title ambiguity implicitly for now)
- Career-exploration dashboard ("what is finance/marketing") — separate PRD later
- Admin dashboard UI (operator will query the database directly; see §12 runbook)

---

## 4. Target users for this test phase

Both audiences, no narrowing:
- **Sports-industry aspirants** — Sean's warm distribution: Substack readers, Duke Sports Analytics Club alumni, ConvergeSports network. First testers come from here.
- **General career switchers** — consulting, banking, PM, tech; matches the original discovery interview base.

The product is industry-agnostic; sports is a distribution wedge, not a product constraint.

---

## 5. Core user flow

1. **Landing page:** single input box ("What role are you trying to reach?") with 4-6 clickable example chips drawn from the pre-seeded set (§10).
2. User submits free text.
3. **Input validation:** the query parser (§6.3, LLM Call 1) returns a confidence signal. If the input is not plausibly a career-role query ("I want to be happy", "asdfgh"), bounce gracefully: "Tell us a role or job title you're aiming for — like 'sports agent' or 'VP of Product.'" No Crustdata call is made.
4. **Loading state (cache miss only):** progressive and honest. Show staged status ("Finding people currently in this role…" → "Analyzing their career histories…") rather than a bare spinner. Target under ~20s worst case; cache hits render near-instantly.
5. **Results screen:**
   - Header with the parsed canonical role and honest sample framing: **"Based on 390 professionals currently in this type of role"** — always "of the professionals we analyzed," never implied ground truth about all humans in the role.
   - 4-6 cluster cards: archetype name, 1-2 sentence description, % of analyzed sample, small preview (3 example people).
   - **Feedback widget on every cluster card:** thumbs up/down ("Does this match how you understand this path?") plus optional one-line comment. Stored server-side with the query + cluster id.
   - Clicking a cluster opens **Explore Path**: full roster for that cluster — name, current title/company, education, estimated years of experience, LinkedIn link. LinkedIn links open in a new tab; render the link affordance as secondary (an icon, not a promise), since some vendor-supplied profile URLs are dead or private.
   - **Exit survey link** in the footer/results view: "2 minutes of feedback →" pointing to an external survey URL (environment-configurable; Sean will supply a Google Form/Tally link).
6. **Thin-data state:** if fewer than **30 usable profiles** survive cleaning, do not force clusters. Show: "This role is too niche for a reliable pattern yet — try a broader or related title," with 2-3 suggested broader queries generated by the parser.
7. Stateless per user — no accounts, nothing remembered about the visitor beyond the anonymous session token used for rate limiting (§6.5).
8. **Mobile-first responsive design is required**, especially the results and Explore Path views — the primary test audience (students) will predominantly open shared links on phones.

---

## 6. System architecture

### 6.1 Stack
- **App:** single Next.js (React) application on Railway.
- **Database:** Supabase (Postgres). Roles: result cache, raw-pull cache, rate-limit counters, spend ledger, feedback storage. It is a cache and ledger, not a warehouse.
- **LLM:** Anthropic API.
  - **LLM Call 1 (query parsing/validation):** `claude-haiku-4-5-20251001` — fast/cheap, task is simple.
  - **LLM Calls 2a/2b (archetype derivation + classification):** `claude-sonnet-4-6` — output quality here *is* the product.
  - Model IDs must be environment-configurable, not hardcoded.
- **People data:** **Crustdata production REST API.** ⚠️ The Crustdata MCP connector used during design sessions in Claude.ai does not exist in production. The deployed app calls Crustdata's HTTP API directly with an API key Sean provisions. Isolate this behind a single client wrapper module (vendor-swap insurance).
- **Analytics:** **PostHog** (free tier), self-serve events per §11. Do not hand-roll analytics.

### 6.2 Pipeline overview

```
User text
  → [LLM 1] parse + validate + canonicalize
  → cache check (canonical key)
      hit & fresh → render
      miss/stale ↓
  → Crustdata people search (bounded pull)
  → cleaning pass
  → [LLM 2a] derive archetypes from sample
  → [LLM 2b] classify all profiles against archetypes (batched)
  → validation pass (no lost/hallucinated people)
  → write cache
  → render
```

### 6.3 LLM Call 1 — parse, validate, canonicalize

Input: raw user text. Output (structured JSON):
- `is_valid_role_query` (boolean) + `suggestions` if false
- `canonical_role`: normalized `{title_family, industry_context, seniority}` — **this is the cache key.** The parser must collapse synonyms and paraphrases to one canonical form. Specification by example (include these in the prompt):
  - "CDO at a sports team" / "chief data officer sports" / "head of data at an NBA franchise" → same canonical key: `{title_family: "chief data officer", industry_context: "professional sports", seniority: "c-suite"}`
  - "PM at a startup" / "product manager, early stage company" → `{title_family: "product manager", industry_context: "startups", seniority: "mid"}`
- `crustdata_filter`: the structured filter object for the vendor search (title variants to match, industry hints).
- Secondary fuzzy layer: before declaring a cache miss, also check for an existing cached canonical key whose title_family + industry_context match exactly even if seniority differs only trivially. Keep this simple — exact match on the canonical tuple is the primary mechanism; do not build embedding-similarity lookup for v1.

### 6.4 Crustdata fetch + cleaning

- **Pull cap:** max **400 profiles** per query (environment-configurable). People search bills per-100-results; this cap is the primary cost lever.
- **Store the raw cleaned pull in its own table (`cached_pulls`), separately from cluster output.** If clustering fails downstream, retry clustering from the stored pull — never re-pay for the same Crustdata data within the freshness window.
- Cleaning rules:
  - **Primary current role resolution:** `employment_details.current` frequently contains multiple simultaneous entries (main job + board seats + advisory roles). Rule: choose the entry with the most recent start_date whose title does not match advisory/board/volunteer patterns (advisor, board member, board of directors, mentor, volunteer, investor); fall back to first entry if all are ambiguous. Never blindly take index 0.
  - Drop profiles with no employment history, or history too thin to characterize a path (fewer than 2 total roles).
  - **Relevance re-rank:** vendor industry/title filters produce false positives (observed directly in feasibility testing). During LLM 2b classification, include an explicit `not_relevant` bucket; profiles classified there are excluded from clusters and counts.

### 6.5 LLM Call 2 — two-pass clustering (mandatory design)

Do **not** send all ~400 histories in one call and ask for clusters + assignments. That pattern drops people, hallucinates IDs, and is unverifiable. Instead:

- **Pass 2a — derive archetypes:** send a representative sample (~60-80 career histories, sampled across the pull) and ask for 4-6 archetypes: short label, 1-2 sentence description of the common pattern, distinguishing signals. Archetypes are then *fixed*.
- **Pass 2b — classify:** in batches of ~25-40 profiles, classify each person into exactly one archetype (or `not_relevant`). Batches are independent → parallelizable, cheap, and each batch's output is code-verifiable.
- **Validation pass (code, not LLM):** assert that every input person ID appears exactly once in the output and that no output ID was invented. On violation, retry the failed batch once; if it fails again, drop those specific profiles and log the event. Percentages are computed **in code** from final assignments, never taken from LLM prose.
- Note for the record: "clustering" in v1 is LLM-based bucketing, not a statistical/ML clustering pipeline. Intentional simplification — do not build embeddings/k-means for this release.

### 6.6 Rate limiting & cost control

No accounts, so protection is infrastructural — but **not primarily IP-based**: the target users are students behind shared campus IPs, where an IP cap silently locks out an entire library.

- **Primary throttle — anonymous session token** (httpOnly cookie issued on first visit): cap *cache-miss* searches per session per hour (default 5; env-configurable). Cache hits are free and should be limited only loosely (e.g. 60/hour) as bot protection.
- **Secondary backstop — per-IP cap set generously high** (e.g. 50 cache-miss searches/hour/IP) to catch cookie-clearing abuse without punishing campuses.
- **True safety net — global daily credit ceiling:** a `daily_spend` ledger tracks estimated Crustdata credits; at the ceiling, degrade gracefully to cached-only mode with a visible notice ("High demand — showing previously analyzed roles; try one of these"), never a hard error and never silent overspend.
- All three limits are environment variables.

### 6.7 Error handling (required, not improvised)

- Each pipeline stage: retry once on transient failure with backoff.
- Crustdata down/unresponsive: cached-only mode message (same UX as spend-ceiling degrade).
- LLM failure after a successful (paid) Crustdata pull: the pull is already persisted (§6.4) — retry clustering from stored data; user sees the loading state continue, not an error, unless the retry also fails.
- Total pipeline failure: honest error state with the seed-role chips offered as an escape hatch. No blank screens, no raw stack traces.

### 6.8 Data storage, freshness & privacy

- Cache only render-necessary fields (name, title, company, school, dates, LinkedIn URL) — not full raw vendor payloads.
- Freshness window: 30 days (env-configurable). Stale entries are refreshed lazily on next request, not by scheduled jobs (keep v1 simple).
- No user PII collected (no accounts, no uploads). The anonymous session cookie stores no identity.
- Persistent footer disclosure line on the results view — "Career data sourced from public professional profiles via our data provider. To request removal, contact [email]" — with a working mailbox Sean monitors.

---

## 7. Functional requirements summary

| Area | Requirement |
|---|---|
| Input | Free-text role; example chips from seed set |
| Validation | Parser confidence gate; graceful bounce for non-role input |
| Parsing | LLM 1 (Haiku): canonical role (cache key) + vendor filter |
| Fetch | Crustdata REST, 400-profile cap, raw pull persisted separately |
| Cleaning | Primary-role resolution rule; thin-profile drop; `not_relevant` re-rank |
| Clustering | Two-pass (derive → classify), code-side validation, code-computed % |
| Output | Cluster cards → Explore Path roster; honest sample framing |
| Feedback | Thumbs up/down + comment per cluster; exit survey link (env-config URL) |
| Filtering | *Nice-to-have, build last:* experience/school/company filters in roster. Cut first if time-constrained. |
| Caching | Canonical-key cache, 30-day freshness, split pull/cluster tables |
| Rate limiting | Session-token primary, generous IP backstop, global spend ceiling |
| Accounts | None |
| Mobile | Responsive, mobile-first results views |
| Analytics | PostHog events per §11 |

---

## 8. Non-functional requirements

- Cache hits: near-instant. Cache misses: <20s target with staged progressive loading copy.
- All cost/limit constants env-configurable (pull cap, session/IP limits, spend ceiling, freshness window, model IDs, survey URL).
- Reliability over completeness: a clear "not enough data" state always beats a low-confidence forced output. Trust is the product.

---

## 9. Pre-launch QA gate (golden set)

Before any external tester touches the app:
1. Run the full pipeline against the **golden subset** of the seed list (§10, marked ★) — roles where Sean/Ben have first-hand domain knowledge of how people actually get there.
2. Review outputs against that domain knowledge: Are the archetypes recognizably real? Are the % splits plausible? Spot-check 10 individual profiles per role for relevance (did the `not_relevant` bucket catch the false positives?).
3. Launch criterion: **at least 4 of the 5 golden-set roles produce clusters Sean would personally stand behind in front of someone he respects.** Below that, iterate on the 2a/2b prompts before launch — prompt iteration is expected and is why the golden set exists.

---

## 10. Appendix A — Seed & golden-set role list (pre-compute all before launch)

★ = golden set (Sean/Ben have domain knowledge to validate output quality). Sports and general roles are intentionally mixed rather than grouped, since the product treats them as one undifferentiated search space.

1. ★ Head of Strategy & Analytics / SVP of Business Strategy and Analytics — professional sports team
2. ★ Product Manager at a VC-backed startup
3. Chief Data Officer / Head of Data at a professional sports team
4. ★ Private equity associate
5. Director of Baseball Operations at an MLB team
6. ★ Venture capital investor
7. Sports business strategy consultant
8. ★ Chief of Staff at a startup
9. General Manager of an NBA team
10. Management consultant at a top strategy firm
11. Sports agent
12. Data scientist at a large tech company
13. Athletic Director at a Division I university
14. Investment banking analyst/associate
15. Head of Partnerships at a professional sports league
16. Corporate development manager
17. Product Manager at a sports betting company
18. Founder of a venture-backed startup
19. Quantitative analyst / trader at a sportsbook
20. Chief Marketing Officer
21. Director of Player Personnel (NFL/NBA)
22. Head of Growth at a consumer startup
23. VP of Content at a sports media company
24. UX designer at a tech company
25. VP of Ticket Sales & Revenue at a professional team
26. Solutions engineer / sales engineer
27. Sports analytics researcher / academic-to-team track
28. Hedge fund analyst
29. Data scientist at a sports tech startup
30. Brand manager at a CPG company
31. Forward Deployed Engineer *(deliberate stress test: ambiguous, company-specific title)*
32. Chief AI Officer *(deliberate stress test: emerging title, small sample; should exercise the thin-data state or produce interesting clusters)*

Sean reviews/edits this list before seeding; the two stress-test entries are intentionally included to exercise edge cases during QA, not to look good in demos.

---

## 11. Analytics & learning instrumentation (PostHog)

Events: `search_submitted` (raw text + canonical key + hit/miss), `results_rendered` (sample size, cluster count, latency), `cluster_opened`, `person_linkedin_clicked`, `cluster_feedback` (thumb + comment), `exit_survey_clicked`, `thin_data_shown`, `rate_limited`, `degraded_mode_shown`, `pipeline_error`.

Learning questions these must answer:
- Do users recognize the clusters as true? (feedback thumbs by cluster/role)
- Is the roster itself valuable independent of clustering? (cluster_opened → linkedin_clicked funnel)
- What do people search that we didn't seed? (cache-miss raw queries = real demand signal)
- Engagement shape: refine-and-research vs. one-and-done per session.

Decision framing for the test phase (targets are directional, set before launch so results can't be rationalized after): if a majority of cluster feedback is negative on roles *outside* the golden set, the parsing/clustering needs work before wider distribution; if users browse rosters but ignore clusters, the archetype layer may be the wrong packaging of the same data — both are learnings, not failures.

---

## 12. Appendix B — Operator runbook (no admin UI in v1)

Ship a `runbook.md` in the repo with copy-paste SQL for the operator:
- Today's estimated Crustdata credit spend + remaining headroom vs. ceiling
- Cache hit rate (last 24h / 7d)
- 20 most recent searches (raw text + canonical key + hit/miss)
- Feedback entries, newest first
- Pipeline error count by stage (last 24h)
- Sessions currently rate-limited

Plus a one-liner for connecting to the Supabase Postgres instance. The runbook is a deliverable, not documentation debt.

---

## 13. Open questions / v2 triggers

- **Accounts:** revisit only if testers ask to save/revisit searches, or anonymous repeat-search cost becomes material.
- **Semantic layer:** if feedback shows systematic irrelevant-people complaints that the `not_relevant` bucket isn't catching, tighten parser filter construction first; a maintained title ontology is the escalation after that, not the first move.
- **Pull-cap sizing:** watch real credit spend; 400 may be over/under-sized.
- **Vendor swap:** the isolated Crustdata client module is the insurance policy; keep it clean.
- **Match scoring, outreach drafting, career-exploration dashboard:** the v2 candidate list, in roughly that order of validated demand from discovery.
