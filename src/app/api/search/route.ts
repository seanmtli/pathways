// POST /api/search — runs the pipeline and streams REAL stage progress as
// Server-Sent Events (PRD §5.4: progressive and honest, never a bare spinner).
// Issues the anonymous httpOnly session cookie used for rate limiting (§6.6).

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { runPipeline, type PipelineOutcome, type PipelineStage } from "@/lib/pipeline.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SESSION_COOKIE = "pw_session";

// The outcome sent to the client omits heavy roster payloads — results render
// from the cached row on /role/[key]; the stream only needs routing info.
function slimOutcome(o: PipelineOutcome): object {
  if (o.kind === "ok") {
    return {
      kind: "ok",
      canonicalKey: o.canonicalKey,
      cacheHit: o.cacheHit,
      latencyMs: o.latencyMs,
      sampleSize: o.sampleSize,
      clusterCount: o.clusters.length,
      sampleQuality: o.sampleQuality,
      companyScopeLabel: o.companyScope?.label ?? null,
    };
  }
  return o;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { query?: string } | null;
  const query = body?.query?.trim();
  if (!query || query.length > 300) {
    return Response.json({ error: "query required (≤300 chars)" }, { status: 400 });
  }

  const cookieStore = await cookies();
  let session = cookieStore.get(SESSION_COOKIE)?.value;
  const isNewSession = !session;
  if (!session) session = randomUUID();

  const headerStore = await headers();
  const ip = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headerStore.get("x-real-ip") ?? null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: object) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client disconnected — pipeline keeps running so the cache still fills
        }
      };
      // Heartbeat keeps proxies from killing the connection during clustering.
      const heartbeat = setInterval(() => send("ping", { t: Date.now() }), 10_000);
      try {
        const outcome = await runPipeline(query, {
          sessionToken: session!,
          ip,
          onStage: (stage: PipelineStage, detail?: string) => {
            // Batch-level clustering chatter stays server-side; the client
            // gets the stage transitions it can honestly narrate.
            if (stage === "clustering" && detail && !/^\d+ profiles$/.test(detail) && !detail.startsWith("Pass")) return;
            send("stage", { stage, detail });
          },
        });
        send("done", slimOutcome(outcome));
      } catch (err) {
        send("done", { kind: "error", availableRoles: [] });
        console.error("search route:", err);
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  const res = new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
  if (isNewSession) {
    res.headers.append(
      "set-cookie",
      `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
  }
  return res;
}
