import type { Migration } from "../migrate";

/**
 * Query Datasets (ADR 0016, DDD.md §3.7, UBIQUITOUS.md §Reporting): user-authored,
 * read-only datasets defined by a stored SQL `SELECT` over already-synced facts. The row
 * IS the dataset — we never run CREATE VIEW / mutate the schema (ADR 0016 rejected DDL).
 * `sql` is one SELECT using the named params `:org`, `:from`, `:to`; `columns` caches the
 * derived `ColumnMeta[]` as JSON so the catalog lists it without re-preparing every SELECT.
 * All user SQL executes on a second `{ readonly: true }` handle — writes/DDL are impossible
 * by construction, so no SQL blacklist is needed.
 *
 * 0005 is reserved for spend_views (T9.1); this is 0006 to avoid colliding with it.
 */
export default {
  id: "0006_query_datasets",
  sql: `
CREATE TABLE query_datasets(
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  sql         TEXT NOT NULL,
  columns     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`,
} satisfies Migration;
