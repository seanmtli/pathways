// Phase 5: pre-compute all 32 seed roles (PRD §10, Appendix A) before any
// real user sees the app. Sequential on purpose — polite to both vendors and
// easy to audit. Cache hits are skipped instantly; roles whose cluster rows
// were invalidated recluster free from their stored pulls.
//
// Run: npm run seed

import { runPipeline } from "../lib/pipeline.ts";
import { getTodaySpend } from "../lib/db.ts";

// §10 Appendix A, phrased as a user would type them. ★ = golden set.
const SEED_ROLES: { query: string; golden?: boolean; stressTest?: boolean }[] = [
  { query: "Head of Strategy and Analytics at a professional sports team", golden: true },
  { query: "Product Manager at a VC-backed startup", golden: true },
  { query: "Chief Data Officer at a professional sports team" },
  { query: "Private equity associate", golden: true },
  { query: "Director of Baseball Operations at an MLB team" },
  { query: "Venture capital investor", golden: true },
  { query: "Sports business strategy consultant" },
  { query: "Chief of Staff at a startup", golden: true },
  { query: "General Manager of an NBA team" },
  { query: "Management consultant at a top strategy firm" },
  { query: "Sports agent" },
  { query: "Data scientist at a large tech company" },
  { query: "Athletic Director at a Division I university" },
  { query: "Investment banking analyst" },
  { query: "Head of Partnerships at a professional sports league" },
  { query: "Corporate development manager" },
  { query: "Product Manager at a sports betting company" },
  { query: "Founder of a venture-backed startup" },
  { query: "Quantitative analyst at a sportsbook" },
  { query: "Chief Marketing Officer" },
  { query: "Director of Player Personnel at an NFL team" },
  { query: "Head of Growth at a consumer startup" },
  { query: "VP of Content at a sports media company" },
  { query: "UX designer at a tech company" },
  { query: "VP of Ticket Sales at a professional sports team" },
  { query: "Solutions engineer" },
  { query: "Sports analytics researcher" },
  { query: "Hedge fund analyst" },
  { query: "Data scientist at a sports tech startup" },
  { query: "Brand manager at a CPG company" },
  { query: "Forward Deployed Engineer", stressTest: true },
  { query: "Chief AI Officer", stressTest: true },
];

const spendBefore = await getTodaySpend();
console.log(`SEED START · ${SEED_ROLES.length} roles · spend today so far: ${spendBefore.toFixed(1)} credits`);

let ok = 0, thin = 0, failed = 0;

for (const [i, role] of SEED_ROLES.entries()) {
  const n = `${i + 1}/${SEED_ROLES.length}`;
  const t0 = Date.now();
  try {
    const r = await runPipeline(role.query, {
      sessionToken: "seed-script",
      skipLimits: true,
      onStage: (stage, detail) => {
        // Surface batch-level clustering diagnostics in the seed log.
        if (stage === "clustering" && detail && !/^\d+ profiles$/.test(detail)) console.log(`    · ${detail}`);
      },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.kind === "ok") {
      ok++;
      const drops = r.stats.dropped > 0 ? ` · DROPPED ${r.stats.dropped}` : "";
      console.log(
        `${n} OK${role.golden ? " ★" : ""}${role.stressTest ? " (stress)" : ""} "${role.query}" → ${r.canonicalKey} · ` +
          `${r.clusters.length} clusters · ${r.sampleSize} relevant / ${r.stats.classified} classified · ` +
          `${r.stats.notRelevant} not_relevant${drops} · ${r.cacheHit ? "cache hit" : `${secs}s`}`,
      );
    } else if (r.kind === "thin_data") {
      thin++;
      console.log(`${n} THIN${role.stressTest ? " (stress — expected)" : ""} "${role.query}" → ${r.canonicalKey} · ${r.usableProfiles} usable profiles · ${secs}s`);
    } else {
      failed++;
      console.log(`${n} ${r.kind.toUpperCase()} "${role.query}" · ${secs}s`);
    }
  } catch (err) {
    failed++;
    console.log(`${n} THREW "${role.query}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

const spendAfter = await getTodaySpend();
console.log(
  `SEED DONE · ok=${ok} thin=${thin} failed=${failed} · credits spent this run: ${(spendAfter - spendBefore).toFixed(1)} (today total ${spendAfter.toFixed(1)})`,
);
