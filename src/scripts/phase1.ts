// Phase 1: one hardcoded role, end to end (no UI, no DB, no rate limiting).
// Role: "Chief Data Officer at a professional sports team" (seed list #3).
//
// Pipeline: Crustdata pull → cleaning → 2a archetype derivation →
// 2b batched classification → code-side validation → console report.
//
// The raw pull is cached to data/pulls/*.json so prompt iteration never
// re-pays Crustdata (same principle as the cached_pulls table in Phase 2).

import fs from "node:fs";
import path from "node:path";
import { fuzzyOr, searchPeople, type CrustdataFilter, type PullResult } from "../lib/crustdata.ts";
import { cleanProfiles, type CleanProfile } from "../lib/cleaning.ts";
import { clusterProfiles } from "../lib/clustering.ts";
import { config } from "../lib/config.ts";

const ROLE_DESCRIPTION = "Chief Data Officer / Head of Data at a professional sports team or league";

// In Phase 2 this filter comes from LLM Call 1; hardcoded here.
const FILTER: CrustdataFilter = {
  op: "and",
  conditions: [
    fuzzyOr("experience.employment_details.current.title", [
      "Chief Data Officer",
      "Head of Data",
      "Chief Data and Analytics Officer",
      "VP of Data",
      "SVP of Data",
    ]),
    fuzzyOr("experience.employment_details.current.company_professional_network_industry", [
      "Spectator Sports",
      "Sports Teams and Clubs",
      "Sports and Recreation",
    ]),
  ],
};

const PULL_CACHE = path.join(import.meta.dirname, "../../data/pulls/phase1-cdo-sports.json");

async function getPull(): Promise<PullResult> {
  if (fs.existsSync(PULL_CACHE)) {
    console.log(`Using cached pull: ${PULL_CACHE}`);
    return JSON.parse(fs.readFileSync(PULL_CACHE, "utf8")) as PullResult;
  }
  console.log(`Fetching up to ${config.pullCap()} profiles from Crustdata…`);
  const t0 = Date.now();
  const pull = await searchPeople(FILTER);
  console.log(
    `Fetched ${pull.profiles.length} of ${pull.totalMatched} matches in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(~${pull.estimatedCredits.toFixed(1)} credits)`,
  );
  fs.mkdirSync(path.dirname(PULL_CACHE), { recursive: true });
  fs.writeFileSync(PULL_CACHE, JSON.stringify(pull));
  return pull;
}

function fmtPerson(p: CleanProfile): string {
  const edu = p.education[0]?.school ?? "no education listed";
  return `      • ${p.name} — ${p.currentTitle} @ ${p.currentCompany} (${edu}${p.yearsExperience !== null ? `, ~${p.yearsExperience}y` : ""})`;
}

async function main() {
  const tStart = Date.now();
  const pull = await getPull();

  const { profiles, stats: cleanStats } = cleanProfiles(pull.profiles);
  console.log(
    `\nCleaning: ${cleanStats.input} in → ${cleanStats.kept} usable ` +
      `(dropped: ${cleanStats.droppedNoHistory} no current role, ${cleanStats.droppedThinHistory} thin history, ${cleanStats.droppedNoIdentity} no name)`,
  );

  if (profiles.length < config.minUsableProfiles()) {
    console.log(`\nTHIN-DATA STATE: only ${profiles.length} usable profiles (< ${config.minUsableProfiles()}).`);
    return;
  }

  const tCluster = Date.now();
  const result = await clusterProfiles(ROLE_DESCRIPTION, profiles, (m) => console.log(`  ${m}`));
  const clusterSecs = ((Date.now() - tCluster) / 1000).toFixed(1);

  console.log("\n" + "=".repeat(80));
  console.log(`PATHWAYS — ${ROLE_DESCRIPTION}`);
  console.log(`Based on ${result.stats.relevant} professionals we analyzed (of ${result.stats.classified} classified)`);
  console.log("=".repeat(80));

  for (const cluster of result.clusters) {
    console.log(`\n▌ ${cluster.archetype.label} — ${cluster.percentage}% (${cluster.members.length} people)`);
    console.log(`  ${cluster.archetype.description}`);
    console.log(`  Signals: ${cluster.archetype.signals.join("; ")}`);
    console.log(`  Examples:`);
    for (const p of cluster.members.slice(0, 3)) console.log(fmtPerson(p));
  }

  console.log("\n" + "-".repeat(80));
  console.log("VALIDATION SUMMARY");
  console.log(`  Pull: ${pull.profiles.length} profiles (~${pull.estimatedCredits.toFixed(1)} Crustdata credits)`);
  console.log(`  Cleaned: ${profiles.length} usable`);
  console.log(
    `  Classified: ${result.stats.classified} across ${result.stats.batches} batches ` +
      `(${result.stats.batchRetries} retries, ${result.stats.dropped} dropped after failed retry)`,
  );
  console.log(`  not_relevant bucket: ${result.stats.notRelevant} profiles excluded`);
  const accounted = result.stats.classified + result.stats.dropped;
  console.log(
    `  Accounting check: ${accounted}/${profiles.length} profiles accounted for ${accounted === profiles.length ? "✓" : "✗ MISMATCH"}`,
  );
  console.log(`  Cluster percentages sum: ${result.clusters.reduce((n, c) => n + c.percentage, 0)}% (rounding)`);
  console.log(`  Clustering time: ${clusterSecs}s · total pipeline: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  if (result.stats.notRelevant > 0) {
    console.log(`\n  Sample of not_relevant exclusions (false-positive check):`);
    for (const p of result.notRelevant.slice(0, 5)) console.log(fmtPerson(p));
  }
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
