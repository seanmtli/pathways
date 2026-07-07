// Phase 3 verification: prove each §6.6/§6.7 protection fires, without
// spending Crustdata credits. Run: npm run test:limits

import { randomUUID } from "node:crypto";
import { runPipeline } from "../lib/pipeline.ts";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
}

const CACHED_QUERY = "sports agent"; // seeded in Phase 2 → always a cache hit
const UNCACHED_QUERY = "hedge fund analyst"; // not seeded → cache miss path

// 1. Session cache-miss cap: with a 0/hour cap, an uncached query must be
// rate-limited at the miss gate — before any Crustdata spend.
{
  process.env.RATE_LIMIT_SESSION_MISS_PER_HOUR = "0";
  const r = await runPipeline(UNCACHED_QUERY, { sessionToken: `test-${randomUUID()}`, ip: "203.0.113.1" });
  check("session miss cap", r.kind === "rate_limited" && r.scope === "session", `outcome: ${r.kind}`);
  process.env.RATE_LIMIT_SESSION_MISS_PER_HOUR = "5";
}

// 2. Cache hits are NOT blocked by the miss cap (only by the loose total cap).
{
  process.env.RATE_LIMIT_SESSION_MISS_PER_HOUR = "0";
  const r = await runPipeline(CACHED_QUERY, { sessionToken: `test-${randomUUID()}`, ip: "203.0.113.1" });
  check("cache hit unaffected by miss cap", r.kind === "ok" && r.cacheHit, `outcome: ${r.kind}`);
  process.env.RATE_LIMIT_SESSION_MISS_PER_HOUR = "5";
}

// 3. IP backstop: generous cap, but must fire when exceeded even across
// different session tokens (cookie-clearing abuse).
{
  process.env.RATE_LIMIT_IP_MISS_PER_HOUR = "0";
  const r = await runPipeline(UNCACHED_QUERY, { sessionToken: `test-${randomUUID()}`, ip: "203.0.113.99" });
  check("IP miss backstop", r.kind === "rate_limited" && r.scope === "ip", `outcome: ${r.kind}`);
  process.env.RATE_LIMIT_IP_MISS_PER_HOUR = "50";
}

// 4. Spend ceiling: with the ceiling below today's spend, an uncached query
// must degrade to cached-only mode — with previously analyzed roles offered.
{
  process.env.DAILY_CREDIT_CEILING = "0.01";
  const r = await runPipeline(UNCACHED_QUERY, { sessionToken: `test-${randomUUID()}`, ip: "203.0.113.2" });
  const rolesOffered = r.kind === "degraded" ? r.availableRoles.length : 0;
  check(
    "spend ceiling degrades to cached-only",
    r.kind === "degraded" && r.reason === "spend_ceiling" && rolesOffered > 0,
    `outcome: ${r.kind}, cached roles offered: ${rolesOffered}`,
  );
  process.env.DAILY_CREDIT_CEILING = "300";
}

// 5. Spend ceiling does NOT block cache hits (degrade is cached-only mode,
// and hits are the cached mode).
{
  process.env.DAILY_CREDIT_CEILING = "0.01";
  const r = await runPipeline(CACHED_QUERY, { sessionToken: `test-${randomUUID()}`, ip: "203.0.113.2" });
  check("cache hit served at spend ceiling", r.kind === "ok" && r.cacheHit, `outcome: ${r.kind}`);
  process.env.DAILY_CREDIT_CEILING = "300";
}

// 6. Loose per-session total cap (bot protection) blocks even cache hits.
{
  process.env.RATE_LIMIT_SESSION_TOTAL_PER_HOUR = "2";
  const session = `test-${randomUUID()}`;
  const r1 = await runPipeline(CACHED_QUERY, { sessionToken: session, ip: "203.0.113.3" });
  const r2 = await runPipeline(CACHED_QUERY, { sessionToken: session, ip: "203.0.113.3" });
  const r3 = await runPipeline(CACHED_QUERY, { sessionToken: session, ip: "203.0.113.3" });
  check(
    "session total cap",
    r1.kind === "ok" && r2.kind === "ok" && r3.kind === "rate_limited",
    `outcomes: ${r1.kind}, ${r2.kind}, ${r3.kind}`,
  );
  process.env.RATE_LIMIT_SESSION_TOTAL_PER_HOUR = "60";
}

// 7. Vendor-down degrade: point the client at an unreachable host and confirm
// cached-only mode (not an exception) after the internal retry.
{
  process.env.CRUSTDATA_API_KEY_BACKUP = process.env.CRUSTDATA_API_KEY;
  process.env.CRUSTDATA_API_KEY = "invalid-key-simulating-outage";
  const r = await runPipeline(UNCACHED_QUERY, { sessionToken: `test-${randomUUID()}`, ip: "203.0.113.4" });
  check(
    "vendor failure degrades to cached-only",
    r.kind === "degraded" && r.reason === "vendor_down",
    `outcome: ${r.kind}${r.kind === "degraded" ? ` (${r.reason})` : ""}`,
  );
  process.env.CRUSTDATA_API_KEY = process.env.CRUSTDATA_API_KEY_BACKUP!;
}

console.log(failures === 0 ? "\nAll protection gates verified." : `\n${failures} gate(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
