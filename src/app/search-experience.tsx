"use client";

// The search box, staged loading state, and every non-ok outcome state.
// Loading progress is REAL: the API streams actual pipeline stages over SSE.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "@/lib/analytics.ts";

type Chip = { canonical_key: string; role_description: string };

type DoneEvent =
  | { kind: "ok"; canonicalKey: string; cacheHit: boolean; latencyMs: number }
  | { kind: "invalid_query"; suggestions: string[] }
  | { kind: "thin_data"; suggestions: string[]; usableProfiles: number }
  | { kind: "rate_limited"; scope: string; availableRoles: Chip[] }
  | { kind: "degraded"; reason: string; availableRoles: Chip[] }
  | { kind: "error"; availableRoles: Chip[] };

// Honest narration for each real pipeline stage.
const STAGES = [
  { id: "parsing", label: "Reading your role" },
  { id: "fetching", label: "Finding people currently in this role" },
  { id: "clustering", label: "Analyzing their career histories" },
  { id: "caching", label: "Grouping into paths" },
] as const;
type StageId = (typeof STAGES)[number]["id"];

function stageIndex(stage: string): number {
  if (stage === "cache_check") return 0;
  if (stage === "cleaning") return 1;
  const i = STAGES.findIndex((s) => s.id === stage);
  return i === -1 ? 0 : i;
}

export function SearchExperience({ chips, initialQuery }: { chips: string[]; initialQuery?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [activeStage, setActiveStage] = useState(0);
  const [stageDetail, setStageDetail] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<Exclude<DoneEvent, { kind: "ok" }> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (phase !== "loading") return;
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || phase === "loading") return;
    setQuery(trimmed);
    setOutcome(null);
    setPhase("loading");
    setActiveStage(0);
    setStageDetail(null);
    setElapsed(0);
    track("search_submitted", { raw_query: trimmed });

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`search failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: DoneEvent | null = null;

      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const eventMatch = frame.match(/^event: (.+)$/m);
          const dataMatch = frame.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const data = JSON.parse(dataMatch[1]);
          if (eventMatch[1] === "stage") {
            setActiveStage(stageIndex(data.stage));
            if (data.stage === "clustering" && typeof data.detail === "string") {
              const m = data.detail.match(/^(\d+) profiles$/);
              if (m) setStageDetail(`${m[1]} people found`);
            }
          } else if (eventMatch[1] === "done") {
            done = data as DoneEvent;
          }
        }
      }

      if (!done) throw new Error("stream ended without result");
      if (done.kind === "ok") {
        router.push(`/role/${encodeURIComponent(done.canonicalKey)}`);
        return; // keep the loading state up during navigation
      }
      if (done.kind === "thin_data") track("thin_data_shown", { query: trimmed });
      if (done.kind === "rate_limited") track("rate_limited", { scope: done.scope });
      if (done.kind === "degraded") track("degraded_mode_shown", { reason: done.reason });
      if (done.kind === "error") track("pipeline_error", { query: trimmed });
      setOutcome(done);
      setPhase("done");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      track("pipeline_error", { query: trimmed, client: true });
      setOutcome({ kind: "error", availableRoles: [] });
      setPhase("done");
    }
  }

  if (phase === "loading") {
    return (
      <div className="fade-in" aria-live="polite">
        <p style={{ fontSize: 15, color: "var(--on-deep-soft)", marginBottom: 20 }}>
          Mapping paths to <strong style={{ color: "var(--on-deep)", fontWeight: 600 }}>{query}</strong>
          {" · "}
          <span className="mono">{elapsed}s</span>
        </p>
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14 }}>
          {STAGES.map((s, i) => {
            const state = i < activeStage ? "done" : i === activeStage ? "active" : "next";
            return (
              <li key={s.id} style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <span
                  aria-hidden
                  className={state === "active" ? "pulse mono" : "mono"}
                  style={{
                    fontSize: 14,
                    width: 18,
                    color: state === "next" ? "oklch(0.68 0.02 172)" : "var(--on-deep)",
                  }}
                >
                  {state === "done" ? "✓" : state === "active" ? "●" : "○"}
                </span>
                <span
                  style={{
                    fontSize: 16,
                    color: state === "next" ? "oklch(0.68 0.02 172)" : state === "active" ? "var(--on-deep)" : "var(--on-deep-soft)",
                    fontWeight: state === "active" ? 500 : 400,
                  }}
                >
                  {s.label}
                  {state === "active" && s.id === "clustering" && stageDetail ? (
                    <span className="mono" style={{ fontSize: 13, marginLeft: 10, color: "var(--on-deep-soft)" }}>
                      {stageDetail}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
        <p style={{ fontSize: 13, color: "var(--on-deep-soft)", marginTop: 24 }}>
          First time we've seen this role — a fresh analysis takes up to a
          minute. Roles we've mapped before load instantly.
        </p>
      </div>
    );
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(query);
        }}
        style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. sports agent, VP of product, quant trader…"
          aria-label="What role are you trying to reach?"
          maxLength={300}
          style={{
            flex: "1 1 320px",
            font: "inherit",
            fontSize: 17,
            padding: "14px 16px",
            borderRadius: 10,
            border: "1px solid oklch(0.45 0.04 172)",
            background: "var(--surface)",
            color: "var(--ink)",
            minWidth: 0,
          }}
        />
        <button
          type="submit"
          disabled={!query.trim()}
          style={{
            padding: "14px 26px",
            borderRadius: 10,
            border: "none",
            background: query.trim() ? "var(--on-deep)" : "oklch(0.45 0.03 172)",
            color: query.trim() ? "var(--brand-deep)" : "oklch(0.7 0.02 172)",
            fontWeight: 600,
            fontSize: 16,
            transition: "background 0.15s ease-out",
          }}
        >
          Map the paths
        </button>
      </form>

      {outcome && <OutcomeNotice outcome={outcome} onPick={submit} />}

      <div style={{ marginTop: 28 }}>
        <p style={{ fontSize: 13.5, color: "var(--on-deep-soft)", marginBottom: 10 }}>Try one of these:</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {chips.map((c) => (
            <button
              key={c}
              onClick={() => submit(c)}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                border: "1px solid oklch(0.45 0.04 172)",
                background: "transparent",
                color: "var(--on-deep)",
                fontSize: 14,
                transition: "background 0.15s ease-out, border-color 0.15s ease-out",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "oklch(0.32 0.05 175)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function OutcomeNotice({
  outcome,
  onPick,
}: {
  outcome: Exclude<DoneEvent, { kind: "ok" }>;
  onPick: (q: string) => void;
}) {
  const router = useRouter();

  const copy: Record<string, { title: string; body: string }> = {
    invalid_query: {
      title: "Tell us a role or job title you're aiming for",
      body: "Something like “sports agent” or “VP of Product” — we'll map how people actually got there.",
    },
    thin_data: {
      title: "This role is too niche for a reliable pattern yet",
      body: "We found too few people currently in it to be honest about the paths. Try a broader or related title:",
    },
    rate_limited: {
      title: "You've hit the hourly limit for new roles",
      body: "Fresh analyses are limited to keep this free. Roles we've already mapped are always available:",
    },
    degraded: {
      title: "High demand right now",
      body: "We're showing previously analyzed roles while new analyses are paused. Try one of these:",
    },
    error: {
      title: "Something broke on our end",
      body: "Your search didn't cost you anything, and it wasn't your fault. Try again in a minute, or explore a mapped role:",
    },
  };
  const { title, body } = copy[outcome.kind];

  const suggestions =
    outcome.kind === "invalid_query" || outcome.kind === "thin_data" ? outcome.suggestions : [];
  const cachedRoles =
    outcome.kind === "rate_limited" || outcome.kind === "degraded" || outcome.kind === "error"
      ? outcome.availableRoles
      : [];

  return (
    <div
      className="fade-in"
      role="status"
      style={{
        marginTop: 18,
        padding: "16px 18px",
        borderRadius: 12,
        background: "oklch(0.32 0.05 175)",
        border: "1px solid oklch(0.42 0.05 172)",
      }}
    >
      <p style={{ fontWeight: 600, marginBottom: 4 }}>{title}</p>
      <p style={{ fontSize: 14.5, color: "var(--on-deep-soft)" }}>{body}</p>
      {(suggestions.length > 0 || cachedRoles.length > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              style={{
                padding: "7px 13px",
                borderRadius: 999,
                border: "1px solid oklch(0.5 0.05 172)",
                background: "transparent",
                color: "var(--on-deep)",
                fontSize: 13.5,
              }}
            >
              {s}
            </button>
          ))}
          {cachedRoles.map((r) => (
            <button
              key={r.canonical_key}
              onClick={() => router.push(`/role/${encodeURIComponent(r.canonical_key)}`)}
              style={{
                padding: "7px 13px",
                borderRadius: 999,
                border: "1px solid oklch(0.5 0.05 172)",
                background: "transparent",
                color: "var(--on-deep)",
                fontSize: 13.5,
              }}
            >
              {r.role_description}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
