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
