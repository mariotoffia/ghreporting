# 0009 — Apache ECharts for charts; binding store mediates sheet⇄chart

Status: accepted

## Context

Requirement 7: interactive graphs that "connect" to the sheets so data stays in sync
both ways. Needs a stable, actively maintained charting library with rich interaction
events (brush, click, zoom).

## Decision

- **Apache ECharts** — Apache-2.0, huge active community, canvas-rendered (fine with
  thousands of points), declarative `option` objects that serialize cleanly into our
  `ChartSpec` value object, and first-class interaction events.
- **No React wrapper library.** `echarts-for-react` lags upstream; a ~20-line
  `ChartHost` (`useRef` + `init` + `setOption` + `ResizeObserver` + dispose) is less
  code than the wrapper's config surface.
- **Bidirectional sync is mediated, never direct** (see ARCHITECTURE.md §7): a
  `Binding` (zustand store) links sheet range ⇄ dataset query ⇄ chart spec.
  Sheet edit → binding revision bump → ChartHost re-reads range → `setOption`.
  Chart brush/click → binding selection → SheetHost highlights/filters the range.
  The store is the single mediator, which is what prevents update loops.

## Consequences

- Charts are serializable specs — saved with the workbook, rebuilt on load, no live
  object graphs to persist.
- zustand (~1 kB) is added as the store; React context alone gets noisy for
  cross-feature, high-frequency updates. This is the only frontend state library.
- Chart edits do not write back cell *values* (charts visualize; sheets edit) — the
  "bidirectional" contract is data→chart and selection/filter→sheet, which is also
  how Excel behaves.

## Rejected alternatives

- **Plotly.js:** capable but heavier and the OSS/dash split muddies direction.
- **Recharts/visx:** lovely for bespoke dashboards; weaker out-of-the-box interaction
  (brush/zoom/toolbox) for an analysis workbench.
- **Direct Univer-chart plugin coupling:** binds us to Univer's chart roadmap and
  breaks the mediator invariant (DDD.md §4.9).
