// The QueryDatasetRegistry (ADR 0017): the narrow port the `reports` service calls to materialize
// a report's embedded query datasets into the catalog and to garbage-collect orphaned ones. The
// data service implements it (it owns the query_datasets table, the read-only handle deriveColumns
// validates on, and the built-in id set). Reports depends only on this interface — the composition
// root wires the concrete (ARCHITECTURE.md §2). Every row in query_datasets is report-managed.
import type { Database } from "bun:sqlite";
import type { QueryDatasetDef } from "@ghreporting/domain";
import { AppError } from "../../kernel/errors";
import { deriveColumns } from "./query-dataset";

export interface QueryDatasetRegistry {
  /** Validate + deriveColumns EVERY def first (no half-applied provision), then upsert each
   *  (INSERT … ON CONFLICT DO UPDATE, preserving created_at). Throws ValidationError (400) on bad
   *  SQL and AppError("dataset.reserved", 409) if an id equals a built-in connector id. */
  provision(defs: QueryDatasetDef[]): void;
  /** Mark-and-sweep GC: delete every query_datasets row whose id is NOT in referencedIds. */
  sweep(referencedIds: Set<string>): void;
}

export interface RegistryDeps {
  db(): Database; // read-write handle (owns query_datasets)
  roDb: Database; // read-only handle deriveColumns validates on
  isBuiltin(id: string): boolean; // built-in connector ids can't be shadowed
  now(): Date;
}

export function createQueryDatasetRegistry(deps: RegistryDeps): QueryDatasetRegistry {
  return {
    provision(defs) {
      // Derive (and reject) ALL before writing ANY — an import must never half-apply.
      const prepared = defs.map((d) => {
        if (deps.isBuiltin(d.id)) {
          throw new AppError("dataset.reserved", `${d.id} is a built-in dataset`, 409);
        }
        return { d, columns: JSON.stringify(deriveColumns(deps.roDb, d.sql)) };
      });
      const at = deps.now().toISOString();
      for (const { d, columns } of prepared) {
        deps
          .db()
          .query(
            `INSERT INTO query_datasets(id,title,description,sql,columns,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?6)
             ON CONFLICT(id) DO UPDATE SET title=?2, description=?3, sql=?4, columns=?5, updated_at=?6`,
          )
          .run(d.id, d.title, d.description ?? null, d.sql, columns, at);
      }
    },
    sweep(referencedIds) {
      const ids = [...referencedIds];
      if (ids.length === 0) {
        deps.db().query("DELETE FROM query_datasets").run();
        return;
      }
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
      deps
        .db()
        .query(`DELETE FROM query_datasets WHERE id NOT IN (${placeholders})`)
        .run(...ids);
    },
  };
}
