// LLM Call 1 (PRD §6.3): parse + validate + canonicalize the user's free text.
// Fast/cheap model (Haiku). The canonical role tuple is the cache key, so the
// parser must collapse synonyms and paraphrases to one canonical form — the
// worked examples from the PRD are embedded in the prompt as the spec.
//
// The parser emits title variants and industry names; the Crustdata filter is
// constructed in code (never trusted raw from the LLM), using OR-groups only.

import { config } from "./config.ts";
import { jsonCall } from "./llm.ts";
import { fuzzyOr, type CrustdataFilter } from "./crustdata.ts";

export interface CanonicalRole {
  title_family: string;
  industry_context: string;
  seniority: string;
}

export interface ParseResult {
  isValidRoleQuery: boolean;
  /** Broader/related queries — shown on invalid input and thin-data states. */
  suggestions: string[];
  canonicalRole: CanonicalRole | null;
  roleDescription: string;
  crustdataFilter: CrustdataFilter | null;
  /** Title conditions alone — the fail-open fallback when an industry
   * constraint (possibly an invalid taxonomy name) matches ~nothing. */
  titleOnlyFilter: CrustdataFilter | null;
}

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    is_valid_role_query: { type: "boolean" },
    canonical_role: {
      type: "object",
      properties: {
        title_family: { type: "string" },
        industry_context: { type: "string" },
        seniority: { type: "string", enum: ["entry", "mid", "senior", "director", "vp", "c-suite", "any"] },
      },
      required: ["title_family", "industry_context", "seniority"],
      additionalProperties: false,
    },
    role_description: { type: "string" },
    title_variants: { type: "array", items: { type: "string" } },
    industry_values: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["is_valid_role_query", "canonical_role", "role_description", "title_variants", "industry_values", "suggestions"],
  additionalProperties: false,
} as const;

const SYSTEM = `You parse a career-exploration query into a canonical role for a career-paths product. The user typed free text describing a role they want to reach.

Output fields:

1. is_valid_role_query — true only if the text plausibly names a career role or job title. "I want to be happy", "asdfgh", or general life questions are false.

2. canonical_role — the normalized role. THIS IS A CACHE KEY: you MUST collapse synonyms, abbreviations, and paraphrases to one canonical form so equivalent queries produce byte-identical values. Always lowercase. Follow these examples exactly:
   - "CDO at a sports team" / "chief data officer sports" / "head of data at an NBA franchise" → {title_family: "chief data officer", industry_context: "professional sports", seniority: "c-suite"}
   - "PM at a startup" / "product manager, early stage company" / "product manager at a VC-backed startup" → {title_family: "product manager", industry_context: "startups", seniority: "mid"}
   - "PE associate" / "private equity associate" → {title_family: "private equity associate", industry_context: "private equity", seniority: "mid"}
   Use the most standard name for the title_family (expand abbreviations: "PM" → "product manager", "SWE" → "software engineer", "VC" → "venture capital investor"). industry_context is a short standard phrase ("professional sports", "startups", "consulting", "technology", "finance"); use "any" if the role has no industry constraint. If the query names no seniority, infer the typical seniority of the role itself.

3. role_description — one human-readable line describing the target role, used in prompts and UI headers (e.g. "Product Manager at a venture-backed startup").

4. title_variants — 3 to 6 job-title strings for substring matching against current job titles in a professional-profiles database. Write titles EXACTLY the way they appear on a business card — NEVER concatenate the industry or employer type into the title. People at hedge funds are titled "Investment Analyst" or "Analyst", not "hedge fund analyst"; the industry lives in industry_values. Include common synonyms and abbreviation forms. A short generic title (e.g. "Analyst") is fine when industry_values constrains the employer; without an industry constraint, keep variants specific enough not to match unrelated roles.
   Example: query "hedge fund analyst" → title_variants ["Investment Analyst", "Research Analyst", "Equity Analyst", "Analyst"], industry_values ["Hedge Funds", "Investment Management"].

5. industry_values — EXACT LinkedIn industry-taxonomy names for the employer. Invalid names silently match zero companies, so only use names from the official taxonomy. Common valid values: "Spectator Sports", "Sports Teams and Clubs", "Business Consulting and Services", "Venture Capital and Private Equity Principals", "Investment Banking", "Investment Management", "Hedge Funds", "Financial Services", "Banking", "Software Development", "Technology, Information and Internet", "IT Services and IT Consulting", "Advertising Services", "Entertainment Providers", "Broadcast Media Production and Distribution", "Higher Education", "Hospitals and Health Care", "Insurance", "Real Estate", "Retail", "Manufacturing", "Gambling Facilities and Casinos", "Staffing and Recruiting". Choose the categories the actual employers would list themselves under — not adjacent industries. If you are not confident a name is in the official taxonomy, OMIT it and rely on titles. Empty array if the role is not industry-constrained.

6. suggestions — 2-3 example role queries. If the query is invalid, suggest concrete roles ("sports agent", "VP of product"). If valid, suggest broader or adjacent versions of THIS role (used when data is too thin).

If is_valid_role_query is false, still fill canonical_role/title_variants/industry_values with empty strings and arrays.`;

interface RawParse {
  is_valid_role_query: boolean;
  canonical_role: { title_family: string; industry_context: string; seniority: string };
  role_description: string;
  title_variants: string[];
  industry_values: string[];
  suggestions: string[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function canonicalKeyOf(role: CanonicalRole): string {
  return `${role.title_family}|${role.industry_context}|${role.seniority}`;
}

export async function parseQuery(rawQuery: string): Promise<ParseResult> {
  const raw = await jsonCall<RawParse>({
    model: config.parseModel(),
    system: SYSTEM,
    user: `Query: ${rawQuery.slice(0, 300)}`,
    schema: PARSE_SCHEMA,
    maxTokens: 4000,
  });

  if (!raw.is_valid_role_query || !raw.canonical_role.title_family) {
    return {
      isValidRoleQuery: false,
      suggestions: raw.suggestions,
      canonicalRole: null,
      roleDescription: "",
      crustdataFilter: null,
      titleOnlyFilter: null,
    };
  }

  // Normalize in code — never trust the LLM to be byte-stable on casing/whitespace.
  const canonicalRole: CanonicalRole = {
    title_family: normalize(raw.canonical_role.title_family),
    industry_context: normalize(raw.canonical_role.industry_context),
    seniority: normalize(raw.canonical_role.seniority),
  };

  const conditions: CrustdataFilter[] = [
    fuzzyOr(
      "experience.employment_details.current.title",
      raw.title_variants.filter((t) => t.trim().length > 2).slice(0, 6),
    ),
  ];
  const industries = raw.industry_values.filter((v) => v.trim().length > 0).slice(0, 6);
  if (industries.length > 0) {
    conditions.push(fuzzyOr("experience.employment_details.current.company_professional_network_industry", industries));
  }

  return {
    isValidRoleQuery: true,
    suggestions: raw.suggestions,
    canonicalRole,
    roleDescription: raw.role_description,
    crustdataFilter: conditions.length === 1 ? conditions[0] : { op: "and", conditions },
    titleOnlyFilter: conditions[0],
  };
}
