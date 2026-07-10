import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Open (creating if needed) the one shared database. WAL + FK on (ADR 0003). */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

/**
 * A second, read-only handle on the same file — where the `data` uService runs user-authored
 * query-dataset SQL (ADR 0016). `{ readonly: true }` makes writes/DDL throw at the driver, so
 * arbitrary user SELECTs cannot corrupt the app's own tables. WAL (ADR 0003) lets this handle
 * read cleanly while syncs write on the read-write handle.
 *
 * `:memory:` has no shared second handle (each open is a distinct database), so callers that
 * run against an in-memory DB pass their own handle — production always uses a file.
 */
export function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true });
}
