# Evidence-Grounded Employer Scoping + Parse Memoization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the parser from inventing employer scopes on unscoped queries — a scope is honored only when the user's own words attach an employer to the role — and freeze each query's parse so identical queries stay consistent and never trigger a duplicate paid pull.

**Architecture:** Three layered changes, all in existing files. (1) A pure, deterministic **evidence gate** in `parser.ts` runs on the LLM's raw output before scope resolution: named companies survive only if their name appears verbatim in the query; category scopes (sets/presets/startup/inferred) survive only when an employer connective ("at/for/with/within") attaches the evidence phrase to the role. Invention becomes structurally impossible regardless of model nondeterminism. (2) Scope **resolution failures split by kind**: a named-company we can't find still bounces honestly (`NamedCompanyResolutionError`); a category we can't fully resolve degrades to a broad, honest search instead of erroring. (3) A `pw_parse_memo` table freezes the first valid parse per normalized query, giving consistency and eliminating parser-drift duplicate pulls.

**Tech Stack:** TypeScript (native Node 24, no build), Next.js 15 App Router, Supabase Postgres (service-role), `node:test` + `node:assert/strict`, OpenRouter LLM via `jsonCall`, Crustdata REST via `crustdata.ts`.

## Global Constraints

- Native TS runtime — no build step; files run via `node --env-file=.env`. No new dependencies.
- All tests use `node:test` + `node:assert/strict`; `npm test` runs `node --test src/lib/*.test.ts`.
- Tests set `process.env.CRUSTDATA_API_KEY = "test-key"` and `process.env.OPENROUTER_API_KEY = "test-key"` at top of file; mock `globalThis.fetch` and restore it in a `finally`.
- The gate is **subtractive only** — it may remove an invented scope, never add one. It must not change any currently-working unscoped query.
- Percentages/clustering untouched. This plan only changes parsing, scope resolution, and parse caching.
- Named-company resolution failure → still bounces (`invalid_query`). Only **category** scope failures degrade to broad. This is the one asymmetry to preserve everywhere.
- pw_ table convention: RLS enabled, no policies, service-role access only.
- Follow existing `parser.ts` style: `normalize()` for casing/space, lowercase canonical fields, no comments unless they carry intent (`ponytail:` for deliberate simplifications with a named ceiling).

---

## File Structure

- `src/lib/parser.ts` (modify) — add `NamedCompanyResolutionError`, `normalizeQuery`, `mentionInQuery`, `categoryEvidenceOk`, `gateScopeInputs`, `PARSER_VERSION`; add `scope_evidence` to `PARSE_SCHEMA` + `RawParse` + `SYSTEM`; wire the gate and split-failure handling into `parseQuery`; throw the typed error on the named path in `resolveCompanyScope`.
- `src/lib/db.ts` (modify) — add `getParseMemo` / `putParseMemo`; import `ParseResult`.
- `src/lib/pipeline.ts` (modify) — check memo before `parseQuery`, write memo after a valid parse.
- `supabase/migrations/20260715000000_add_parse_memo.sql` (create) — the memo table.
- `src/lib/scope-evidence.test.ts` (create) — pure-function unit tests for the gate + `normalizeQuery`.
- `src/lib/parse-scope.test.ts` (create) — integration tests for `parseQuery` (invented scope dropped, named bounce, category degrade) and `resolveCompanyScope` typed-error behavior, via routed `fetch` stub.

---

### Task 1: Evidence gate — pure helpers

The deterministic core of Option 1. Pure functions, no LLM, no DB, no network. This task is the whole "code verifies what the user typed" guarantee.

**Files:**
- Modify: `src/lib/parser.ts` (add exports near the other helpers, after `normalize`/`titleCase` around line 178)
- Test: `src/lib/scope-evidence.test.ts` (create)

**Interfaces:**
- Consumes: existing `normalize(value: string): string` in `parser.ts` (line 172), `RawParse` interface (line 157).
- Produces:
  - `normalizeQuery(query: string): string`
  - `mentionInQuery(query: string, mention: string): boolean`
  - `categoryEvidenceOk(query: string, evidence: string): boolean`
  - `type ScopeParse = Pick<RawParse, "company_set_key" | "employer_preset_key" | "company_mentions" | "proposed_companies" | "scope_label" | "startup_employer">`
  - `gateScopeInputs(raw: ScopeParse & { scope_evidence: string }, query: string): ScopeParse`

- [ ] **Step 1: Write the failing test**

Create `src/lib/scope-evidence.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

process.env.CRUSTDATA_API_KEY = "test-key";
process.env.OPENROUTER_API_KEY = "test-key";

import {
  normalizeQuery,
  mentionInQuery,
  categoryEvidenceOk,
  gateScopeInputs,
} from "./parser.ts";

test("normalizeQuery lowercases, trims, collapses whitespace", () => {
  assert.equal(normalizeQuery("  Consultant   at  MBB "), "consultant at mbb");
  assert.equal(normalizeQuery("PM at a Startup"), normalizeQuery("pm at a startup"));
});

test("categoryEvidenceOk requires a connective attaching the evidence", () => {
  assert.equal(categoryEvidenceOk("consultant at MBB", "MBB"), true);
  assert.equal(categoryEvidenceOk("PM at a startup", "startup"), true);
  assert.equal(
    categoryEvidenceOk("investment banker at a boutique investment bank", "boutique investment bank"),
    true,
  );
  // Industry that is part of the role, not an employer the user chose:
  assert.equal(categoryEvidenceOk("investment banking analyst", "investment banking"), false);
  assert.equal(categoryEvidenceOk("hedge fund analyst", "hedge fund"), false);
  // Pure fabrication — words not in the query at all:
  assert.equal(categoryEvidenceOk("solutions engineer", "large technology company"), false);
  assert.equal(categoryEvidenceOk("consultant at MBB", ""), false);
});

test("mentionInQuery honors a verbatim proper name, connective or not", () => {
  assert.equal(mentionInQuery("VC investor at Sequoia", "Sequoia"), true);
  assert.equal(mentionInQuery("McKinsey consultant", "McKinsey"), true);
  assert.equal(mentionInQuery("software engineer", "Google"), false);
  assert.equal(mentionInQuery("anything", ""), false);
});

test("gateScopeInputs drops an invented category scope", () => {
  const gated = gateScopeInputs(
    {
      company_set_key: "banking.bulge_bracket.v1",
      employer_preset_key: null,
      company_mentions: [],
      proposed_companies: [],
      scope_label: "",
      startup_employer: false,
      scope_evidence: "investment banking",
    },
    "investment banking analyst",
  );
  assert.equal(gated.company_set_key, null);
});

test("gateScopeInputs keeps a real category scope", () => {
  const gated = gateScopeInputs(
    {
      company_set_key: "consulting.mbb",
      employer_preset_key: null,
      company_mentions: [],
      proposed_companies: [],
      scope_label: "",
      startup_employer: false,
      scope_evidence: "MBB",
    },
    "consultant at MBB",
  );
  assert.equal(gated.company_set_key, "consulting.mbb");
});

test("gateScopeInputs drops an invented preset but keeps a stated startup", () => {
  const invented = gateScopeInputs(
    {
      company_set_key: null,
      employer_preset_key: "large_technology_company",
      company_mentions: [],
      proposed_companies: [],
      scope_label: "",
      startup_employer: false,
      scope_evidence: "large technology company",
    },
    "solutions engineer",
  );
  assert.equal(invented.employer_preset_key, null);

  const stated = gateScopeInputs(
    {
      company_set_key: null,
      employer_preset_key: "startup",
      company_mentions: [],
      proposed_companies: [],
      scope_label: "",
      startup_employer: true,
      scope_evidence: "startup",
    },
    "PM at a startup",
  );
  assert.equal(stated.employer_preset_key, "startup");
  assert.equal(stated.startup_employer, true);
});

test("gateScopeInputs filters unverbatim mentions, keeps verbatim ones", () => {
  const invented = gateScopeInputs(
    {
      company_set_key: null,
      employer_preset_key: null,
      company_mentions: ["Google"],
      proposed_companies: [],
      scope_label: "",
      startup_employer: false,
      scope_evidence: "",
    },
    "software engineer",
  );
  assert.deepEqual(invented.company_mentions, []);

  const real = gateScopeInputs(
    {
      company_set_key: null,
      employer_preset_key: null,
      company_mentions: ["Sequoia"],
      proposed_companies: [],
      scope_label: "",
      startup_employer: false,
      scope_evidence: "Sequoia",
    },
    "VC at Sequoia",
  );
  assert.deepEqual(real.company_mentions, ["Sequoia"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `scope-evidence.test.ts` errors with `The requested module './parser.ts' does not provide an export named 'normalizeQuery'` (and the other new names).

- [ ] **Step 3: Add the helpers to `parser.ts`**

Insert after `titleCase` (currently ending at line 178), before `companyHash`:

```ts
export function normalizeQuery(query: string): string {
  return normalize(query);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A proper company name in the user's own words is unambiguous evidence — honor
// it with or without a connective ("McKinsey consultant", "VC at Sequoia").
export function mentionInQuery(query: string, mention: string): boolean {
  const m = normalize(mention);
  return m.length > 0 && normalize(query).includes(m);
}

// A CATEGORY scope (set / preset / startup / inferred cohort) is honored only
// when the query attaches the employer to the role with a connective. This is
// what separates "consultant AT mbb" (a real employer scope) from "investment
// banking analyst" (the industry is part of the role, not a chosen employer) —
// the exact failure the audit found the model inventing.
// ponytail: connective must directly precede the evidence phrase; a stray "at"
// elsewhere won't pass. Ceiling: an employer typed with no connective and no
// proper name (e.g. "startup PM") runs broad — the safe, honest failure.
export function categoryEvidenceOk(query: string, evidence: string): boolean {
  const q = normalize(query);
  const e = normalize(evidence);
  if (!e || !q.includes(e)) return false;
  const re = new RegExp(`\\b(at|for|with|within)\\s+(a\\s+|an\\s+|the\\s+)?${escapeRegExp(e)}\\b`);
  return re.test(q);
}

type ScopeParse = Pick<
  RawParse,
  "company_set_key" | "employer_preset_key" | "company_mentions" | "proposed_companies" | "scope_label" | "startup_employer"
>;

// The evidence gate: AI extracts, code verifies. Purely subtractive — it can
// only strip an unverifiable scope, never add one, so it cannot change a query
// that already parses unscoped.
export function gateScopeInputs(raw: ScopeParse & { scope_evidence: string }, query: string): ScopeParse {
  const categoryOk = categoryEvidenceOk(query, raw.scope_evidence);
  return {
    company_mentions: raw.company_mentions.filter((mention) => mentionInQuery(query, mention)),
    company_set_key: categoryOk ? raw.company_set_key : null,
    employer_preset_key: categoryOk ? raw.employer_preset_key : null,
    proposed_companies: categoryOk ? raw.proposed_companies : [],
    scope_label: categoryOk ? raw.scope_label : "",
    startup_employer: categoryOk ? raw.startup_employer : false,
  };
}
```

Note: `RawParse` (line 157) does not yet have `scope_evidence`. Add it now so this task type-checks — change the interface (line 157-170) to include:

```ts
  scope_label: string;
  scope_evidence: string;
  suggestions: string[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `scope-evidence.test.ts` tests green; existing `company-scope.test.ts` still green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parser.ts src/lib/scope-evidence.test.ts
git commit -m "feat: evidence gate for employer scoping (pure helpers)"
```

---

### Task 2: Wire the gate + split scope-resolution failures

Make the gate live in `parseQuery`, teach the LLM to emit `scope_evidence`, and split resolution failures: named-company failures bounce; category failures degrade to a broad search.

**Files:**
- Modify: `src/lib/parser.ts` — `PARSE_SCHEMA` (line 79), `SYSTEM` (line 131), `resolveCompanyScope` named path (line 258-262), `parseQuery` catch block (line 369-380), add `NamedCompanyResolutionError` and `PARSER_VERSION`.
- Test: `src/lib/parse-scope.test.ts` (create)

**Interfaces:**
- Consumes (from Task 1): `gateScopeInputs`, `normalizeQuery`.
- Produces:
  - `export class NamedCompanyResolutionError extends Error {}`
  - `export const PARSER_VERSION: string`
  - `parseQuery(rawQuery: string): Promise<ParseResult>` — now: invented scopes dropped; named failure → `{ isValidRoleQuery: false }`; category failure → valid result with `companyScope: null`.

- [ ] **Step 1: Write the failing integration test**

Create `src/lib/parse-scope.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

process.env.CRUSTDATA_API_KEY = "test-key";
process.env.OPENROUTER_API_KEY = "test-key";

import { parseQuery, resolveCompanyScope, NamedCompanyResolutionError } from "./parser.ts";

// A complete RawParse payload with sensible defaults; override per test.
function rawParse(overrides: Record<string, unknown> = {}) {
  return {
    is_valid_role_query: true,
    canonical_role: { title_family: "analyst", industry_context: "finance", seniority: "mid" },
    role_description: "Analyst",
    title_variants: ["analyst", "investment analyst"],
    industry_values: [],
    startup_employer: false,
    company_set_key: null,
    employer_preset_key: null,
    company_mentions: [],
    proposed_companies: [],
    scope_label: "",
    scope_evidence: "",
    suggestions: [],
    ...overrides,
  };
}

// Route fetch: OpenRouter returns our crafted parse; Crustdata identify is
// answered by `identify`. Returns a restore fn.
function stubFetch(content: object, identify: (body: any) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    if (url.includes("crustdata.com/company/identify")) {
      return Response.json(identify(JSON.parse(String(init?.body))));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("invented category scope is dropped — query runs broad, still valid", async () => {
  const restore = stubFetch(
    rawParse({
      canonical_role: { title_family: "investment banking analyst", industry_context: "investment banking", seniority: "mid" },
      title_variants: ["investment banking analyst", "analyst"],
      company_set_key: "banking.bulge_bracket.v1",
      scope_evidence: "investment banking",
    }),
    () => {
      throw new Error("identify should not be called — scope was gated out");
    },
  );
  try {
    const parsed = await parseQuery("investment banking analyst");
    assert.equal(parsed.isValidRoleQuery, true);
    assert.equal(parsed.companyScope, null);
    assert.ok(parsed.crustdataFilter, "a broad filter is still produced");
  } finally {
    restore();
  }
});

test("named-company that cannot be resolved bounces (invalid)", async () => {
  const restore = stubFetch(
    rawParse({
      company_mentions: ["Nonexistent Co"],
      scope_evidence: "Nonexistent Co",
    }),
    () => [{ matched_on: "Nonexistent Co", matches: [] }],
  );
  try {
    const parsed = await parseQuery("analyst at Nonexistent Co");
    assert.equal(parsed.isValidRoleQuery, false);
  } finally {
    restore();
  }
});

test("category (set) that cannot be resolved degrades to a broad search", async () => {
  const restore = stubFetch(
    rawParse({
      canonical_role: { title_family: "consultant", industry_context: "management consulting", seniority: "mid" },
      title_variants: ["consultant", "management consultant"],
      company_set_key: "consulting.mbb",
      scope_evidence: "MBB",
    }),
    // Resolve nothing — every set member fails identity resolution.
    (body) => (body.names ?? body.domains ?? [""]).map((v: string) => ({ matched_on: v, matches: [] })),
  );
  try {
    const parsed = await parseQuery("consultant at MBB");
    assert.equal(parsed.isValidRoleQuery, true, "does not bounce");
    assert.equal(parsed.companyScope, null, "degraded to broad");
  } finally {
    restore();
  }
});

test("resolveCompanyScope throws NamedCompanyResolutionError on the named path only", async () => {
  const restore = stubFetch({}, () => [{ matched_on: "Nope Inc", matches: [] }]);
  try {
    await assert.rejects(
      () =>
        resolveCompanyScope({
          company_set_key: null,
          employer_preset_key: null,
          company_mentions: ["Nope Inc"],
          proposed_companies: [],
          scope_label: "",
          startup_employer: false,
        }),
      (err: unknown) => err instanceof NamedCompanyResolutionError,
    );
  } finally {
    restore();
  }
});

test("resolveCompanyScope throws a plain Error (not named) on a set failure", async () => {
  const restore = stubFetch({}, (body) =>
    (body.names ?? body.domains ?? [""]).map((v: string) => ({ matched_on: v, matches: [] })),
  );
  try {
    await assert.rejects(
      () =>
        resolveCompanyScope({
          company_set_key: "consulting.mbb",
          employer_preset_key: null,
          company_mentions: [],
          proposed_companies: [],
          scope_label: "",
          startup_employer: false,
        }),
      (err: unknown) => err instanceof Error && !(err instanceof NamedCompanyResolutionError),
    );
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `parse-scope.test.ts` errors on the missing `NamedCompanyResolutionError` export and/or the invented-scope test (identify is currently called because the gate isn't wired into `parseQuery` yet).

- [ ] **Step 3: Add `NamedCompanyResolutionError` and `PARSER_VERSION`**

At the top of `parser.ts`, after the imports (after line 23):

```ts
/** Thrown only when the user named a specific company we could not resolve.
 *  Distinguishes an honest bounce from a category scope that should degrade. */
export class NamedCompanyResolutionError extends Error {}

/** Bump when the parse prompt or scope logic changes so stale memos are ignored. */
export const PARSER_VERSION = "2026-07-15-evidence-gate";
```

- [ ] **Step 4: Add `scope_evidence` to the schema and prompt**

In `PARSE_SCHEMA.properties` (after `scope_label`, line 101) add:

```ts
    scope_label: { type: "string" },
    scope_evidence: { type: "string" },
    suggestions: { type: "array", items: { type: "string" }, maxItems: 3 },
```

In `PARSE_SCHEMA.required` (line 104-117) add `"scope_evidence"` after `"scope_label"`.

In the `SYSTEM` string, replace rule 10 (line 145) and the examples block. Change rule 10 and add rule 11:

```
10. suggestions contains 2-3 broader role queries. Never silently broaden or narrow the actual search.
11. scope_evidence: copy the EXACT words from the query that name the employer or employer category — normally the phrase right after "at/for/with/within" ("at MBB" -> "MBB", "at a startup" -> "startup", "at Sequoia" -> "Sequoia"). If the query names no employer, return "". The role's own industry is NOT an employer: "investment banking analyst", "hedge fund analyst", "solutions engineer", and "corporate development manager" each name a role, not an employer — for these return scope_evidence "" and leave company_set_key, employer_preset_key, company_mentions null/empty and startup_employer false.
```

Replace the "Canonical examples" block (lines 147-153) with:

```
Canonical examples:
- "VC investor at Sequoia" -> title_family "venture capital investor", company_mentions ["Sequoia"], scope_evidence "Sequoia", no set/preset.
- "consultant at MBB" -> company_set_key "consulting.mbb", scope_evidence "MBB".
- "SWE at MANGO" -> company_set_key "tech.mango", scope_evidence "MANGO".
- "investment banker at a boutique investment bank" -> company_set_key "banking.independent_advisory.v1", scope_evidence "boutique investment bank".
- "PM at a startup" -> employer_preset_key "startup", startup_employer true, scope_evidence "startup".
- "investment banking analyst" -> NO employer scope: all scope fields null/empty/false, scope_evidence "". The bank tier was never stated.
- "hedge fund analyst" -> NO employer scope, scope_evidence "".
- "solutions engineer" -> NO employer scope, scope_evidence "".
```

- [ ] **Step 5: Throw the typed error on the named path**

In `resolveCompanyScope`, change the named-companies throw (line 260-262):

```ts
    const companies = await resolveNames(mentions);
    if (companies.length !== new Set(mentions.map(normalize)).size) {
      throw new NamedCompanyResolutionError("One or more named companies could not be resolved unambiguously");
    }
```

Leave the set throw (line 275) and inferred throws (lines 307, 310) as plain `Error` — they are category failures that must degrade.

- [ ] **Step 6: Wire the gate + split-failure handling into `parseQuery`**

Replace the scope-resolution block in `parseQuery` (lines 369-380):

```ts
  const gated = gateScopeInputs(raw, rawQuery);
  let companyScope: ResolvedCompanyScope | null;
  try {
    companyScope = await resolveCompanyScope(gated);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof NamedCompanyResolutionError) {
      // The user named a company we can't find — bouncing is honest; showing
      // everything would silently answer a different question.
      console.error(`named company unresolved for "${rawQuery.slice(0, 120)}": ${detail}`);
      return invalid([`Try ${titleCase(canonicalRole.title_family)} at a broader employer group`, titleCase(canonicalRole.title_family)]);
    }
    // A category scope we can't fully resolve degrades to a broad, honest
    // search instead of erroring — the fix for the audit's ERROR runs.
    console.warn(`category scope degraded to broad for "${rawQuery.slice(0, 120)}": ${detail}`);
    companyScope = null;
  }
  if (companyScope && !config.companyScopedSearchEnabled()) {
    console.warn("COMPANY_SCOPED_SEARCH_ENABLED is false — blocking employer-scoped search");
    return invalid([titleCase(canonicalRole.title_family)]);
  }
```

Note: `gateScopeInputs(raw, rawQuery)` — `raw` already carries `scope_evidence` after the RawParse change in Task 1; passing the full `raw` (a superset of `ScopeParse & { scope_evidence }`) is fine. The returned `gated` is exactly the `Pick` shape `resolveCompanyScope` consumes.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all of `parse-scope.test.ts`, `scope-evidence.test.ts`, and existing `company-scope.test.ts` green.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/parser.ts src/lib/parse-scope.test.ts
git commit -m "feat: gate invented scopes; degrade category failures to broad search"
```

---

### Task 3: Parse-memo table (migration)

The Postgres table that freezes each query's first valid parse.

**Files:**
- Create: `supabase/migrations/20260715000000_add_parse_memo.sql`

**Interfaces:**
- Produces: table `public.pw_parse_memo (normalized_query text, parser_version text, parse_result jsonb, created_at timestamptz)` with composite PK `(normalized_query, parser_version)`.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260715000000_add_parse_memo.sql`:

```sql
-- Freezes the first valid parse of a given query so identical queries stay
-- consistent (same canonical key, same scope) and never trigger a duplicate
-- paid pull from parser drift. parser_version invalidates the whole memo when
-- the parse prompt/logic changes.
create table if not exists public.pw_parse_memo (
  normalized_query text not null,
  parser_version text not null,
  parse_result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (normalized_query, parser_version)
);

alter table public.pw_parse_memo enable row level security;

create index if not exists pw_parse_memo_fresh_idx
  on public.pw_parse_memo (normalized_query, parser_version, created_at desc);
```

- [ ] **Step 2: Apply the migration**

The Supabase MCP is not authorized in this session, so apply by hand (matches `runbook.md` Option A):
open https://supabase.com/dashboard → project `zhgiuztnmsffydyasgit` → SQL Editor → paste the file's contents → Run.
Expected: "Success. No rows returned." Verify with:

```sql
select count(*) from public.pw_parse_memo;
```
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260715000000_add_parse_memo.sql
git commit -m "feat: pw_parse_memo table for parse memoization"
```

---

### Task 4: Memoize parses in the pipeline

Read the memo before spending an LLM call; write it after a valid parse. Failures here never break the pipeline.

**Files:**
- Modify: `src/lib/db.ts` — add `getParseMemo` / `putParseMemo`; import `ParseResult`.
- Modify: `src/lib/pipeline.ts` — memo check around the `parseQuery` call (lines 119-121); import `PARSER_VERSION` + `normalizeQuery`.

**Interfaces:**
- Consumes: `ParseResult` (from `parser.ts` line 61), `PARSER_VERSION`, `normalizeQuery` (Task 2/1), `freshnessCutoff()` (db.ts line 22), `supabase` client (db.ts line 17).
- Produces:
  - `getParseMemo(normalizedQuery: string, parserVersion: string): Promise<ParseResult | null>`
  - `putParseMemo(normalizedQuery: string, parserVersion: string, parseResult: ParseResult): Promise<void>`

- [ ] **Step 1: Add a stability check for the memo key**

The memo key is `normalizeQuery(rawQuery)`. The only correctness risk is key drift across whitespace/casing. Add to `src/lib/scope-evidence.test.ts`:

```ts
test("normalizeQuery is a stable memo key across casing and spacing", () => {
  const a = normalizeQuery("Consultant at MBB");
  const b = normalizeQuery("  consultant   at   mbb  ");
  assert.equal(a, b);
  assert.equal(a, "consultant at mbb");
});
```

Run: `npm test`
Expected: PASS (this just locks the behavior Task 1 already provides).

- [ ] **Step 2: Add the memo db functions**

In `src/lib/db.ts`, extend the parser import (line 9):

```ts
import type { ResolvedCompanyScope, ParseResult } from "./parser.ts";
```

Add at the end of the file:

```ts
// ---------- parse_memo ----------

export async function getParseMemo(normalizedQuery: string, parserVersion: string): Promise<ParseResult | null> {
  const { data } = await supabase
    .from("pw_parse_memo")
    .select("parse_result")
    .eq("normalized_query", normalizedQuery)
    .eq("parser_version", parserVersion)
    .gte("created_at", freshnessCutoff())
    .maybeSingle();
  return data ? (data.parse_result as ParseResult) : null;
}

export async function putParseMemo(
  normalizedQuery: string,
  parserVersion: string,
  parseResult: ParseResult,
): Promise<void> {
  await supabase.from("pw_parse_memo").upsert(
    {
      normalized_query: normalizedQuery,
      parser_version: parserVersion,
      parse_result: parseResult,
      created_at: new Date().toISOString(),
    },
    { onConflict: "normalized_query,parser_version" },
  );
}
```

- [ ] **Step 3: Wire the memo into the pipeline**

In `src/lib/pipeline.ts`, extend the parser import (lines 13-19) to add `PARSER_VERSION` and `normalizeQuery`:

```ts
import {
  parseQuery,
  canonicalKeyOf,
  companyScopeKey,
  normalizeQuery,
  PARSER_VERSION,
  type ParseResult,
  type ResolvedCompanyScope,
} from "./parser.ts";
```

Replace the parse block (lines 119-121):

```ts
    // 1. Parse + validate + canonicalize (LLM 1) — memoized per query so the
    // same text always yields the same canonical key/scope (no parser drift,
    // no duplicate paid pull). Memo failures never break the pipeline.
    stage("parsing");
    const normalizedQuery = normalizeQuery(rawQuery);
    let parsed = await db.getParseMemo(normalizedQuery, PARSER_VERSION).catch(() => null);
    if (parsed) {
      console.info(`parse memo hit: ${normalizedQuery}`);
    } else {
      parsed = await retryOnce("parse", null, () => parseQuery(rawQuery));
      if (parsed.isValidRoleQuery) {
        await db.putParseMemo(normalizedQuery, PARSER_VERSION, parsed).catch(() => {});
      }
    }
```

Note: `parsed` is inferred as `ParseResult` from `parseQuery`'s return and the memo cast — the explicit `: ParseResult` annotation from the old line is no longer needed; the `let` binding types correctly. Everything downstream (`parsed.isValidRoleQuery`, `parsed.canonicalRole`, `parsed.companyScope`, `parsed.crustdataFilter`, `parsed.titleOnlyFilter`) is unchanged.

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 5: Live memo verification (requires migration applied + real keys)**

Run the same query twice:

```bash
npm run role -- "investment banking analyst"
npm run role -- "investment banking analyst"
```
Expected: the **second** run prints `parse memo hit: investment banking analyst` and skips the parse LLM call. Both runs must show `companyScope: null` / a broad search (no invented bulge-bracket scope). Then confirm the memo row exists:

```sql
select normalized_query, parser_version, created_at
from public.pw_parse_memo
where normalized_query = 'investment banking analyst';
```
Expected: exactly one row.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/lib/pipeline.ts src/lib/scope-evidence.test.ts
git commit -m "feat: memoize valid parses per normalized query"
```

---

## Post-implementation manual QA (audit re-run)

After all four tasks, re-run the audit queries against the live pipeline and confirm the fix. For each **unscoped** query, `companyScope` must be `null`; for each **scoped** query it must resolve. Run via `npm run diagnose-scope -- "<query>"` (or `npm run role`):

| Query | Expected after fix |
|---|---|
| `solutions engineer` | broad — `companyScope: null` |
| `investment banking analyst` | broad — `companyScope: null` |
| `hedge fund analyst` | broad — `companyScope: null` |
| `corporate development manager` | broad — `companyScope: null` |
| `data scientist` | broad — `companyScope: null` |
| `consultant at MBB` | scoped — set `consulting.mbb` |
| `PM at a startup` | scoped — preset `startup` |
| `software engineer at MANGO` | scoped — set `tech.mango` |
| `VC investor at Sequoia` | scoped — named `Sequoia Capital` |
| `analyst at <garbage company>` | bounces — `invalid_query` |

No ERROR outcomes should appear for any category-scoped query that fails resolution — those now degrade to broad.

---

## Self-Review

**Spec coverage:**
- Option 1 (evidence-grounded, AI extracts / code verifies) → Task 1 (gate) + Task 2 Step 4-6 (`scope_evidence` field + wiring). ✓
- Category-scope failures degrade to broad, named-company failures still bounce → Task 2 Step 5-6 (`NamedCompanyResolutionError` split). ✓
- Memoization → Task 3 (table) + Task 4 (db + pipeline). ✓
- "Reduce all the error runs" → Task 2 Step 6 converts category resolution throws (the audit's ERROR runs) into broad searches; verified in Task 2 test 3 and the QA table. ✓
- "Many test cases" → 8 pure-function tests (Task 1) + 1 key-stability test (Task 4) + 5 integration tests (Task 2) + live/QA verification (Task 4 Step 5, post-impl table). ✓

**Placeholder scan:** none — every code and test step is complete.

**Type consistency:** `gateScopeInputs` returns `ScopeParse`, exactly the `Pick` shape `resolveCompanyScope` consumes; `NamedCompanyResolutionError` referenced in Task 2 Steps 3/5/6 and both files' tests; `PARSER_VERSION`/`normalizeQuery` defined in `parser.ts` (Tasks 1-2) and imported in `pipeline.ts` (Task 4); `ParseResult` imported into `db.ts` (Task 4) matches `parser.ts` export (line 61). Consistent.

**Known ceilings (deliberate, commented in code):**
- A category employer typed with no connective and no proper name ("startup PM") runs broad. Safe, honest failure — accepted per the decision.
- A connective + genuinely stated broad category still resolves to whatever cohort the model picked ("...at a hedge fund" → multi-manager set): over-narrowing *within* a stated category is out of scope here; the audit failures were invention on *unscoped* queries, which this fully fixes.
- Only valid parses are memoized (invalid/transient bounces re-parse each time — cheap, and avoids freezing a transient error).
