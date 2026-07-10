// Single client wrapper around Crustdata's production REST API (PRD §6.1).
// Everything vendor-specific — endpoint, auth, filter syntax, response shape —
// stays inside this module so the vendor is swappable later.
//
// Verified against the live API (2026-07-06):
//   POST https://api.crustdata.com/person/search
//   headers: authorization: Bearer <key>, x-api-version: 2025-11-01
//   body: { filters, limit } → { profiles, next_cursor, total_count }
//   Billing: ~0.03 credits per result returned.
//
// ⚠️ Filter gotcha (observed live, contradicts Crustdata's own docs example):
// pipe alternation inside one fuzzy condition ("A|B") does NOT act as OR and
// silently collapses matches. Always express title variants as an explicit
// { op: "or" } group of separate (.) conditions.

import { config } from "./config.ts";

const API_URL = "https://api.crustdata.com/person/search";
const COMPANY_IDENTIFY_URL = "https://api.crustdata.com/company/identify";
const API_VERSION = "2025-11-01";
// Single-request page size. The API accepts large limits, so a default 400-cap
// pull normally completes in one request; cursor pagination below is the fallback.
const PAGE_SIZE = 400;

export interface ScalarFilterCondition {
  field: string;
  type: "=" | "!=" | "(.)" | ">" | "<" | ">=" | "<=";
  value: string | number;
}
export interface ListFilterCondition {
  field: string;
  type: "in" | "not_in";
  value: readonly (string | number)[];
}
export type FilterCondition = ScalarFilterCondition | ListFilterCondition;
export interface FilterGroup {
  op: "and" | "or";
  conditions: CrustdataFilter[];
}
export type CrustdataFilter = FilterCondition | FilterGroup;

/** Build an OR-group of fuzzy title matches — the only alternation form that works. */
export function fuzzyOr(field: string, values: string[]): CrustdataFilter {
  if (values.length === 1) return { field, type: "(.)", value: values[0] };
  return {
    op: "or",
    conditions: values.map((value) => ({ field, type: "(.)", value })),
  };
}

// Raw response types — only the fields the pipeline actually consumes.
export interface RawEmployment {
  title: string | null;
  name: string | null; // company name
  start_date: string | null;
  end_date: string | null;
  company_professional_network_industry: string | null;
  company_headcount_range?: string | null;
  company_type?: string | null;
  seniority_level: string | null;
  crustdata_company_id?: number | null;
  company_id?: number | null;
  company_website?: string | null;
  company_website_domain?: string | null;
  company_professional_network_profile_url?: string | null;
}
export interface RawSchool {
  school: string | null;
  degree: string | null;
  field_of_study?: string | null;
  start_year: number | null;
  end_year: number | null;
}
export interface RawProfile {
  crustdata_person_id: number;
  basic_profile: {
    name: string | null;
    current_title: string | null;
    location?: { raw?: string | null } | null;
  };
  social_handles?: {
    professional_network_identifier?: { profile_url?: string | null } | null;
  } | null;
  experience?: {
    employment_details?: {
      current?: RawEmployment[] | null;
      past?: RawEmployment[] | null;
    } | null;
  } | null;
  education?: { schools?: RawSchool[] | null } | null;
}

interface SearchResponse {
  profiles: RawProfile[];
  next_cursor: string | null;
  total_count: number;
}

export interface PullResult {
  profiles: RawProfile[];
  totalMatched: number;
  estimatedCredits: number;
}

async function postSearch(body: object, attempt = 0): Promise<SearchResponse> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.crustdataApiKey()}`,
      "content-type": "application/json",
      "x-api-version": API_VERSION,
    },
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    if (attempt === 0) return null; // retry transient network failure once
    throw err;
  });

  if (res === null || res.status >= 500 || res.status === 429) {
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return postSearch(body, 1);
    }
    throw new Error(`Crustdata request failed with status ${res?.status ?? "network error"}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Crustdata ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as SearchResponse;
}

export interface ResolvedCompany {
  crustdataCompanyId: number;
  canonicalName: string;
  domain: string | null;
  linkedinUrl: string | null;
  confidence: number;
}

interface IdentifyMatch {
  confidence_score?: number;
  company_data?: {
    crustdata_company_id?: number;
    basic_info?: {
      name?: string | null;
      primary_domain?: string | null;
      professional_network_url?: string | null;
    } | null;
  } | null;
}

interface IdentifyResult {
  matched_on?: string;
  matches?: IdentifyMatch[];
}

const identifyCache = new Map<string, ResolvedCompany | null>();

type IdentifyKind = "names" | "domains" | "professional_network_profile_urls";

function identifyCacheKey(kind: IdentifyKind, value: string): string {
  return `${kind}:${value.toLowerCase()}`;
}

function parseCompanyId(data: IdentifyMatch["company_data"]): number | null {
  const raw = data?.crustdata_company_id ?? data?.basic_info?.crustdata_company_id;
  if (raw === null || raw === undefined) return null;
  const id = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(id) ? id : null;
}

function acceptIdentifyMatch(
  kind: IdentifyKind,
  ranked: IdentifyMatch[],
): { id: number; data: NonNullable<IdentifyMatch["company_data"]> } | null {
  const top = ranked[0];
  const confidence = top?.confidence_score ?? 0;
  const margin = confidence - (ranked[1]?.confidence_score ?? 0);
  const data = top?.company_data;
  const id = parseCompanyId(data);
  const minConfidence = kind === "professional_network_profile_urls" ? 0.85 : kind === "domains" ? 0.7 : 0.8;
  const minMargin = kind === "professional_network_profile_urls" ? 0.1 : kind === "domains" ? 0.03 : 0.05;
  if (!id || !data || confidence < minConfidence || (ranked.length > 1 && margin < minMargin)) return null;
  return { id, data };
}

async function requestIdentify(
  kind: IdentifyKind,
  values: readonly string[],
  exactMatch: boolean,
  markUnresolved: boolean,
): Promise<void> {
  if (values.length === 0) return;
  const res = await fetch(COMPANY_IDENTIFY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.crustdataApiKey()}`,
      "content-type": "application/json",
      "x-api-version": API_VERSION,
    },
    body: JSON.stringify({
      [kind]: values,
      fields: ["basic_info"],
      ...(kind === "domains" ? { exact_match: exactMatch } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Crustdata company identify ${res.status}: ${text.slice(0, 500)}`);
  }

  const results = (await res.json()) as IdentifyResult[];
  for (let i = 0; i < values.length; i++) {
    const requested = values[i];
    const key = identifyCacheKey(kind, requested);
    const result =
      results.find((entry) => entry.matched_on?.toLowerCase() === requested.toLowerCase()) ??
      results[i];
    const ranked = [...(result?.matches ?? [])].sort(
      (a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0),
    );
    const accepted = acceptIdentifyMatch(kind, ranked);
    if (accepted) {
      identifyCache.set(key, {
        crustdataCompanyId: accepted.id,
        canonicalName: accepted.data.basic_info?.name?.trim() || requested,
        domain: accepted.data.basic_info?.primary_domain ?? (kind === "domains" ? requested : null),
        linkedinUrl: accepted.data.basic_info?.professional_network_url ?? (kind === "professional_network_profile_urls" ? requested : null),
        confidence: ranked[0]?.confidence_score ?? 0,
      });
    } else if (markUnresolved) {
      identifyCache.set(key, null);
    }
  }
}

async function identify(
  kind: IdentifyKind,
  values: readonly string[],
): Promise<Map<string, ResolvedCompany>> {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const missing = unique.filter((value) => !identifyCache.has(identifyCacheKey(kind, value)));

  if (missing.length > 0) {
    if (kind === "domains") {
      await requestIdentify("domains", missing, true, false);
      const fuzzyRetry = missing.filter((value) => !identifyCache.has(identifyCacheKey("domains", value)));
      if (fuzzyRetry.length > 0) await requestIdentify("domains", fuzzyRetry, false, true);
      for (const value of missing) {
        const key = identifyCacheKey("domains", value);
        if (!identifyCache.has(key)) identifyCache.set(key, null);
      }
    } else {
      await requestIdentify(kind, missing, false, true);
    }
  }

  const resolved = new Map<string, ResolvedCompany>();
  for (const value of unique) {
    const match = identifyCache.get(identifyCacheKey(kind, value));
    if (match) resolved.set(value, match);
  }
  return resolved;
}

/**
 * Resolve names to stable Crustdata company ids. Ambiguous or low-confidence
 * names fail closed rather than becoming fuzzy person-search filters.
 */
export async function identifyCompanies(names: readonly string[]): Promise<Map<string, ResolvedCompany>> {
  return identify("names", names);
}

export async function identifyCompaniesByDomain(domains: readonly string[]): Promise<Map<string, ResolvedCompany>> {
  return identify("domains", domains);
}

export async function identifyCompaniesByProfileUrl(urls: readonly string[]): Promise<Map<string, ResolvedCompany>> {
  return identify("professional_network_profile_urls", urls);
}

/**
 * Bounded people pull: pages through results up to the pull cap (PRD §6.4).
 */
export async function searchPeople(filters: CrustdataFilter, maxResults = config.pullCap()): Promise<PullResult> {
  const profiles: RawProfile[] = [];
  let cursor: string | null = null;
  let totalMatched = 0;

  while (profiles.length < maxResults) {
    const limit = Math.min(PAGE_SIZE, maxResults - profiles.length);
    const body: Record<string, unknown> = { filters, limit };
    if (cursor) body.cursor = cursor;

    const page = await postSearch(body);
    totalMatched = page.total_count;
    // Dedupe by person id — guards against pagination echoing rows back.
    const seen = new Set(profiles.map((p) => p.crustdata_person_id));
    const fresh = page.profiles.filter((p) => !seen.has(p.crustdata_person_id));
    profiles.push(...fresh);
    cursor = page.next_cursor;
    if (!cursor || fresh.length === 0) break;
  }

  return {
    profiles,
    totalMatched,
    estimatedCredits: profiles.length * config.creditsPerResult(),
  };
}
