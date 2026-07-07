// Phase 2 test harness: run the full generalized pipeline for a free-text
// query. Usage: npm run role -- "private equity associate"

import { runPipeline } from "../lib/pipeline.ts";
import type { CleanProfile } from "../lib/cleaning.ts";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: npm run role -- "<free-text role query>"');
  process.exit(1);
}

function fmtPerson(p: CleanProfile): string {
  const edu = p.education[0]?.school ?? "no education listed";
  return `      • ${p.name} — ${p.currentTitle} @ ${p.currentCompany} (${edu}${p.yearsExperience !== null ? `, ~${p.yearsExperience}y` : ""})`;
}

const result = await runPipeline(query, {
  sessionToken: "dev-cli",
  skipLimits: process.env.ENFORCE_LIMITS !== "1", // CLI skips limits unless testing them
  onStage: (stage, detail) => console.log(`  [${stage}]${detail ? ` ${detail}` : ""}`),
});

if (result.kind === "invalid_query") {
  console.log(`\nNot a role query. Suggestions: ${result.suggestions.join(" · ")}`);
} else if (result.kind === "rate_limited") {
  console.log(`\nRATE LIMITED (${result.scope}). Cached roles: ${result.availableRoles.map((r) => r.role_description).join(" · ")}`);
} else if (result.kind === "degraded") {
  console.log(`\nDEGRADED (${result.reason}) — cached-only mode. Cached roles: ${result.availableRoles.map((r) => r.role_description).join(" · ")}`);
} else if (result.kind === "error") {
  console.log(`\nERROR state. Cached roles offered: ${result.availableRoles.map((r) => r.role_description).join(" · ")}`);
} else if (result.kind === "thin_data") {
  console.log(
    `\nTHIN DATA (${result.usableProfiles} usable profiles) for ${result.canonicalKey}. Broader queries: ${result.suggestions.join(" · ")}`,
  );
} else {
  console.log("\n" + "=".repeat(80));
  console.log(`PATHWAYS — ${result.roleDescription}`);
  console.log(
    `key: ${result.canonicalKey} · ${result.cacheHit ? "CACHE HIT" : "cache miss"} · ${(result.latencyMs / 1000).toFixed(1)}s · based on ${result.sampleSize} professionals`,
  );
  console.log("=".repeat(80));
  for (const c of result.clusters) {
    console.log(`\n▌ ${c.archetype.label} — ${c.percentage}% (${c.members.length} people)`);
    console.log(`  ${c.archetype.description}`);
    for (const p of c.members.slice(0, 3)) console.log(fmtPerson(p));
  }
  console.log(
    `\nStats: ${JSON.stringify(result.stats)}`,
  );
}
