# 0016 — Query datasets: user-defined aggregations as read-only stored SELECTs

Status: accepted

## Context

[ADR 0014](0014-report-designer-standalone-definitions.md) made **reports** data: a report
is a stored, parameterized definition the browser compiles and executes — new reports need
no deploy. But the **datasets** those reports query stayed *code*: each is a
`DatasetConnector` (`packages` / `services/data/connectors/*`) compiled into the binary. A
SQL-literate user who wants a new aggregation ("premium spend per model per month") still
had to wait for a code change and a release — the exact friction ADR 0014 removed one layer
up.

This is a **single-user, local-first** app. The user already owns
`~/.ghreporting/ghreporting.db` and can open it in `sqlite3`, so *read* SQL over their own
facts is not a privilege escalation. Secrets never live in SQLite (`credentials_meta` holds
metadata only; tokens live in the Keychain / encrypted-file via `SecretStore`), so a SELECT
cannot exfiltrate a credential. The one genuine risk is a **write or DDL** corrupting the
app's own tables.

## Decision

Add **Query Datasets**: a user-authored, read-only dataset defined by a stored SQL `SELECT`
over already-synced facts. It finishes ADR 0014 one layer down — datasets become data too.

1. **The row is the dataset — no DDL.** A query dataset is a row in `query_datasets`
   (migration `0006`): `id` (kebab-case), `title`, `description`, `sql` (one SELECT using
   named params `:org`, `:from`, `:to`), and a cached `columns` JSON. We never run
   `CREATE VIEW` / mutate the schema, so there is nothing to leak between the definition and
   the live object, and export/import (a future task) is a one-row dump.
2. **Read-only handle closes the write risk at the driver.** All user SQL runs on a second
   `Database(dbPath, { readonly: true })` handle (`adapters/db/database.ts` `openReadOnly`).
   A write/DDL throws `attempt to write a readonly database`. A **second, independent** guard
   wraps every user statement as `SELECT * FROM ( <sql> ) LIMIT n`, so a `DELETE`/`DROP` is a
   *syntax error* before it reaches the driver. **No SQL blacklist** — belt and suspenders,
   both structural. WAL ([ADR 0003](0003-sqlite-via-bun-sqlite.md)) lets the read-only handle
   read cleanly while syncs write on the read-write handle.
3. **Columns auto-derived.** `deriveColumns` prepares the SELECT on the read-only handle
   (validating syntax and rejecting writes), reads `columnNames` at `LIMIT 0`, and infers
   each type from a `LIMIT 1` sample. The result is cached in the row so the catalog lists a
   query dataset without re-preparing.
4. **First-class in the catalog, zero report-designer change.** The `data` service resolver
   falls back to a `query_datasets` lookup on a built-in miss (so a dataset created a moment
   ago is queryable with no re-init), and `GET /api/data/datasets` merges the rows beside the
   built-ins with `coverage: []` (they never sync). The report designer's dataset picker,
   fed by that same endpoint, lists them automatically. Built-ins win a name clash, enforced
   at create time (409).
5. **CRUD + preview under `data`.** `/api/data/query-datasets` (list/create/get/update/delete)
   plus `/preview` (derive + run for the editor), reusing the shared HTTP write-guards.

## Consequences

- **Good:** new aggregations are data — authored in the browser, no migration, no deploy;
  arbitrary read SQL is safe by construction (two structural guards, not a fragile blacklist);
  reports point at a query dataset with no designer change.
- **Cost:** type inference is sample-based (`ponytail:` in `query-dataset.ts`) — an
  all-`NULL` first row can mistype a column; refine to per-column typing if a chart mistypes.
  A query dataset is only as fast as its SELECT over local SQLite (no materialization).
- **Rejected — real `CREATE VIEW`/`DROP VIEW` DDL:** would mutate the schema the migrations
  own and reintroduce the write risk this ADR closes; the stored row is simpler.
- **Rejected — a no-code/visual aggregation builder:** no maintained OSS React lib builds a
  full `SELECT … GROUP BY` (react-querybuilder et al. build only `WHERE`); a SQL editor is
  less code and more expressive for the SQL-literate target user.
- **Rejected — server-side execution changes / a write surface:** the browser still
  orchestrates (ADR 0014); writes stay impossible through this surface by construction.

References [ADR 0014](0014-report-designer-standalone-definitions.md),
[ADR 0003](0003-sqlite-via-bun-sqlite.md).
