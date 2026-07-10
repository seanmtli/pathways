import Link from "next/link";
import { getFreshSearch } from "@/lib/db.ts";
import { FeedbackWidget, ResultsTracker, PathLink } from "./interactive.tsx";
import { ExamplePerson } from "./person-timeline.tsx";
import { EXAMPLE_CHIPS } from "@/lib/seeds.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export default async function ResultsPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const canonicalKey = safeDecode(key);
  const search = await getFreshSearch(canonicalKey).catch(() => null);

  if (!search) {
    return (
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "48px 20px" }}>
        <TopBar />
        <h1 style={{ fontSize: "1.6rem", marginTop: 40, marginBottom: 10 }}>
          We haven't mapped this role yet
        </h1>
        <p style={{ color: "var(--ink-soft)", marginBottom: 24 }}>
          This link may have expired, or the role hasn't been analyzed. Run a
          fresh search — it takes about a minute.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {EXAMPLE_CHIPS.map((c) => (
            <Link
              key={c}
              href={`/?q=${encodeURIComponent(c)}`}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                border: "1px solid var(--line)",
                fontSize: 14,
                color: "var(--brand)",
              }}
            >
              {c}
            </Link>
          ))}
        </div>
      </main>
    );
  }

  const surveyUrl = process.env.EXIT_SURVEY_URL;
  const refreshed = new Date(search.refreshed_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const maxPct = Math.max(...search.clusters.map((c) => c.percentage), 1);
  const scope = search.company_scope;
  const scopedCompanies = scope && "companies" in scope ? scope.companies : [];
  const pullCountry = search.pull_country;

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 24px 64px" }}>
      <ResultsTracker
        canonicalKey={search.canonical_key}
        sampleSize={search.sample_size}
        clusterCount={search.clusters.length}
        scopeKind={scope?.kind ?? null}
        scopeKey={search.company_scope_key}
        sampleQuality={search.sample_quality}
      />
      <TopBar />

      <header style={{ margin: "36px 0 8px" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 4.5vw, 2.1rem)", fontWeight: 600, letterSpacing: "-0.015em" }}>
          Career paths to {search.role_description}
        </h1>
        <p style={{ marginTop: 10, fontSize: 15, color: "var(--ink-soft)" }}>
          Based on{" "}
          <strong className="mono" style={{ color: "var(--ink)", fontWeight: 600 }}>
            {search.sample_size}
          </strong>{" "}
          professionals currently in this type of role — the share each path
          shows is of the people we analyzed, not of everyone who's ever done
          it. Data refreshed {refreshed}.
        </p>
        {scope && (
          <div
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 10,
              background: "var(--brand-tint)",
              color: "var(--ink-soft)",
              fontSize: 14,
            }}
          >
            {scopedCompanies.length > 0 ? (
              <p>
                Searched current employees at{" "}
                <strong style={{ color: "var(--ink)" }}>
                  {scopedCompanies.map((company) => company.canonicalName).join(", ")}
                </strong>
                {scope.kind === "set" ? ` · cohort dated ${scope.asOf}` : ""}.
              </p>
            ) : (
              <p>{scope.kind === "structural" ? scope.description : scope.label}</p>
            )}
            {scope.kind === "inferred" && (
              <p style={{ marginTop: 6 }}>
                This company group was suggested by AI and each employer was verified against Crustdata.
              </p>
            )}
            {search.sample_quality === "small" && (
              <p style={{ marginTop: 6 }}>
                Small sample: treat path percentages as directional rather than population estimates.
              </p>
            )}
            {pullCountry && <p style={{ marginTop: 6 }}>Sample limited to people currently located in {pullCountry}.</p>}
          </div>
        )}
        {!scope && search.sample_quality === "small" && (
          <p
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 10,
              background: "var(--brand-tint)",
              color: "var(--ink-soft)",
              fontSize: 14,
            }}
          >
            Small sample: treat path percentages as directional rather than population estimates.
          </p>
        )}
      </header>

      <ol style={{ listStyle: "none", margin: "28px 0 0", padding: 0 }}>
        {search.clusters.map((cluster, i) => (
          <li
            key={cluster.archetype.label}
            className="row-in"
            style={
              {
                "--i": i,
                padding: "22px 0 18px",
                borderTop: "1px solid var(--line)",
              } as React.CSSProperties
            }
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
              <span
                className="mono"
                style={{ fontSize: "1.7rem", fontWeight: 600, color: "var(--brand)", minWidth: 72 }}
              >
                {cluster.percentage}%
              </span>
              <div style={{ flex: 1, minWidth: 240 }}>
                <PathLink
                  href={`/role/${encodeURIComponent(search.canonical_key)}/path/${i}`}
                  label={cluster.archetype.label}
                  canonicalKey={search.canonical_key}
                >
                  <h2 style={{ fontSize: "1.15rem", fontWeight: 600, display: "inline" }}>
                    {cluster.archetype.label}
                  </h2>
                </PathLink>
                <span className="mono" style={{ fontSize: 13, color: "var(--ink-soft)", marginLeft: 10 }}>
                  {cluster.members.length} people
                </span>
              </div>
            </div>

            {/* Share bar — scaled to the largest cluster so differences read instantly */}
            <div
              aria-hidden
              style={{
                height: 6,
                borderRadius: 3,
                background: "var(--brand-tint)",
                margin: "10px 0 12px",
                overflow: "hidden",
              }}
            >
              <div
                className="bar-fill"
                style={
                  {
                    "--i": i,
                    height: "100%",
                    width: `${(cluster.percentage / maxPct) * 100}%`,
                    background: "var(--bar)",
                    borderRadius: 3,
                  } as React.CSSProperties
                }
              />
            </div>

            <div className="cluster-body">
              <p style={{ fontSize: 15, color: "var(--ink-soft)" }}>
                {cluster.archetype.description}
              </p>

              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6, minWidth: 0, fontSize: 14 }}>
              {cluster.members.slice(0, 3).map((p) => (
                <ExamplePerson key={p.id} person={p} canonicalKey={search.canonical_key} />
              ))}
              </ul>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
              <PathLink
                href={`/role/${encodeURIComponent(search.canonical_key)}/path/${i}`}
                label={cluster.archetype.label}
                canonicalKey={search.canonical_key}
              >
                <span style={{ fontSize: 14.5, fontWeight: 550, color: "var(--brand)" }}>
                  Explore this path — all {cluster.members.length} people →
                </span>
              </PathLink>
              <FeedbackWidget canonicalKey={search.canonical_key} clusterLabel={cluster.archetype.label} />
            </div>
          </li>
        ))}
      </ol>

      {search.stats.notRelevant > 0 && (
        <p style={{ marginTop: 20, fontSize: 13, color: "var(--ink-soft)" }}>
          {search.stats.notRelevant} profiles matched the search but weren't
          genuinely in this role, so we excluded them from the numbers above.
        </p>
      )}

      {surveyUrl && (
        <p style={{ marginTop: 32, fontSize: 14.5 }}>
          Did this help?{" "}
          <a href={surveyUrl} target="_blank" rel="noopener noreferrer" data-survey-link>
            2 minutes of feedback →
          </a>
        </p>
      )}
    </main>
  );
}

function TopBar() {
  return (
    <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Link href="/" className="mono" style={{ fontSize: 14.5, fontWeight: 600, color: "var(--brand)" }}>
        pathways
      </Link>
      <Link href="/" style={{ fontSize: 14, color: "var(--brand)" }}>
        New search
      </Link>
    </nav>
  );
}
