// Pipeline orchestrator (PRD §6.2):
//   user text → [LLM 1] parse/canonicalize → cache check → Crustdata fetch
//   → cleaning → [LLM 2a/2b] clustering → validation → cache write → render.
//
// Error handling per §6.7: each stage retries once on transient failure; a
// paid Crustdata pull is persisted before clustering so clustering failures
// never re-pay the vendor; failures are logged to pw_pipeline_errors.

import { parseQuery, canonicalKeyOf, type ParseResult } from "./parser.ts";
import { searchPeople } from "./crustdata.ts";
import { cleanProfiles, type CleanProfile } from "./cleaning.ts";
import { clusterProfiles, type Cluster, type ClusteringResult } from "./clustering.ts";
import { config } from "./config.ts";
import * as db from "./db.ts";

export type PipelineStage =
  | "parsing"
  | "cache_check"
  | "fetching"
  | "cleaning"
  | "clustering"
  | "caching";

export type PipelineOutcome =
  | { kind: "invalid_query"; suggestions: string[] }
  | { kind: "thin_data"; suggestions: string[]; usableProfiles: number; canonicalKey: string }
  | {
      kind: "ok";
      canonicalKey: string;
      roleDescription: string;
      clusters: Cluster[];
      stats: ClusteringResult["stats"];
      sampleSize: number;
      cacheHit: boolean;
      latencyMs: number;
    };

export interface PipelineContext {
  sessionToken?: string | null;
  ip?: string | null;
  onStage?: (stage: PipelineStage, detail?: string) => void;
}

async function retryOnce<T>(stage: string, key: string | null, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (firstErr) {
    await db.logPipelineError(stage, key, firstErr instanceof Error ? firstErr.message : String(firstErr));
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await fn();
    } catch (secondErr) {
      await db.logPipelineError(stage, key, `retry failed: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`);
      throw secondErr;
    }
  }
}

export async function runPipeline(rawQuery: string, ctx: PipelineContext = {}): Promise<PipelineOutcome> {
  const t0 = Date.now();
  const stage = ctx.onStage ?? (() => {});
  const logBase = { raw_query: rawQuery, session_token: ctx.sessionToken, ip: ctx.ip };

  // 1. Parse + validate + canonicalize (LLM 1)
  stage("parsing");
  const parsed: ParseResult = await retryOnce("parse", null, () => parseQuery(rawQuery));
  if (!parsed.isValidRoleQuery || !parsed.canonicalRole || !parsed.crustdataFilter) {
    await db.logSearch({ ...logBase, cache_hit: false, outcome: "invalid_query", latency_ms: Date.now() - t0 });
    return { kind: "invalid_query", suggestions: parsed.suggestions };
  }
  const key = canonicalKeyOf(parsed.canonicalRole);

  // 2. Cache check: exact canonical key, then the fuzzy secondary layer (§6.3)
  stage("cache_check", key);
  const cached =
    (await db.getFreshSearch(key)) ??
    (await db.fuzzyFindSearch(parsed.canonicalRole.title_family, parsed.canonicalRole.industry_context));
  if (cached) {
    await db.logSearch({ ...logBase, canonical_key: cached.canonical_key, cache_hit: true, outcome: "ok", latency_ms: Date.now() - t0 });
    return {
      kind: "ok",
      canonicalKey: cached.canonical_key,
      roleDescription: cached.role_description,
      clusters: cached.clusters,
      stats: cached.stats,
      sampleSize: cached.sample_size,
      cacheHit: true,
      latencyMs: Date.now() - t0,
    };
  }

  // 3. Fetch (or reuse a fresh stored pull — never re-pay within the window, §6.4)
  let profiles: CleanProfile[];
  let pullId: string;
  const existingPull = await db.getFreshPull(key);
  if (existingPull) {
    stage("fetching", "reusing stored pull");
    profiles = existingPull.profiles;
    pullId = existingPull.id;
  } else {
    stage("fetching");
    const pull = await retryOnce("fetch", key, () => searchPeople(parsed.crustdataFilter!));
    await db.addSpend(pull.estimatedCredits);

    stage("cleaning");
    const cleaned = cleanProfiles(pull.profiles);
    profiles = cleaned.profiles;
    // Persist the cleaned pull BEFORE clustering (§6.4/§6.7): if clustering
    // fails downstream we retry from this row, never from a fresh paid pull.
    pullId = await retryOnce("cache_write", key, () =>
      db.insertPull({
        canonical_key: key,
        role_description: parsed.roleDescription,
        crustdata_filter: parsed.crustdataFilter!,
        profiles,
        total_matched: pull.totalMatched,
        estimated_credits: pull.estimatedCredits,
      }),
    );
  }

  // 4. Thin-data gate (§5.6)
  if (profiles.length < config.minUsableProfiles()) {
    await db.logSearch({ ...logBase, canonical_key: key, cache_hit: false, outcome: "thin_data", latency_ms: Date.now() - t0 });
    return { kind: "thin_data", suggestions: parsed.suggestions, usableProfiles: profiles.length, canonicalKey: key };
  }

  // 5. Two-pass clustering + validation (LLM 2a/2b, §6.5)
  stage("clustering", `${profiles.length} profiles`);
  const result = await retryOnce("cluster", key, () =>
    clusterProfiles(parsed.roleDescription, profiles, (m) => stage("clustering", m)),
  );

  // 6. Cache write
  stage("caching");
  await retryOnce("cache_write", key, () =>
    db.upsertSearch({
      canonical_key: key,
      title_family: parsed.canonicalRole!.title_family,
      industry_context: parsed.canonicalRole!.industry_context,
      seniority: parsed.canonicalRole!.seniority,
      role_description: parsed.roleDescription,
      pull_id: pullId,
      clusters: result.clusters,
      stats: result.stats,
      sample_size: result.stats.relevant,
    }),
  );

  const latencyMs = Date.now() - t0;
  await db.logSearch({ ...logBase, canonical_key: key, cache_hit: false, outcome: "ok", latency_ms: latencyMs });
  return {
    kind: "ok",
    canonicalKey: key,
    roleDescription: parsed.roleDescription,
    clusters: result.clusters,
    stats: result.stats,
    sampleSize: result.stats.relevant,
    cacheHit: false,
    latencyMs,
  };
}
