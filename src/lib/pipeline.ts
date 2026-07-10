// Pipeline orchestrator (PRD §6.2) with cost/abuse protection (§6.6) and
// error handling (§6.7):
//   user text → rate gates → [LLM 1] parse/canonicalize → cache check
//   → miss gates (session/IP caps, spend ceiling) → Crustdata fetch
//   → cleaning → [LLM 2a/2b] clustering → validation → cache write.
//
// Protection is session-token-first, NOT IP-first: the target users are
// students behind shared campus IPs, so the IP cap is a generous backstop
// against cookie-clearing abuse only. The true safety net is the global
// daily credit ceiling, which degrades to cached-only mode — never a hard
// error, never silent overspend.

import {
  parseQuery,
  canonicalKeyOf,
  companyScopeKey,
  type ParseResult,
  type ResolvedCompanyScope,
} from "./parser.ts";
import { searchPeople } from "./crustdata.ts";
import { cleanProfiles, type CleanProfile } from "./cleaning.ts";
import {
  clusterProfiles,
  clusteringOptionsForSample,
  type Cluster,
  type ClusteringResult,
} from "./clustering.ts";
import { config } from "./config.ts";
import * as db from "./db.ts";

export type PipelineStage = "parsing" | "cache_check" | "fetching" | "cleaning" | "clustering" | "caching";

export interface CachedRoleChip {
  canonical_key: string;
  role_description: string;
}

export type PipelineOutcome =
  | { kind: "invalid_query"; suggestions: string[] }
  | { kind: "rate_limited"; scope: "session" | "ip"; availableRoles: CachedRoleChip[] }
  | { kind: "degraded"; reason: "spend_ceiling" | "vendor_down"; availableRoles: CachedRoleChip[] }
  | { kind: "error"; availableRoles: CachedRoleChip[] }
  | {
      kind: "thin_data";
      suggestions: string[];
      usableProfiles: number;
      canonicalKey: string;
      companyScopeLabel: string | null;
    }
  | {
      kind: "ok";
      canonicalKey: string;
      roleDescription: string;
      clusters: Cluster[];
      stats: ClusteringResult["stats"];
      sampleSize: number;
      cacheHit: boolean;
      latencyMs: number;
      companyScope: ResolvedCompanyScope | null;
      sampleQuality: "standard" | "small";
    };

export interface PipelineContext {
  sessionToken?: string | null;
  ip?: string | null;
  /** Disable rate/spend gates (internal seeding scripts only). */
  skipLimits?: boolean;
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

async function safeCachedRoles(): Promise<CachedRoleChip[]> {
  try {
    return await db.listCachedRoles();
  } catch {
    return [];
  }
}

export async function runPipeline(rawQuery: string, ctx: PipelineContext = {}): Promise<PipelineOutcome> {
  const t0 = Date.now();
  const stage = ctx.onStage ?? (() => {});
  const enforce = !ctx.skipLimits;
  const elapsed = () => Date.now() - t0;

  // Gate 0 — loose per-session total cap (bot protection; cache hits are
  // cheap but not free). Checked before any LLM spend.
  if (enforce && ctx.sessionToken) {
    const total = await db.countSessionSearches(ctx.sessionToken);
    if (total >= config.sessionTotalPerHour()) {
      await db.logSearch({
        raw_query: rawQuery, cache_hit: false, outcome: "rate_limited",
        session_token: ctx.sessionToken, ip: ctx.ip, latency_ms: elapsed(),
      });
      return { kind: "rate_limited", scope: "session", availableRoles: await safeCachedRoles() };
    }
  }

  // Open the two-phase log row: in-flight requests count toward limits.
  const logId = await db.startSearchLog({ raw_query: rawQuery, session_token: ctx.sessionToken, ip: ctx.ip });
  const finish = (patch: Parameters<typeof db.updateSearchLog>[1]) =>
    db.updateSearchLog(logId, { latency_ms: elapsed(), ...patch });

  try {
    // 1. Parse + validate + canonicalize (LLM 1)
    stage("parsing");
    const parsed: ParseResult = await retryOnce("parse", null, () => parseQuery(rawQuery));
    if (!parsed.isValidRoleQuery || !parsed.canonicalRole || !parsed.crustdataFilter) {
      await finish({ outcome: "invalid_query" });
      return { kind: "invalid_query", suggestions: parsed.suggestions };
    }
    const scopeKey = companyScopeKey(parsed.companyScope);
    const key = canonicalKeyOf(parsed.canonicalRole, parsed.companyScope);

    // 2. Cache check: exact canonical key, then the fuzzy secondary layer (§6.3)
    stage("cache_check", key);
    const cached =
      (await db.getFreshSearch(key)) ??
      (await db.fuzzyFindSearch(
        parsed.canonicalRole.title_family,
        parsed.canonicalRole.industry_context,
        scopeKey,
      ));
    if (cached) {
      await finish({ canonical_key: cached.canonical_key, cache_hit: true, outcome: "ok" });
      return {
        kind: "ok",
        canonicalKey: cached.canonical_key,
        roleDescription: cached.role_description,
        clusters: cached.clusters,
        stats: cached.stats,
        sampleSize: cached.sample_size,
        cacheHit: true,
        latencyMs: elapsed(),
        companyScope: cached.company_scope,
        sampleQuality: cached.sample_quality,
      };
    }

    // CACHE MISS — the expensive path. Gates before any paid work (§6.6).
    if (enforce && ctx.sessionToken) {
      const misses = await db.countSessionMisses(ctx.sessionToken);
      if (misses >= config.sessionMissPerHour()) {
        await finish({ canonical_key: key, outcome: "rate_limited" });
        return { kind: "rate_limited", scope: "session", availableRoles: await safeCachedRoles() };
      }
    }
    if (enforce && ctx.ip) {
      const ipMisses = await db.countIpMisses(ctx.ip);
      if (ipMisses >= config.ipMissPerHour()) {
        await finish({ canonical_key: key, outcome: "rate_limited" });
        return { kind: "rate_limited", scope: "ip", availableRoles: await safeCachedRoles() };
      }
    }
    await db.updateSearchLog(logId, { canonical_key: key, outcome: "miss_in_progress" });

    // 3. Fetch — reuse a fresh stored pull if one exists (never re-pay, §6.4);
    // the spend ceiling only gates an actual paid Crustdata call.
    let profiles: CleanProfile[];
    let pullId: string;
    const existingPull = await db.getFreshPull(key);
    if (existingPull) {
      stage("fetching", "reusing stored pull");
      profiles = existingPull.profiles;
      pullId = existingPull.id;
    } else {
      // Global daily credit ceiling (§6.6): project the worst-case cost of
      // this pull; at the ceiling, degrade to cached-only — never overspend.
      if (enforce) {
        const spend = await db.getTodaySpend();
        const worstCase = config.pullCap() * config.creditsPerResult();
        if (spend + worstCase > config.dailyCreditCeiling()) {
          await finish({ canonical_key: key, outcome: "degraded" });
          return { kind: "degraded", reason: "spend_ceiling", availableRoles: await safeCachedRoles() };
        }
      }

      stage("fetching");
      let pull;
      try {
        pull = await retryOnce("fetch", key, () => searchPeople(parsed.crustdataFilter!));
        // Fail-open: an industry-constrained pull that matches almost nothing
        // usually means the industry name isn't in the vendor's taxonomy —
        // retry on titles alone rather than showing a false thin-data state.
        // (A near-empty pull costs ~nothing, so this stays within budget.)
        if (
          pull.profiles.length < config.minUsableProfiles() &&
          parsed.titleOnlyFilter &&
          parsed.titleOnlyFilter !== parsed.crustdataFilter
        ) {
          stage("fetching", "broadening: industry filter matched too few");
          const broadPull = await retryOnce("fetch", key, () => searchPeople(parsed.titleOnlyFilter!));
          if (broadPull.profiles.length > pull.profiles.length) {
            await db.addSpend(pull.estimatedCredits);
            pull = broadPull;
          }
        }
      } catch {
        // Crustdata down/unresponsive → cached-only mode, same UX as the
        // spend-ceiling degrade (§6.7). Never a blank error screen.
        await finish({ canonical_key: key, outcome: "degraded" });
        return { kind: "degraded", reason: "vendor_down", availableRoles: await safeCachedRoles() };
      }
      await db.addSpend(pull.estimatedCredits);

      stage("cleaning");
      const cleaned = cleanProfiles(pull.profiles, {
        companyScope: parsed.companyScope,
        titleVariants: parsed.titleVariants,
      });
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
    const minimumProfiles = 12;
    if (profiles.length < minimumProfiles) {
      await finish({ canonical_key: key, outcome: "thin_data" });
      return {
        kind: "thin_data",
        suggestions: parsed.suggestions,
        usableProfiles: profiles.length,
        canonicalKey: key,
        companyScopeLabel: parsed.companyScope?.label ?? null,
      };
    }

    // 5. Two-pass clustering + validation (LLM 2a/2b, §6.5)
    stage("clustering", `${profiles.length} profiles`);
    const result = await retryOnce("cluster", key, () =>
      clusterProfiles(
        parsed.roleDescription,
        profiles,
        (m) => stage("clustering", m),
        clusteringOptionsForSample(profiles.length, minimumProfiles),
      ),
    );

    // Thin-data gate again AFTER relevance filtering (§8: a clear "not enough
    // data" state always beats a low-confidence forced output). A pull can be
    // large but mostly vendor false positives — never cache that as a result.
    const finalClusteringOptions = clusteringOptionsForSample(result.stats.relevant, minimumProfiles);
    const invalidFinalBucket =
      result.clusters.length < (finalClusteringOptions.minArchetypes ?? 2) ||
      result.clusters.length > (finalClusteringOptions.maxArchetypes ?? 6);
    if (result.stats.relevant < minimumProfiles || result.clusters.length < 2 || invalidFinalBucket) {
      await finish({ canonical_key: key, outcome: "thin_data" });
      return {
        kind: "thin_data",
        suggestions: parsed.suggestions,
        usableProfiles: result.stats.relevant,
        canonicalKey: key,
        companyScopeLabel: parsed.companyScope?.label ?? null,
      };
    }

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
        target_kind: "current_role",
        company_scope_key: scopeKey,
        company_scope: parsed.companyScope,
        sample_quality: result.stats.relevant < 30 ? "small" : "standard",
        pull_country: config.pullCountry() || null,
      }),
    );

    await finish({ canonical_key: key, outcome: "ok" });
    return {
      kind: "ok",
      canonicalKey: key,
      roleDescription: parsed.roleDescription,
      clusters: result.clusters,
      stats: result.stats,
      sampleSize: result.stats.relevant,
      cacheHit: false,
      latencyMs: elapsed(),
      companyScope: parsed.companyScope,
      sampleQuality: result.stats.relevant < 30 ? "small" : "standard",
    };
  } catch (err) {
    // Total pipeline failure (§6.7): honest error state; any paid pull was
    // already persisted, so a later retry starts from stored data for free.
    await db.logPipelineError("pipeline", null, err instanceof Error ? err.message : String(err));
    await finish({ outcome: "error" });
    return { kind: "error", availableRoles: await safeCachedRoles() };
  }
}
