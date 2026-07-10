import Link from "next/link";
import { getFreshSearch } from "@/lib/db.ts";
import { RosterRow } from "../../person-timeline.tsx";

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
  const scope = search.company_scope;
  const scopedCompanies = scope && "companies" in scope ? scope.companies : [];
  const pullCountry = search.pull_country;

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
        {scope && (
          <p style={{ marginTop: 10, fontSize: 13.5, color: "var(--ink-soft)" }}>
            Current-employer scope:{" "}
            {scopedCompanies.length > 0
              ? scopedCompanies.map((company) => company.canonicalName).join(", ")
              : scope.label}
            {search.sample_quality === "small" ? " · Small sample; percentages are directional." : ""}
            {pullCountry ? ` · Current location: ${pullCountry}.` : ""}
          </p>
        )}
        {!scope && search.sample_quality === "small" && (
          <p style={{ marginTop: 10, fontSize: 13.5, color: "var(--ink-soft)" }}>
            Small sample; percentages are directional.
          </p>
        )}
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
        {cluster.members.map((p) => (
          <RosterRow key={p.id} person={p} canonicalKey={search.canonical_key} />
        ))}
      </ul>

      <p style={{ marginTop: 20, fontSize: 13, color: "var(--ink-soft)" }}>
        Click any person to unfold the career path that got them here.
        Everyone above is currently in or near this role, per public
        professional profiles. Some LinkedIn links may be private or out of
        date — that's the data, not a promise.
      </p>
    </main>
  );
}
