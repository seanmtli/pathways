# Pathways

A career-navigation tool: type a target role in plain English — *"I want to be
a Chief Data Officer at a sports team"* — and see the **real career paths real
people took to get there**, clustered into a small number of named archetypes,
each with its share of the analyzed sample and a browsable roster of actual
people.

Built per [pathways-v1.2-prd.md](pathways-v1.2-prd.md). This is a learning
instrument for a no-revenue test phase, not an investor demo: honest sample
framing, a "not enough data" state instead of low-confidence output, and
aggressive cost protection since v1 ships with no user accounts.

## How it works

```
User text
  → [LLM 1: Haiku] parse + validate + canonicalize   ← the canonical role tuple is the cache key
  → cache check (exact key, then seniority-fuzzy)
      hit & fresh → render (~2s)
      miss ↓
  → rate gates (session token → IP backstop → daily credit ceiling)
  → Crustdata people search (bounded pull, ~12 credits max)
  → cleaning pass (primary-role resolution, thin-profile drop)
  → [LLM 2a: Sonnet] derive 4-6 archetypes from a sample — then FIXED
  → [LLM 2b: Sonnet] classify all profiles in parallel batches
  → validation pass (code, not LLM: every person accounted for exactly once)
  → write cache → render (~40s)
```

Design decisions that are load-bearing:

- **Two-pass clustering is mandatory** (PRD §6.5). One mega-call drops people
  and hallucinates IDs unverifiably. Pass 2b classifies in independent batches
  against fixed archetypes; each batch is code-verifiable. Batch schemas use
  ordinal person IDs enum-constrained in the JSON schema (long ID enums hit
  the API's schema-compilation limits), a coverage retry re-asks only for
  unassigned people, and a final accounting assertion guarantees every profile
  is classified-or-dropped exactly once. **Percentages are computed in code,
  never taken from LLM output.**
- **Raw pulls are cached separately from cluster output** (`pw_cached_pulls`
  vs `pw_cached_searches`): a paid Crustdata pull is persisted before
  clustering starts, so downstream failures retry from stored data — the same
  vendor data is never paid for twice within the freshness window.
- **Rate limiting is session-token-first, not IP-first** (PRD §6.6): the
  target users are students behind shared campus IPs. The IP cap is a
  generous backstop against cookie clearing; the true safety net is the
  global daily credit ceiling, which degrades to cached-only mode with a
  visible notice — never a hard error, never silent overspend.
- **The Crustdata client is one swappable module**
  ([src/lib/crustdata.ts](src/lib/crustdata.ts)). Note the filter quirk
  documented there: pipe alternation inside a fuzzy filter silently breaks
  matching; always use explicit OR-groups.

## Repo layout

```
src/lib/
  config.ts      env-driven constants (all cost/limit levers)
  crustdata.ts   vendor client — the only file that knows about Crustdata
  parser.ts      LLM 1: canonicalization + filter construction
  cleaning.ts    §6.4 cleaning rules
  clustering.ts  LLM 2a/2b + code-side validation
  db.ts          Supabase access (cache, ledger, logs)
  pipeline.ts    orchestrator: gates → parse → cache → fetch → cluster
src/scripts/
  run-role.ts    run the pipeline for any query from the CLI
  test-limits.ts verifies all rate/spend/degradation gates
  phase1.ts      original hardcoded single-role pipeline (kept for reference)
runbook.md       operator runbook — tested copy-paste SQL (no admin UI in v1)
```

## Running locally

Requires Node 24+ (TypeScript runs natively, no build step).

```sh
npm install
cp .env.example .env   # fill in keys
npm run role -- "private equity associate"   # full pipeline for one query
npm run test:limits                          # verify protection gates
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CRUSTDATA_API_KEY` | — | Crustdata production REST API key |
| `OPENROUTER_API_KEY` | — | OpenRouter API key (all LLM calls route through OpenRouter) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | — | Postgres cache + ledger (service role; server-side only) |
| `LLM_PARSE_MODEL` | `google/gemini-2.5-flash-lite` | LLM 1 (parsing) — any OpenRouter slug with structured outputs |
| `LLM_CLUSTER_MODEL` | `google/gemini-3-flash-preview` | LLM 2a/2b (clustering — output quality here *is* the product) |
| `CRUSTDATA_PULL_CAP` | 400 | Max profiles per query — the primary cost lever |
| `DAILY_CREDIT_CEILING` | 300 | Global daily Crustdata credit cap |
| `RATE_LIMIT_SESSION_MISS_PER_HOUR` | 5 | Paid searches per visitor/hour |
| `RATE_LIMIT_SESSION_TOTAL_PER_HOUR` | 60 | All searches per visitor/hour |
| `RATE_LIMIT_IP_MISS_PER_HOUR` | 50 | Paid searches per IP/hour (generous — campus IPs) |
| `CACHE_FRESHNESS_DAYS` | 30 | Cache freshness window |
| `MIN_USABLE_PROFILES` | 30 | Thin-data threshold |
| `ARCHETYPE_SAMPLE_SIZE` / `CLASSIFY_BATCH_SIZE` | 70 / 30 | Clustering knobs |
| `EXIT_SURVEY_URL` | — | External survey link (frontend) |

## Status

- [x] **Phase 1** — single hardcoded role, end to end
- [x] **Phase 2** — generalized pipeline + Supabase persistence + synonym-collapsing cache
- [x] **Phase 3** — rate limiting, spend ceiling, graceful degradation + operator runbook
- [x] **Phase 4** — frontend (Next.js: landing, staged loading, cluster cards, Explore Path, feedback)
- [x] **Phase 5** — all 32 seed roles pre-computed; golden-set QA review in progress

Cache-miss latency: ~25-65s depending on role size (PRD target <20s); staged
loading copy keeps it honest. Reclustering from a stored pull runs ~21-30s.
