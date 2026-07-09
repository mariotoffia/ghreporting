# 0008 — Univer for Excel-like sheets and formulas

Status: accepted

## Context

Requirement 6: an Excel-like grid the data service can populate, easy dataset
discovery, and **Excel-like formulas** for light processing. Must be stable, modern,
actively community-driven — and license-compatible with a tool we might distribute.

## Decision

**Univer** (`@univerjs/presets`, sheets-core preset): Apache-2.0, TypeScript-first,
actively developed successor to the Luckysheet lineage, with a built-in formula engine
(HyperFormula-class functionality without the GPL/commercial licensing question) and a
documented facade API (`univerAPI`) for programmatic range read/write, command events,
and workbook snapshots — exactly the hooks the Binding mechanism needs
(ARCHITECTURE.md §7).

Integration rules:

- Univer is wrapped in **one** `SheetHost` component; the rest of the app talks to the
  binding store, never to `univerAPI` directly.
- Workbook persistence = Univer snapshot JSON stored via the `workspace` service.
- Pin the Univer minor version; its API surface still moves — upgrades are a deliberate
  task with the sheet tests as the gate.

## Consequences

- Formulas, cell editing, copy/paste, and selection come for free; we write data
  binding, not a spreadsheet.
- Univer is heavy (~MBs) — lazy-loaded route so login/explorer stay light.
- Optional later: register a custom `GHDATA()` formula function to pull datasets from
  inside the sheet (kept as a stretch task, T7.4).

## Rejected alternatives

- **Handsontable + HyperFormula:** excellent, but non-commercial license restrictions.
- **AG Grid Community:** superb grid, no formula engine in the free tier.
- **x-spreadsheet / jspreadsheet CE / Fortune Sheet:** lighter but less active and/or
  weaker formula support — the formula requirement decides this.
