import test from "node:test";
import assert from "node:assert/strict";
import { initialFrame, nextFrame } from "./typewriter.ts";
import { PLACEHOLDER_PROMPTS } from "./seeds.ts";

test("prompts are short question sentences", () => {
  assert.ok(PLACEHOLDER_PROMPTS.length >= 4);
  for (const p of PLACEHOLDER_PROMPTS) {
    assert.ok(p.length <= 60, `too long: ${p}`);
    assert.ok(p.endsWith("?"), `not a question: ${p}`);
  }
});

test("full cycle: types prompt 0, holds, deletes, advances to prompt 1", () => {
  const prompts = ["Ab?", "Cd?"];
  let f = initialFrame();
  const seen: string[] = [];
  // Run until we're typing prompt 1; cap iterations to catch infinite loops.
  for (let i = 0; i < 100 && !(f.promptIndex === 1 && f.phase === "typing" && f.text.length > 0); i++) {
    f = nextFrame(f, prompts);
    seen.push(`${f.phase}:${f.text}`);
  }
  assert.ok(seen.includes("typing:A"));
  assert.ok(seen.includes("holding:Ab?"), "must hold the full prompt");
  assert.ok(seen.includes("deleting:Ab"));
  assert.ok(seen.some((s) => s.startsWith("gap:")), "must pause between prompts");
  assert.equal(f.promptIndex, 1);
  assert.equal(f.text, "C");
});

test("wraps from last prompt back to first", () => {
  const prompts = ["A?", "B?"];
  let f = { text: "", promptIndex: 1, phase: "deleting" as const, delayMs: 30 };
  f = nextFrame(f, prompts); // empty text while deleting -> advance + gap
  assert.equal(f.promptIndex, 0);
  assert.equal(f.phase, "gap");
});

test("every frame has a positive delay", () => {
  let f = initialFrame();
  for (let i = 0; i < 50; i++) {
    f = nextFrame(f, PLACEHOLDER_PROMPTS);
    assert.ok(f.delayMs > 0);
  }
});
