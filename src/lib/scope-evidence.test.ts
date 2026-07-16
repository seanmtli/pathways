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

test("normalizeQuery is a stable memo key across casing and spacing", () => {
  const a = normalizeQuery("Consultant at MBB");
  const b = normalizeQuery("  consultant   at   mbb  ");
  assert.equal(a, b);
  assert.equal(a, "consultant at mbb");
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
