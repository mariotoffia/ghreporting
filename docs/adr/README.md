# Architecture Decision Records

Records of decisions made for this codebase. Each ADR captures the context, the
decision, and its consequences, so the reasoning survives past the commit that carried
the code. Format: MADR-style. `accepted` records document the committed direction;
implementation state is tracked in IMPLEMENTATION_PLAN.md, not here.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-bun-vite-react-typescript.md) | Bun runtime, Vite + React + TypeScript frontend | accepted |
| [0002](0002-hono-http-framework.md) | Hono as the HTTP framework | accepted |
| [0003](0003-sqlite-via-bun-sqlite.md) | SQLite via `bun:sqlite`, numbered SQL migrations | accepted |
| [0004](0004-uservice-kernel-modular-monolith.md) | uService kernel: modular monolith, event bus, SSE | accepted |
| [0005](0005-local-first-sync-pipeline.md) | Local-first sync pipeline with watermarks and ETags | accepted |
| [0006](0006-pluggable-credential-store.md) | Pluggable credential store; macOS Keychain first | accepted |
| [0007](0007-webauthn-touchid-login.md) | Login via WebAuthn platform authenticator (Touch ID) | accepted |
| [0008](0008-univer-spreadsheet.md) | Univer for Excel-like sheets and formulas | accepted |
| [0009](0009-echarts-charts.md) | Apache ECharts for charts; binding store mediates sheet⇄chart | accepted |
| [0010](0010-single-binary-packaging.md) | Single-binary packaging with `bun build --compile` | accepted |
| [0011](0011-biome-lint-format.md) | Biome for lint + format; `tsc --noEmit` as vet | accepted |
| [0012](0012-copilot-metrics-reports-api.md) | Copilot metrics via the usage-metrics reports API (legacy API sunset) | accepted |

## Numbering

ADRs are numbered sequentially from `0001`. Filenames are `NNNN-<slug>.md`. A
superseded ADR keeps its number and gains a `Superseded by NNNN` line; it is never
deleted or renumbered.
