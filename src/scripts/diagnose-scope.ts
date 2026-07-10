// Quick scope diagnostics. Usage:
//   node --env-file=.env src/scripts/diagnose-scope.ts "consultant at MBB"

import { parseQuery } from "../lib/parser.ts";
import { identifyCompanies, identifyCompaniesByDomain, searchPeople } from "../lib/crustdata.ts";
import { cleanProfiles } from "../lib/cleaning.ts";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: node --env-file=.env src/scripts/diagnose-scope.ts "<query>"');
  process.exit(1);
}

console.log(`Query: ${query}\n`);

try {
  const parsed = await parseQuery(query);
  console.log("parse.isValidRoleQuery:", parsed.isValidRoleQuery);
  console.log("parse.roleDescription:", parsed.roleDescription);
  console.log("parse.companyScope:", parsed.companyScope?.kind ?? null, parsed.companyScope?.label ?? "");
  console.log("parse.filter:", JSON.stringify(parsed.crustdataFilter, null, 2));

  if (!parsed.isValidRoleQuery || !parsed.crustdataFilter) {
    console.log("suggestions:", parsed.suggestions);
    process.exit(1);
  }

  if (parsed.companyScope && "companies" in parsed.companyScope) {
    for (const c of parsed.companyScope.companies) {
      console.log(`  resolved: ${c.canonicalName} → id ${c.crustdataCompanyId} (${c.domain ?? "no domain"})`);
    }
  }

  const pull = await searchPeople(parsed.crustdataFilter, 50);
  console.log(`\nfetch: ${pull.profiles.length} profiles (total_matched=${pull.totalMatched})`);

  const cleaned = cleanProfiles(pull.profiles, {
    companyScope: parsed.companyScope,
    titleVariants: parsed.titleVariants,
  });
  console.log("clean:", cleaned.stats);

  if (cleaned.profiles[0]) {
    const p = cleaned.profiles[0];
    const current = pull.profiles[0]?.experience?.employment_details?.current?.[0];
    console.log("\nfirst raw current:", current);
    console.log("first cleaned:", p.currentTitle, "@", p.currentCompany, "id", p.matchedCurrentRole.companyId);
  }
} catch (err) {
  console.error("DIAGNOSTIC ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
}

// Spot-check a few registry domains when no query scope.
const domains = ["sequoiacap.com", "mckinsey.com", "bcg.com", "bain.com", "openai.com"];
const domainHits = await identifyCompaniesByDomain(domains);
console.log("\nDomain spot-check:");
for (const d of domains) {
  const hit = domainHits.get(d);
  console.log(`  ${d}: ${hit ? `${hit.canonicalName} (${hit.crustdataCompanyId})` : "MISS"}`);
}

const nameHits = await identifyCompanies(["Sequoia Capital", "Boston Consulting Group (BCG)"]);
console.log("\nName spot-check:");
for (const [name, hit] of nameHits) {
  console.log(`  ${name}: ${hit.canonicalName} (${hit.crustdataCompanyId})`);
}
