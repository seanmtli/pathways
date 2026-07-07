import { SearchExperience } from "./search-experience.tsx";
import { EXAMPLE_CHIPS } from "@/lib/seeds.ts";

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return (
    <main
      style={{
        background: "linear-gradient(180deg, var(--brand-deep) 0%, var(--brand-deep-2) 100%)",
        color: "var(--on-deep)",
        minHeight: "calc(100dvh - 78px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ padding: "22px clamp(20px, 5vw, 48px)" }}>
        <span
          className="mono"
          style={{ fontSize: 15, fontWeight: 600, letterSpacing: "0.02em", color: "var(--on-deep)" }}
        >
          pathways
        </span>
      </header>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "24px clamp(20px, 5vw, 48px) 64px",
          maxWidth: 860,
          width: "100%",
          margin: "0 auto",
        }}
      >
        <h1
          style={{
            fontSize: "clamp(1.9rem, 5.5vw, 3.1rem)",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            marginBottom: 14,
          }}
        >
          What role are you trying to reach?
        </h1>
        <p style={{ fontSize: "clamp(1rem, 2.2vw, 1.125rem)", color: "var(--on-deep-soft)", marginBottom: 32 }}>
          See the real career paths real people took to get there — grouped into
          the patterns that actually worked, with the people behind each one.
        </p>

        <SearchExperience chips={EXAMPLE_CHIPS} initialQuery={q?.slice(0, 300)} />
      </div>
    </main>
  );
}
