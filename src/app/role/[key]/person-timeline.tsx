"use client";

// Expandable career timelines — the journey behind every sample person.
// Shared by the results-page example people (ExamplePerson) and the Explore
// Path roster rows (RosterRow). All data comes from the cached pull
// (CleanProfile.history) — zero additional vendor cost.

import { useState } from "react";
import { substantiveHistory, higherEducation, type CleanProfile, type RoleEntry } from "@/lib/cleaning.ts";
import { track } from "@/lib/analytics.ts";
import { LinkedInLink } from "./interactive.tsx";

function yearSpan(r: RoleEntry): string {
  const start = r.start ? r.start.slice(0, 4) : "?";
  if (!r.end) return `${start}–now`;
  const end = r.end.slice(0, 4);
  return start === end ? start : `${start}–${end}`;
}

// Vendor histories are padded with student clubs, committees, and volunteer
// posts. They drown the actual career story, so drop them — unless doing so
// would leave nothing (some people genuinely have only these).
const MAX_ROLES = 6;

function Timeline({ person }: { person: CleanProfile }) {
  const roles = substantiveHistory(person.history);
  // Show the most recent roles — the end of the path is what a career
  // explorer is walking backwards from.
  const shown = roles.slice(-MAX_ROLES);
  const hidden = roles.length - shown.length;

  // One or two degrees is context; a full list is noise.
  const edu = higherEducation(person)
    .slice(0, 2)
    .map((e) => (e.degree ? `${e.school} — ${e.degree}` : e.school))
    .join(" · ");

  return (
    <div className="fade-in timeline" role="region" aria-label={`Career path of ${person.name}`}>
      {edu && <div className="t-edu">🎓 {edu}</div>}
      {hidden > 0 && <div className="t-earlier">+{hidden} earlier {hidden === 1 ? "role" : "roles"}</div>}
      <ol>
        {shown.map((r, i) => (
          <li key={`${r.start ?? "x"}-${i}`} className={!r.end ? "t-now" : undefined}>
            <span className="mono t-years">{yearSpan(r)}</span>
            <span className="t-role">
              <strong>{r.title}</strong>
              {r.company ? <span className="t-co"> · {r.company}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function useExpand(canonicalKey: string, personId: string) {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    setOpen((v) => {
      if (!v) track("person_path_expanded", { canonical_key: canonicalKey, person_id: personId });
      return !v;
    });
  };
  return { open, toggle };
}

/** Example person on a results-page path card. */
export function ExamplePerson({ person, canonicalKey }: { person: CleanProfile; canonicalKey: string }) {
  const { open, toggle } = useExpand(canonicalKey, person.id);
  return (
    <li className="xp" style={{ minWidth: 0 }}>
      <button type="button" className="xp-row" aria-expanded={open} onClick={toggle}>
        <span aria-hidden className="mono xp-chevron">{open ? "▾" : "▸"}</span>
        <span className="xp-name">{person.name}</span>
        <span className="xp-role">
          {person.currentTitle}
          {person.currentCompany ? ` · ${person.currentCompany}` : ""}
        </span>
      </button>
      {open && <Timeline person={person} />}
    </li>
  );
}

/** Roster row on the Explore Path page — same grid as the roster header. */
export function RosterRow({ person, canonicalKey }: { person: CleanProfile; canonicalKey: string }) {
  const { open, toggle } = useExpand(canonicalKey, person.id);
  const edu = person.education[0]?.school ?? "—";
  const yoe = person.yearsExperience !== null ? `~${person.yearsExperience}y` : "";
  return (
    <li className={open ? "r-open" : undefined}>
      <button type="button" className="r-toggle" aria-expanded={open} onClick={toggle} title="Show career path">
        <span className="r-name">
          <span aria-hidden className="mono xp-chevron">{open ? "▾" : "▸"}</span>
          {person.name}
        </span>
        <span className="r-role">
          {person.currentTitle}
          {person.currentCompany ? ` · ${person.currentCompany}` : ""}
        </span>
        <span className="r-edu" data-yoe={yoe} title={person.education.map((e) => e.school).join("; ")}>
          {edu}
        </span>
        <span className="r-loc" title={person.location ?? undefined}>
          {person.location ? person.location.split(",").slice(0, 2).join(",") : "—"}
        </span>
        <span className="r-yoe mono">{yoe || "—"}</span>
      </button>
      <span className="r-link">
        {person.linkedinUrl ? <LinkedInLink url={person.linkedinUrl} canonicalKey={canonicalKey} /> : null}
      </span>
      {open && (
        <div className="r-timeline">
          <Timeline person={person} />
        </div>
      )}
    </li>
  );
}
