// One-off: reproduce the few-assignments failure on the PM pull and inspect
// the raw model response (stop_reason, output shape). Not part of the app.

import Anthropic from "@anthropic-ai/sdk";
import { getFreshPull } from "../lib/db.ts";
import { careerSummary } from "../lib/cleaning.ts";
import { config } from "../lib/config.ts";

const anthropic = new Anthropic();
const pull = await getFreshPull("product manager|startups|mid");
if (!pull) throw new Error("no pull");
const batch = pull.profiles.slice(0, 30);
const ordinals = batch.map((_, i) => String(i + 1));

const labels = [
  "Founder turned Product Manager",
  "Software Engineer to PM",
  "Consulting or Strategy to PM",
  "Marketing or Growth to PM",
  "Domain Expert or Operator to PM",
  "Serial Entrepreneur and Operator",
];

const schema = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", enum: ordinals },
          archetype: { type: "string", enum: [...labels, "not_relevant"] },
        },
        required: ["id", "archetype"],
        additionalProperties: false,
      },
    },
  },
  required: ["assignments"],
  additionalProperties: false,
};

const res = await anthropic.messages.create({
  model: config.clusterModel(),
  max_tokens: 6000,
  system: `You are classifying professionals into fixed career-path archetypes for the target role: Product Manager at a venture-backed startup

Archetypes:
${labels.map((l) => `- "${l}"`).join("\n")}

Rules:
- Assign each person to exactly ONE archetype label — or "not_relevant".
- Return exactly one assignment per input person, keyed by their [id]. The assignments array must have exactly ${batch.length} entries — one for each id from 1 to ${batch.length}. Do not skip anyone.`,
  messages: [{ role: "user", content: `Classify these ${batch.length} people:\n\n${batch.map((p, i) => careerSummary(p, ordinals[i])).join("\n")}` }],
  output_config: { format: { type: "json_schema", schema } },
});

const text = res.content.find((b) => b.type === "text")?.text ?? "";
const parsed = JSON.parse(text);
console.log("stop_reason:", res.stop_reason);
console.log("output_tokens:", res.usage.output_tokens);
console.log("assignments returned:", parsed.assignments?.length);
console.log("first 300 chars:", text.slice(0, 300));
