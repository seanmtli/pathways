import Link from "next/link";
import { getFreshSearch } from "@/lib/db.ts";
import { LinkedInLink } from "../../interactive.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export default async function ExplorePathPage({
  params,
}: {
  params: Promise<{ key: string; idx: string }>;
}) {
  const { key, idx } = await params;
  const canonicalKey = safeDecode(key);
  const search = await getFreshSearch(canonicalKey).catch(() => null);
  const cluster = search?.clusters[Number(idx)];

  if (!search || !cluster) {
    return (
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "48px 20px" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: 10 }}>This path isn't available anymore</h1>
        <p style={{ color: "var(--ink-soft)", marginBottom: 20 }}>
          The analysis may have been refreshed. Start from the role overview.
        </p>
        <Link href={search ? `/role/${encodeURIComponent(canonicalKey)}` : "/"} style={{ fontWeight: 550 }}>
          {search ? "← Back to results" : "← New search"}
        </Link>
      </main>
    );
  }

  const backHref = `/role/${encodeURIComponent(search.canonical_key)}`;

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 24px 64px" }}>
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Link href={backHref} style={{ fontSize: 14, color: "var(--brand)" }}>
          ← {search.role_description}
        </Link>
        <Link href="/" className="mono" style={{ fontSize: 14.5, fontWeight: 600, color: "var(--brand)" }}>
          pathways
        </Link>
      </nav>

      <header style={{ margin: "32px 0 24px" }}>
        <h1 style={{ fontSize: "clamp(1.4rem, 4vw, 1.9rem)", fontWeight: 600, letterSpacing: "-0.015em" }}>
          {cluster.archetype.label}
        </h1>
        <p style={{ marginTop: 8, fontSize: 15, color: "var(--ink-soft)" }}>
          {cluster.archetype.description}
        </p>
        <p className="mono" style={{ marginTop: 10, fontSize: 14, color: "var(--brand)", fontWeight: 600 }}>
          {cluster.percentage}% of the {search.sample_size} professionals we analyzed · {cluster.members.length} people
        </p>
      </header>

      <div className="roster-head" aria-hidden>
        <span>Name</span>
        <span>Current role</span>
        <span>Education</span>
        <span className="r-loc">Location</span>
        <span style={{ textAlign: "right" }}>Yrs</span>
        <span />
      </div>
      <ul className="roster">
        {cluster.members.map((p) => {
          const edu = p.education[0]?.school ?? "—";
          const yoe = p.yearsExperience !== null ? `~${p.yearsExperience}y` : "";
          return (
            <li key={p.id}>
              <span className="r-name">{p.name}</span>
              <span className="r-role">
                {p.currentTitle}
                {p.currentCompany ? ` · ${p.currentCompany}` : ""}
              </span>
              <span className="r-edu" data-yoe={yoe} title={p.education.map((e) => e.school).join("; ")}>
                {edu}
              </span>
              <span className="r-loc" title={p.location ?? undefined}>
                {p.location ? p.location.split(",").slice(0, 2).join(",") : "—"}
              </span>
              <span className="r-yoe mono">{yoe || "—"}</span>
              <span className="r-link">
                {p.linkedinUrl ? <LinkedInLink url={p.linkedinUrl} canonicalKey={search.canonical_key} /> : null}
              </span>
            </li>
          );
        })}
      </ul>

      <p style={{ marginTop: 20, fontSize: 13, color: "var(--ink-soft)" }}>
        Everyone above is currently in or near this role, per public
        professional profiles. Some LinkedIn links may be private or out of
        date — that's the data, not a promise.
      </p>
    </main>
  );
}
