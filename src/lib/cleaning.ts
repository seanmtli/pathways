// Cleaning pass (PRD §6.4): resolve the primary current role, drop thin
// profiles, and reduce each profile to the render-necessary fields.

import type { CrustdataFilter, RawEmployment, RawProfile } from "./crustdata.ts";
import type { ResolvedCompanyScope } from "./parser.ts";
import { employerPresetByKey } from "./employer-presets.ts";

export interface RoleEntry {
  title: string;
  company: string;
  start: string | null; // "YYYY-MM"
  end: string | null; // null = present
  companyId?: number | null;
}

export interface MatchedCurrentRole {
  title: string;
  company: string;
  companyId: number | null;
}

export interface CleanProfile {
  id: string;
  name: string;
  linkedinUrl: string | null;
  currentTitle: string;
  currentCompany: string;
  location: string | null;
  yearsExperience: number | null;
  education: { school: string; degree: string | null }[];
  history: RoleEntry[]; // chronological, includes current role last
  matchedCurrentRole: MatchedCurrentRole;
}

// PRD §6.4: advisory/board/volunteer patterns to skip when resolving the
// primary current role.
const ADVISORY_PATTERN =
  /\b(advisor|adviser|advisory|board (member|observer|director)|board of directors|mentor|volunteer|angel investor)\b/i;

function ym(date: string | null): string | null {
  if (!date) return null;
  return date.slice(0, 7);
}

/**
 * PRD §6.4: `current` often holds several simultaneous entries (main job +
 * board seats). Pick the entry with the most recent start_date whose title
 * doesn't match advisory patterns; fall back to the first entry if all are
 * ambiguous. Never blindly take index 0.
 */
export function resolvePrimaryCurrent(current: RawEmployment[]): RawEmployment | null {
  if (current.length === 0) return null;
  const nonAdvisory = current.filter((e) => e.title && !ADVISORY_PATTERN.test(e.title));
  const pool = nonAdvisory.length > 0 ? nonAdvisory : current;
  return [...pool].sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""))[0];
}

function toRoleEntry(e: RawEmployment): RoleEntry | null {
  if (!e.title || !e.name) return null;
  return {
    title: e.title,
    company: e.name,
    start: ym(e.start_date),
    end: ym(e.end_date),
    companyId: e.crustdata_company_id ?? e.company_id ?? null,
  };
}

export interface CleaningStats {
  input: number;
  kept: number;
  droppedNoHistory: number;
  droppedThinHistory: number;
  droppedNoIdentity: number;
  droppedScopeMismatch: number;
}

export interface CleaningOptions {
  companyScope?: ResolvedCompanyScope | null;
  titleVariants?: readonly string[];
}

function normalizeMatch(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function employmentCompanyId(entry: RawEmployment): number | null {
  return entry.crustdata_company_id ?? entry.company_id ?? null;
}

function matchesTitle(entry: RawEmployment, variants: readonly string[]): boolean {
  if (!entry.title || variants.length === 0) return Boolean(entry.title);
  const title = normalizeMatch(entry.title);
  return variants.some((variant) => title.includes(normalizeMatch(variant)));
}

function structuralField(entry: RawEmployment, field: string): string | null {
  if (field.endsWith(".company_professional_network_industry")) {
    return entry.company_professional_network_industry;
  }
  if (field.endsWith(".company_headcount_range")) return entry.company_headcount_range ?? null;
  if (field.endsWith(".company_type")) return entry.company_type ?? null;
  return null;
}

function matchesEmploymentFilter(entry: RawEmployment, filter: CrustdataFilter): boolean {
  if ("conditions" in filter) {
    return filter.op === "and"
      ? filter.conditions.every((condition) => matchesEmploymentFilter(entry, condition))
      : filter.conditions.some((condition) => matchesEmploymentFilter(entry, condition));
  }
  const actual = structuralField(entry, filter.field);
  if (actual === null) return false;
  if (filter.type === "in" || filter.type === "not_in") {
    const contains = filter.value.some((value) => normalizeMatch(String(value)) === normalizeMatch(actual));
    return filter.type === "in" ? contains : !contains;
  }
  if (filter.type === "=" || filter.type === "!=") {
    const equal = normalizeMatch(String(filter.value)) === normalizeMatch(actual);
    return filter.type === "=" ? equal : !equal;
  }
  if (filter.type === "(.)") return normalizeMatch(actual).includes(normalizeMatch(String(filter.value)));
  return false;
}

function resolveScopedCurrent(
  current: RawEmployment[],
  scope: ResolvedCompanyScope | null | undefined,
  titleVariants: readonly string[],
): RawEmployment | null {
  if (!scope) return resolvePrimaryCurrent(current);
  if (scope.kind === "structural") {
    const preset = employerPresetByKey(scope.presetKey);
    if (!preset) return null;
    return resolvePrimaryCurrent(
      current.filter(
        (entry) =>
          matchesTitle(entry, titleVariants) &&
          preset.conditions.every((condition) => matchesEmploymentFilter(entry, condition)),
      ),
    );
  }
  const allowed = new Set(scope.companies.map((item) => item.crustdataCompanyId));
  const matching = current.filter(
    (entry) => {
      const id = employmentCompanyId(entry);
      return id !== null && allowed.has(id) && matchesTitle(entry, titleVariants);
    },
  );
  return resolvePrimaryCurrent(matching);
}

export function cleanProfiles(raw: RawProfile[], options: CleaningOptions = {}): { profiles: CleanProfile[]; stats: CleaningStats } {
  const stats: CleaningStats = {
    input: raw.length,
    kept: 0,
    droppedNoHistory: 0,
    droppedThinHistory: 0,
    droppedNoIdentity: 0,
    droppedScopeMismatch: 0,
  };
  const out: CleanProfile[] = [];
  const seenIds = new Set<string>();

  for (const p of raw) {
    const id = String(p.crustdata_person_id);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const name = p.basic_profile?.name;
    if (!name) {
      stats.droppedNoIdentity++;
      continue;
    }

    const current = p.experience?.employment_details?.current ?? [];
    const past = p.experience?.employment_details?.past ?? [];
    const primary = resolveScopedCurrent(current, options.companyScope, options.titleVariants ?? []);
    if (!primary || !primary.title) {
      if (options.companyScope) stats.droppedScopeMismatch++;
      else stats.droppedNoHistory++;
      continue;
    }

    // Full role history: past + all current entries, chronological.
    const historyEntries = [...past, ...current]
      .map(toRoleEntry)
      .filter((e): e is RoleEntry => e !== null)
      .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));

    // PRD §6.4: drop profiles whose history is too thin to characterize a path.
    if (historyEntries.length < 2) {
      stats.droppedThinHistory++;
      continue;
    }

    const firstStart = historyEntries.find((e) => e.start)?.start;
    const yearsExperience = firstStart
      ? Math.max(0, Math.round(new Date().getFullYear() - Number(firstStart.slice(0, 4))))
      : null;

    out.push({
      id,
      name,
      linkedinUrl: p.social_handles?.professional_network_identifier?.profile_url ?? null,
      currentTitle: primary.title,
      currentCompany: primary.name ?? "",
      location: p.basic_profile?.location?.raw ?? null,
      yearsExperience,
      education: (p.education?.schools ?? [])
        .filter((s) => s.school)
        .map((s) => ({ school: s.school as string, degree: s.degree ?? null })),
      history: historyEntries,
      matchedCurrentRole: {
        title: primary.title,
        company: primary.name ?? "",
        companyId: employmentCompanyId(primary),
      },
    });
    stats.kept++;
  }

  return { profiles: out, stats };
}

// ---------- Career-history signal extraction ----------
//
// Vendor histories are padded with committees, fellowships, accelerator
// cohorts, and summer programs. Two orthogonal signals separate them from
// employment, and neither alone is sufficient:
//   1. vocabulary — a "Fellowship Co-Director" is not a job. Matched against
//      "title · company" because the giveaway is often the organization
//      ("Secretary · Colgate Finance Club"), not the title. `intern` carries a
//      trailing boundary so it can't swallow "internal" / "international".
//   2. duration — programs run weeks, jobs run months.
//
// Shared by the UI timeline and the exemplar ranker so both agree on what
// counts as a career.

const NOISE_PATTERN =
  /\b(committee|clubs?|society|fellow|scholar|volunteer|ambassador|mentor|board (member|observer)|chapter|student|cohort|co-chair|chair|participant|accelerator|bootcamp|delegate|contributor|academy|summer program|undergraduate|campus|tutor|liaison|intern(ship)?s?\b)/i;

const MIN_JOB_MONTHS = 6;

export const isNoiseRole = (r: RoleEntry): boolean => NOISE_PATTERN.test(`${r.title} ${r.company}`);

/** Months a role spanned; an ongoing role counts as long-running. */
export function roleMonths(r: RoleEntry): number {
  if (!r.end) return Infinity;
  if (!r.start) return 0;
  const [sy, sm] = r.start.split("-").map(Number);
  const [ey, em] = r.end.split("-").map(Number);
  return (ey - sy) * 12 + (em - sm);
}

/**
 * The roles that actually constitute a career. Falls back progressively so a
 * person with only short or oddly-titled roles is never reduced to nothing.
 */
export function substantiveHistory(history: RoleEntry[]): RoleEntry[] {
  const jobs = history.filter((r) => !isNoiseRole(r) && roleMonths(r) >= MIN_JOB_MONTHS);
  if (jobs.length >= 2) return jobs;
  const nonNoise = history.filter((r) => !isNoiseRole(r));
  return nonNoise.length >= 2 ? nonNoise : history;
}

/** Higher education only, unless that's all the person has. */
export function higherEducation(p: CleanProfile): CleanProfile["education"] {
  const higher = p.education.filter((e) => !/\b(high school|secondary school)\b/i.test(e.school));
  return higher.length > 0 ? higher : p.education;
}

/** Compact one-line-per-role text form of a career history for LLM prompts. */
export function careerSummary(p: CleanProfile, idOverride?: string): string {
  const path = p.history
    .map((r) => {
      const span = r.start ? `${r.start.slice(0, 4)}–${r.end ? r.end.slice(0, 4) : "now"}` : "dates unknown";
      return `${r.title} @ ${r.company} (${span})`;
    })
    .join(" → ");
  const edu = p.education.map((e) => (e.degree ? `${e.school} (${e.degree})` : e.school)).join("; ") || "none listed";
  const yoe = p.yearsExperience !== null ? `~${p.yearsExperience}y experience` : "experience unknown";
  return `[${idOverride ?? p.id}] Current: ${p.currentTitle} @ ${p.currentCompany}. ${yoe}. Path: ${path}. Education: ${edu}`;
}
