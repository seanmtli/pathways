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
