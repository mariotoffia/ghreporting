# Design — Report-provisioned query datasets & self-contained reports

Date: 2026-07-10
Status: approved (brainstorming), pending spec review → writing-plans

## Context

ADR 0014 made **reports** data (a portable JSON `ReportDefinition` the browser compiles and
executes). ADR 0016 made **datasets** data (a stored read-only `SELECT`, E8.6). But the two are
still wired by hand: a report panel references a dataset **by id**, and that dataset must already
exist — authored standalone (E8.6) or shipped as connector code (E9/T9.1's views + derived
connectors). So a report is **not** self-contained: importing a report JSON does nothing useful
unless the datasets it needs happen to exist already, and E9's spend aggregations still require a
migration + connector code.

Goal: **a report you can import into a fresh system and it just works — with zero code changes.**
The report definition carries its own SQL datasets; the system provisions them on import and
removes them when no report needs them.

## Decision

The **report definition is the single source of truth.** It embeds its query-dataset SQL inline.
The `query_datasets` table becomes a **derived registry** that the `reports` service provisions
(upserts) from definitions and garbage-collects when orphaned. Every `query_datasets` row is
report-managed — there is no separate user-owned class.

Confirmed product choices (brainstorming):
- **All query datasets are report-scoped.** No `provenance` split; the table is derived from
  reports. (No new migration — the E8.6 `query_datasets` schema is reused as-is.)
- **Upsert / overwrite** on provision (`INSERT OR REPLACE` by id, last write wins).
- **Fully editable** standalone tab: edits/deletes are allowed but **transient** — the next
  re-provision from the definition reverts them (definition is authoritative).
- **Datasets are authored inside a report** (report-designer dataset form, or the imported JSON).
  No free-standing dataset creation (`POST /query-datasets` is removed).

## 1. Domain — `packages/domain/src/report.ts`

```ts
export interface QueryDatasetDef {
  id: string;            // kebab-case, catalog id
  title: string;
  description?: string;
  sql: string;           // one SELECT; uses :org, :from, :to
}
export interface ReportDefinition {
  version: 1;
  parameters: ReportParameter[];
  panels: ReportPanel[];
  datasets?: QueryDatasetDef[];   // NEW — embedded, provisioned on save/import
}
```

`validateDefinition` additionally validates `datasets` (when present): each `id` is kebab-case,
`title`/`sql` non-empty strings, ids unique within the definition. It does **not** check built-in
collisions or SQL validity (zero-dependency package) — the data service owns that at provision
time. `toExport`/`parseExport` already move the whole definition, so embedded datasets travel with
export/import automatically (no envelope change).

## 2. Provisioning mechanism — port injection (not the event bus)

A small port the `data` service implements and the composition root injects into `reports`:

```ts
export interface QueryDatasetRegistry {
  /** deriveColumns + upsert (INSERT OR REPLACE) each def. Throws ValidationError (400) on bad
   *  SQL, and AppError 409 if an id collides with a built-in connector (built-ins can't be
   *  shadowed — the resolver always prefers them, so a shadowed row would be dead). */
  provision(defs: QueryDatasetDef[]): void;
  /** Delete every query_datasets row whose id is NOT in referencedIds (mark-and-sweep GC). */
  sweep(referencedIds: Set<string>): void;
}
```

**Why a port, not the bus:** a bad SQL on **import must fail the request synchronously with a
400** — an async bus can't surface that to the importing call. A port keeps the dependency rule
intact: `reports` depends on a tiny interface; `data` implements it (it owns the table, `roDb`,
`deriveColumns`, and the built-in id set); only `app.ts` knows both concretes.

The `data` service exposes the registry on its returned interface (closing over its own
`ctx`/`roDb`/`connectors`); it is valid after `data.init` (which runs before `reports.init` by
registration order).

## 3. Lifecycle & GC

`reports` service drives provisioning on **seed-init, create, update, import, delete**. After each
mutation (definition already written to the `reports` table):
1. `registry.provision(mutatedReport.datasets ?? [])`
2. `referenced = ⋃ (report.definition.datasets[].id) over ALL reports`;
   `registry.sweep(referenced)`

Consequences:
- Deleting the last report that embeds a dataset id → that row is swept.
- Two reports embedding the same id → both are roots; deleting one keeps the row (upsert made
  them identical; if SQL differs, last-write-wins and this is documented).
- On a fresh DB, seed-on-init provisions the Copilot Spend datasets → the seeded report renders
  with no migration and no connector code.

## 4. Collision & built-in reservation

- id == a built-in connector id → `provision` throws 409 (`dataset.reserved`); a report cannot
  shadow `premium-requests` et al. (the resolver always prefers built-ins, so the row would be
  dead). This is the one case "overwrite" does not apply — built-ins are code, not rows.
- id == an existing report-managed row → overwrite (upsert), per the confirmed choice.

## 5. Routes & UI

Server (`data` uService):
- **Remove** `POST /query-datasets` (no free-standing create — provisioning is the only creator).
- Keep `GET /query-datasets`, `GET /:id`, `PUT /:id` (transient edit), `DELETE /:id` (transient),
  `POST /preview`, `GET /schema`.

Web:
- **Report designer** (`features/reports/Designer.tsx`) gains a **Datasets** section: add/edit
  `{id, title, sql}` rows using the CodeMirror `SqlField` + `/preview`. This is where SQL is
  authored. The panel dataset dropdown lists the definition's embedded datasets alongside
  built-ins.
- **Query-datasets tab** becomes list + transient-edit of provisioned rows (no create button).

## 6. E9 redesign (self-contained)

- **Drop T9.1** (migration `0005_spend_views` + derived-connector code). Its two aggregations
  become embedded query-dataset SQL over the base fact tables.
- **T9.2 → self-contained** `copilot-spend.json`: `datasets: [spend-by-user-model-month,
  spend-by-team-month]` (each a `SELECT … GROUP BY` over `usage_facts`/`orgs`/`skus`/`users`/
  `teams`/`team_members`, bound by `:org`/`:from`/`:to`), panels referencing them by id. Loads on
  init → provisioned → renders. The per-model/user breakdown is columns pivoted client-side
  (`execute.ts`), so `org`+`range` binding suffices — no new filter support needed.

## 7. Docs

- **ADR 0017** — reports provision & GC their embedded datasets; supersedes T9.1's code-dataset
  approach. References ADR 0014, 0016.
- UBIQUITOUS.md — "Provisioned dataset" (a query dataset materialized from a report definition,
  GC'd when no report references it).
- Rewrite the E9 plan section.

## 8. Testing

- Domain: `datasets` validation (good/bad shapes, dup ids, placeholder scan unaffected).
- Registry: `provision` derives+upserts, rejects built-in id (409) and bad SQL (400); `sweep`
  deletes only unreferenced rows; upsert overwrites.
- Reports service: create/update/import/delete each provision + sweep correctly; seed-on-init
  provisions; import of a report with embedded datasets makes its panels immediately queryable;
  deleting a report GCs its now-orphaned datasets but keeps ones another report still embeds.
- E9: `copilot-spend.json` passes `validateDefinition`, provisions on init, and its datasets
  return correct aggregates from seeded facts.
- Web: report-designer dataset section round-trips; standalone tab no longer offers create.

## 9. Edge cases / risks

- **Provision failure mid-import** must not half-apply — validate + deriveColumns ALL embedded
  datasets before the first upsert (mirrors the existing validate-before-write discipline).
- **A report referencing a dataset it does not embed** (relies on another report's) — allowed but
  not self-contained; sweep roots are embedded ids only, so it can be GC'd out from under the
  referrer. Documented as "embed what you need."
- **Transient edits** to a provisioned row diverge from the definition until the next
  re-provision; acceptable per the confirmed choice, surfaced in the tab's copy.

## 10. Out of scope (YAGNI)

- Refcount stored in the DB (a join table) — the reports table is the root set; a sweep is cheap
  at this scale.
- Per-dataset ownership/permissions — single-user local app.
- Migrating existing standalone E8.6 rows — none exist in production.
