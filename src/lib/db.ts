// Supabase Postgres access (service-role key, server-side only).
// The database is a cache and ledger, not a warehouse (PRD §6.1).

import { createClient } from "@supabase/supabase-js";
import type { Cluster, ClusteringResult } from "./clustering.ts";
import type { CleanProfile } from "./cleaning.ts";
import type { CrustdataFilter } from "./crustdata.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY"), {
  auth: { persistSession: false },
});

function freshnessCutoff(): string {
  const days = Number(process.env.CACHE_FRESHNESS_DAYS ?? "30");
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
}

export async function getFreshSearch(canonicalKey: string): Promise<CachedSearch | null> {
  const { data, error } = await supabase
    .from("pw_cached_searches")
    .select("*")
    .eq("canonical_key", canonicalKey)
    .gte("refreshed_at", freshnessCutoff())
    .maybeSingle();
  if (error) throw new Error(`getFreshSearch: ${error.message}`);
  return data as CachedSearch | null;
}

/**
 * Secondary fuzzy layer (PRD §6.3): before declaring a miss, look for a fresh
 * cached key whose title_family + industry_context match exactly even though
 * seniority differs. Deliberately simple — no embedding lookup in v1.
 */
export async function fuzzyFindSearch(titleFamily: string, industryContext: string): Promise<CachedSearch | null> {
  const { data, error } = await supabase
    .from("pw_cached_searches")
    .select("*")
    .eq("title_family", titleFamily)
    .eq("industry_context", industryContext)
    .gte("refreshed_at", freshnessCutoff())
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`fuzzyFindSearch: ${error.message}`);
  return data as CachedSearch | null;
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

export interface SearchLogEntry {
  raw_query: string;
  canonical_key?: string | null;
  cache_hit: boolean;
  outcome: "ok" | "thin_data" | "invalid_query" | "degraded" | "error" | "rate_limited";
  session_token?: string | null;
  ip?: string | null;
  latency_ms?: number;
}

export async function logSearch(entry: SearchLogEntry): Promise<void> {
  const { error } = await supabase.from("pw_search_log").insert(entry);
  if (error) console.error(`logSearch failed: ${error.message}`); // never fail a request over logging
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
