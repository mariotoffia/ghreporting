# 0015 — ChartHost stays presentational; effect-driven chart tests use happy-dom

Status: accepted

## Context

Two forces met while implementing E8 (T8.1 ChartHost, T8.2 bidirectional link):

1. IMPLEMENTATION_PLAN_DETAILS.md T8.2 literally says *"ChartHost subscribes to its
   binding's revision (`useBindings(...)`)"*. But ARCHITECTURE.md §7 and the report
   designer (T8.5.4) both require **ChartHost to render report panels that have no sheet
   and no binding** — a panel is "a Binding without a persisted sheet range". A ChartHost
   that reaches into the binding store and reads a Univer range cannot be reused there.
   DDD invariant 9 also wants the Binding to be the *only* sheet⇄chart coupling.

2. T8.2 requires a regression test that a `select()` does **not** trigger a chart
   re-render — *"spy on setOption count"*. `setOption` only fires from a React effect, and
   the existing component tests use `renderToString` (server render, effects never run), so
   that suite structurally cannot observe it.

## Decision

- **ChartHost is pure presentational**: props are `spec`, `columns`, `rows`, `onClick`,
  `onBrush` — no store, no Univer, only `echarts`. The sheet-specific
  revision→re-read→`select` wiring lives one layer up in a new `BoundChart` component,
  which the Workbench mounts and the reports feature does not. This is the correct
  resolution of the plan's own internal tension; behavior matches T8.2, and ChartHost
  becomes reusable by ReportView (E8.5).

- **Effect-driven chart tests use happy-dom**: the loop-prevention regression
  (`BoundChart.test.tsx`) registers `@happy-dom/global-registrator`, renders via
  `react-dom/client` + React `act`, and mocks the `echarts` module to spy on `setOption`.
  It asserts: paint on mount, repaint on `bumpRevision`, and **no** repaint on `select`.
  happy-dom is registered per-file and `unregister()`ed in `afterAll` so it never leaks a
  `document` global into the `renderToString` suites. Pure logic (`toEChartsOption`,
  `eventToRows`, `selectionRangeA1`, `deriveChartSpec`) stays covered by fast, DOM-free
  unit tests.

## Consequences

- One new **devDependency** (`@happy-dom/global-registrator`); effect-driven components are
  now testable without a browser. Production bundles are unaffected.
- The literal T8.2 wording ("ChartHost subscribes…") is superseded by the pure-ChartHost +
  BoundChart split. No behavioral difference; the same store channels drive the same flows.
- Component tests now come in two flavors — DOM-free `renderToString` (default) and
  happy-dom (only when effects must run). Reach for the latter sparingly.

## Rejected alternatives

- **ChartHost subscribes to the store directly** (plan's literal wording): couples the
  charts feature to the binding store and, transitively, to the Univer sheet read —
  breaking reuse by the sheetless report panels and blurring the mediator.
- **`@testing-library/react`**: heavier than needed; `react-dom/client` + `act` covers the
  single effect-driven regression without the extra dependency surface.
- **Global happy-dom preload**: would add a `document` to every test, including the SSR
  suites that deliberately run without one.
