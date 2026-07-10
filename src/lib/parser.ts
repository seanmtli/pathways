import { createHash } from "node:crypto";
import { config } from "./config.ts";
import { jsonCall } from "./llm.ts";
import {
  fuzzyOr,
  identifyCompanies,
  identifyCompaniesByDomain,
  identifyCompaniesByProfileUrl,
  type CrustdataFilter,
  type ResolvedCompany,
} from "./crustdata.ts";
import {
  COMPANY_SET_KEYS,
  companyByAlias,
  companySetByAlias,
  companySetByKey,
  type CompanySetKey,
} from "./company-sets.ts";
import {
  EMPLOYER_PRESET_KEYS,
  employerPresetByKey,
  type EmployerPresetKey,
} from "./employer-presets.ts";

export interface CanonicalRole {
  title_family: string;
  industry_context: string;
  seniority: string;
}

export type ResolvedCompanyScope =
  | {
      kind: "named" | "inferred";
      scopeKey: string;
      label: string;
      companies: ResolvedCompany[];
      verified: true;
      sourceQuery?: string;
    }
  | {
      kind: "set";
      scopeKey: string;
      setKey: CompanySetKey;
      label: string;
      revision: number;
      asOf: string;
      description: string;
      companies: ResolvedCompany[];
      verified: true;
    }
  | {
      kind: "structural";
      scopeKey: string;
      presetKey: EmployerPresetKey;
      label: string;
      revision: number;
      description: string;
      verified: true;
    };

export interface ParseResult {
  isValidRoleQuery: boolean;
  suggestions: string[];
  canonicalRole: CanonicalRole | null;
  roleDescription: string;
  titleVariants: string[];
  industryValues: string[];
  companyScope: ResolvedCompanyScope | null;
  crustdataFilter: CrustdataFilter | null;
  /** Null for every employer-scoped search: explicit scope is never broadened. */
  titleOnlyFilter: CrustdataFilter | null;
}

const nullableEnum = (values: readonly string[]) => ({
  type: ["string", "null"] as const,
  enum: [...values, null],
});

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
    title_variants: { type: "array", items: { type: "string" }, maxItems: 6 },
    industry_values: { type: "array", items: { type: "string" }, maxItems: 6 },
    startup_employer: { type: "boolean" },
    company_set_key: nullableEnum(COMPANY_SET_KEYS),
    employer_preset_key: nullableEnum(EMPLOYER_PRESET_KEYS),
    company_mentions: { type: "array", items: { type: "string" }, maxItems: 5 },
    proposed_companies: { type: "array", items: { type: "string" }, maxItems: 15 },
    scope_label: { type: "string" },
    suggestions: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
  required: [
    "is_valid_role_query",
    "canonical_role",
    "role_description",
    "title_variants",
    "industry_values",
    "startup_employer",
    "company_set_key",
    "employer_preset_key",
    "company_mentions",
    "proposed_companies",
    "scope_label",
    "suggestions",
  ],
  additionalProperties: false,
} as const;

const SET_GUIDE = COMPANY_SET_KEYS.map((key) => {
  const set = companySetByKey(key)!;
  return `- ${key}: ${set.label} — ${set.description}`;
}).join("\n");

const PRESET_GUIDE = EMPLOYER_PRESET_KEYS.map((key) => {
  const preset = employerPresetByKey(key)!;
  return `- ${key}: ${preset.label} — ${preset.description}`;
}).join("\n");

const SYSTEM = `You parse a career-exploration query into a current-role target and optional current-employer scope.

Output rules:
1. is_valid_role_query is true only for a present/future job target. Education destinations ("go to law school"), former-employer filters ("formerly at Google"), and feeder-source questions ("where do Sequoia investors come from?") are unsupported and must be false.
2. canonical_role is a normalized lowercase cache identity. Expand abbreviations: PM → product manager, SWE → software engineer, VC → venture capital investor. Keep the employer out of title_family.
3. title_variants contains 3-6 business-card titles. Never concatenate an employer or industry into a title. Avoid bare generic titles unless a narrow employer scope makes them safe.
4. industry_values contains exact LinkedIn industry names. Use only established taxonomy values; return [] when unsure.
5. Put a conventional cohort in company_set_key, using this closed list:
${SET_GUIDE}
6. Put a broad employer category in employer_preset_key, using this closed list:
${PRESET_GUIDE}
7. Put explicitly named companies in company_mentions verbatim. Multiple companies mean OR. Explicit names take precedence over a cohort or preset.
8. proposed_companies is only for a semantic cohort not covered above (for example "European neobanks"). Propose 2-15 exact employer names. scope_label repeats the user's category phrase. Otherwise proposed_companies is [] and scope_label is "".
9. startup_employer remains true for startup/early-stage/venture-backed employers; also emit employer_preset_key "startup".
10. suggestions contains 2-3 broader role queries. Never silently broaden the actual search.

Canonical examples:
- "VC investor at Sequoia" → title_family "venture capital investor", company_mentions ["Sequoia"], no set/preset.
- "consultant at MBB" → company_set_key "consulting.mbb", no company mention.
- "SWE at MANGO" → company_set_key "tech.mango".
- "investment banker at a boutique investment bank" → company_set_key "banking.independent_advisory.v1".
- "researcher at an AI lab" → company_set_key "ai.independent_model_labs.v1".
- "PM at a startup" → employer_preset_key "startup".

If invalid, still provide all required fields using empty strings, arrays, and nulls.`;

interface RawParse {
  is_valid_role_query: boolean;
  canonical_role: { title_family: string; industry_context: string; seniority: string };
  role_description: string;
  title_variants: string[];
  industry_values: string[];
  startup_employer: boolean;
  company_set_key: string | null;
  employer_preset_key: string | null;
  company_mentions: string[];
  proposed_companies: string[];
  scope_label: string;
  suggestions: string[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function companyHash(ids: readonly number[]): string {
  const canonical = JSON.stringify([...new Set(ids)].sort((a, b) => a - b));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function companyScopeKey(scope: ResolvedCompanyScope | null): string | null {
  if (!scope) return null;
  return scope.scopeKey;
}

export function canonicalKeyOf(role: CanonicalRole, scope: ResolvedCompanyScope | null = null): string {
  const base = `${role.title_family}|${role.industry_context}|${role.seniority}`;
  return scope ? `${base}|scope:${scope.scopeKey}` : base;
}

function nameVariants(canonicalName: string, aliases: readonly string[] = []): string[] {
  const variants = new Set([canonicalName, ...aliases]);
  const withoutParens = canonicalName.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (withoutParens) variants.add(withoutParens);
  return [...variants];
}

async function resolveEntry(entry: {
  canonicalName: string;
  seed: ReturnType<typeof companyByAlias>;
}): Promise<ResolvedCompany | undefined> {
  const { canonicalName, seed } = entry;
  if (seed?.domain) {
    const domainHit = (await identifyCompaniesByDomain([seed.domain])).get(seed.domain);
    if (domainHit) return domainHit;
  }
  const names = nameVariants(canonicalName, seed?.aliases ?? []);
  const nameHits = await identifyCompanies(names);
  for (const name of names) {
    const hit = nameHits.get(name);
    if (hit) return hit;
  }
  if (seed?.linkedinUrl) {
    return (await identifyCompaniesByProfileUrl([seed.linkedinUrl])).get(seed.linkedinUrl);
  }
  return undefined;
}

async function resolveNames(names: readonly string[]): Promise<ResolvedCompany[]> {
  const entries = [...new Map(
    names
      .map((name) => {
        const seed = companyByAlias(name);
        const canonicalName = seed?.canonicalName ?? name.trim();
        return canonicalName ? [normalize(canonicalName), { canonicalName, seed }] as const : null;
      })
      .filter((entry): entry is readonly [string, { canonicalName: string; seed: ReturnType<typeof companyByAlias> }] => entry !== null),
  ).values()];
  const resolved = await Promise.all(entries.map((entry) => resolveEntry(entry)));
  return resolved.filter((match): match is ResolvedCompany => match !== undefined);
}

function companyEmployerFilter(companies: readonly ResolvedCompany[]): CrustdataFilter {
  const ids = companies.map((item) => item.crustdataCompanyId);
  const names = [...new Set(companies.map((item) => item.canonicalName))];
  return {
    op: "or",
    conditions: [
      { field: "experience.employment_details.current.company_id", type: "in", value: ids },
      { field: "experience.employment_details.current.company_name", type: "in", value: names },
    ],
  };
}

export async function resolveCompanyScope(raw: Pick<
  RawParse,
  "company_set_key" | "employer_preset_key" | "company_mentions" | "proposed_companies" | "scope_label" | "startup_employer"
>): Promise<ResolvedCompanyScope | null> {
  const mentions = raw.company_mentions.map((value) => value.trim()).filter(Boolean);

  // Models occasionally echo an acronym as a company mention. Recover the
  // deterministic set instead of sending "MBB" to entity resolution.
  const mentionSet = mentions.length === 1 ? companySetByAlias(mentions[0]) : null;
  if (mentions.length > 0 && !mentionSet) {
    const companies = await resolveNames(mentions);
    if (companies.length !== new Set(mentions.map(normalize)).size) {
      throw new Error("One or more named companies could not be resolved unambiguously");
    }
    return {
      kind: "named",
      scopeKey: `named:${companyHash(companies.map((item) => item.crustdataCompanyId))}`,
      label: companies.map((item) => item.canonicalName).join(", "),
      companies,
      verified: true,
    };
  }

  const set = mentionSet ?? companySetByKey(raw.company_set_key);
  if (set) {
    const companies = await resolveNames(set.companies.map((item) => item.canonicalName));
    if (companies.length !== set.companies.length) {
      throw new Error(`Not every company in ${set.key} could be resolved`);
    }
    return {
      kind: "set",
      scopeKey: `set:${set.key}:r${set.revision}:${companyHash(companies.map((item) => item.crustdataCompanyId))}`,
      setKey: set.key as CompanySetKey,
      label: set.label,
      revision: set.revision,
      asOf: set.asOf,
      description: set.description,
      companies,
      verified: true,
    };
  }

  const presetKey = raw.startup_employer ? "startup" : raw.employer_preset_key;
  const preset = employerPresetByKey(presetKey);
  if (preset) {
    return {
      kind: "structural",
      scopeKey: `preset:${preset.key}:r${preset.revision}`,
      presetKey: preset.key as EmployerPresetKey,
      label: preset.label,
      revision: preset.revision,
      description: preset.description,
      verified: true,
    };
  }

  const proposed = raw.proposed_companies.map((value) => value.trim()).filter(Boolean);
  if (proposed.length > 0) {
    if (!config.inferredCompanySetsEnabled()) throw new Error("Inferred company cohorts are disabled");
    const companies = await resolveNames(proposed);
    const proposedCount = new Set(proposed.map(normalize)).size;
    if (companies.length < 2 || companies.length !== proposedCount) {
      throw new Error("Every inferred company must be verified");
    }
    return {
      kind: "inferred",
      scopeKey: `inferred:${companyHash(companies.map((item) => item.crustdataCompanyId))}`,
      label: raw.scope_label.trim() || "inferred employer group",
      companies,
      verified: true,
      sourceQuery: raw.scope_label.trim(),
    };
  }

  return null;
}

function and(conditions: CrustdataFilter[]): CrustdataFilter {
  return conditions.length === 1 ? conditions[0] : { op: "and", conditions };
}

function widenedSuggestions(role: CanonicalRole, scope: ResolvedCompanyScope | null, raw: string[]): string[] {
  const generic = titleCase(role.title_family);
  const suggestions = [...raw];
  if (scope?.kind === "named") suggestions.unshift(`${generic} at ${scope.label}`);
  if (scope) suggestions.push(generic);
  return [...new Set(suggestions.map((value) => value.trim()).filter(Boolean))].slice(0, 3);
}

export async function parseQuery(rawQuery: string): Promise<ParseResult> {
  const raw = await jsonCall<RawParse>({
    model: config.parseModel(),
    system: SYSTEM,
    user: `Query: ${rawQuery.slice(0, 300)}`,
    schema: PARSE_SCHEMA,
    maxTokens: 4000,
  });

  const invalid = (suggestions = raw.suggestions): ParseResult => ({
    isValidRoleQuery: false,
    suggestions,
    canonicalRole: null,
    roleDescription: "",
    titleVariants: [],
    industryValues: [],
    companyScope: null,
    crustdataFilter: null,
    titleOnlyFilter: null,
  });

  if (!raw.is_valid_role_query || !raw.canonical_role.title_family) return invalid();

  const canonicalRole: CanonicalRole = {
    title_family: normalize(raw.canonical_role.title_family),
    industry_context: normalize(raw.canonical_role.industry_context),
    seniority: normalize(raw.canonical_role.seniority),
  };
  const titleVariants = raw.title_variants.map((value) => value.trim()).filter((value) => value.length > 2).slice(0, 6);
  if (titleVariants.length === 0) return invalid();

  let companyScope: ResolvedCompanyScope | null;
  try {
    companyScope = await resolveCompanyScope(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`resolveCompanyScope failed for "${rawQuery.slice(0, 120)}": ${detail}`);
    return invalid([`Try ${titleCase(canonicalRole.title_family)} at a broader employer group`, titleCase(canonicalRole.title_family)]);
  }
  if (companyScope && !config.companyScopedSearchEnabled()) {
    console.warn("COMPANY_SCOPED_SEARCH_ENABLED is false — blocking employer-scoped search");
    return invalid([titleCase(canonicalRole.title_family)]);
  }

  const baseConditions: CrustdataFilter[] = [
    fuzzyOr("experience.employment_details.current.title", titleVariants),
  ];

  if (companyScope?.kind === "named" || companyScope?.kind === "set" || companyScope?.kind === "inferred") {
    baseConditions.push(companyEmployerFilter(companyScope.companies));
  } else if (companyScope?.kind === "structural") {
    const preset = employerPresetByKey(companyScope.presetKey)!;
    baseConditions.push(...preset.conditions);
  }

  const country = config.pullCountry();
  if (country) baseConditions.push({ field: "basic_profile.location.country", type: "=", value: country });

  const conditions = [...baseConditions];
  const industries = raw.industry_values.map((value) => value.trim()).filter(Boolean).slice(0, 6);
  if (industries.length > 0 && !companyScope) {
    conditions.push({
      field: "experience.employment_details.current.company_professional_network_industry",
      type: "in",
      value: industries,
    });
  }

  const crustdataFilter = and(conditions);
  const titleOnlyFilter = companyScope
    ? null
    : conditions.length === baseConditions.length
      ? crustdataFilter
      : and(baseConditions);
  const roleDescription = companyScope
    ? `${titleCase(canonicalRole.title_family)} at ${companyScope.label}`
    : raw.role_description.trim() || titleCase(canonicalRole.title_family);

  return {
    isValidRoleQuery: true,
    suggestions: widenedSuggestions(canonicalRole, companyScope, raw.suggestions),
    canonicalRole,
    roleDescription,
    titleVariants,
    industryValues: industries,
    companyScope,
    crustdataFilter,
    titleOnlyFilter,
  };
}
