// Supabase Postgres access (service-role key, server-side only).
// The database is a cache and ledger, not a warehouse (PRD §6.1).

import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import type { Cluster, ClusteringResult } from "./clustering.ts";
import type { CleanProfile } from "./cleaning.ts";
import type { CrustdataFilter } from "./crustdata.ts";
import type { ResolvedCompanyScope, ParseResult } from "./parser.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY"), {
  auth: { persistSession: false },
});

function freshnessCutoff(): string {
  return new Date(Date.now() - config.cacheFreshnessDays() * 24 * 60 * 60 * 1000).toISOString();
}

function oneHourAgo(): string {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

// ---------- cached_searches ----------

export interface CachedSearch {
  canonical_key: string;
  title_family: string;
  industry_context: string;
  seniority: string;
  role_description: string;
  pull_id: string | null;
  clusters: Cluster[];
  stats: ClusteringResult["stats"];
  sample_size: number;
  refreshed_at: string;
  target_kind: "current_role";
  company_scope_key: string | null;
  company_scope: ResolvedCompanyScope | null;
  sample_quality: "standard" | "small";
  pull_country: string | null;
}

function normalizeCachedSearch(row: Partial<CachedSearch> | null): CachedSearch | null {
  if (!row) return null;
  return {
    ...row,
    target_kind: row.target_kind ?? "current_role",
    company_scope_key: row.company_scope_key ?? null,
    company_scope: row.company_scope ?? null,
    sample_quality: row.sample_quality ?? "standard",
    pull_country: row.pull_country ?? null,
  } as CachedSearch;
}

export async function getFreshSearch(canonicalKey: string): Promise<CachedSearch | null> {
  const { data, error } = await supabase
    .from("pw_cached_searches")
    .select("*")
    .eq("canonical_key", canonicalKey)
    .gte("refreshed_at", freshnessCutoff())
    .maybeSingle();
  if (error) throw new Error(`getFreshSearch: ${error.message}`);
  return normalizeCachedSearch(data as Partial<CachedSearch> | null);
}

/**
 * Secondary fuzzy layer (PRD §6.3): before declaring a miss, look for a fresh
 * cached key whose title_family + industry_context match exactly even though
 * seniority differs. Deliberately simple — no embedding lookup in v1.
 */
export async function fuzzyFindSearch(
  titleFamily: string,
  industryContext: string,
  companyScopeKey: string | null,
): Promise<CachedSearch | null> {
  let query = supabase
    .from("pw_cached_searches")
    .select("*")
    .eq("target_kind", "current_role")
    .eq("title_family", titleFamily)
    .eq("industry_context", industryContext)
    .gte("refreshed_at", freshnessCutoff())
    .order("refreshed_at", { ascending: false })
    .limit(1)
  query = companyScopeKey === null
    ? query.is("company_scope_key", null)
    : query.eq("company_scope_key", companyScopeKey);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`fuzzyFindSearch: ${error.message}`);
  return normalizeCachedSearch(data as Partial<CachedSearch> | null);
}

export async function upsertSearch(row: Omit<CachedSearch, "refreshed_at">): Promise<void> {
  const { error } = await supabase
    .from("pw_cached_searches")
    .upsert({ ...row, refreshed_at: new Date().toISOString() });
  if (error) throw new Error(`upsertSearch: ${error.message}`);
}

// ---------- cached_pulls ----------

export interface CachedPull {
  id: string;
  canonical_key: string;
  profiles: CleanProfile[];
  profile_count: number;
  total_matched: number | null;
  estimated_credits: number;
  created_at: string;
}

export async function getFreshPull(canonicalKey: string): Promise<CachedPull | null> {
  const { data, error } = await supabase
    .from("pw_cached_pulls")
    .select("*")
    .eq("canonical_key", canonicalKey)
    .gte("created_at", freshnessCutoff())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getFreshPull: ${error.message}`);
  return data as CachedPull | null;
}

export async function insertPull(row: {
  canonical_key: string;
  role_description: string;
  crustdata_filter: CrustdataFilter;
  profiles: CleanProfile[];
  total_matched: number;
  estimated_credits: number;
}): Promise<string> {
  const { data, error } = await supabase
    .from("pw_cached_pulls")
    .insert({ ...row, profile_count: row.profiles.length })
    .select("id")
    .single();
  if (error) throw new Error(`insertPull: ${error.message}`);
  return (data as { id: string }).id;
}

// ---------- ledger + logs ----------

export async function addSpend(credits: number): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.rpc("pw_add_spend", { p_day: day, p_credits: credits });
  if (error) throw new Error(`addSpend: ${error.message}`);
}

export async function getTodaySpend(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from("pw_daily_spend").select("credits").eq("day", day).maybeSingle();
  if (error) throw new Error(`getTodaySpend: ${error.message}`);
  return data ? Number((data as { credits: number }).credits) : 0;
}

export type SearchOutcome =
  | "in_progress"       // request started, hit/miss not yet known
  | "miss_in_progress"  // cache miss confirmed, paid work underway
  | "ok"
  | "thin_data"
  | "invalid_query"
  | "degraded"
  | "error"
  | "rate_limited";

export interface SearchLogEntry {
  raw_query: string;
  canonical_key?: string | null;
  cache_hit: boolean;
  outcome: SearchOutcome;
  session_token?: string | null;
  ip?: string | null;
  latency_ms?: number;
}

export async function logSearch(entry: SearchLogEntry): Promise<void> {
  const { error } = await supabase.from("pw_search_log").insert(entry);
  if (error) console.error(`logSearch failed: ${error.message}`); // never fail a request over logging
}

/**
 * Two-phase logging: a row is written when the request starts (and updated to
 * miss_in_progress when a paid path begins) so that in-flight requests count
 * toward rate limits — a burst of concurrent misses can't slip under the cap
 * during the ~40s a cache miss takes to complete.
 */
export async function startSearchLog(entry: Pick<SearchLogEntry, "raw_query" | "session_token" | "ip">): Promise<number | null> {
  const { data, error } = await supabase
    .from("pw_search_log")
    .insert({ ...entry, cache_hit: false, outcome: "in_progress" })
    .select("id")
    .single();
  if (error) {
    console.error(`startSearchLog failed: ${error.message}`);
    return null; // logging must never take the product down
  }
  return (data as { id: number }).id;
}

export async function updateSearchLog(
  id: number | null,
  patch: Partial<Pick<SearchLogEntry, "canonical_key" | "cache_hit" | "outcome" | "latency_ms">>,
): Promise<void> {
  if (id === null) return;
  const { error } = await supabase.from("pw_search_log").update(patch).eq("id", id);
  if (error) console.error(`updateSearchLog failed: ${error.message}`);
}

// Outcomes that represent (actual or in-flight) paid cache-miss work.
const MISS_OUTCOMES = ["miss_in_progress", "ok", "thin_data", "error"];

export async function countSessionSearches(sessionToken: string): Promise<number> {
  const { count, error } = await supabase
    .from("pw_search_log")
    .select("id", { count: "exact", head: true })
    .eq("session_token", sessionToken)
    .gte("created_at", oneHourAgo());
  if (error) throw new Error(`countSessionSearches: ${error.message}`);
  return count ?? 0;
}

export async function countSessionMisses(sessionToken: string): Promise<number> {
  const { count, error } = await supabase
    .from("pw_search_log")
    .select("id", { count: "exact", head: true })
    .eq("session_token", sessionToken)
    .eq("cache_hit", false)
    .in("outcome", MISS_OUTCOMES)
    .gte("created_at", oneHourAgo());
  if (error) throw new Error(`countSessionMisses: ${error.message}`);
  return count ?? 0;
}

export async function countIpMisses(ip: string): Promise<number> {
  const { count, error } = await supabase
    .from("pw_search_log")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .eq("cache_hit", false)
    .in("outcome", MISS_OUTCOMES)
    .gte("created_at", oneHourAgo());
  if (error) throw new Error(`countIpMisses: ${error.message}`);
  return count ?? 0;
}

/** Previously analyzed roles — the escape hatch shown in degraded/error states. */
export async function listCachedRoles(limit = 8): Promise<{ canonical_key: string; role_description: string }[]> {
  const { data, error } = await supabase
    .from("pw_cached_searches")
    .select("canonical_key, role_description")
    .gte("refreshed_at", freshnessCutoff())
    .order("refreshed_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listCachedRoles: ${error.message}`);
  return (data ?? []) as { canonical_key: string; role_description: string }[];
}

export async function logPipelineError(stage: string, canonicalKey: string | null, message: string): Promise<void> {
  const { error } = await supabase
    .from("pw_pipeline_errors")
    .insert({ stage, canonical_key: canonicalKey, message: message.slice(0, 2000) });
  if (error) console.error(`logPipelineError failed: ${error.message}`);
}

export async function insertFeedback(row: {
  canonical_key: string;
  cluster_label: string;
  thumbs_up: boolean;
  comment?: string | null;
  session_token?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("pw_feedback").insert(row);
  if (error) throw new Error(`insertFeedback: ${error.message}`);
}

/**
 * Attach a comment to this session's most recent thumb on a cluster (the
 * widget stores the thumb instantly, then lets the user add one line).
 */
export async function amendFeedbackComment(row: {
  canonical_key: string;
  cluster_label: string;
  session_token: string;
  comment: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("pw_feedback")
    .select("id")
    .eq("canonical_key", row.canonical_key)
    .eq("cluster_label", row.cluster_label)
    .eq("session_token", row.session_token)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`amendFeedbackComment: ${error.message}`);
  if (!data) return false;
  const { error: updateError } = await supabase
    .from("pw_feedback")
    .update({ comment: row.comment })
    .eq("id", (data as { id: number }).id);
  if (updateError) throw new Error(`amendFeedbackComment: ${updateError.message}`);
  return true;
}

// ---------- parse_memo ----------

export async function getParseMemo(normalizedQuery: string, parserVersion: string): Promise<ParseResult | null> {
  const { data, error } = await supabase
    .from("pw_parse_memo")
    .select("parse_result")
    .eq("normalized_query", normalizedQuery)
    .eq("parser_version", parserVersion)
    .gte("created_at", freshnessCutoff())
    .maybeSingle();
  if (error) console.warn(`getParseMemo failed for "${normalizedQuery}": ${error.message}`);
  return data ? (data.parse_result as ParseResult) : null;
}

export async function putParseMemo(
  normalizedQuery: string,
  parserVersion: string,
  parseResult: ParseResult,
): Promise<void> {
  const { error } = await supabase.from("pw_parse_memo").upsert(
    {
      normalized_query: normalizedQuery,
      parser_version: parserVersion,
      parse_result: parseResult,
      created_at: new Date().toISOString(),
    },
    { onConflict: "normalized_query,parser_version" },
  );
  if (error) console.warn(`putParseMemo failed for "${normalizedQuery}": ${error.message}`);
}
