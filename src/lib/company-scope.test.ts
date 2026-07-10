import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPANY_SET_KEYS,
  companyByAlias,
  companySetByAlias,
  validateCompanyRegistry,
} from "./company-sets.ts";
import { canonicalKeyOf, resolveCompanyScope, type ResolvedCompanyScope } from "./parser.ts";
import { cleanProfiles } from "./cleaning.ts";
import type { RawProfile } from "./crustdata.ts";
import { clusteringOptionsForSample } from "./clustering.ts";

process.env.CRUSTDATA_API_KEY = "test-key";

test("registry exposes distinct acronym sets and aliases", () => {
  validateCompanyRegistry();
  assert.ok(COMPANY_SET_KEYS.includes("tech.faang"));
  assert.equal(companySetByAlias("MANGO")?.key, "tech.mango");
  assert.equal(companySetByAlias("MBB")?.key, "consulting.mbb");
  assert.equal(companyByAlias("Sequoia")?.canonicalName, "Sequoia Capital");
  assert.equal(companyByAlias("Alphabet"), null);
  assert.notDeepEqual(
    companySetByAlias("FAANG")?.companies.map((item) => item.canonicalName),
    companySetByAlias("MANGO")?.companies.map((item) => item.canonicalName),
  );
});

test("named company resolution produces stable company-id cache identity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { names?: string[]; domains?: string[] };
    const identifiers = body.names ?? body.domains ?? [];
    return Response.json(
      identifiers.map((name, index) => ({
        matched_on: name,
        matches: [{
          confidence_score: 0.99,
          company_data: {
            crustdata_company_id: 1000 + index,
            basic_info: { name, primary_domain: `${name.toLowerCase().replace(/\W+/g, "")}.com` },
          },
        }],
      })),
    );
  };
  try {
    const scope = await resolveCompanyScope({
      company_set_key: null,
      employer_preset_key: null,
      company_mentions: ["Sequoia"],
      proposed_companies: [],
      scope_label: "",
      startup_employer: false,
    });
    assert.equal(scope?.kind, "named");
    assert.match(scope?.scopeKey ?? "", /^named:[a-f0-9]{32}$/);
    assert.match(
      canonicalKeyOf(
        { title_family: "venture capital investor", industry_context: "venture capital", seniority: "mid" },
        scope,
      ),
      /\|scope:named:/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MBB resolves to its exact three-company cohort", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { names?: string[]; domains?: string[] };
    const identifiers = body.names ?? body.domains ?? [];
    return Response.json(
      identifiers.map((name, index) => ({
        matched_on: name,
        matches: [{
          confidence_score: 0.99,
          company_data: {
            crustdata_company_id: 2000 + index,
            basic_info: { name, primary_domain: null },
          },
        }],
      })),
    );
  };
  try {
    const scope = await resolveCompanyScope({
      company_set_key: "consulting.mbb",
      employer_preset_key: null,
      company_mentions: [],
      proposed_companies: [],
      scope_label: "",
      startup_employer: false,
    });
    assert.equal(scope?.kind, "set");
    assert.equal(scope && "companies" in scope ? scope.companies.length : 0, 3);
    assert.match(scope?.scopeKey ?? "", /^set:consulting\.mbb:r1:[a-f0-9]{32}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cleaning requires title and company on the same current entry", () => {
  const scope: ResolvedCompanyScope = {
    kind: "named",
    scopeKey: "named:test",
    label: "Bain & Company",
    verified: true,
    companies: [{
      crustdataCompanyId: 22,
      canonicalName: "Bain & Company",
      domain: "bain.com",
      linkedinUrl: null,
      confidence: 1,
    }],
  };
  const profile: RawProfile = {
    crustdata_person_id: 1,
    basic_profile: { name: "A Person", current_title: "Consultant" },
    experience: {
      employment_details: {
        current: [
          {
            title: "Consultant",
            name: "Bain Capital",
            crustdata_company_id: 11,
            start_date: "2025-01-01",
            end_date: null,
            company_professional_network_industry: null,
            seniority_level: null,
          },
          {
            title: "Consultant",
            name: "Bain & Company",
            crustdata_company_id: 22,
            start_date: "2024-01-01",
            end_date: null,
            company_professional_network_industry: null,
            seniority_level: null,
          },
        ],
        past: [{
          title: "Analyst",
          name: "Prior Co",
          start_date: "2022-01-01",
          end_date: "2023-12-31",
          company_professional_network_industry: null,
          seniority_level: null,
        }],
      },
    },
  };

  const result = cleanProfiles([profile], { companyScope: scope, titleVariants: ["Consultant"] });
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].matchedCurrentRole.companyId, 22);
  assert.equal(result.profiles[0].currentCompany, "Bain & Company");
});

test("small-sample clustering boundaries are deterministic", () => {
  assert.deepEqual(clusteringOptionsForSample(12, 12), { minRelevant: 12, minArchetypes: 2, maxArchetypes: 2 });
  assert.deepEqual(clusteringOptionsForSample(23, 12), { minRelevant: 12, minArchetypes: 2, maxArchetypes: 2 });
  assert.deepEqual(clusteringOptionsForSample(24, 12), { minRelevant: 12, minArchetypes: 3, maxArchetypes: 3 });
  assert.deepEqual(clusteringOptionsForSample(29, 12), { minRelevant: 12, minArchetypes: 3, maxArchetypes: 3 });
  assert.deepEqual(clusteringOptionsForSample(30, 12), { minRelevant: 12, minArchetypes: 4, maxArchetypes: 6 });
});

test("structural scope requires title and employer attributes on one current entry", () => {
  const scope: ResolvedCompanyScope = {
    kind: "structural",
    scopeKey: "preset:startup:r1",
    presetKey: "startup",
    label: "a startup",
    revision: 1,
    description: "Privately held employers with 1-200 employees.",
    verified: true,
  };
  const profile: RawProfile = {
    crustdata_person_id: 2,
    basic_profile: { name: "Split Match", current_title: "Product Manager" },
    experience: {
      employment_details: {
        current: [
          {
            title: "Product Manager",
            name: "Large Public Co",
            start_date: "2025-01-01",
            end_date: null,
            company_professional_network_industry: "Software Development",
            company_headcount_range: "10,001+",
            company_type: "Public Company",
            seniority_level: null,
          },
          {
            title: "Advisor",
            name: "Tiny Startup",
            start_date: "2025-02-01",
            end_date: null,
            company_professional_network_industry: "Software Development",
            company_headcount_range: "11-50",
            company_type: "Privately Held",
            seniority_level: null,
          },
        ],
        past: [],
      },
    },
  };
  const result = cleanProfiles([profile], { companyScope: scope, titleVariants: ["Product Manager"] });
  assert.equal(result.profiles.length, 0);
  assert.equal(result.stats.droppedScopeMismatch, 1);
});
