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
const API_VERSION = "2025-11-01";
// Single-request page size. The API accepts large limits, so a default 400-cap
// pull normally completes in one request; cursor pagination below is the fallback.
const PAGE_SIZE = 400;

export interface FilterCondition {
  field: string;
  type: string; // "=", "(.)", ">", "!=", ...
  value: string | number;
}
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
  seniority_level: string | null;
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
