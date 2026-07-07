// Cleaning pass (PRD §6.4): resolve the primary current role, drop thin
// profiles, and reduce each profile to the render-necessary fields.

import type { RawEmployment, RawProfile } from "./crustdata.ts";

export interface RoleEntry {
  title: string;
  company: string;
  start: string | null; // "YYYY-MM"
  end: string | null; // null = present
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
  return { title: e.title, company: e.name, start: ym(e.start_date), end: ym(e.end_date) };
}

export interface CleaningStats {
  input: number;
  kept: number;
  droppedNoHistory: number;
  droppedThinHistory: number;
  droppedNoIdentity: number;
}

export function cleanProfiles(raw: RawProfile[]): { profiles: CleanProfile[]; stats: CleaningStats } {
  const stats: CleaningStats = { input: raw.length, kept: 0, droppedNoHistory: 0, droppedThinHistory: 0, droppedNoIdentity: 0 };
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
    const primary = resolvePrimaryCurrent(current);
    if (!primary || !primary.title) {
      stats.droppedNoHistory++;
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
    });
    stats.kept++;
  }

  return { profiles: out, stats };
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
