# Animated Typing Placeholder — Design

**Date:** 2026-07-14
**Status:** Approved

## Goal

Replicate the nerdapply.com search-bar effect: the placeholder types out sample
prompts character-by-character, holds, deletes, and cycles to the next. Trains
users that Pathways answers "what are the paths to X?" questions. Chips row
stays exactly as-is.

## Verified mechanic (nerdapply.com, observed live)

JS drives the input's `placeholder` attribute directly — type char-by-char,
hold the full sentence ~2s, delete char-by-char, next prompt, loop. No extra
DOM, no layout shift.

## Changes

### 1. `src/lib/seeds.ts`

New export next to `EXAMPLE_CHIPS`:

```ts
export const PLACEHOLDER_PROMPTS = [
  "What are the paths to becoming a sports agent?",
  "How do people break into venture capital?",
  "How do you become a chief of staff?",
  "What roles lead to Chief Data Officer at a sports team?",
  "How did consultants land at MBB?",
  "What's the path to VP of Product?",
];
```

Short question sentences; mix of current chip roles and unexplored ones.
Safe to imitate: the parser is LLM-based and extracts the role from
question-form queries, so no backend change.

### 2. `src/app/search-experience.tsx`

A ~30-line `useEffect` state machine (no dependencies, no library) that sets
placeholder text state:

- Type ~55 ms/char → hold full sentence ~2.2 s → delete ~30 ms/char →
  400 ms gap → next prompt, looping forever.
- Runs only while `query` is empty; pauses when the user types, resumes if
  they clear the input.
- `prefers-reduced-motion: reduce` → no animation, first prompt shown as a
  static placeholder.
- Timers cleaned up on unmount and on effect re-run.
- Existing `aria-label` is the accessible name; placeholder churn is not
  announced. `page.tsx` passes prompts in or the component imports them
  directly (component imports — simplest).

## Untouched

Chips row, submit flow, SSE loading stages, outcome notices, parser, API.

## Verification

Run the dev server: watch the bar type/delete/cycle through all prompts;
type into it and confirm animation stops; clear it and confirm it resumes;
emulate reduced motion and confirm a static placeholder.
