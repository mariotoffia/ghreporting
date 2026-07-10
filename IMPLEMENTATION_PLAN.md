# GH Reporting — Implementation Plan

> **For agentic workers:** work strictly task-by-task from this table. For each task,
> read its section in [IMPLEMENTATION_PLAN_DETAILS.md](IMPLEMENTATION_PLAN_DETAILS.md)
> plus the docs its **Refs** line names, implement test-first, and only tick the box
> when the Done-when criterion and `make lint && make vet && make test` are green.

**Goal:** a local-first GitHub reporting workbench — Copilot/AI model spend per model,
user, team — with Excel-like sheets, linked charts, Touch ID login, and Keychain-backed
credentials, packaged as a single executable.

**Architecture:** modular-monolith uService kernel on Bun + Hono; local SQLite as the
only query backend with gap-driven GitHub sync; React/Vite frontend where a Binding
mediates sheet ⇄ dataset ⇄ chart. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Tech stack:** Bun ≥ 1.3, Hono, `bun:sqlite`, octokit, @simplewebauthn, React 19,
Vite 7, TanStack Query, zustand, Univer, Apache ECharts, Biome, `bun test`, Playwright,
mitata.

## Global constraints (apply to every task)

- Code files ≤ 500 lines; docs ≤ 600 lines (`wc -l` before you finish). This file and
  IMPLEMENTATION_PLAN_DETAILS.md are exempt from the doc limit.
- Vocabulary from [UBIQUITOUS.md](UBIQUITOUS.md) verbatim; interfaces copied from
  [ARCHITECTURE.md](ARCHITECTURE.md) §3 / [PLUGIN.md](PLUGIN.md) verbatim.
- Dependency rule (ARCHITECTURE.md §2); `packages/domain` keeps zero dependencies.
- TDD: the task's listed tests exist and fail before the implementation makes them pass.
- New third-party deps only where the task's details say so.
- Secrets never in SQLite, logs, or the browser.
- GitHub API etiquette per [TESTS.md](TESTS.md) §3 — in app code *and* tests.
- Definition of done: task's **Done when** + `make lint && make vet && make test` green
  + this table's row ticked in the same commit.

## How to work a task (junior workflow)

1. Pick the first ⬜ row whose **Depends** are all ✅.
2. Open its details section; read every doc in its **Refs** line first.
3. Write the listed failing tests → implement → green → `make lint-fix && make lint && make vet && make test`.
4. Tick the row (⬜ → ✅), commit task-by-task.

## Task table

Status: ✅ done · ⬜ open · (opt) optional.

### E0 — Foundation

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T0.1 | Workspace scaffold (bun workspaces, tsconfigs, Biome) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t01-workspace-scaffold) | — | ✅ |
| T0.2 | Makefile + toolchain verification | [details](IMPLEMENTATION_PLAN_DETAILS.md#t02-makefile-and-toolchain) | T0.1 | ✅ |

### E1 — uService kernel

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T1.1 | Kernel ports and errors | [details](IMPLEMENTATION_PLAN_DETAILS.md#t11-kernel-ports-and-errors) | T0.2 | ✅ |
| T1.2 | Event bus | [details](IMPLEMENTATION_PLAN_DETAILS.md#t12-event-bus) | T1.1 | ✅ |
| T1.3 | Config and logger | [details](IMPLEMENTATION_PLAN_DETAILS.md#t13-config-and-logger) | T1.1 | ✅ |
| T1.4 | Registry and app composition | [details](IMPLEMENTATION_PLAN_DETAILS.md#t14-registry-and-app-composition) | T1.2, T1.3 | ✅ |
| T1.5 | SSE hub | [details](IMPLEMENTATION_PLAN_DETAILS.md#t15-sse-hub) | T1.4 | ✅ |

### E2 — Storage and sync (`data` uService)

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T2.1 | SQLite adapter and migration runner | [details](IMPLEMENTATION_PLAN_DETAILS.md#t21-sqlite-adapter-and-migration-runner) | T1.4 | ✅ |
| T2.2 | Schema v1 migration | [details](IMPLEMENTATION_PLAN_DETAILS.md#t22-schema-v1) | T2.1 | ✅ |
| T2.3 | GitHub client adapter | [details](IMPLEMENTATION_PLAN_DETAILS.md#t23-github-client-adapter) | T1.4, T3.4 | ✅ |
| T2.4 | Sync engine and data service | [details](IMPLEMENTATION_PLAN_DETAILS.md#t24-sync-engine-and-data-service) | T2.2, T2.3 | ✅ |
| T2.5a | Connector: org-people | [details](IMPLEMENTATION_PLAN_DETAILS.md#t25a-connector-org-people) | T2.4 | ✅ |
| T2.5b | Connector: copilot-seats | [details](IMPLEMENTATION_PLAN_DETAILS.md#t25b-connector-copilot-seats) | T2.4 | ✅ |
| T2.5c | Connector: copilot-metrics | [details](IMPLEMENTATION_PLAN_DETAILS.md#t25c-connector-copilot-metrics) | T2.4 | ✅ |
| T2.5d | Connector: premium-requests | [details](IMPLEMENTATION_PLAN_DETAILS.md#t25d-connector-premium-requests) | T2.4 | ✅ |
| T2.5e | Connector: billing-usage | [details](IMPLEMENTATION_PLAN_DETAILS.md#t25e-connector-billing-usage) | T2.4 | ✅ |
| T2.6 | Background refresh scheduler | [details](IMPLEMENTATION_PLAN_DETAILS.md#t26-background-refresh-scheduler) | T2.5c, T2.5d | ✅ |

### E3 — Credentials uService

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T3.1 | Secret store ports, encrypted-file backend, conformance suite | [details](IMPLEMENTATION_PLAN_DETAILS.md#t31-secret-store-ports-and-encrypted-file-backend) | T1.4 | ✅ |
| T3.2 | macOS Keychain backend | [details](IMPLEMENTATION_PLAN_DETAILS.md#t32-macos-keychain-backend) | T3.1 | ✅ |
| T3.3 | Credential providers and github-pat | [details](IMPLEMENTATION_PLAN_DETAILS.md#t33-credential-providers-and-github-pat) | T3.1, T5.1 | ✅ |
| T3.4 | Credentials service and routes | [details](IMPLEMENTATION_PLAN_DETAILS.md#t34-credentials-service-and-routes) | T3.2, T3.3 | ✅ |

### E4 — Access (`auth` uService)

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T4.1 | WebAuthn register and login ceremonies | [details](IMPLEMENTATION_PLAN_DETAILS.md#t41-webauthn-register-and-login) | T2.2, T1.4 | ✅ |
| T4.2 | Session gate and master key unlock | [details](IMPLEMENTATION_PLAN_DETAILS.md#t42-session-gate-and-master-key-unlock) | T4.1, T3.4 | ✅ |

### E5 — Notifications uService

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T5.1 | Notifications service | [details](IMPLEMENTATION_PLAN_DETAILS.md#t51-notifications-service) | T2.2 | ✅ |
| T5.2 | notify wiring and SSE stream | [details](IMPLEMENTATION_PLAN_DETAILS.md#t52-notify-wiring-and-sse-stream) | T5.1, T1.5 | ✅ |

### E6 — Web shell

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T6.1 | App shell, router, API client | [details](IMPLEMENTATION_PLAN_DETAILS.md#t61-app-shell-router-api-client) | T0.2 | ✅ |
| T6.2 | Login and first-run setup UI | [details](IMPLEMENTATION_PLAN_DETAILS.md#t62-login-and-first-run-ui) | T6.1, T4.2 | ✅ |
| T6.3 | Notifications UI | [details](IMPLEMENTATION_PLAN_DETAILS.md#t63-notifications-ui) | T6.1, T5.2 | ✅ |
| T6.4 | Data explorer | [details](IMPLEMENTATION_PLAN_DETAILS.md#t64-data-explorer) | T6.1, T2.5e | ✅ |

### E7 — Sheets

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T7.1 | Workspace uService (workbooks, bindings) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t71-workspace-uservice) | T2.2 | ✅ |
| T7.2 | SheetHost (Univer embed, snapshots) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t72-sheethost-univer-embed) | T6.1, T7.1 | ✅ |
| T7.3 | Binding store and insert-into-sheet flow | [details](IMPLEMENTATION_PLAN_DETAILS.md#t73-binding-store-and-insert-flow) | T7.2, T6.4 | ✅ |
| T7.4 | Custom GHDATA() sheet formula | [details](IMPLEMENTATION_PLAN_DETAILS.md#t74-ghdata-formula) | T7.3 | ✅ (opt) |

### E8 — Charts

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T8.1 | ChartHost (ECharts wrapper, chart specs) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t81-charthost) | T7.3 | ✅ |
| T8.2 | Bidirectional sheet⇄chart link | [details](IMPLEMENTATION_PLAN_DETAILS.md#t82-bidirectional-sheet-chart-link) | T8.1 | ✅ |

### E8.5 — Report designer (`reports` uService)

Reports as **data, not code**: a stored, parameterized Report Definition that the
frontend compiles and executes into a read-only view. Standalone store (not workbooks);
export/import; list/edit/delete. See [ADR 0014](docs/adr/0014-report-designer-standalone-definitions.md).

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T8.5.1 | Domain: ReportDefinition, validate, compile, export envelope | [details](IMPLEMENTATION_PLAN_DETAILS.md#t851-report-domain) | T1.1 | ✅ |
| T8.5.2 | `reports` uService: schema, CRUD, export/import, seed-on-init | [details](IMPLEMENTATION_PLAN_DETAILS.md#t852-reports-uservice) | T8.5.1, T2.2 | ✅ |
| T8.5.3 | Web: report designer (list/create/edit/delete, import/export) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t853-report-designer-ui) | T8.5.2, T6.1 | ✅ |
| T8.5.4 | Web: ReportView execution (compile → query → table/chart, param re-run) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t854-reportview-execution) | T8.5.1, T8.1, T2.5d | ✅ |

### E8.6 — Query datasets (`data` uService)

Datasets as **data, not code**: a SQL-literate user defines a new aggregation as a stored
read-only `SELECT` over already-synced facts — no migration, no deploy. Executed on a
read-only DB handle (writes/DDL impossible by construction), surfaced in the catalog
beside built-ins, so the report designer needs zero changes. Finishes ADR 0014 one layer
down; see [ADR 0016](docs/adr/0016-query-datasets-stored-selects.md) (0015 was taken by ChartHost).

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T8.6.1 | Migration `0006_query_datasets` + read-only DB handle wiring | [details](IMPLEMENTATION_PLAN_DETAILS.md#t861-query-datasets-migration-and-read-only-handle) | T2.2 | ✅ |
| T8.6.2 | Generic query-dataset connector, `deriveColumns`, resolver fallback, catalog merge | [details](IMPLEMENTATION_PLAN_DETAILS.md#t862-generic-connector-and-resolver) | T8.6.1, T2.5d | ✅ |
| T8.6.3 | `data` routes: `/query-datasets` CRUD + `/preview` | [details](IMPLEMENTATION_PLAN_DETAILS.md#t863-query-datasets-routes) | T8.6.2 | ✅ |
| T8.6.4 | Web: query-datasets screen (CodeMirror SQL editor w/ schema autocomplete, preview, nav) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t864-query-datasets-ui) | T8.6.3, T6.1 | ✅ |
| T8.6.5 | ADR 0016 + UBIQUITOUS/PLUGIN/ARCHITECTURE updates | [details](IMPLEMENTATION_PLAN_DETAILS.md#t865-query-datasets-docs) | T8.6.1 | ✅ |

### E8.7 — Report-provisioned query datasets (`reports` ⋈ `data`)

Reports become **self-contained**: a Report Definition embeds its own query-dataset SQL, the
`reports` service **provisions** (upserts) those into `query_datasets` on save/import and
**garbage-collects** them when no report references them. Import a report JSON into a fresh
system and it just works — no migration, no connector code. See
[ADR 0017](docs/adr/0017-report-provisioned-datasets.md) and
[design spec](docs/superpowers/specs/2026-07-10-report-provisioned-datasets-design.md).

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T8.7.1 | Domain: `ReportDefinition.datasets` + validation (embedded query datasets) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t871-domain-embedded-datasets) | T8.5.1 | ✅ |
| T8.7.2 | `QueryDatasetRegistry` port + `data` impl (`provision`/`sweep`); remove standalone create | [details](IMPLEMENTATION_PLAN_DETAILS.md#t872-registry-port-and-data-impl) | T8.6.2, T8.6.3 | ✅ |
| T8.7.3 | `reports` service wiring: provision + GC on seed/create/update/import/delete | [details](IMPLEMENTATION_PLAN_DETAILS.md#t873-reports-provisioning-wiring) | T8.7.1, T8.7.2, T8.5.2 | ✅ |
| T8.7.4 | Web: report-designer Datasets section (CodeMirror authoring); standalone tab drops create | [details](IMPLEMENTATION_PLAN_DETAILS.md#t874-report-designer-datasets-ui) | T8.7.3, T8.6.4 | ✅ |
| T8.7.5 | ADR 0017 + UBIQUITOUS + ARCHITECTURE (supersede T9.1 code-dataset approach) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t875-report-provisioned-datasets-docs) | T8.7.1 | ✅ |

### E9 — First report: Copilot model spend (self-contained)

Redesigned on E8.7: the Copilot Spend report is a single importable Report Definition that
**embeds** its spend aggregations as query-dataset SQL — no views, no derived-connector code
(the old T9.1 approach is superseded by [ADR 0017](docs/adr/0017-report-provisioned-datasets.md)).

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T9.1 | Spend aggregation query datasets (embedded SQL over base facts) | [details](IMPLEMENTATION_PLAN_DETAILS.md#t91-spend-aggregation-query-datasets) | T2.5d, T8.7.1 | ✅ |
| T9.2 | Seed the self-contained Copilot Spend Report Definition and validate | [details](IMPLEMENTATION_PLAN_DETAILS.md#t92-seed-copilot-spend-report) | T9.1, T8.7.3, T8.5.4 | ✅ |

### E10 — Packaging

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T10.1 | Embed frontend and compile single binary | [details](IMPLEMENTATION_PLAN_DETAILS.md#t101-embed-and-compile) | T6.4 (all UI tasks you want shipped) | ⬜ |
| T10.2 | macOS .app wrapper and cross-compile | [details](IMPLEMENTATION_PLAN_DETAILS.md#t102-app-wrapper-and-cross-compile) | T10.1 | ⬜ |

### E11 — Quality hardening

| ID | Task | Details | Depends | Status |
|----|------|---------|---------|--------|
| T11.1 | Integration tests: fixtures, replay, live suite | [details](IMPLEMENTATION_PLAN_DETAILS.md#t111-integration-tests) | T2.5a–e | ⬜ |
| T11.2 | Benchmarks | [details](IMPLEMENTATION_PLAN_DETAILS.md#t112-benchmarks) | T2.4, T9.1 | ⬜ |
| T11.3 | Playwright e2e smoke | [details](IMPLEMENTATION_PLAN_DETAILS.md#t113-e2e-smoke) | T6.2, T7.3, T8.1 | ⬜ |

## Suggested order

T1.1→T1.5 · T2.1→T2.2 · T5.1 · T3.1→T3.4 · T2.3→T2.4 · T4.1→T4.2 · T5.2 ·
T2.5a→e · T2.6 · T6.1→T6.4 · T7.1→T7.3 · T8.1→T8.2 · T8.5.1→T8.5.4 · T8.6.1→T8.6.5 ·
T9.1→T9.2 · T11.1→T11.3 · T10.1→T10.2 · (T7.4 whenever).

E8.5 depends only on T8.1 (ChartHost) + the premium-requests datasets — not on the
Univer sheet path (E7) or the bidirectional link (T8.2): report panels render as HTML
tables, not sheets.

E8.6 is optional relative to E9: E9 ships the same spend aggregations as SQL views in a
migration (T9.1), which always work. E8.6 makes *new* aggregations authorable from the
browser without a deploy — E9's numbers can later be re-expressed as query datasets, but
E9 does not depend on E8.6.

The one intentional cycle-breaker: T2.3 (GitHub client) needs a token from the
credentials service (T3.4); until T3.4 lands, T2.3's tests inject a fake token
provider — the details section says exactly how.
