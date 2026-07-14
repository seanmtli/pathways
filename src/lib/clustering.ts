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
import { careerSummary, substantiveHistory, isNoiseRole, type CleanProfile } from "./cleaning.ts";

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

export interface ClusteringOptions {
  minRelevant?: number;
  minArchetypes?: number;
  maxArchetypes?: number;
}

export function clusteringOptionsForSample(profileCount: number, minRelevant: number): ClusteringOptions {
  if (profileCount < 24) return { minRelevant, minArchetypes: 2, maxArchetypes: 2 };
  if (profileCount < 30) return { minRelevant, minArchetypes: 3, maxArchetypes: 3 };
  return { minRelevant, minArchetypes: 4, maxArchetypes: 6 };
}

export async function deriveArchetypes(
  roleDescription: string,
  sample: CleanProfile[],
  options: ClusteringOptions = {},
): Promise<Archetype[]> {
  const minArchetypes = options.minArchetypes ?? 4;
  const maxArchetypes = options.maxArchetypes ?? 6;
  const system = `You are a career-path analyst. You will be given the career histories of professionals currently in a target role. Your job is to identify exactly ${minArchetypes === maxArchetypes ? minArchetypes : `${minArchetypes}-${maxArchetypes}`} distinct, recognizable career paths ("archetypes") people took to reach this role.

Rules:
- Return between ${minArchetypes} and ${maxArchetypes} archetypes, collectively covering the common patterns in the data.
- Each label must be short (2-6 words) and instantly legible to a career explorer, e.g. "Consulting → strategy track".
- Each description is 1-2 sentences describing the common pattern.
- "signals" lists 2-4 concrete distinguishing markers (prior industries, typical roles, education) that separate this archetype from the others.
- Base archetypes only on the evidence in the histories provided. Do not invent paths that aren't represented.
- Ignore internal corporate-support staff whose function does not match the target role (human resources, recruiting / talent acquisition, IT / infrastructure support, office management / facilities, executive assistant / administrative, internal finance, internal marketing / communications). They are data-vendor false positives, not a career path to this role — do not create an archetype for them.`;

  const user = `Target role: ${roleDescription}

Career histories (sample of ${sample.length} professionals):

${sample.map((p) => careerSummary(p)).join("\n")}`;

  const { archetypes } = await jsonCall<{ archetypes: Archetype[] }>({
    system,
    user,
    schema: ARCHETYPE_SCHEMA,
    maxTokens: 4000,
  });

  if (archetypes.length < minArchetypes || archetypes.length > maxArchetypes) {
    throw new Error(
      `Archetype derivation returned ${archetypes.length} archetypes (expected ${minArchetypes}-${maxArchetypes})`,
    );
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
function classifySchema(labels: string[], ordinals: string[], allowNotRelevant: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: ordinals },
            archetype: { type: "string", enum: allowNotRelevant ? [...labels, NOT_RELEVANT] : labels },
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
function labelNormalizer(labels: string[], allowNotRelevant: boolean): (raw: string) => string | null {
  const map = new Map(labels.map((l) => [l.trim().toLowerCase(), l]));
  if (allowNotRelevant) map.set(NOT_RELEVANT, NOT_RELEVANT);
  return (raw) => map.get(raw.trim().toLowerCase()) ?? null;
}

async function classifyBatch(
  roleDescription: string,
  archetypes: Archetype[],
  batch: CleanProfile[],
  allowNotRelevant: boolean,
  feedback?: string,
): Promise<Assignment[]> {
  const labels = archetypes.map((a) => a.label);
  const relevanceRules = allowNotRelevant
    ? `
- If a person is clearly NOT actually in or closely adjacent to the target role (a false positive from the data vendor — wrong industry, wrong function, or a title match that means something else), assign "${NOT_RELEVANT}" instead. Be strict: relevance means their current role genuinely matches the target role.
- Internal corporate-support staff whose function does not match the target role are "${NOT_RELEVANT}", even at the right employer. Human resources, recruiting / talent acquisition, IT / help desk / infrastructure support, office management / facilities, executive assistant / administrative, internal finance / accounting, and internal marketing / communications are support functions — NOT the target role — unless the target role IS that function. Example: at a consulting firm, a "Talent Acquisition Manager", "HR Consultant", or "IT Support Manager" is NOT a management/strategy consultant. Judge by what the person actually does, not by a title keyword that happens to overlap.
- Interns, summer associates/analysts, students, and trainees are "${NOT_RELEVANT}" — they do not yet hold the role.
- If the target role specifies a startup employer: people at decades-old small businesses, family firms, agencies, franchises, or their own one-person shell company are "${NOT_RELEVANT}" — a startup is a young company, not merely a small one. Use the career history for age signals (e.g. someone employed at the same small company since 2005 is not at a startup).`
    : `
- Everyone in this batch has already been screened as genuinely in the target role — assign each person to the single closest archetype even if the fit is imperfect.`;
  const system = `You are classifying professionals into fixed career-path archetypes for the target role: ${roleDescription}

Archetypes:
${archetypes.map((a) => `- "${a.label}": ${a.description} Signals: ${a.signals.join("; ")}`).join("\n")}

Rules:
- Assign each person to exactly ONE archetype label (verbatim from the list) — the single best fit for how they reached their current role.${relevanceRules}
- Return exactly one assignment per input person, keyed by their [id]. The assignments array must have exactly ${batch.length} entries — one for each id from 1 to ${batch.length}. Do not skip anyone.`;

  // People are numbered 1..N for this call; ordinals map back to person ids here.
  const ordinals = batch.map((_, i) => String(i + 1));
  const user =
    `Classify these ${batch.length} people:\n\n${batch.map((p, i) => careerSummary(p, ordinals[i])).join("\n")}` +
    (feedback ? `\n\nIMPORTANT — your previous attempt was rejected: ${feedback}. Return an assignment for every id listed above.` : "");

  const { assignments } = await jsonCall<{ assignments: { id: string; archetype: string }[] }>({
    system,
    user,
    schema: classifySchema(labels, ordinals, allowNotRelevant),
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
  allowNotRelevant: boolean,
  feedback?: string,
): Promise<void> {
  const normalize = labelNormalizer(archetypes.map((a) => a.label), allowNotRelevant);
  try {
    const assignments = await classifyBatch(roleDescription, archetypes, profiles, allowNotRelevant, feedback);
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

// ---------- Pass 2c: exemplar selection ----------
//
// The first three members of a cluster are the faces of that path — the first
// thing a career explorer sees. Arbitrary order surfaces poor ambassadors (a
// founder/VC profile heading an "IB → PE" cluster). So: score every member
// for legibility in code, then have the model pick the most representative
// three from the shortlist. Selection is validated in code (enum + id check),
// with the heuristic order as the fallback — a bad LLM call degrades the
// ordering, never the data.

const EXEMPLAR_COUNT = 3;
const SHORTLIST_SIZE = 24;

/**
 * How legible is this person's path as a story? Rewards a real, dated,
 * multi-step history and penalizes vendor padding. Deterministic.
 */
function legibilityScore(p: CleanProfile): number {
  const career = substantiveHistory(p.history);
  const noiseRatio = p.history.length > 0 ? p.history.filter(isNoiseRole).length / p.history.length : 1;
  const dated = career.filter((r) => r.start).length;

  let score = 0;
  score += Math.min(career.length, 5) * 2; // a path needs steps, with diminishing returns
  score += Math.min(dated, 5); // undated roles can't be rendered on a timeline
  score -= noiseRatio * 6; // mostly-padding histories read badly
  if (career.length < 2) score -= 8; // no journey to show
  if (p.education.length > 0) score += 1;
  if (p.linkedinUrl) score += 1; // the reader can verify them
  return score;
}

const EXEMPLAR_SCHEMA = (ordinals: string[]) => ({
  type: "object",
  properties: {
    exemplar_ids: { type: "array", items: { type: "string", enum: ordinals } },
  },
  required: ["exemplar_ids"],
  additionalProperties: false,
});

/**
 * Order a cluster's members so the most representative appear first.
 * Returns a new array; never drops or duplicates anyone.
 */
export async function rankExemplars(
  roleDescription: string,
  archetype: Archetype,
  members: CleanProfile[],
  log: (msg: string) => void = () => {},
): Promise<CleanProfile[]> {
  if (members.length <= EXEMPLAR_COUNT) return members;

  const shortlist = [...members].sort((a, b) => legibilityScore(b) - legibilityScore(a)).slice(0, SHORTLIST_SIZE);
  const ordinals = shortlist.map((_, i) => String(i + 1));

  const system = `You are choosing the ${EXEMPLAR_COUNT} people who best exemplify one career path, for a career-exploration product. They will be shown as the faces of this path.

Target role: ${roleDescription}
Path: "${archetype.label}" — ${archetype.description}
Distinguishing signals: ${archetype.signals.join("; ")}

Choose the ${EXEMPLAR_COUNT} people whose career histories most clearly and typically embody THIS path:
- Their journey should visibly follow the path's signals, not merely end at the target role.
- Prefer the typical case over the exceptional or exotic one. A reader should think "so that's the standard route."
- Their current role must genuinely be the target role.
- Prefer legible histories: clear, dated steps a reader can follow.
- Reject anyone whose story is mostly a different path (e.g. a lifelong founder heading a banking-to-buyout path).

Return exactly ${EXEMPLAR_COUNT} ids, best first.`;

  const user = `Candidates:\n\n${shortlist.map((p, i) => careerSummary(p, ordinals[i])).join("\n")}`;

  const rest = (chosen: CleanProfile[]) => {
    const chosenIds = new Set(chosen.map((p) => p.id));
    return members.filter((p) => !chosenIds.has(p.id));
  };

  try {
    const { exemplar_ids } = await llmJsonCall<{ exemplar_ids: string[] }>({
      model: config.clusterModel(),
      system,
      user,
      schema: EXEMPLAR_SCHEMA(ordinals),
      maxTokens: 500,
    });

    // Validate in code: real ordinals, no duplicates, enough of them.
    const picked: CleanProfile[] = [];
    const seen = new Set<string>();
    for (const raw of exemplar_ids) {
      const idx = Number(raw) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < shortlist.length && !seen.has(shortlist[idx].id)) {
        seen.add(shortlist[idx].id);
        picked.push(shortlist[idx]);
      }
    }
    if (picked.length < EXEMPLAR_COUNT) {
      log(`Exemplars "${archetype.label}": only ${picked.length} valid picks, topping up from shortlist`);
      for (const p of shortlist) {
        if (picked.length >= EXEMPLAR_COUNT) break;
        if (!seen.has(p.id)) { seen.add(p.id); picked.push(p); }
      }
    }
    return [...picked, ...rest(picked)];
  } catch (err) {
    log(`Exemplars "${archetype.label}" failed (${err instanceof Error ? err.message : String(err)}); using heuristic order`);
    const fallback = shortlist.slice(0, EXEMPLAR_COUNT);
    return [...fallback, ...rest(fallback)];
  }
}

/** Rank exemplars for every cluster, in parallel. Mutates nothing. */
export async function rankAllExemplars(
  roleDescription: string,
  clusters: Cluster[],
  log: (msg: string) => void = () => {},
): Promise<Cluster[]> {
  return Promise.all(
    clusters.map(async (c) => ({
      ...c,
      members: await rankExemplars(roleDescription, c.archetype, c.members, log),
    })),
  );
}

/**
 * One full derive-and-classify round: 2a on a sample of `profiles`, then 2b
 * over all of them (parallel wave + sequential retry wave, §6.5).
 */
async function clusterRound(
  roleDescription: string,
  profiles: CleanProfile[],
  log: (msg: string) => void,
  allowNotRelevant = true,
  options: ClusteringOptions = {},
): Promise<{ archetypes: Archetype[]; assigned: Map<string, string>; batches: number; retries: number }> {
  // Pass 2a
  const sample = representativeSample(profiles, config.archetypeSampleSize());
  log(`Pass 2a: deriving archetypes from ${sample.length} sampled histories…`);
  const archetypes = await deriveArchetypes(roleDescription, sample, options);
  log(`Pass 2a: ${archetypes.length} archetypes derived: ${archetypes.map((a) => a.label).join(" | ")}`);

  // Pass 2b — independent batches
  const batchSize = config.classifyBatchSize();
  const batches: CleanProfile[][] = [];
  for (let i = 0; i < profiles.length; i += batchSize) batches.push(profiles.slice(i, i + batchSize));
  log(`Pass 2b: classifying ${profiles.length} profiles in ${batches.length} parallel batches of ≤${batchSize}…`);

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
        await classifyAttempt(roleDescription, archetypes, batches[i], assigned, `Batch ${i + 1}`, log, allowNotRelevant);
      }
    }),
  );

  // Wave 2 — the single retry per unassigned profile (§6.5), run
  // SEQUENTIALLY after the parallel wave so it executes under calm load.
  const unassigned = profiles.filter((p) => !assigned.has(p.id));
  const retries = unassigned.length > 0 ? Math.ceil(unassigned.length / batchSize) : 0;
  if (unassigned.length > 0) {
    log(`Retry wave: ${unassigned.length} profiles unassigned after parallel pass, retrying sequentially`);
    for (let i = 0; i < unassigned.length; i += batchSize) {
      const chunk = unassigned.slice(i, i + batchSize);
      await classifyAttempt(
        roleDescription, archetypes, chunk, assigned, `Retry chunk ${i / batchSize + 1}`, log, allowNotRelevant,
        `it did not include every person. You MUST return exactly one assignment for every id from 1 to ${chunk.length}`,
      );
    }
  }

  return { archetypes, assigned, batches: batches.length, retries };
}

export async function clusterProfiles(
  roleDescription: string,
  profiles: CleanProfile[],
  log: (msg: string) => void = () => {},
  options: ClusteringOptions = {},
): Promise<ClusteringResult> {
  // Round 1 over the full cleaned pull.
  const round1 = await clusterRound(roleDescription, profiles, log, true, options);

  const round1Relevant = profiles.filter((p) => {
    const label = round1.assigned.get(p.id);
    return label !== undefined && label !== NOT_RELEVANT;
  });
  const round1Classified = [...round1.assigned.values()].length;

  // Pollution recovery: when most of the pull is vendor false positives, the
  // round-1 archetypes were fitted to garbage (2a can't know relevance in
  // advance). Re-derive archetypes from the RELEVANT people only and
  // re-classify them — round 1 then serves purely as the relevance sieve.
  const threshold = Number(process.env.POLLUTION_RECOVERY_THRESHOLD ?? "0.6");
  let archetypes = round1.archetypes;
  let assigned = round1.assigned;
  let batches = round1.batches;
  let retries = round1.retries;
  const minRelevant = options.minRelevant ?? config.minUsableProfiles();
  const relevantOptions = clusteringOptionsForSample(round1Relevant.length, minRelevant);
  const bucketChanged =
    relevantOptions.minArchetypes !== (options.minArchetypes ?? 4) ||
    relevantOptions.maxArchetypes !== (options.maxArchetypes ?? 6);
  const polluted =
    round1Classified > 0 &&
    round1Relevant.length / round1Classified < threshold;

  if (
    round1Relevant.length >= minRelevant &&
    (polluted || bucketChanged)
  ) {
    log(
      `Recovery: only ${round1Relevant.length}/${round1Classified} classified as relevant — ` +
        `re-deriving archetypes from the relevant subset`,
    );
    const round2 = await clusterRound(roleDescription, round1Relevant, log, false, relevantOptions);
    archetypes = round2.archetypes;
    batches += round2.batches;
    retries += round2.retries;
    // Merge: round-1 not_relevant verdicts stand; relevant people take their
    // round-2 label (including a stricter round-2 not_relevant).
    assigned = new Map(round1.assigned);
    for (const p of round1Relevant) {
      const label2 = round2.assigned.get(p.id);
      if (label2 !== undefined) assigned.set(p.id, label2);
      else assigned.delete(p.id); // dropped in round 2 → counts as dropped
    }
  }

  // Anyone unassigned after all waves is dropped and logged (§6.5).
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
  const labels = archetypes.map((a) => a.label);
  const byLabel = new Map<string, CleanProfile[]>(labels.map((l) => [l, []]));
  const notRelevant: CleanProfile[] = [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  for (const [id, label] of assigned) {
    const profile = profileById.get(id)!;
    if (label === NOT_RELEVANT || !byLabel.has(label)) notRelevant.push(profile);
    else byLabel.get(label)!.push(profile);
  }

  const relevantTotal = [...byLabel.values()].reduce((n, m) => n + m.length, 0);
  const unranked: Cluster[] = archetypes
    .map((archetype) => {
      const members = byLabel.get(archetype.label)!;
      return {
        archetype,
        members,
        percentage: relevantTotal > 0 ? Math.round((members.length / relevantTotal) * 100) : 0,
      };
    })
    .filter((cluster) => cluster.members.length > 0)
    .sort((a, b) => b.members.length - a.members.length);

  // Pass 2c — order each cluster's members so the best ambassadors lead.
  log(`Pass 2c: selecting exemplars for ${unranked.length} clusters…`);
  const clusters = await rankAllExemplars(roleDescription, unranked, log);

  return {
    clusters,
    notRelevant,
    droppedAfterRetry,
    stats: {
      classified: relevantTotal + notRelevant.length,
      relevant: relevantTotal,
      notRelevant: notRelevant.length,
      dropped: droppedAfterRetry.length,
      batches,
      batchRetries: retries,
    },
  };
}
