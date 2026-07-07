// Two-pass clustering (PRD §6.5 — mandatory design).
//
// Pass 2a derives 4-6 archetypes from a representative sample; archetypes are
// then FIXED. Pass 2b classifies every profile against them in independent,
// parallel batches. A code-side validation pass asserts that every input
// person id appears exactly once and no id was invented; a failed batch is
// retried once, then its profiles are dropped and the event logged.
// Percentages are computed in code from final assignments — never taken from
// LLM output.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { careerSummary, type CleanProfile } from "./cleaning.ts";

const anthropic = new Anthropic();

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

async function jsonCall<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<T> {
  const response = await anthropic.messages.create({
    model: config.clusterModel(),
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    output_config: { format: { type: "json_schema", schema: opts.schema } },
  });
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`LLM returned no text block (stop_reason: ${response.stop_reason})`);
  return JSON.parse(text) as T;
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

${sample.map(careerSummary).join("\n")}`;

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

function classifySchema(labels: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
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
 * Code-side validation (PRD §6.5): every input id exactly once, nothing
 * invented, every archetype label from the fixed set.
 */
export function validateAssignments(batch: CleanProfile[], assignments: Assignment[], labels: string[]): string | null {
  const validLabels = new Set([...labels, NOT_RELEVANT]);
  const inputIds = new Set(batch.map((p) => p.id));
  const seen = new Set<string>();
  for (const a of assignments) {
    if (!inputIds.has(a.id)) return `hallucinated id ${a.id}`;
    if (seen.has(a.id)) return `duplicate id ${a.id}`;
    if (!validLabels.has(a.archetype)) return `unknown archetype "${a.archetype}"`;
    seen.add(a.id);
  }
  if (seen.size !== inputIds.size) {
    const missing = [...inputIds].filter((id) => !seen.has(id));
    return `missing ids: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`;
  }
  return null;
}

async function classifyBatch(
  roleDescription: string,
  archetypes: Archetype[],
  batch: CleanProfile[],
): Promise<Assignment[]> {
  const labels = archetypes.map((a) => a.label);
  const system = `You are classifying professionals into fixed career-path archetypes for the target role: ${roleDescription}

Archetypes:
${archetypes.map((a) => `- "${a.label}": ${a.description} Signals: ${a.signals.join("; ")}`).join("\n")}

Rules:
- Assign each person to exactly ONE archetype label (verbatim from the list) — the single best fit for how they reached their current role.
- If a person is clearly NOT actually in or closely adjacent to the target role (a false positive from the data vendor — wrong industry, wrong function, or a title match that means something else), assign "${NOT_RELEVANT}" instead. Be strict: relevance means their current role genuinely matches the target role.
- Return exactly one assignment per input person, keyed by their [id]. Do not skip anyone; do not invent ids.`;

  const user = `Classify these ${batch.length} people:\n\n${batch.map(careerSummary).join("\n")}`;

  const { assignments } = await jsonCall<{ assignments: Assignment[] }>({
    system,
    user,
    schema: classifySchema(labels),
    maxTokens: 6000,
  });
  return assignments;
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
  let retries = 0;
  const droppedAfterRetry: CleanProfile[] = [];

  const batchResults = await Promise.all(
    batches.map(async (batch, i) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const assignments = await classifyBatch(roleDescription, archetypes, batch);
          const problem = validateAssignments(batch, assignments, labels);
          if (problem === null) return assignments;
          log(`Batch ${i + 1} attempt ${attempt + 1} failed validation: ${problem}`);
        } catch (err) {
          log(`Batch ${i + 1} attempt ${attempt + 1} errored: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (attempt === 0) retries++;
      }
      // PRD §6.5: after one retry, drop these specific profiles and log it.
      log(`Batch ${i + 1}: dropping ${batch.length} profiles after failed retry`);
      droppedAfterRetry.push(...batch);
      return [] as Assignment[];
    }),
  );

  // Aggregate — counts and percentages computed in code only.
  const byLabel = new Map<string, CleanProfile[]>(labels.map((l) => [l, []]));
  const notRelevant: CleanProfile[] = [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  for (const assignments of batchResults) {
    for (const a of assignments) {
      const profile = profileById.get(a.id)!;
      if (a.archetype === NOT_RELEVANT) notRelevant.push(profile);
      else byLabel.get(a.archetype)!.push(profile);
    }
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
