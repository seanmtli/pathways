// Two-pass clustering (PRD §6.5 — mandatory design).
//
// Pass 2a derives 4-6 archetypes from a representative sample; archetypes are
// then FIXED. Pass 2b classifies every profile against them in independent,
// parallel batches. A code-side validation pass asserts that every input
// person id appears exactly once and no id was invented; a failed batch is
// retried once, then its profiles are dropped and the event logged.
// Percentages are computed in code from final assignments — never taken from
// LLM output.

import { config } from "./config.ts";
import { jsonCall as llmJsonCall } from "./llm.ts";
import { careerSummary, type CleanProfile } from "./cleaning.ts";

export interface Archetype {
  label: string;
  description: string;
  signals: string[];
}

export interface Cluster {
  archetype: Archetype;
  members: CleanProfile[];
  /** Share of classified, relevant profiles — computed in code. */
  percentage: number;
}

export interface ClusteringResult {
  clusters: Cluster[];
  notRelevant: CleanProfile[];
  droppedAfterRetry: CleanProfile[];
  stats: {
    classified: number;
    relevant: number;
    notRelevant: number;
    dropped: number;
    batches: number;
    batchRetries: number;
  };
}

function jsonCall<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<T> {
  return llmJsonCall<T>({ model: config.clusterModel(), ...opts });
}

/** Evenly-spaced sample across the pull so the archetype pass sees the spread. */
export function representativeSample(profiles: CleanProfile[], size: number): CleanProfile[] {
  if (profiles.length <= size) return profiles;
  const step = profiles.length / size;
  const out: CleanProfile[] = [];
  for (let i = 0; i < size; i++) out.push(profiles[Math.floor(i * step)]);
  return out;
}

// ---------- Pass 2a: derive archetypes ----------

const ARCHETYPE_SCHEMA = {
  type: "object",
  properties: {
    archetypes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          description: { type: "string" },
          signals: { type: "array", items: { type: "string" } },
        },
        required: ["label", "description", "signals"],
        additionalProperties: false,
      },
    },
  },
  required: ["archetypes"],
  additionalProperties: false,
} as const;

export async function deriveArchetypes(roleDescription: string, sample: CleanProfile[]): Promise<Archetype[]> {
  const system = `You are a career-path analyst. You will be given the career histories of professionals currently in a target role. Your job is to identify the 4-6 distinct, recognizable career paths ("archetypes") people took to reach this role.

Rules:
- Between 4 and 6 archetypes, collectively covering the common patterns in the data.
- Each label must be short (2-6 words) and instantly legible to a career explorer, e.g. "Consulting → strategy track".
- Each description is 1-2 sentences describing the common pattern.
- "signals" lists 2-4 concrete distinguishing markers (prior industries, typical roles, education) that separate this archetype from the others.
- Base archetypes only on the evidence in the histories provided. Do not invent paths that aren't represented.`;

  const user = `Target role: ${roleDescription}

Career histories (sample of ${sample.length} professionals):

${sample.map((p) => careerSummary(p)).join("\n")}`;

  const { archetypes } = await jsonCall<{ archetypes: Archetype[] }>({
    system,
    user,
    schema: ARCHETYPE_SCHEMA,
    maxTokens: 4000,
  });

  if (archetypes.length < 3 || archetypes.length > 7) {
    throw new Error(`Archetype derivation returned ${archetypes.length} archetypes (expected 4-6)`);
  }
  return archetypes;
}

// ---------- Pass 2b: classify (batched, parallel) ----------

const NOT_RELEVANT = "not_relevant";

// Guardrail: the id field is enum-constrained to this batch's ordinal ids
// ("1".."30"), so a hallucinated id is structurally impossible. Ordinals keep
// the schema far below the API's compilation-complexity limit (long numeric
// person-id enums were observed to hit "Schema is too complex" 400s and to
// degrade enforcement near the limit) and are trivial for the model to copy.
// Missing people remain possible — caught by the resilient worker below.
function classifySchema(labels: string[], ordinals: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: ordinals },
            archetype: { type: "string", enum: [...labels, NOT_RELEVANT] },
          },
          required: ["id", "archetype"],
          additionalProperties: false,
        },
      },
    },
    required: ["assignments"],
    additionalProperties: false,
  };
}

interface Assignment {
  id: string;
  archetype: string;
}

/**
 * Case/whitespace-insensitive label normalization. Structured-output schemas
 * enforce the enum on most calls, but enforcement has been observed to
 * degrade intermittently under parallel load — a trivially-off label
 * ("...To PM" vs "...to PM") should be coerced, not thrown away.
 */
function labelNormalizer(labels: string[]): (raw: string) => string | null {
  const map = new Map(labels.map((l) => [l.trim().toLowerCase(), l]));
  map.set(NOT_RELEVANT, NOT_RELEVANT);
  return (raw) => map.get(raw.trim().toLowerCase()) ?? null;
}

async function classifyBatch(
  roleDescription: string,
  archetypes: Archetype[],
  batch: CleanProfile[],
  feedback?: string,
): Promise<Assignment[]> {
  const labels = archetypes.map((a) => a.label);
  const system = `You are classifying professionals into fixed career-path archetypes for the target role: ${roleDescription}

Archetypes:
${archetypes.map((a) => `- "${a.label}": ${a.description} Signals: ${a.signals.join("; ")}`).join("\n")}

Rules:
- Assign each person to exactly ONE archetype label (verbatim from the list) — the single best fit for how they reached their current role.
- If a person is clearly NOT actually in or closely adjacent to the target role (a false positive from the data vendor — wrong industry, wrong function, or a title match that means something else), assign "${NOT_RELEVANT}" instead. Be strict: relevance means their current role genuinely matches the target role.
- Interns, summer associates/analysts, students, and trainees are "${NOT_RELEVANT}" — they do not yet hold the role.
- Return exactly one assignment per input person, keyed by their [id]. The assignments array must have exactly ${batch.length} entries — one for each id from 1 to ${batch.length}. Do not skip anyone.`;

  // People are numbered 1..N for this call; ordinals map back to person ids here.
  const ordinals = batch.map((_, i) => String(i + 1));
  const user =
    `Classify these ${batch.length} people:\n\n${batch.map((p, i) => careerSummary(p, ordinals[i])).join("\n")}` +
    (feedback ? `\n\nIMPORTANT — your previous attempt was rejected: ${feedback}. Return an assignment for every id listed above.` : "");

  const { assignments } = await jsonCall<{ assignments: { id: string; archetype: string }[] }>({
    system,
    user,
    schema: classifySchema(labels, ordinals),
    maxTokens: 6000,
  });

  // Translate ordinals → real person ids; anything unparseable is discarded
  // here and picked up by the coverage retry in the worker.
  const out: Assignment[] = [];
  for (const a of assignments) {
    const idx = Number(a.id) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < batch.length) {
      out.push({ id: batch[idx].id, archetype: a.archetype });
    }
  }
  return out;
}

/**
 * One classification attempt over a set of profiles. Every valid,
 * first-occurrence assignment with an in-set id is kept (hallucinated ids
 * are impossible via the schema enum AND rejected here); anything else is
 * left unassigned for the caller to retry or drop (§6.5).
 */
async function classifyAttempt(
  roleDescription: string,
  archetypes: Archetype[],
  profiles: CleanProfile[],
  assigned: Map<string, string>,
  label: string,
  log: (msg: string) => void,
  feedback?: string,
): Promise<void> {
  const normalize = labelNormalizer(archetypes.map((a) => a.label));
  try {
    const assignments = await classifyBatch(roleDescription, archetypes, profiles, feedback);
    const ids = new Set(profiles.map((p) => p.id));
    for (const a of assignments) {
      const canonical = normalize(a.archetype);
      if (canonical !== null && ids.has(a.id) && !assigned.has(a.id)) assigned.set(a.id, canonical);
    }
    const unassigned = profiles.filter((p) => !assigned.has(p.id)).length;
    if (unassigned > 0) log(`${label}: ${unassigned}/${profiles.length} unassigned`);
  } catch (err) {
    log(`${label} errored: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function clusterProfiles(
  roleDescription: string,
  profiles: CleanProfile[],
  log: (msg: string) => void = () => {},
): Promise<ClusteringResult> {
  // Pass 2a
  const sample = representativeSample(profiles, config.archetypeSampleSize());
  log(`Pass 2a: deriving archetypes from ${sample.length} sampled histories…`);
  const archetypes = await deriveArchetypes(roleDescription, sample);
  log(`Pass 2a: ${archetypes.length} archetypes derived: ${archetypes.map((a) => a.label).join(" | ")}`);

  // Pass 2b — independent batches, run in parallel
  const batchSize = config.classifyBatchSize();
  const batches: CleanProfile[][] = [];
  for (let i = 0; i < profiles.length; i += batchSize) batches.push(profiles.slice(i, i + batchSize));
  log(`Pass 2b: classifying ${profiles.length} profiles in ${batches.length} parallel batches of ≤${batchSize}…`);

  const labels = archetypes.map((a) => a.label);
  const assigned = new Map<string, string>(); // person id → canonical label

  // Wave 1 — parallel first attempts, with bounded concurrency. Constrained
  // decoding has been observed to degrade under concurrent load (arrays
  // closed early with only a few assignments), so retries do NOT happen here.
  const concurrency = Number(process.env.CLASSIFY_CONCURRENCY ?? "5");
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const i = next++;
        await classifyAttempt(roleDescription, archetypes, batches[i], assigned, `Batch ${i + 1}`, log);
      }
    }),
  );

  // Wave 2 — the single retry per unassigned profile (§6.5), run
  // SEQUENTIALLY after the parallel wave so it executes under calm load.
  let unassigned = profiles.filter((p) => !assigned.has(p.id));
  const retries = unassigned.length > 0 ? Math.ceil(unassigned.length / batchSize) : 0;
  if (unassigned.length > 0) {
    log(`Retry wave: ${unassigned.length} profiles unassigned after parallel pass, retrying sequentially`);
    for (let i = 0; i < unassigned.length; i += batchSize) {
      const chunk = unassigned.slice(i, i + batchSize);
      await classifyAttempt(
        roleDescription, archetypes, chunk, assigned, `Retry chunk ${i / batchSize + 1}`, log,
        `it did not include every person. You MUST return exactly one assignment for every id from 1 to ${chunk.length}`,
      );
    }
  }

  // After the retry, anyone still unassigned is dropped and logged (§6.5).
  const droppedAfterRetry = profiles.filter((p) => !assigned.has(p.id));
  if (droppedAfterRetry.length > 0) {
    log(`Dropping ${droppedAfterRetry.length} profiles still unassigned after retry`);
  }

  // Final code-side accounting check (PRD §6.5): assigned ∪ dropped must
  // cover every input exactly once. This cannot fail given the construction
  // above, but the product promise is verified counts — so verify.
  const droppedIds = new Set(droppedAfterRetry.map((p) => p.id));
  for (const p of profiles) {
    if (assigned.has(p.id) === droppedIds.has(p.id)) {
      throw new Error(`Accounting violation: profile ${p.id} is ${assigned.has(p.id) ? "double-counted" : "unaccounted for"}`);
    }
  }

  // Aggregate — counts and percentages computed in code only.
  const byLabel = new Map<string, CleanProfile[]>(labels.map((l) => [l, []]));
  const notRelevant: CleanProfile[] = [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  for (const [id, label] of assigned) {
    const profile = profileById.get(id)!;
    if (label === NOT_RELEVANT) notRelevant.push(profile);
    else byLabel.get(label)!.push(profile);
  }

  const relevantTotal = [...byLabel.values()].reduce((n, m) => n + m.length, 0);
  const clusters: Cluster[] = archetypes
    .map((archetype) => {
      const members = byLabel.get(archetype.label)!;
      return {
        archetype,
        members,
        percentage: relevantTotal > 0 ? Math.round((members.length / relevantTotal) * 100) : 0,
      };
    })
    .sort((a, b) => b.members.length - a.members.length);

  return {
    clusters,
    notRelevant,
    droppedAfterRetry,
    stats: {
      classified: relevantTotal + notRelevant.length,
      relevant: relevantTotal,
      notRelevant: notRelevant.length,
      dropped: droppedAfterRetry.length,
      batches: batches.length,
      batchRetries: retries,
    },
  };
}
