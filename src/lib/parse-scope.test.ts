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
