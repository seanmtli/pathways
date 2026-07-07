// POST /api/feedback — per-cluster thumbs + optional comment (PRD §5.5).

import { cookies } from "next/headers";
import { amendFeedbackComment, insertFeedback } from "@/lib/db.ts";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    canonicalKey?: string;
    clusterLabel?: string;
    thumbsUp?: boolean;
    comment?: string;
    amend?: boolean;
  } | null;

  if (!body?.canonicalKey || !body.clusterLabel) {
    return Response.json({ error: "canonicalKey and clusterLabel required" }, { status: 400 });
  }

  const session = (await cookies()).get("pw_session")?.value ?? null;
  try {
    if (body.amend && body.comment?.trim() && session) {
      // Attach the one-line comment to the thumb this session just left.
      const amended = await amendFeedbackComment({
        canonical_key: body.canonicalKey.slice(0, 300),
        cluster_label: body.clusterLabel.slice(0, 200),
        session_token: session,
        comment: body.comment.slice(0, 500),
      });
      if (amended) return Response.json({ ok: true });
      // fall through to insert if there was no row to amend
    }
    if (typeof body.thumbsUp !== "boolean") {
      return Response.json({ error: "thumbsUp required" }, { status: 400 });
    }
    await insertFeedback({
      canonical_key: body.canonicalKey.slice(0, 300),
      cluster_label: body.clusterLabel.slice(0, 200),
      thumbs_up: body.thumbsUp,
      comment: body.comment?.slice(0, 500) || null,
      session_token: session,
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("feedback route:", err);
    return Response.json({ error: "failed to save" }, { status: 500 });
  }
}
