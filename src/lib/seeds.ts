// Landing-page example chips, drawn from the seed list (PRD §10, Appendix A).
// Mixed sports + general on purpose — one undifferentiated search space.

export const EXAMPLE_CHIPS = [
  "Chief Data Officer at a sports team",
  "Product manager at a startup",
  "Private equity associate",
  "Venture capital investor",
  "Chief of staff at a startup",
  "Consultant at MBB",
];
// ponytail: company-scoped search still works for typed queries (e.g. "VC at
// Sequoia"). We just don't surface single-company / boutique chips yet — those
// are the ones Sean flagged. MANGO dropped: a contrived cohort the parser
// can't reliably resolve.

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
