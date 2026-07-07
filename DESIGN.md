# Pathways — Design System

**Concept:** field atlas of careers. Deep-spruce identity surface for the
landing; paper-white data surface for results. Warmth and character carried by
type and the mono data voice, never by tinted backgrounds.

## Color (OKLCH, light theme)

| Token | Value | Role |
|---|---|---|
| `--bg` | `oklch(0.985 0.002 170)` | app background (true off-white, chroma ≈ 0) |
| `--surface` | `oklch(1 0 0)` | raised rows/panels |
| `--ink` | `oklch(0.24 0.02 170)` | primary text |
| `--ink-soft` | `oklch(0.42 0.02 170)` | secondary text (≥4.5:1 on bg) |
| `--line` | `oklch(0.9 0.008 170)` | hairlines |
| `--brand` | `oklch(0.38 0.08 170)` | spruce — actions, links, data figures |
| `--brand-deep` | `oklch(0.26 0.045 175)` | landing/hero surface |
| `--brand-tint` | `oklch(0.94 0.02 170)` | share-bar track, hover tints |
| `--bar` | `oklch(0.55 0.1 168)` | share bars |
| `--warn-bg` / `--warn-ink` | `oklch(0.95 0.04 85)` / `oklch(0.4 0.09 70)` | degraded/limit notices |

Strategy: committed on the landing (spruce carries the surface), restrained on
data screens (spruce ≤10%, carried by figures/bars/links).

## Type

- **Schibsted Grotesk** — UI + display. Display ≤ 3.4rem, tracking ≥ -0.03em.
- **Spline Sans Mono** — all data figures (percentages, counts, years, keys).
  The mono voice IS the brand's credibility.
- Body line length ≤ 70ch. `text-wrap: balance` on headings.

## Layout (desktop-first)

- Results: max-width 60rem; each cluster row uses the width — header line
  (% + label + count) over a full share bar, then description and example
  people side-by-side in two columns. Collapses to one column < 760px.
- Rosters: max-width 69rem table with Name / Current role / Education /
  Location / Yrs / link columns; stacked rows < 640px (location dropped).
- Clusters are **ranked rows**, never a card grid.
- Spacing rhythm: 4px base; section gaps 48/64, row padding 16/20.

## Motion

- Share bars grow on first paint (`transform: scaleX`, ease-out-quint, 600ms,
  staggered 60ms/row). Stage transitions crossfade 240ms.
- Everything behind `@media (prefers-reduced-motion: reduce)` → instant.

## States

Every non-ok pipeline outcome has a designed state with cached-role chips as
the escape hatch. Loading is real: SSE streams actual pipeline stages.
