"use client";

// Client islands for the results + roster pages: feedback widget, analytics
// tracking, and tracked links.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { track } from "@/lib/analytics.ts";

export function ResultsTracker({
  canonicalKey,
  sampleSize,
  clusterCount,
  scopeKind,
  scopeKey,
  sampleQuality,
}: {
  canonicalKey: string;
  sampleSize: number;
  clusterCount: number;
  scopeKind: string | null;
  scopeKey: string | null;
  sampleQuality: "standard" | "small";
}) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track("results_rendered", {
      canonical_key: canonicalKey,
      sample_size: sampleSize,
      cluster_count: clusterCount,
      scope_kind: scopeKind,
      scope_key: scopeKey,
      sample_quality: sampleQuality,
    });
    const survey = document.querySelector("[data-survey-link]");
    const onClick = () => track("exit_survey_clicked", { canonical_key: canonicalKey });
    survey?.addEventListener("click", onClick);
    return () => survey?.removeEventListener("click", onClick);
  }, [canonicalKey, sampleSize, clusterCount, scopeKind, scopeKey, sampleQuality]);
  return null;
}

export function PathLink({
  href,
  label,
  canonicalKey,
  children,
}: {
  href: string;
  label: string;
  canonicalKey: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{ color: "inherit" }}
      onClick={() => track("cluster_opened", { canonical_key: canonicalKey, cluster: label })}
    >
      {children}
    </Link>
  );
}

export function LinkedInLink({ url, canonicalKey }: { url: string; canonicalKey: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="LinkedIn profile (may be private or unavailable)"
      title="LinkedIn profile — some links may be dead or private"
      onClick={() => track("person_linkedin_clicked", { canonical_key: canonicalKey })}
      style={{ color: "var(--ink-soft)", display: "inline-flex", padding: 4 }}
    >
      {/* Deliberately secondary affordance (PRD §5.5): an icon, not a promise */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z" />
      </svg>
    </a>
  );
}

export function FeedbackWidget({ canonicalKey, clusterLabel }: { canonicalKey: string; clusterLabel: string }) {
  const [state, setState] = useState<"idle" | "commenting" | "sent">("idle");
  const [thumb, setThumb] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");

  // The thumb is stored the moment it's clicked (so it's never lost); a
  // comment submitted afterwards amends that same row.
  async function sendThumb(thumbsUp: boolean) {
    track("cluster_feedback", { canonical_key: canonicalKey, cluster: clusterLabel, thumbs_up: thumbsUp });
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonicalKey, clusterLabel, thumbsUp }),
    }).catch(() => {});
  }
  async function sendComment(text: string) {
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonicalKey, clusterLabel, thumbsUp: thumb, comment: text, amend: true }),
    }).catch(() => {});
  }

  if (state === "sent") {
    return (
      <span className="fade-in" style={{ fontSize: 13.5, color: "var(--ink-soft)" }} role="status">
        Thanks — noted.
      </span>
    );
  }

  if (state === "commenting") {
    return (
      <form
        className="fade-in"
        style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (comment.trim()) void sendComment(comment.trim());
          setState("sent");
        }}
      >
        <input
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What's off (or right) about it?"
          maxLength={200}
          aria-label="Optional feedback comment"
          style={{
            font: "inherit",
            fontSize: 13.5,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: "var(--surface)",
            color: "var(--ink)",
            width: 220,
          }}
        />
        <button
          type="submit"
          style={{
            fontSize: 13,
            padding: "6px 12px",
            borderRadius: 8,
            border: "none",
            background: "var(--brand)",
            color: "white",
            fontWeight: 550,
          }}
        >
          Send
        </button>
      </form>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13.5, color: "var(--ink-soft)" }}>
      Does this match how you understand this path?
      <button
        aria-label="Yes, this path rings true"
        onClick={() => {
          setThumb(true);
          void sendThumb(true);
          setState("commenting");
        }}
        style={thumbStyle}
      >
        👍
      </button>
      <button
        aria-label="No, this path seems off"
        onClick={() => {
          setThumb(false);
          void sendThumb(false);
          setState("commenting");
        }}
        style={thumbStyle}
      >
        👎
      </button>
    </span>
  );
}

const thumbStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  background: "var(--surface)",
  borderRadius: 8,
  padding: "4px 8px",
  fontSize: 14,
  lineHeight: 1,
};
