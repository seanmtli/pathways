# Animated Typing Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The landing-page search bar's placeholder types out short question prompts character-by-character, holds, deletes, and cycles — like nerdapply.com.

**Architecture:** A pure frame reducer (`src/lib/typewriter.ts`, unit-tested, no React) drives a small `setTimeout` hook inside `search-experience.tsx` that writes the animated text into the input's `placeholder` attribute. No new dependencies, no extra DOM.

**Tech Stack:** Next.js (App Router), React 19, TypeScript run natively by Node (type-stripping), `node:test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-typing-placeholder-design.md`
- No new npm dependencies.
- Chips row, submit flow, SSE loading stages, outcome notices, parser, API: untouched.
- Timings: type 55 ms/char, hold 2200 ms, delete 30 ms/char, 400 ms gap between prompts.
- `prefers-reduced-motion: reduce` → no animation, first prompt shown statically.
- Animation runs only while the input is empty.
- Repo quirk: source files import with explicit `.ts`/`.tsx` extensions (e.g. `from "./seeds.ts"`). Follow that.

---

### Task 1: Typewriter frame reducer + prompt list

**Files:**
- Create: `src/lib/typewriter.ts`
- Modify: `src/lib/seeds.ts` (append after `EXAMPLE_CHIPS`, line 11)
- Test: `src/lib/typewriter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 2 relies on these exact names):
  - `seeds.ts`: `export const PLACEHOLDER_PROMPTS: string[]`
  - `typewriter.ts`: `export type TypewriterFrame = { text: string; promptIndex: number; phase: "typing" | "holding" | "deleting" | "gap"; delayMs: number }`
  - `typewriter.ts`: `export function initialFrame(): TypewriterFrame`
  - `typewriter.ts`: `export function nextFrame(f: TypewriterFrame, prompts: readonly string[]): TypewriterFrame`

- [ ] **Step 1: Write the failing test**

Create `src/lib/typewriter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/typewriter.test.ts`
Expected: FAIL — cannot find module `./typewriter.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/typewriter.ts`:

```ts
// Pure frame reducer for the search-bar typing placeholder. Each frame says
// what to show and how long to wait before asking for the next frame.

export type TypewriterFrame = {
  text: string;
  promptIndex: number;
  phase: "typing" | "holding" | "deleting" | "gap";
  delayMs: number;
};

const TYPE_MS = 55;
const HOLD_MS = 2200;
const DELETE_MS = 30;
const GAP_MS = 400;

export function initialFrame(): TypewriterFrame {
  return { text: "", promptIndex: 0, phase: "typing", delayMs: TYPE_MS };
}

export function nextFrame(f: TypewriterFrame, prompts: readonly string[]): TypewriterFrame {
  const prompt = prompts[f.promptIndex] ?? prompts[0] ?? "";
  switch (f.phase) {
    case "typing": {
      const text = prompt.slice(0, f.text.length + 1);
      return text === prompt
        ? { ...f, text, phase: "holding", delayMs: HOLD_MS }
        : { ...f, text, delayMs: TYPE_MS };
    }
    case "holding":
      return { ...f, phase: "deleting", delayMs: DELETE_MS };
    case "deleting": {
      if (f.text === "") {
        return {
          text: "",
          promptIndex: (f.promptIndex + 1) % prompts.length,
          phase: "gap",
          delayMs: GAP_MS,
        };
      }
      return { ...f, text: f.text.slice(0, -1), delayMs: DELETE_MS };
    }
    case "gap":
      return { ...f, phase: "typing", delayMs: TYPE_MS };
  }
}
```

Append to `src/lib/seeds.ts` (after the `EXAMPLE_CHIPS` block and its trailing comment):

```ts
// Cycled by the search bar's typing-placeholder animation. Question-form is
// safe to imitate: the LLM parser extracts the role from full questions.
export const PLACEHOLDER_PROMPTS = [
  "What are the paths to becoming a sports agent?",
  "How do people break into venture capital?",
  "How do you become a chief of staff?",
  "What roles lead to Chief Data Officer?",
  "How did consultants land at MBB?",
  "What's the path to VP of Product?",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/typewriter.test.ts`
Expected: PASS — 4 tests, 0 failures.

Also run the existing suite to confirm nothing broke:
`node --test src/lib/company-scope.test.ts` (needs no real API key; sets its own).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/typewriter.ts src/lib/typewriter.test.ts src/lib/seeds.ts
git commit -m "feat: typewriter frame reducer + placeholder prompts"
```

---

### Task 2: Wire the animation into the search bar

**Files:**
- Modify: `src/app/search-experience.tsx` (imports at top; a hook above `SearchExperience`; the `placeholder` prop at line ~186)

**Interfaces:**
- Consumes (from Task 1): `PLACEHOLDER_PROMPTS` from `@/lib/seeds.ts`; `initialFrame`, `nextFrame` from `@/lib/typewriter.ts`.
- Produces: nothing consumed by later tasks (final task).

- [ ] **Step 1: Add the hook and wire it up**

In `src/app/search-experience.tsx`, extend the imports:

```tsx
import { initialFrame, nextFrame } from "@/lib/typewriter.ts";
import { PLACEHOLDER_PROMPTS } from "@/lib/seeds.ts";
```

Add above `export function SearchExperience(...)`:

```tsx
// Types sample prompts into the placeholder, nerdapply-style. Pauses while
// the input has text; reduced motion gets a static prompt instead.
function useTypingPlaceholder(active: boolean): string {
  const [frame, setFrame] = useState(initialFrame);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (!active || reduced) return;
    const t = setTimeout(() => setFrame((f) => nextFrame(f, PLACEHOLDER_PROMPTS)), frame.delayMs);
    return () => clearTimeout(t);
  }, [active, reduced, frame]);

  return reduced ? PLACEHOLDER_PROMPTS[0] : frame.text;
}
```

Inside `SearchExperience`, after the `query` state declaration:

```tsx
const typingPlaceholder = useTypingPlaceholder(query === "");
```

Change the input's placeholder prop from:

```tsx
placeholder="e.g. sports agent, VP of product, quant trader…"
```

to:

```tsx
placeholder={typingPlaceholder}
```

Note: when `phase === "loading"` the component returns the staged-progress UI before the form renders — the hook still runs (hooks must be unconditional; it's already above the early return) but its timer is cheap and the placeholder is invisible. No special handling needed.

- [ ] **Step 2: Verify in the browser**

Start the dev server (Browser pane, `.claude/launch.json` — create with `npm run dev` on port 3000 if missing) and open `http://localhost:3000`:

1. Watch the search bar: placeholder types a question char-by-char, holds ~2 s, deletes, cycles to the next. Let it run through at least two prompts.
2. Type any text into the input → animation freezes (placeholder hidden). Clear the input → animation resumes.
3. Check the console for errors (there must be none from this change).
4. Reduced motion: in the page, run
   `matchMedia("(prefers-reduced-motion: reduce)").matches` — if you can't
   toggle it via the OS, temporarily verify by flipping the hook's `reduced`
   initial state to `true` and confirming a static first prompt renders, then
   flip it back.

Expected: all four behaviors as described; chips row and submit flow unchanged.

- [ ] **Step 3: Run the test suite once more**

Run: `node --test src/lib/typewriter.test.ts src/lib/company-scope.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/search-experience.tsx
git commit -m "feat: animated typing placeholder in search bar"
```
