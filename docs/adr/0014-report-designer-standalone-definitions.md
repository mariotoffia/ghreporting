# 0014 — Report designer: standalone, parameterized report definitions

Status: accepted

## Context

Requirement 10 needs a shipped report (Copilot spend per model/user). The original plan
(T9.2) built it as *code*: a pure `copilotSpend.ts` builder that returned a workbook name,
binding payloads, and chart specs. Every additional report would then be another code
change and another release. We want a **report designer**: reports authored, edited,
exported, imported, and executed as data by a non-developer.

Two existing concepts are adjacent but wrong for this:

- The `workspace` uService already stores **Workbooks** (a Univer snapshot) and
  **Bindings** with CRUD and cascade delete. But a Workbook is a *materialized* artifact
  carrying a large derived snapshot — the wrong unit to export/import or to re-run against
  fresh data with different parameters.
- The kernel forbids services importing each other; cross-service work goes through the
  event bus or the browser.

## Decision

Add a **`reports` uService** that owns a standalone, self-contained **Report Definition** —
a versioned JSON document of `parameters` + `panels` — independent of the
`workspace`/`workbook` tables.

1. **Definition, not workbook.** A Report persists no Univer snapshot and no `bindings`
   rows. The definition is the only source of truth; the rendered view is derived and
   disposable. This makes export/import trivial (dump/validate the JSON) and lets one
   report re-execute against fresh data with different parameters.
2. **Shared-kernel aggregate.** `ReportDefinition` type, invariants, `validateDefinition`,
   and `compile` live in `packages/domain/report.ts` (zero-dependency), so the server
   (write/import validation) and the web designer (edit-time validation) use identical
   code.
3. **Frontend-orchestrated execution.** The server never runs a report. The browser GETs
   a definition, `compile()`s it (substituting parameter values), and issues one
   `/api/data/query` per panel — honoring "services never import each other."
4. **Read-only view, no persisted workbook.** Panels render as HTML tables (reusing the
   explorer's Preview/format) plus `ChartHost`. Changing a parameter re-runs only the
   affected panel queries. Interactivity and sync progress reuse the existing
   `/api/notifications/stream`; there is no new SSE channel.
5. **Copilot Spend becomes a seed.** It ships as a committed `ReportDefinition` JSON the
   `reports` service loads on init (idempotent, stable id `copilot-spend`) and executes
   through the generic view. The hardcoded `copilotSpend.ts` builder is removed.

The term **Report** in [UBIQUITOUS.md](../../UBIQUITOUS.md) is redefined accordingly (was
"a workbook template shipped with the app").

## Consequences

- **Good:** reports are data — list/create/edit/delete/import/export with no deploy;
  portability is a one-file JSON; Reporting stays off the heavy Univer/E7 path (depends
  only on ChartHost + the premium-requests datasets); one validator/compiler shared by
  both tiers.
- **Cost:** a definition→view divergence is impossible only because the view is read-only.
  If reports later need to be *editable spreadsheets*, that is the rejected
  "materialize into a Workbook" option and needs its own ADR (definition↔workbook
  round-trip is non-trivial).
- **Rejected — reuse the workspace store:** would couple reports to a derived 20 MB
  snapshot and complicate export/import for no gain.
- **Rejected — server-side execution:** would require the `reports` service to reach the
  `data` service, violating the no-cross-import rule.

Supersedes the hardcoded-builder approach previously described in T9.2.
