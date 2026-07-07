// All cost/limit constants live here and come from environment variables (PRD §8).
// Values are read lazily so tests/scripts can override process.env before use.

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function intEnv(name: string, fallback: string): number {
  const n = Number.parseInt(env(name, fallback), 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} is not a number`);
  return n;
}

export const config = {
  crustdataApiKey: () => env("CRUSTDATA_API_KEY"),

  // Cost levers (PRD §6.4, §8)
  pullCap: () => intEnv("CRUSTDATA_PULL_CAP", "400"),
  creditsPerResult: () => Number(env("CRUSTDATA_CREDITS_PER_RESULT", "0.03")),

  // Model slugs on OpenRouter (PRD §6.1) — env-configurable, never hardcoded
  // at call sites. Any OpenRouter model with structured-output support works.
  parseModel: () => env("LLM_PARSE_MODEL", "google/gemini-2.5-flash-lite"),
  clusterModel: () => env("LLM_CLUSTER_MODEL", "google/gemini-3-flash-preview"),

  // Clustering knobs (PRD §6.5)
  archetypeSampleSize: () => intEnv("ARCHETYPE_SAMPLE_SIZE", "70"),
  classifyBatchSize: () => intEnv("CLASSIFY_BATCH_SIZE", "30"),

  // Thin-data threshold (PRD §5.6)
  minUsableProfiles: () => intEnv("MIN_USABLE_PROFILES", "30"),

  // Rate limiting & cost control (PRD §6.6) — all env-tunable
  sessionMissPerHour: () => intEnv("RATE_LIMIT_SESSION_MISS_PER_HOUR", "5"),
  sessionTotalPerHour: () => intEnv("RATE_LIMIT_SESSION_TOTAL_PER_HOUR", "60"),
  ipMissPerHour: () => intEnv("RATE_LIMIT_IP_MISS_PER_HOUR", "50"),
  dailyCreditCeiling: () => Number(env("DAILY_CREDIT_CEILING", "300")),

  // Cache freshness window in days (PRD §6.8)
  cacheFreshnessDays: () => intEnv("CACHE_FRESHNESS_DAYS", "30"),
};
