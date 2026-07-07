// LLM access via OpenRouter (OpenAI-compatible chat completions).
// One module owns the provider; parser.ts and clustering.ts only speak
// jsonCall(). Models are env-configured slugs (config.parseModel /
// config.clusterModel) — any OpenRouter model with structured-output
// support can be swapped in without a code change.

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

function apiKey(): string {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new Error("Missing required env var: OPENROUTER_API_KEY");
  return k;
}

interface JsonCallOpts {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; code?: number };
}

/**
 * One structured-output call: returns parsed JSON conforming to `schema`.
 * Retries transient failures (429/5xx/network) once with backoff; schema
 * violations are NOT retried here — callers own content-level validation
 * (the §6.5 validation pass), since provider enforcement varies.
 */
export async function jsonCall<T>(opts: JsonCallOpts, attempt = 0): Promise<T> {
  let res: Response | null = null;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey()}`,
        "content-type": "application/json",
        "http-referer": "https://github.com/seanmtli/pathways",
        "x-openrouter-title": "Pathways",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        max_tokens: opts.maxTokens,
        response_format: {
          type: "json_schema",
          json_schema: { name: "result", strict: true, schema: opts.schema },
        },
        // Only route to providers that actually honor response_format —
        // silent schema-dropping is worse than a routing failure.
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return jsonCall(opts, 1);
    }
    throw err;
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 4000));
      return jsonCall(opts, 1);
    }
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const data = (await res.json()) as ChatResponse;
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message}`);
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error(`LLM returned no content (finish_reason: ${choice?.finish_reason ?? "unknown"})`);
  return JSON.parse(content) as T;
}
