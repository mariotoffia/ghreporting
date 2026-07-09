# Report Designer (`reports` uService) — Design

**Status:** approved (2026-07-09) · **Epic:** E8.5 · **Supersedes:** the hardcoded
`copilotSpend.ts` builder in T9.2.

## Problem

Reports are currently *code*: [UBIQUITOUS.md](../../../UBIQUITOUS.md) defines a `Report`
as "a workbook template shipped with the app," and T9.2 implements Copilot Spend as a
pure builder function (`copilotSpend.ts`) that returns a workbook name, binding payloads,
and chart specs. Every new report is a new code change and a new deploy. We want reports
to be **data**: stored, parameterized definitions that a non-developer can list, create,
edit, delete, export, import, and execute — a report *designer*.

## Decisions (locked)

| Fork | Decision |
|------|----------|
| Report ↔ workbook | **Standalone store.** `reports` owns a self-contained `ReportDefinition`; it does **not** reuse the `workspace`/`workbook` tables. The definition is the portable source of truth. |
| Execution locus | **Frontend-orchestrated.** The server never runs a report; the browser compiles the definition and runs data queries. Respects "services never import each other." |
| Interactivity / SSE | **Reuse existing infra.** Parameter changes re-run data queries; sync progress rides the existing `/api/notifications/stream`. No new SSE channel. |
| Copilot Spend (T9.2) | **Convert to a seeded `ReportDefinition`**, executed by the generic engine. The hardcoded builder is deleted from scope. |
| Render target | **Read-only Report view** that re-executes on parameter change. **No workbook is persisted.** Panels render as HTML tables + `ChartHost`. |

Rejected: materializing into an editable Univer workbook (couples reports to E7, creates a
definition↔workbook divergence with no round-trip). Revisit only if reports must become
editable spreadsheets.

## Bounded context & vocabulary

New context `reports`. **`Report` is redefined**: a stored, parameterized *Report
Definition* that executes into a read-only report view.

- **Report Definition** — the declarative, portable, parameterized spec. Source of truth.
  Stored as one JSON document.
- **Panel** — one unit of report structure: a dataset + parameterized query + optional
  transform (pivot) + optional Chart Spec. Renders as a table and/or a chart. A Panel is
  a `Binding` minus the persisted sheet range; it reuses the `DatasetQuery`/`ChartSpec`
  shapes.
- **Parameter** — a named report input (org, date range, filter) with a default,
  substituted into panel queries at execution. Placeholders reference parameters by name.
- **Execution** — compiling a definition + parameter values into a build-plan, then
  running each panel's data query. Frontend-orchestrated.
- **Export / Import** — a versioned JSON envelope; the whole portability story.

## Architecture

### Domain (`packages/domain/src/report.ts`, zero-dep, pure)

The `ReportDefinition` is a shared-kernel aggregate: the server validates it on
write/import, the web designer validates it while editing, and both compile it.

```ts
export interface ReportParameter {
  name: string;                      // referenced as "{{name}}" in panel queries
  kind: "org" | "dateRange" | "string" | "number";
  default: unknown;
}
export interface ReportPanel {
  id: string;
  title: string;
  dataset: string;                   // exactly one dataset per panel (invariant)
  query: Record<string, unknown>;    // DatasetQuery with "{{param}}" placeholders; opaque here
  transform?: { pivot: { x: string; series: string; value: string } };
  chartSpec?: Record<string, unknown>; // ChartSpec; opaque here — ChartHost owns deep validation
}
export interface ReportDefinition {
  version: 1;
  parameters: ReportParameter[];
  panels: ReportPanel[];
}

export function validateDefinition(json: unknown): ReportDefinition; // throws ValidationError
export function compile(def: ReportDefinition, values: Record<string, unknown>): BuildPlan;
export function toExport(name: string, description: string | null, def: ReportDefinition): ExportEnvelope;
export function parseExport(json: unknown): { name: string; description: string | null; definition: ReportDefinition };
```

Invariants enforced by `validateDefinition`: `version === 1`; parameter names unique and
non-empty; every `{{placeholder}}` in a panel query references a declared parameter; each
panel names exactly one dataset; panel ids unique. `query`/`chartSpec` **innards stay
opaque** — the data service and `ChartHost` own their deep validation; the domain owns the
*envelope* invariants only, keeping `packages/domain` free of web/data coupling.

`compile` is pure string/placeholder substitution → `BuildPlan { panels: [{ id, title,
dataset, query, transform?, chartSpec? }] }`. No I/O.

### `reports` uService (`apps/server/src/services/reports/service.ts`)

One table, migration `0004_reports.ts` — a definition is a document, never queried
server-side, so no child tables:

```sql
CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  definition  TEXT NOT NULL,   -- JSON ReportDefinition
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

Routes under `/api/reports` (JSON, ids `crypto.randomUUID()`):

- `GET /reports` → `[{id, name, description, updated_at}]` (no definition body)
- `POST /reports {name, description?, definition}` → `validateDefinition` → insert
- `GET /reports/:id` → full row incl. `definition`
- `PUT /reports/:id {name?, description?, definition?}` → validate if `definition` sent
- `DELETE /reports/:id`
- `GET /reports/:id/export` → `ExportEnvelope` as attachment (`Content-Disposition`)
- `POST /reports/import {envelope}` → `parseExport` → validate → insert with a **new id**

Definition size cap ~1 MB (definitions are KB; the cap is a runaway guard). **Seeds the
Copilot Spend definition on `init`** if absent (idempotent, stable id) so the app opens
with one working report. **No server compile/execute endpoint** — the frontend GETs the
definition and compiles locally.

The write-guards currently private to `workspace` (`jsonObject`, `nonEmpty`, size-cap)
are lifted to `apps/server/src/kernel/http.ts` and shared by both services.

### Frontend (`apps/web/src/features/reports/`)

- **Designer** — list / create / edit / delete, import/export buttons, panel editor (pick
  dataset → query → optional chartSpec). Validates against the same domain
  `validateDefinition`.
- **ReportView** — `GET /api/reports/:id` → `compile` with current parameter values →
  per panel `POST /api/data/query {dataset, query, sync}` → render table (reuse the
  explorer's `Preview`/`format`) + `ChartHost`. Parameter controls at the top; changing
  one re-runs the affected queries. Interactivity reuses existing infra: sync progress on
  `/api/notifications/stream`; background-refresh sync events (T2.6) invalidate the report.

Panels render as **HTML tables, not Univer sheets** — a deliberate simplification that
keeps E8.5 off the E7 dependency chain. It depends only on `ChartHost` (T8.1) and the
premium-requests datasets (T2.5d / T9.1).

## Governance docs touched

- **ADR 0014** — reports as standalone parameterized definitions; frontend-orchestrated
  execution; read-only re-executing view; Copilot Spend as a seed.
- **DDD.md** — new Reporting context §3.7: `ReportDefinition` aggregate + invariants.
- **UBIQUITOUS.md** — Reporting section + redefined `Report`.
- **ARCHITECTURE.md** — add `reports` to the uService diagram and §7 frontend map.

## Plan injection

New epic **E8.5 — Report designer (`reports` uService)**, after E8:

| Task | Scope | Depends |
|------|-------|---------|
| T8.5.1 | Domain `report.ts`: types, `validateDefinition`, `compile`, export envelope | T1.1 |
| T8.5.2 | `reports` uService: migration `0004_reports.ts`, CRUD + export/import, seed-on-init, register in composition root; lift write-guards to `kernel/http.ts` | T8.5.1, T2.2 |
| T8.5.3 | Web designer: list/create/edit/delete + import/export UI | T8.5.2, T6.1 |
| T8.5.4 | Web ReportView: compile + per-panel query + table/ChartHost render + parameter re-execute | T8.5.1, T8.1, T2.5d |

**E9 changes**: T9.1 (spend views) unchanged except its migration renumbers `0003`→`0005`
(0003 and now 0004 are taken). **T9.2 rewritten** — "Seed the Copilot Spend Report
Definition," executed by the generic ReportView, same CSV-accuracy acceptance test;
depends on T8.5.4 + T9.1. The hardcoded builder is removed.

## Testing

- Domain: `validateDefinition` accept/reject matrix (unbound placeholder, dup param names,
  missing dataset, wrong version, dup panel ids); `compile` substitutes params and leaves
  non-placeholders intact; export round-trips (`parseExport(toExport(x)) === x`).
- Service: CRUD round-trips; list omits definition; import rejects an invalid envelope;
  export→import round-trip yields a new id; seed-on-init is idempotent; size guard.
- Web: designer store transitions; ReportView compiles + issues one data query per panel
  (mocked api); parameter change re-queries only affected panels.
- E9 acceptance: seeded Copilot Spend totals match GitHub's premium-request CSV to the cent
  (carried over from T9.2).
</content>
