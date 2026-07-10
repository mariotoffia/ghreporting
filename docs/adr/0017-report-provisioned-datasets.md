# 0017 — Reports provision and garbage-collect their embedded query datasets

Status: accepted

## Context

[ADR 0014](0014-report-designer-standalone-definitions.md) made **reports** data (a portable JSON
`ReportDefinition` the browser compiles and executes). [ADR 0016](0016-query-datasets-stored-selects.md)
made **datasets** data (a stored read-only `SELECT`). But the two were still wired by hand: a
report panel references a dataset **by id**, and that dataset had to already exist — authored
standalone (ADR 0016) or shipped as connector code (the original E9/T9.1 views + derived
connectors). So a report was **not** self-contained. Importing a report JSON into a fresh system
did nothing useful unless the datasets it needs happened to exist, and the first shipped report
still required a migration plus connector code.

We want: **import a report and it just works — no code changes, no migration.**

## Decision

The **report definition is the single source of truth** for its datasets. A definition may embed
its query datasets inline (`datasets: QueryDatasetDef[]`); the `reports` service **provisions**
(upserts) them into the `query_datasets` catalog on every mutation and **garbage-collects** them
when no report references them. The `query_datasets` table becomes a **derived registry** — every
row is report-managed; there is no separate user-owned class.

1. **Embedded, portable.** `datasets` lives in the definition, so export/import (already a
   whole-definition envelope) carries it for free. `validateDefinition` checks shape only (kebab
   id, non-empty title/sql, unique ids) — SQL validity and built-in collisions are the data
   service's job at provision time.
2. **Provisioning via a port, not the event bus.** The `data` service implements a
   `QueryDatasetRegistry` (`provision` / `sweep`); the composition root injects it into `reports`
   (which depends on a consumer-declared `DatasetProvisioner` interface, not on the data service —
   dependency rule, ARCHITECTURE §2). A bus was rejected: a bad SQL on **import must fail the
   request synchronously with a 400**, which an async bus cannot do.
3. **Upsert / overwrite.** `provision` is `INSERT … ON CONFLICT DO UPDATE` by id (last write wins),
   preserving `created_at`. All embedded datasets are validated (columns derived) **before** the
   first upsert and before the reports-table write, so an import never half-applies.
4. **Mark-and-sweep GC, reports are the root set.** After each mutation the service recomputes the
   union of `datasets[].id` over **all** reports and deletes every `query_datasets` row not in it.
   No refcount column, no join table — a sweep is cheap at this scale, and on boot a reconcile
   makes the registry match the reports table (tolerant per-report so one stale report can't brick
   startup).
5. **Built-ins stay reserved.** A report cannot claim a built-in connector id (`provision` throws
   409) — the resolver always prefers built-ins, so a shadow row would be dead.
6. **Authoring moves into the report.** SQL is authored in the report designer's Datasets section
   (reusing the CodeMirror `SqlField` + `/preview`); the standalone Query-datasets tab lists and
   *transiently* edits provisioned rows (a re-provision from the definition reverts a manual edit).
   The free-standing `POST /query-datasets` create route is removed.

## Consequences

- **Good:** a report is a single importable, self-contained JSON — import it on a fresh machine
  and its panels resolve with no migration or connector code. E9's Copilot Spend ships this way
  (its aggregations are embedded SQL, not views). One validator/compiler still shared by both
  tiers (ADR 0014).
- **Cost:** a manual edit to a provisioned row in the standalone tab is transient (reverted on the
  owning report's next save) — accepted, surfaced in the tab's copy. A report that references a
  dataset it does not embed can be GC'd out from under it (sweep roots are embedded ids only) — the
  guidance is "embed what you need."
- **Supersedes** the T9.1 approach (SQL views in a migration + derived-connector code); E9 is
  redesigned around embedded datasets.
- **Rejected:** event-bus provisioning (no synchronous import failure); a DB-stored refcount/join
  table (YAGNI at this scale); a separate user-owned standalone dataset class (the confirmed model
  is report-scoped-only).

References [ADR 0016](0016-query-datasets-stored-selects.md),
[ADR 0014](0014-report-designer-standalone-definitions.md).
