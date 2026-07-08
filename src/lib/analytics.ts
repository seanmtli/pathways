"use client";

// PostHog wrapper (PRD §11). No-ops cleanly when NEXT_PUBLIC_POSTHOG_KEY is
// unset so local dev and pre-key deploys never break. Do not hand-roll
// analytics beyond this thin wrapper.

import posthog from "posthog-js";

let initialized = false;

function ensureInit(): boolean {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return false;
  if (!initialized) {
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      capture_pageview: true,
      persistence: "memory", // no user PII / identity retained (PRD §6.8)
    });
    initialized = true;
  }
  return true;
}

export type PathwaysEvent =
  | "search_submitted"
  | "results_rendered"
  | "cluster_opened"
  | "person_path_expanded"
  | "person_linkedin_clicked"
  | "cluster_feedback"
  | "exit_survey_clicked"
  | "thin_data_shown"
  | "rate_limited"
  | "degraded_mode_shown"
  | "pipeline_error";

export function track(event: PathwaysEvent, props?: Record<string, unknown>): void {
  if (ensureInit()) posthog.capture(event, props);
}
